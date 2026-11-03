import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { classifyAuthError, containsNoSecrets, createAuthRouteModel, createHost, hostCapabilities, HostError, isDispatchRefused,
  type HostDispatch, type HostOptions, type HostProgressEvent, type Model } from "schway/host";
import { codexSubscriptionIdentity, grokSubscriptionIdentity, type CredentialStore } from "../src/auth/store.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { withTempDir } from "./helpers.ts";
import { encodeXaiSse, XAI_TEXT_EVENTS } from "./fixtures/xai.ts";

type Route = "codex" | "grok";
const SENTINELS = ["sentinel-access-old", "sentinel-access-new", "sentinel-refresh", "sentinel-api-key"];
const modelFor = (route: Route) => route === "codex" ? "gpt-5.4" : "grok-4.7";
const identityFor = (route: Route) => route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity();
/** Skips retry backoff only; the run deadline sleep still waits for abort, so it never fires early. */
const fastClock = { now: () => Date.now(), sleep: (ms: number, signal?: AbortSignal) => ms < 60_000 ? Promise.resolve()
  : new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })) };

async function options(dir: string, auth?: HostOptions["auth"], limits?: Partial<HostOptions["limits"]>): Promise<HostOptions> {
  const workspaceRoot = join(dir, "work"), homeDirectory = join(dir, "home");
  await mkdir(workspaceRoot, { recursive: true }); await mkdir(homeDirectory, { recursive: true });
  return { workspaceRoot, homeDirectory, sessionDirectory: join(dir, "sessions"),
    context: { policy: "strict", systemPrompt: "Trusted host operator", sections: [], sources: [] },
    tools: { policy: "exact", hostedLookup: "off", definitions: [] },
    limits: { maxTurns: 3, maxConcurrentTools: 2, contextWindow: 32768, maxInputChars: 4096, ...limits },
    ...(auth ? { auth } : {}) };
}

function codexSse(text = "Hello world"): Response {
  const events = [
    { type: "response.created", response: { id: "r", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message" } },
    { type: "response.output_text.delta", output_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item: { type: "message" } },
    { type: "response.completed", response: { id: "r", status: "completed" } },
  ];
  return new Response(`${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
}

const xaiSse = () => new Response(encodeXaiSse(XAI_TEXT_EVENTS), { headers: { "Content-Type": "text/event-stream" } });
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const fresh = () => Response.json({ access_token: "sentinel-access-new", refresh_token: "sentinel-refresh", expires_in: 3600 });
const REFUSED_MESSAGE = "Provider request refused by the embedding application's dispatch authorizer. The refused request was not sent.";

async function seed(store: CredentialStore, route: Route, expired = false): Promise<void> {
  await store.set(identityFor(route), JSON.stringify({ accessToken: "sentinel-access-old", refreshToken: "sentinel-refresh",
    obtainedAt: expired ? 1 : Date.now(), expiresAt: expired ? 1 : Date.now() + 3_600_000 }));
}

/** Fake transport recording every physical request body in arrival order. */
function transport(route: Route, script: { inference?: Array<() => Response | Promise<Response>>; token?: () => Response | Promise<Response> } = {}) {
  const log: Array<{ kind: "token" | "inference"; url: string; body: string }> = [];
  const inference = [...(script.inference ?? [])];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = typeof init?.body === "string" ? init.body : "";
    if (url.includes("auth.x.ai") || url.includes("/oauth/token")) {
      log.push({ kind: "token", url, body });
      return (script.token ?? fresh)();
    }
    log.push({ kind: "inference", url, body });
    const next = inference.shift();
    return next ? next() : route === "codex" ? codexSse() : xaiSse();
  }) as never;
  return { fetch, log, inferences: () => log.filter(entry => entry.kind === "inference") };
}

async function drain(model: Model, text = "hello"): Promise<void> {
  for await (const _event of model.stream({ systemPrompt: "s", context: [], items: [{ type: "user", id: "u1", content: [{ type: "text", text }] }] })) { /* drain */ }
}

test("capabilities advertise the dispatch-authorization and provider-requests contracts", () => {
  const caps = hostCapabilities();
  expect(caps.dispatchAuthorizationContract).toBe("schway.host.dispatch-authorization/v1");
  expect(caps.providerRequestsContract).toBe("schway.host.provider-requests/v1");
});

test("grok 401 refresh resend authorizes initial then auth-retry with exact body hashes", async () => {
  await withTempDir(async dir => {
    const store = fakeCredentialStore(); await seed(store, "grok");
    const wire = transport("grok", { inference: [() => new Response("expired", { status: 401 })] });
    const host = await createHost(await options(dir, { route: "grok", model: "grok-4.7", store, fetch: wire.fetch, env: { XAI_API_KEY: "sentinel-api-key" } }));
    const session = await host.createSession();
    const seen: HostDispatch[] = [], progress: HostProgressEvent[] = [];
    const run = await session.submitWithRoute({ text: "resend" }, { authorizeDispatch: dispatch => { seen.push(dispatch); }, onProgress: event => progress.push(event) });
    expect(run.outcome).toBe("completed");
    expect(seen.map(dispatch => [dispatch.kind, dispatch.sequence])).toEqual([["initial", 1], ["auth-retry", 2]]);
    const sent = wire.inferences();
    expect(sent).toHaveLength(2);
    expect(seen.map(dispatch => dispatch.bodySha256)).toEqual(sent.map(entry => sha256(entry.body)));
    expect(seen.map(dispatch => dispatch.bodyBytes)).toEqual(sent.map(entry => Buffer.byteLength(entry.body)));
    expect(Object.keys(seen[0]!).sort()).toEqual(["bodyBytes", "bodySha256", "effort", "kind", "model", "outputCap", "provider", "route", "sequence"]);
    // No pin and no requested thinking: nothing requested and no effort control in either body.
    expect(seen.map(dispatch => dispatch.effort)).toEqual([{ requested: null, sent: null }, { requested: null, sent: null }]);
    expect(seen[0]).toMatchObject({ route: "grok", provider: "xai", model: "grok-4.7" });
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(run.usage.providerRequests).toEqual({ initialSends: 1, authRetrySends: 1, renewalRequests: 1 });
    expect(sent.every(entry => entry.url.startsWith("https://api.x.ai/"))).toBe(true);
    for (const entry of sent) expect(containsNoSecrets(entry.body, SENTINELS)).toBe(true);
    expect(containsNoSecrets([seen, run, progress], SENTINELS)).toBe(true);
    await session.close(); await host.close();
  });
});

test("refusing the grok auth-retry sends exactly one inference request and ends honestly", async () => {
  await withTempDir(async dir => {
    const store = fakeCredentialStore(); await seed(store, "grok");
    const wire = transport("grok", { inference: [() => new Response("expired", { status: 401 })] });
    const host = await createHost(await options(dir, { route: "grok", model: "grok-4.7", store, fetch: wire.fetch }));
    const session = await host.createSession();
    const seen: HostDispatch[] = [];
    const run = await session.submitWithRoute({ text: "resend" }, { clock: fastClock, authorizeDispatch: dispatch => {
      seen.push(dispatch);
      if (dispatch.kind === "auth-retry") throw new Error("budget exhausted sentinel-access-new");
    } });
    expect(run.outcome).toBe("error");
    expect(wire.inferences()).toHaveLength(1);
    expect(seen.map(dispatch => dispatch.kind)).toEqual(["initial", "auth-retry"]);
    if (!("auth" in run)) throw new Error("expected auth detail");
    expect(run.auth).toMatchObject({ route: "grok", model: "grok-4.7", status: "dispatch-refused" });
    // Earlier sends in this run did leave, so the copy speaks only of the refused request.
    expect(run.auth.nextAction).toBe("The embedding application refused a provider request. The refused request was not sent. Retry the turn after the application allows it.");
    expect(run.auth.nextAction).not.toMatch(/No request/);
    expect(run.usage.providerRequests).toEqual({ initialSends: 1, authRetrySends: 0, renewalRequests: 1 });
    expect(containsNoSecrets(run, SENTINELS)).toBe(true);
    await session.close(); await host.close();
  });
});

for (const route of ["codex", "grok"] as const) {
  test(`${route} revocation during a pending credential read refuses the send`, async () => {
    await withTempDir(async dir => {
      const base = fakeCredentialStore(); await seed(base, route);
      const reading = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      const store: CredentialStore = { ...base, async get(identity) { reading.resolve(); await release.promise; return base.get(identity); } };
      const wire = transport(route);
      const host = await createHost(await options(dir, { route, model: modelFor(route), store, fetch: wire.fetch }));
      let revoked = false;
      const seen: HostDispatch[] = [];
      const model = await host.auth!.createModel({ authorizeDispatch: dispatch => { seen.push(dispatch); if (revoked) throw new Error("revoked by app"); } });
      const pending = drain(model).then(() => undefined, (error: unknown) => error);
      await reading.promise;
      revoked = true;
      release.resolve();
      const error = await pending;
      expect(isDispatchRefused(error)).toBe(true);
      expect(wire.inferences()).toHaveLength(0);
      expect(seen).toHaveLength(1);
      expect(containsNoSecrets((error as Error).message, SENTINELS)).toBe(true);
      await host.close();
    });
  });

  test(`${route} revocation during a pending renewal refuses the send after renewal settles`, async () => {
    await withTempDir(async dir => {
      const store = fakeCredentialStore(); await seed(store, route, true);
      const renewing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      const wire = transport(route, { token: async () => { renewing.resolve(); await release.promise; return fresh(); } });
      const host = await createHost(await options(dir, { route, model: modelFor(route), store, fetch: wire.fetch }));
      let revoked = false;
      const model = await host.auth!.createModel({ authorizeDispatch: () => { if (revoked) throw new Error("revoked by app"); } });
      const pending = drain(model).then(() => undefined, (error: unknown) => error);
      await renewing.promise;
      revoked = true;
      release.resolve();
      expect(isDispatchRefused(await pending)).toBe(true);
      expect(wire.log.map(entry => entry.kind)).toEqual(["token"]);
      await host.close();
    });
  });
}

test("codex with an expired token renews first, then authorizes exactly one inference send", async () => {
  await withTempDir(async dir => {
    const store = fakeCredentialStore(); await seed(store, "codex", true);
    const order: string[] = [];
    const wire = transport("codex");
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      order.push(String(input).includes("/oauth/token") ? "token" : "inference");
      return (wire.fetch as unknown as typeof globalThis.fetch)(input, init);
    }) as never;
    const host = await createHost(await options(dir, { route: "codex", model: "gpt-5.4", store, fetch }));
    const session = await host.createSession();
    const seen: HostDispatch[] = [];
    const run = await session.submitWithRoute({ text: "renew" }, { authorizeDispatch: dispatch => { order.push("authorize"); seen.push(dispatch); } });
    expect(run.outcome).toBe("completed");
    expect(order).toEqual(["token", "authorize", "inference"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ route: "codex", provider: "codex-subscription", model: "gpt-5.4", kind: "initial", sequence: 1 });
    expect(seen[0]!.bodySha256).toBe(sha256(wire.inferences()[0]!.body));
    expect(run.usage.providerRequests).toEqual({ initialSends: 1, authRetrySends: 0, renewalRequests: 1 });
    // Codex inference bodies carry no token material; only the renewal request carries the refresh token.
    for (const entry of wire.inferences()) expect(containsNoSecrets(entry.body, SENTINELS)).toBe(true);
    expect(containsNoSecrets([seen, run], SENTINELS)).toBe(true);
    await session.close(); await host.close();
  });
});

test("agent-loop transient retries are each authorized as separate physical sends", async () => {
  await withTempDir(async dir => {
    const store = fakeCredentialStore(); await seed(store, "grok");
    const wire = transport("grok", { inference: [() => new Response("busy", { status: 500 })] });
    const host = await createHost(await options(dir, { route: "grok", model: "grok-4.7", store, fetch: wire.fetch }));
    const session = await host.createSession();
    const seen: HostDispatch[] = [];
    const run = await session.submitWithRoute({ text: "flaky" }, { clock: fastClock, authorizeDispatch: dispatch => { seen.push(dispatch); } });
    expect(run.outcome).toBe("completed");
    expect(seen.map(dispatch => [dispatch.kind, dispatch.sequence])).toEqual([["initial", 1], ["initial", 1]]);
    expect(seen.map(dispatch => dispatch.bodySha256)).toEqual(wire.inferences().map(entry => sha256(entry.body)));
    expect(run.usage.providerRequests).toEqual({ initialSends: 2, authRetrySends: 0, renewalRequests: 0 });
    await session.close(); await host.close();
  });
});

test("compaction model calls through a route model are authorized and counted", async () => {
  await withTempDir(async dir => {
    const store = fakeCredentialStore(); await seed(store, "codex");
    const wire = transport("codex", { inference: [() => codexSse("Summary of the earlier retained work.")] });
    const host = await createHost(await options(dir, { route: "codex", model: "gpt-5.4", store, fetch: wire.fetch }));
    const session = await host.createSession();
    for (let i = 0; i < 12; i++) await session.submit({ text: `retained ${i}` }, createScriptedModel({ text: "retained output" }));
    const seen: HostDispatch[] = [];
    const model = await host.auth!.createModel({ authorizeDispatch: dispatch => { seen.push(dispatch); } });
    const compacted = await session.compact(model);
    expect(compacted.outcome).toBe("completed");
    expect(seen.map(dispatch => [dispatch.kind, dispatch.sequence])).toEqual([["initial", 1]]);
    expect(seen[0]!.bodySha256).toBe(sha256(wire.inferences()[0]!.body));
    expect(compacted.usage.providerRequests).toEqual({ initialSends: 1, authRetrySends: 0, renewalRequests: 0 });
    await session.close(); await host.close();
  });
});

test("refusal is not retried, is classified, and never switches route, model or billing", async () => {
  await withTempDir(async dir => {
    const store = fakeCredentialStore(); await seed(store, "codex");
    const wire = transport("codex");
    const host = await createHost(await options(dir, { route: "codex", model: "gpt-5.4", store, fetch: wire.fetch, env: { OPENAI_API_KEY: "sentinel-api-key" } }));
    const session = await host.createSession();
    let calls = 0;
    const run = await session.submitWithRoute({ text: "refused" }, { clock: fastClock, authorizeDispatch: () => { calls++; throw new Error("recipient not allowed"); } });
    expect(run.outcome).toBe("error");
    expect(calls).toBe(1);
    expect(wire.log).toHaveLength(0);
    if (!("auth" in run)) throw new Error("expected auth detail");
    expect(run.auth).toMatchObject({ route: "codex", model: "gpt-5.4", status: "dispatch-refused", observedInference: "not-checked" });
    expect(run.usage.providerRequests).toEqual({ initialSends: 0, authRetrySends: 0, renewalRequests: 0 });
    expect(containsNoSecrets(run, SENTINELS)).toBe(true);

    let modelCalls = 0;
    const refusing = await host.auth!.createModel({ authorizeDispatch: () => { modelCalls++; throw new Error("over budget"); } });
    const submitted = await session.submit({ text: "refused again" }, refusing, { clock: fastClock });
    expect(submitted.outcome).toBe("error");
    expect(modelCalls).toBe(1);
    expect(wire.log).toHaveLength(0);
    if (submitted.outcome !== "error") throw new Error("expected error");
    expect(submitted.error.message).toBe(REFUSED_MESSAGE);
    // Identity only: a copy of the message is not the refusal.
    expect(isDispatchRefused(new Error(submitted.error.message))).toBe(false);
    expect(submitted.model).toEqual({ provider: "codex-subscription", id: "gpt-5.4" });
    expect(containsNoSecrets(submitted, SENTINELS)).toBe(true);
    await session.close(); await host.close();
  });
});

test("an authorizer returning a promise refuses the send instead of being awaited", async () => {
  await withTempDir(async dir => {
    const store = fakeCredentialStore(); await seed(store, "codex");
    const wire = transport("codex");
    const host = await createHost(await options(dir, { route: "codex", model: "gpt-5.4", store, fetch: wire.fetch }));
    const model = await host.auth!.createModel({ authorizeDispatch: (async () => {}) as unknown as (dispatch: HostDispatch) => void });
    const error = await drain(model).then(() => undefined, (failure: unknown) => failure);
    expect(isDispatchRefused(error)).toBe(true);
    expect(wire.log).toHaveLength(0);
    await host.close();
  });
});

test("without an authorizer request bytes are unchanged", async () => {
  await withTempDir(async dir => {
    const store = fakeCredentialStore(); await seed(store, "codex");
    const wire = transport("codex");
    const host = await createHost(await options(dir, { route: "codex", model: "gpt-5.4", store, fetch: wire.fetch }));
    const one = await host.createSession(), two = await host.createSession();
    const seen: HostDispatch[] = [];
    expect((await one.submitWithRoute({ text: "same bytes" })).outcome).toBe("completed");
    expect((await two.submitWithRoute({ text: "same bytes" }, { authorizeDispatch: dispatch => { seen.push(dispatch); } })).outcome).toBe("completed");
    const [plain, authorized] = wire.inferences().map(entry => entry.body);
    expect(authorized).toBe(plain!);
    expect(seen[0]!.bodySha256).toBe(sha256(plain!));
    await one.close(); await two.close(); await host.close();
  });
});

test("direct route models accept an authorizer and reject malformed options", async () => {
  await withTempDir(async dir => {
    const store = fakeCredentialStore(); await seed(store, "codex");
    const wire = transport("codex");
    const seen: HostDispatch[] = [];
    const direct = await createAuthRouteModel({ route: "codex", model: "gpt-5.4", store, fetch: wire.fetch }, { authorizeDispatch: dispatch => { seen.push(dispatch); } });
    await drain(direct);
    expect(seen).toHaveLength(1);
    await expect(createAuthRouteModel({ route: "codex", model: "gpt-5.4", store }, { authorizeDispatch: "no" } as never)).rejects.toMatchObject({ code: "invalid-input" });
    const host = await createHost(await options(dir, { route: "codex", model: "gpt-5.4", store, fetch: wire.fetch }));
    for (const bad of [{ bogus: true }, { authorizeDispatch: 1 }, null, []]) {
      await expect(host.auth!.createModel(bad as never)).rejects.toBeInstanceOf(HostError);
    }
    const session = await host.createSession();
    await expect(session.submit({ text: "x" }, createScriptedModel({ text: "ok" }), { authorizeDispatch: () => {} } as never)).rejects.toMatchObject({ code: "invalid-input" });
    await expect(session.compact(createScriptedModel({ text: "ok" }), { authorizeDispatch: () => {} } as never)).rejects.toMatchObject({ code: "invalid-input" });
    await expect(session.submitWithRoute({ text: "x" }, { authorizeDispatch: "no" } as never)).rejects.toMatchObject({ code: "invalid-input" });
    await session.close(); await host.close();
  });
});

/** Seed retained history with a scripted model, then reopen it on a fresh host with a tiny context window. */
async function reopenCrowded(dir: string, auth: HostOptions["auth"]) {
  const seedHost = await createHost(await options(dir, auth));
  const seeded = await seedHost.createSession();
  for (let i = 0; i < 12; i++) await seeded.submit({ text: `retained ${i} ${"context ".repeat(20)}` }, createScriptedModel({ text: `retained output ${"words ".repeat(20)}` }));
  const reference = seeded.reference;
  await seeded.close(); await seedHost.close();
  const host = await createHost(await options(dir, auth, { contextWindow: 100 }));
  return { host, session: await host.openSession(reference) };
}

test("a refused pressure compaction does not mask a later failure before the next send", async () => {
  for (const refuseFirst of [true, false]) {
    await withTempDir(async dir => {
      const base = fakeCredentialStore(); await seed(base, "codex");
      let reads = 0, failReads = false;
      const store: CredentialStore = { ...base, async get(identity) { reads++; if (failReads && reads >= 3) throw new Error("locked sentinel-access-old"); return base.get(identity); } };
      const wire = transport("codex", { inference: [() => codexSse("Summary of the earlier retained work.")] });
      const { host, session } = await reopenCrowded(dir, { route: "codex", model: "gpt-5.4", store, fetch: wire.fetch });
      reads = 0; failReads = true;
      const seen: HostDispatch[] = [];
      const run = await session.submitWithRoute({ text: "next turn" }, { clock: fastClock, authorizeDispatch: dispatch => {
        seen.push(dispatch);
        if (refuseFirst && seen.length === 1) throw new Error("compaction recipient not allowed");
      } });
      expect(run.outcome).toBe("error");
      if (!("auth" in run)) throw new Error("expected auth detail");
      // The pressure compaction is the first authorized call; the turn then fails at its credential read.
      expect(seen.length).toBe(1);
      expect(run.auth.status).toBe("rejected");
      expect(containsNoSecrets(run, SENTINELS)).toBe(true);
      await session.close(); await host.close();
    });
  }
});

test("provider text echoing the refusal wording stays a retryable provider failure", async () => {
  await withTempDir(async dir => {
    const store = fakeCredentialStore(); await seed(store, "grok");
    const echo = () => Response.json({ error: { message: REFUSED_MESSAGE } }, { status: 500 });
    const wire = transport("grok", { inference: [echo, echo, echo] });
    const host = await createHost(await options(dir, { route: "grok", model: "grok-4.7", store, fetch: wire.fetch }));
    const session = await host.createSession();
    const seen: HostDispatch[] = [];
    const run = await session.submitWithRoute({ text: "echo" }, { clock: fastClock, authorizeDispatch: dispatch => { seen.push(dispatch); } });
    expect(run.outcome).toBe("error");
    expect(wire.inferences()).toHaveLength(3);
    expect(seen).toHaveLength(3);
    if (!("auth" in run)) throw new Error("expected auth detail");
    expect(run.auth.status).not.toBe("dispatch-refused");
    await session.close(); await host.close();
  });
});

for (const route of ["codex", "grok"] as const) {
  test(`${route} route sends refuse redirects, so every physical POST is authorized`, async () => {
    const label = route === "codex" ? "ChatGPT subscription" : "Grok subscription";
    await withTempDir(async dir => {
      let posts = 0, redirected = 0;
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/elsewhere") { redirected++; return route === "codex" ? codexSse() : xaiSse(); }
        posts++;
        return new Response(null, { status: 307, headers: { Location: "/elsewhere" } });
      } });
      try {
        const store = fakeCredentialStore(); await seed(store, route);
        const fetch = ((_input: string | URL | Request, init?: RequestInit) => globalThis.fetch(new URL("/responses", server.url), init)) as never;
        const host = await createHost(await options(dir, { route, model: modelFor(route), store, fetch }));
        const session = await host.createSession();
        const seen: HostDispatch[] = [], progress: HostProgressEvent[] = [];
        const run = await session.submitWithRoute({ text: "redirect" }, { clock: fastClock, authorizeDispatch: dispatch => { seen.push(dispatch); }, onProgress: event => progress.push(event) });
        expect(run.outcome).toBe("error");
        // The server answered, so the refused redirect is neither followed nor retried as an offline failure.
        expect(redirected).toBe(0);
        expect(posts).toBe(1);
        expect(seen).toHaveLength(1);
        expect(progress.filter(event => event.type === "retry")).toHaveLength(0);
        expect(run.usage.providerRequests).toEqual({ initialSends: 1, authRetrySends: 0, renewalRequests: 0 });
        if (!("auth" in run)) throw new Error("expected auth detail");
        expect(run.auth.status).toBe("integration-unavailable");
        expect(run.auth.nextAction).toBe(`The ${label} answered with an HTTP redirect, which route requests never follow. Retry later; Schway never falls back to API-key billing.`);
        // Without an authorizer the route model still refuses the redirect, and its message carries no URL.
        const plain = await session.submit({ text: "redirect again" }, await host.auth!.createModel(), { clock: fastClock });
        if (plain.outcome !== "error") throw new Error("expected error");
        expect(plain.error.message).toBe(`The ${label} answered with an HTTP redirect. Route requests never follow redirects, so the request was not resent. Retry later.`);
        expect(posts).toBe(2);
        expect(redirected).toBe(0);
        await session.close(); await host.close();
      } finally { server.stop(true); }
    });
  });
}

test("compaction inside a route run is authorized by the per-run authorizer and counted", async () => {
  await withTempDir(async dir => {
    const store = fakeCredentialStore(); await seed(store, "codex");
    const wire = transport("codex", { inference: [() => codexSse("Summary of the earlier retained work."), () => codexSse("Next answer.")] });
    const { host, session } = await reopenCrowded(dir, { route: "codex", model: "gpt-5.4", store, fetch: wire.fetch });
    const seen: HostDispatch[] = [], progress: HostProgressEvent[] = [];
    const run = await session.submitWithRoute({ text: "next turn" }, { authorizeDispatch: dispatch => { seen.push(dispatch); }, onProgress: event => progress.push(event) });
    expect(progress.some(event => event.type === "compaction" && event.stage === "finished" && event.status === "completed")).toBe(true);
    const sent = wire.inferences();
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(seen.map(dispatch => dispatch.bodySha256)).toEqual(sent.map(entry => sha256(entry.body)));
    expect(seen.every(dispatch => dispatch.kind === "initial" && dispatch.sequence === 1)).toBe(true);
    expect(run.usage.providerRequests).toEqual({ initialSends: sent.length, authRetrySends: 0, renewalRequests: 0 });
    expect(run.usage.attempts.some(attempt => attempt.phase === "compaction")).toBe(true);
    await session.close(); await host.close();
  });
});

test("submit reports the refusal when overflow recovery's compaction send is refused", async () => {
  await withTempDir(async dir => {
    const store = fakeCredentialStore(); await seed(store, "codex");
    const wire = transport("codex", { inference: [() => new Response('{"error":{"code":"context_length_exceeded"}}', { status: 400 })] });
    const host = await createHost(await options(dir, { route: "codex", model: "gpt-5.4", store, fetch: wire.fetch }));
    const session = await host.createSession();
    for (let i = 0; i < 12; i++) await session.submit({ text: `retained ${i}` }, createScriptedModel({ text: "retained output" }));
    const seen: HostDispatch[] = [];
    const model = await host.auth!.createModel({ authorizeDispatch: dispatch => { seen.push(dispatch); if (seen.length === 2) throw new Error("summary not allowed"); } });
    const run = await session.submit({ text: "overflowing turn" }, model, { clock: fastClock });
    expect(run.outcome).toBe("error");
    expect(seen).toHaveLength(2);
    expect(wire.inferences()).toHaveLength(1);
    if (run.outcome !== "error") throw new Error("expected error");
    expect(run.error.message).toBe(REFUSED_MESSAGE);
    expect(run.usage.providerRequests).toEqual({ initialSends: 1, authRetrySends: 0, renewalRequests: 0 });
    await session.close(); await host.close();
  });
});

for (const [variant, authorizerError] of [
  ["transient-looking status", () => Object.assign(new Error("budget service busy"), { status: 503 })],
  ["network-looking failure", () => new TypeError("fetch failed")],
] as const) {
  test(`a refusal a wrapper chains as cause is never retried (${variant})`, async () => {
    await withTempDir(async dir => {
      const store = fakeCredentialStore(); await seed(store, "codex");
      const wire = transport("codex");
      const host = await createHost(await options(dir, { route: "codex", model: "gpt-5.4", store, fetch: wire.fetch }));
      const session = await host.createSession();
      let calls = 0;
      const inner = await host.auth!.createModel({ authorizeDispatch: () => { calls++; throw authorizerError(); } });
      const wrapped: Error[] = [];
      const wrapper: Model = { provider: inner.provider, id: inner.id, async *stream(request, call) {
        try { yield* inner.stream(request, call); }
        catch (error) { const failure = new Error("wrapped model failure", { cause: error }); wrapped.push(failure); throw failure; }
      } };
      const run = await session.submit({ text: "wrapped" }, wrapper, { clock: fastClock });
      expect(run.outcome).toBe("error");
      expect(calls).toBe(1);
      expect(wire.log).toHaveLength(0);
      if (run.outcome !== "error") throw new Error("expected error");
      expect(run.error.message).toBe(REFUSED_MESSAGE);
      expect(run.usage.providerRequests).toEqual({ initialSends: 0, authRetrySends: 0, renewalRequests: 0 });
      // Classification follows the cause chain by identity; echoed text alone never matches.
      const selection = { route: "codex" as const, model: "gpt-5.4" };
      expect(classifyAuthError(wrapped[0], selection).status).toBe("dispatch-refused");
      expect(classifyAuthError(new Error("wrapped", { cause: new Error(REFUSED_MESSAGE) }), selection).status).not.toBe("dispatch-refused");
      await session.close(); await host.close();
    });
  });
}

test("a 503 whose body echoes redirect wording keeps its status and is retried", async () => {
  await withTempDir(async dir => {
    const store = fakeCredentialStore(); await seed(store, "grok");
    const echo = () => Response.json({ error: { message: "edge proxy: unexpected redirect from origin" } }, { status: 503 });
    const wire = transport("grok", { inference: [echo, echo] });
    const host = await createHost(await options(dir, { route: "grok", model: "grok-4.7", store, fetch: wire.fetch }));
    const session = await host.createSession();
    const seen: HostDispatch[] = [], progress: HostProgressEvent[] = [];
    const run = await session.submitWithRoute({ text: "echo" }, { clock: fastClock, authorizeDispatch: dispatch => { seen.push(dispatch); }, onProgress: event => progress.push(event) });
    expect(run.outcome).toBe("completed");
    expect(wire.inferences()).toHaveLength(3);
    expect(seen).toHaveLength(3);
    expect(progress.filter(event => event.type === "retry")).toHaveLength(2);
    expect(run.usage.providerRequests).toEqual({ initialSends: 3, authRetrySends: 0, renewalRequests: 0 });
    await session.close(); await host.close();
  });
});

test("grok 401, renewal, then a redirected resend is one authorized resend that is not retried", async () => {
  await withTempDir(async dir => {
    let posts = 0, redirected = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      if (new URL(request.url).pathname === "/elsewhere") { redirected++; return xaiSse(); }
      posts++;
      return posts === 1 ? new Response("expired", { status: 401 }) : new Response(null, { status: 307, headers: { Location: "/elsewhere" } });
    } });
    try {
      const store = fakeCredentialStore(); await seed(store, "grok");
      let renewals = 0;
      const fetch = ((input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes("auth.x.ai")) { renewals++; return Promise.resolve(fresh()); }
        return globalThis.fetch(new URL("/responses", server.url), init);
      }) as never;
      const host = await createHost(await options(dir, { route: "grok", model: "grok-4.7", store, fetch }));
      const session = await host.createSession();
      const seen: HostDispatch[] = [], progress: HostProgressEvent[] = [];
      const run = await session.submitWithRoute({ text: "resend redirect" }, { clock: fastClock, authorizeDispatch: dispatch => { seen.push(dispatch); }, onProgress: event => progress.push(event) });
      expect(run.outcome).toBe("error");
      expect(seen.map(dispatch => `${dispatch.kind}:${dispatch.sequence}`)).toEqual(["initial:1", "auth-retry:2"]);
      expect(posts).toBe(2);
      expect(redirected).toBe(0);
      expect(renewals).toBe(1);
      expect(progress.filter(event => event.type === "retry")).toHaveLength(0);
      expect(run.usage.providerRequests).toEqual({ initialSends: 1, authRetrySends: 1, renewalRequests: 1 });
      if (!("auth" in run)) throw new Error("expected auth detail");
      expect(run.auth.status).toBe("integration-unavailable");
      expect(run.auth.nextAction).toBe("The Grok subscription answered with an HTTP redirect, which route requests never follow. Retry later; Schway never falls back to API-key billing.");
      await session.close(); await host.close();
    } finally { server.stop(true); }
  });
});

test("provider text echoing the redirect wording never gets the redirect guidance", async () => {
  await withTempDir(async dir => {
    const store = fakeCredentialStore(); await seed(store, "codex");
    const wire = transport("codex", { inference: [() => new Response("edge: The ChatGPT subscription answered with an HTTP redirect.", { status: 400 })] });
    const host = await createHost(await options(dir, { route: "codex", model: "gpt-5.4", store, fetch: wire.fetch }));
    const session = await host.createSession();
    const run = await session.submitWithRoute({ text: "echo" }, { clock: fastClock });
    expect(run.outcome).toBe("error");
    if (!("auth" in run)) throw new Error("expected auth detail");
    expect(run.auth.nextAction).not.toContain("answered with an HTTP redirect");
    const selection = { route: "codex" as const, model: "gpt-5.4" };
    expect(classifyAuthError(new Error("The ChatGPT subscription answered with an HTTP redirect."), selection).nextAction).not.toContain("redirect");
    await session.close(); await host.close();
  });
});

test("a deadline that lands after a refused redirect keeps the redirect guidance", async () => {
  await withTempDir(async dir => {
    let posts = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { posts++; return new Response(null, { status: 307, headers: { Location: "/elsewhere" } }); } });
    try {
      const store = fakeCredentialStore(); await seed(store, "codex");
      const fetch = ((_input: string | URL | Request, init?: RequestInit) => globalThis.fetch(new URL("/responses", server.url), init)) as never;
      const host = await createHost(await options(dir, { route: "codex", model: "gpt-5.4", store, fetch }));
      const session = await host.createSession();
      // An embedder clock fires the deadline once the failed attempt is reported, before the run settles.
      const fire = Promise.withResolvers<void>();
      const clock = { now: () => Date.now(), sleep: (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
        if (ms < 60_000) { resolve(); return; }
        void fire.promise.then(() => resolve());
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }) };
      const run = await session.submitWithRoute({ text: "redirect at deadline" }, { clock, onProgress: event => { if (event.type === "usage") fire.resolve(); } });
      expect(run.outcome).toBe("limit_exceeded");
      expect(posts).toBe(1);
      if (!("auth" in run)) throw new Error("expected auth detail");
      expect(run.auth.status).toBe("integration-unavailable");
      expect(run.auth.nextAction).toBe("The ChatGPT subscription answered with an HTTP redirect, which route requests never follow. Retry later; Schway never falls back to API-key billing.");
      await session.close(); await host.close();
    } finally { server.stop(true); }
  });
});

test("a deadline that lands after a dispatch refusal keeps the refusal status", async () => {
  await withTempDir(async dir => {
    const store = fakeCredentialStore(); await seed(store, "codex");
    const wire = transport("codex");
    const host = await createHost(await options(dir, { route: "codex", model: "gpt-5.4", store, fetch: wire.fetch }));
    const session = await host.createSession();
    // An embedder clock fires the deadline once the refused attempt is reported, before the run settles.
    const fire = Promise.withResolvers<void>();
    const clock = { now: () => Date.now(), sleep: (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
      if (ms < 60_000) { resolve(); return; }
      void fire.promise.then(() => resolve());
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }) };
    const run = await session.submitWithRoute({ text: "refused at deadline" }, { clock, authorizeDispatch: () => { throw new Error("over budget"); },
      onProgress: event => { if (event.type === "usage") fire.resolve(); } });
    expect(run.outcome).toBe("limit_exceeded");
    expect(wire.log).toHaveLength(0);
    if (!("auth" in run)) throw new Error("expected auth detail");
    expect(run.auth.status).toBe("dispatch-refused");
    await session.close(); await host.close();
  });
});
