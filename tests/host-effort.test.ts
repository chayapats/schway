import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { containsNoSecrets, createHost, createHostCredentialLifecycle, describeAuthRoute, hostCapabilities, HostError, isRouteControlRefused, listRouteModels,
  type HostDispatch, type HostModelChoice, type HostOptions, type HostRunAttemptUsage, type Model, type ThinkingLevel } from "schway/host";
import { codexSubscriptionIdentity, grokSubscriptionIdentity, type CredentialStore } from "../src/auth/store.ts";
import { THINKING_LEVELS } from "../src/model/model.ts";
import { effortSupport, exactEffort } from "../src/host/route-capabilities.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { withTempDir } from "./helpers.ts";
import { encodeXaiSse } from "./fixtures/xai.ts";

type Route = "codex" | "grok";
const SENTINELS = ["effort-access-sentinel", "effort-refresh-sentinel"];
const MODEL: Record<Route, string> = { codex: "gpt-6-luna", grok: "grok-4.7" };

async function options(dir: string, auth: HostOptions["auth"]): Promise<HostOptions> {
  const workspaceRoot = join(dir, "work"), homeDirectory = join(dir, "home");
  await mkdir(workspaceRoot, { recursive: true }); await mkdir(homeDirectory, { recursive: true });
  return { workspaceRoot, homeDirectory, sessionDirectory: join(dir, "sessions"),
    context: { policy: "strict", systemPrompt: "Trusted host operator", sections: [], sources: [] },
    tools: { policy: "exact", hostedLookup: "off", definitions: [] },
    limits: { maxTurns: 3, maxConcurrentTools: 2, contextWindow: 32768, maxInputChars: 4096 }, auth };
}

async function seededStore(route: Route): Promise<CredentialStore> {
  const store = fakeCredentialStore();
  await store.set(route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity(), JSON.stringify({
    accessToken: "effort-access-sentinel", refreshToken: "effort-refresh-sentinel", obtainedAt: Date.now(), expiresAt: Date.now() + 3_600_000 }));
  return store;
}

/** Catalog rows: Codex lists none/low/high with default low; xAI lists low/high without off, default high. */
function catalog(route: Route): Response {
  return route === "codex"
    ? Response.json({ models: [{ slug: MODEL.codex, visibility: "list", supported_reasoning_levels: [{ effort: "none" }, { effort: "low" }, { effort: "high" }], default_reasoning_level: "low" }] })
    : Response.json({ data: [{ id: MODEL.grok, supported_reasoning_levels: ["low", "high"], default_reasoning_effort: "high" }] });
}

function answer(route: Route, applied?: string): Response {
  const reasoning = applied ? { reasoning: { effort: applied } } : {};
  if (route === "codex") {
    const events = [
      { type: "response.created", response: { id: "r", status: "in_progress" } },
      { type: "response.output_text.delta", output_index: 0, delta: "Summary of the earlier retained work." },
      { type: "response.output_item.done", output_index: 0, item: { type: "message" } },
      { type: "response.completed", response: { id: "r", status: "completed", ...reasoning } },
    ];
    return new Response(`${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  }
  const events = [
    { type: "response.created", response: { id: "resp", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { id: "msg", type: "message", role: "assistant", status: "in_progress", content: [] } },
    { type: "response.output_text.delta", output_index: 0, delta: "Summary of the earlier retained work." },
    { type: "response.output_item.done", output_index: 0, item: { id: "msg", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Summary of the earlier retained work." }] } },
    { type: "response.completed", response: { id: "resp", status: "completed", usage: { input_tokens: 3, output_tokens: 2 }, ...reasoning } },
  ];
  return new Response(encodeXaiSse(events), { headers: { "Content-Type": "text/event-stream" } });
}

/** Fake transport: catalog GETs, token refresh and inference POSTs, recording every inference body. */
function transport(route: Route, script: { applied?: string; inference?: Array<() => Response> } = {}) {
  const bodies: string[] = [];
  const queue = [...(script.inference ?? [])];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (init?.method === "GET" || url.includes("/models")) return catalog(route);
    if (url.includes("auth.x.ai") || url.includes("/oauth/token")) return Response.json({ access_token: "effort-access-new", refresh_token: "effort-refresh-sentinel", expires_in: 3600 });
    bodies.push(typeof init?.body === "string" ? init.body : "");
    const next = queue.shift();
    return next ? next() : answer(route, script.applied);
  }) as never;
  const sentEffort = () => bodies.map(body => (JSON.parse(body) as { reasoning?: { effort?: string } }).reasoning?.effort ?? null);
  return { fetch, bodies, sentEffort };
}

async function listed(route: Route, store: CredentialStore, fetch: never): Promise<HostModelChoice> {
  const result = await listRouteModels({ route, store, fetch });
  if (result.status !== "listed") throw new Error(`expected listing, got ${result.status}`);
  return result.models.find(model => model.id === MODEL[route])!;
}

async function drain(model: Model, thinking?: ThinkingLevel): Promise<void> {
  for await (const _event of model.stream({ systemPrompt: "s", context: [], items: [{ type: "user", id: "u1", content: [{ type: "text", text: "hello" }] }], ...(thinking ? { thinking } : {}) })) { /* drain */ }
}

test("capabilities advertise the effort contract", () => {
  expect(hostCapabilities().effortContract).toBe("schway.host.effort/v1");
});

for (const route of ["codex", "grok"] as const) {
  test(`${route} listed effort support matches what the adapter accepts and sends`, async () => {
    await withTempDir(async dir => {
      const store = await seededStore(route);
      const wire = transport(route);
      const choice = await listed(route, store, wire.fetch);
      expect(choice.effort).toEqual(route === "codex"
        ? { levels: ["off", "low", "high"], offSendable: true, default: "low", evidence: "account-catalog" }
        : { levels: ["low", "high"], offSendable: false, default: "high", evidence: "account-catalog" });
      expect(Object.isFrozen(choice)).toBe(true);
      const host = await createHost(await options(dir, { route, model: MODEL[route], store, fetch: wire.fetch }));
      const model = await host.auth!.createModel({ catalogModel: choice });
      // Each level is accepted by the adapter exactly when the listing says so; off sends a control only when offSendable.
      for (const level of THINKING_LEVELS) {
        const before = wire.bodies.length;
        const failure = await drain(model, level).then(() => undefined, (error: unknown) => error as Error);
        const accepted = failure === undefined;
        expect(accepted).toBe(choice.effort.levels.includes(level));
        if (accepted) expect(wire.sentEffort().at(-1)).toBe(level === "off" ? (choice.effort.offSendable ? "none" : null) : level);
        else expect(wire.bodies.length).toBe(before);
      }
      await host.close();
    });
  });

  test(`${route} static description reports what the adapter accepts without account evidence`, async () => {
    await withTempDir(async dir => {
      const described = describeAuthRoute({ route, model: MODEL[route] });
      expect(described.effort).toEqual({ levels: [], offSendable: false, default: null, evidence: "none" });
      const store = await seededStore(route);
      const wire = transport(route);
      const host = await createHost(await options(dir, { route, model: MODEL[route], store, fetch: wire.fetch }));
      const model = await host.auth!.createModel();
      for (const level of ["off", "low", "high"] as const) await expect(drain(model, level)).rejects.toThrow();
      expect(wire.bodies).toHaveLength(0);
      await host.close();
    });
  });
}

test("exact pins the adapter would refuse or drop reject at createModel before any request", async () => {
  await withTempDir(async dir => {
    const store = await seededStore("grok");
    const wire = transport("grok");
    const choice = await listed("grok", store, wire.fetch);
    const host = await createHost(await options(dir, { route: "grok", model: MODEL.grok, store, fetch: wire.fetch }));
    for (const bad of [
      { catalogModel: choice, effort: { level: "off", mode: "exact" } },
      { catalogModel: choice, effort: { level: "xhigh", mode: "exact" } },
      { effort: { level: "low", mode: "exact" } },
      { catalogModel: { ...choice }, effort: { level: "low", mode: "exact" } },
      { catalogModel: choice, effort: { level: "low" } },
      { catalogModel: choice, effort: { level: "loud", mode: "exact" } },
    ]) {
      const failure = await host.auth!.createModel(bad as never).then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(HostError);
      expect((failure as HostError).code).toBe("invalid-input");
    }
    expect(wire.bodies).toHaveLength(0);
    await host.close();
  });
  // Off listed but without a disable control would be dropped silently, so an exact pin refuses it.
  const capability = { id: "grok-4.7", authRoute: "grok" as const, supportedThinking: ["off", "low"] as const };
  expect(effortSupport("grok", "grok-4.7", capability)).toMatchObject({ levels: ["off", "low"], offSendable: false });
  expect(() => exactEffort("grok", "grok-4.7", capability, { level: "off", mode: "exact" })).toThrow(HostError);
  expect(exactEffort("grok", "grok-4.7", capability, { level: "low", mode: "exact" })).toEqual({ level: "low", sent: "low" });
});

test("a choice listed for another route or model is not evidence", async () => {
  await withTempDir(async dir => {
    const codexChoice = await listed("codex", await seededStore("codex"), transport("codex").fetch);
    const store = await seededStore("grok");
    const host = await createHost(await options(dir, { route: "grok", model: MODEL.grok, store, fetch: transport("grok").fetch }));
    await expect(host.auth!.createModel({ catalogModel: codexChoice })).rejects.toMatchObject({ code: "invalid-input" });
    await host.close();
  });
});

for (const [route, level, sent] of [["codex", "high", "high"], ["codex", "off", "none"], ["grok", "low", "low"]] as const) {
  test(`${route} exact ${level} pin sends ${sent} on every call and reports it per send and attempt`, async () => {
    await withTempDir(async dir => {
      const store = await seededStore(route);
      const wire = transport(route, { applied: sent });
      const choice = await listed(route, store, wire.fetch);
      const host = await createHost(await options(dir, { route, model: MODEL[route], store, fetch: wire.fetch }));
      const session = await host.createSession();
      const seen: HostDispatch[] = [];
      const model = await host.auth!.createModel({ catalogModel: choice, effort: { level, mode: "exact" }, authorizeDispatch: dispatch => { seen.push(dispatch); } });
      const run = await session.submit({ text: "pinned" }, model);
      expect(run.outcome).toBe("completed");
      expect(wire.sentEffort()).toEqual([sent]);
      expect(seen.map(dispatch => dispatch.effort)).toEqual([{ requested: level, sent }]);
      const turns = run.usage.attempts.filter(attempt => attempt.phase === "turn");
      expect(turns.map(attempt => attempt.effort)).toEqual([{ requested: level, sent, reported: sent }]);
      expect(containsNoSecrets([seen, run], SENTINELS)).toBe(true);
      await session.close(); await host.close();
    });
  });
}

test("reported stays null unless the response states the effort, and is never copied from sent", async () => {
  await withTempDir(async dir => {
    const store = await seededStore("codex");
    const wire = transport("codex");
    const choice = await listed("codex", store, wire.fetch);
    const host = await createHost(await options(dir, { route: "codex", model: MODEL.codex, store, fetch: wire.fetch }));
    const session = await host.createSession();
    const model = await host.auth!.createModel({ catalogModel: choice, effort: { level: "high", mode: "exact" } });
    const run = await session.submit({ text: "unstated" }, model);
    expect(run.usage.attempts.map(attempt => attempt.effort)).toEqual([{ requested: "high", sent: "high", reported: null }]);
    await session.close(); await host.close();
  });
});

test("pins hold for compaction calls and auth-retry resends", async () => {
  await withTempDir(async dir => {
    const store = await seededStore("grok");
    const wire = transport("grok", { inference: [() => new Response("expired", { status: 401 })] });
    const choice = await listed("grok", store, wire.fetch);
    const host = await createHost(await options(dir, { route: "grok", model: MODEL.grok, store, fetch: wire.fetch }));
    const session = await host.createSession();
    for (let i = 0; i < 12; i++) await session.submit({ text: `retained ${i}` }, createScriptedModel({ text: "retained output" }));
    const seen: HostDispatch[] = [];
    const model = await host.auth!.createModel({ catalogModel: choice, effort: { level: "high", mode: "exact" }, authorizeDispatch: dispatch => { seen.push(dispatch); } });
    const compacted = await session.compact(model);
    expect(compacted.outcome).toBe("completed");
    // The compaction call met a 401, renewed, and resent: both sends carry the pinned effort.
    expect(seen.map(dispatch => [dispatch.kind, dispatch.effort.requested, dispatch.effort.sent])).toEqual([["initial", "high", "high"], ["auth-retry", "high", "high"]]);
    expect(wire.sentEffort()).toEqual(["high", "high"]);
    const compaction = compacted.usage.attempts.filter((attempt: HostRunAttemptUsage) => attempt.phase === "compaction");
    expect(compaction.map(attempt => attempt.effort)).toEqual([{ requested: "high", sent: "high", reported: null }]);
    await session.close(); await host.close();
  });
});

test("a request whose thinking conflicts with the pin is refused before any I/O and never retried", async () => {
  await withTempDir(async dir => {
    const store = await seededStore("codex");
    const wire = transport("codex");
    const choice = await listed("codex", store, wire.fetch);
    const host = await createHost(await options(dir, { route: "codex", model: MODEL.codex, store, fetch: wire.fetch }));
    let authorizations = 0;
    const pinned = await host.auth!.createModel({ catalogModel: choice, effort: { level: "high", mode: "exact" }, authorizeDispatch: () => { authorizations++; } });
    const failure = await drain(pinned, "low").then(() => undefined, (error: unknown) => error);
    expect(isRouteControlRefused(failure)).toBe(true);
    expect((failure as Error).message).toBe("The request asked for a reasoning effort other than the model's pinned effort, so it was not sent. Leave the request's thinking unset or match the pin.");
    expect(authorizations).toBe(0);
    expect(wire.bodies).toHaveLength(0);
    // A wrapper that sets the conflicting level on every request is refused once per turn, not retried.
    const session = await host.createSession();
    const wrapper: Model = { provider: pinned.provider, id: pinned.id, stream: (request, call) => pinned.stream({ ...request, thinking: "low" }, call) };
    const run = await session.submit({ text: "conflict" }, wrapper, { clock: { now: () => Date.now(), sleep: (ms: number, signal?: AbortSignal) => ms < 60_000 ? Promise.resolve()
      : new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })) } });
    expect(run.outcome).toBe("error");
    if (run.outcome !== "error") throw new Error("expected error");
    expect(run.error.message).toBe((failure as Error).message);
    expect(run.usage.attempts).toHaveLength(1);
    expect(run.usage.attempts[0]!.effort).toBeNull();
    expect(wire.bodies).toHaveLength(0);
    await session.close(); await host.close();
  });
});

test("listed evidence without a pin or requested thinking leaves request bytes unchanged", async () => {
  await withTempDir(async dir => {
    const store = await seededStore("codex");
    const wire = transport("codex");
    const choice = await listed("codex", store, wire.fetch);
    const host = await createHost(await options(dir, { route: "codex", model: MODEL.codex, store, fetch: wire.fetch }));
    await drain(await host.auth!.createModel());
    await drain(await host.auth!.createModel({ catalogModel: choice }));
    expect(wire.bodies).toHaveLength(2);
    expect(wire.bodies[1]).toBe(wire.bodies[0]!);
    expect(wire.sentEffort()).toEqual([null, null]);
    await host.close();
  });
});

/** Transport whose catalog GET returns the given rows; inference bodies are recorded. */
function rowsTransport(route: Route, rows: unknown[]) {
  const bodies: string[] = [];
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "GET") return Response.json(route === "codex" ? { models: rows } : { data: rows });
    bodies.push(typeof init?.body === "string" ? init.body : "");
    return answer(route);
  }) as never;
  return { fetch, bodies };
}

test("a grok row listing no efforts accepts off only as a no-op, exactly as the CLI adapter does", async () => {
  await withTempDir(async dir => {
    const store = await seededStore("grok");
    const wire = rowsTransport("grok", [{ id: MODEL.grok }]);
    const listing = await listRouteModels({ route: "grok", store, fetch: wire.fetch });
    if (listing.status !== "listed") throw new Error("expected listing");
    const choice = listing.models[0]!;
    expect(choice.effort).toEqual({ levels: ["off"], offSendable: false, default: null, evidence: "account-catalog" });
    const host = await createHost(await options(dir, { route: "grok", model: MODEL.grok, store, fetch: wire.fetch }));
    await expect(host.auth!.createModel({ catalogModel: choice, effort: { level: "off", mode: "exact" } })).rejects.toMatchObject({ code: "invalid-input" });
    await drain(await host.auth!.createModel({ catalogModel: choice }), "off");
    // The CLI builds the same capability with the shared xAI builder; neither sends a disable control.
    const { createXaiModel } = await import("../src/model/providers/xai.ts");
    const { xaiModelCapabilities } = await import("../src/model/model-list.ts");
    const cli = createXaiModel({ apiKey: "cli-key", authRoute: "grok", model: MODEL.grok, modelCapability: xaiModelCapabilities([{ id: MODEL.grok }], "grok")[0], fetch: wire.fetch });
    await drain(cli, "off");
    expect(wire.bodies).toHaveLength(2);
    for (const body of wire.bodies) expect((JSON.parse(body) as { reasoning?: unknown }).reasoning).toBeUndefined();
    await host.close();
  });
});

test("each route's default comes from its own catalog field, as the adapters parse it", async () => {
  const codexStore = await seededStore("codex"), grokStore = await seededStore("grok");
  const codex = await listRouteModels({ route: "codex", store: codexStore, fetch: rowsTransport("codex", [
    { slug: "codex-level", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], default_reasoning_level: "high" },
    { slug: "codex-xai-field", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], default_reasoning_effort: "high" },
  ]).fetch });
  const grok = await listRouteModels({ route: "grok", store: grokStore, fetch: rowsTransport("grok", [
    { id: "grok-4.7", supported_reasoning_levels: ["low", "high"], default_reasoning_effort: "medium" },
  ]).fetch });
  if (codex.status !== "listed" || grok.status !== "listed") throw new Error("expected listings");
  expect(codex.models.find(model => model.id === "codex-level")!.effort.default).toBe("high");
  expect(codex.models.find(model => model.id === "codex-xai-field")!.effort.default).toBeNull();
  // xAI keeps an advertised default even when it is not a listed level, as its shared builder does.
  expect(grok.models[0]!.effort).toMatchObject({ levels: ["low", "high"], default: "medium" });
});

test("listed evidence binds to the credential owner that listed it", async () => {
  await withTempDir(async dir => {
    const rows = [{ id: MODEL.grok, supported_reasoning_levels: ["low", "high"] }];
    const storeA = await seededStore("grok"), storeB = await seededStore("grok");
    const choiceA = (await listRouteModels({ route: "grok", store: storeA, fetch: rowsTransport("grok", rows).fetch }));
    if (choiceA.status !== "listed") throw new Error("expected listing");
    const wire = rowsTransport("grok", rows);
    const hostB = await createHost(await options(join(dir, "b"), { route: "grok", model: MODEL.grok, store: storeB, fetch: wire.fetch }));
    // Another account's listing is not evidence for this host's model.
    await expect(hostB.auth!.createModel({ catalogModel: choiceA.models[0]!, effort: { level: "high", mode: "exact" } })).rejects.toMatchObject({ code: "invalid-input" });
    expect(wire.bodies).toHaveLength(0);
    await hostB.close();
  });
});

test("hosts sharing one lifecycle accept each other's listing until logout replaces it", async () => {
  await withTempDir(async dir => {
    const base = await seededStore("grok");
    const lifecycle = createHostCredentialLifecycle({ store: base });
    const wire = rowsTransport("grok", [{ id: MODEL.grok, supported_reasoning_levels: ["low", "high"] }]);
    const listing = await listRouteModels({ route: "grok", lifecycle, fetch: wire.fetch });
    if (listing.status !== "listed") throw new Error("expected listing");
    const choice = listing.models[0]!;
    const first = await createHost(await options(join(dir, "one"), { route: "grok", model: MODEL.grok, lifecycle, fetch: wire.fetch }));
    const second = await createHost(await options(join(dir, "two"), { route: "grok", model: MODEL.grok, lifecycle, fetch: wire.fetch }));
    await drain(await first.auth!.createModel({ catalogModel: choice, effort: { level: "high", mode: "exact" } }));
    await drain(await second.auth!.createModel({ catalogModel: choice, effort: { level: "high", mode: "exact" } }));
    expect(wire.bodies.map(body => (JSON.parse(body) as { reasoning?: { effort?: string } }).reasoning?.effort)).toEqual(["high", "high"]);
    // Logout starts a new credential epoch, so evidence listed before it no longer applies.
    await lifecycle.logout("grok");
    await expect(second.auth!.createModel({ catalogModel: choice })).rejects.toMatchObject({ code: "invalid-input" });
    await first.close(); await second.close(); await lifecycle.close();
  });
});

test("send controls are read from the exact bytes", async () => {
  const { controlsFromBody } = await import("../src/model/dispatch.ts");
  const body = JSON.stringify({ reasoning: { effort: "high" }, max_output_tokens: 512 });
  const bytes = new TextEncoder().encode(body);
  // Every body form the dispatch hash accepts: string, ArrayBuffer and any ArrayBufferView, offsets included.
  const padded = new Uint8Array(bytes.byteLength + 4); padded.set(bytes, 2);
  for (const form of [body, bytes, bytes.buffer.slice(0), new DataView(bytes.buffer.slice(0)), new Int8Array(bytes.buffer.slice(0)), new Uint8Array(padded.buffer, 2, bytes.byteLength), new DataView(padded.buffer, 2, bytes.byteLength)]) {
    expect(controlsFromBody(form)).toEqual({ effort: "high", outputCap: 512 });
  }
  for (const unreadable of ["not json", "[1]", undefined, 42]) expect(controlsFromBody(unreadable)).toEqual({ effort: null, outputCap: null });
});

test("submit reports a route-control refusal that ends overflow recovery, not the overflow consequence", async () => {
  await withTempDir(async dir => {
    const store = await seededStore("codex");
    const wire = transport("codex", { inference: [() => new Response('{"error":{"code":"context_length_exceeded"}}', { status: 400 })] });
    const choice = await listed("codex", store, wire.fetch);
    const host = await createHost(await options(dir, { route: "codex", model: MODEL.codex, store, fetch: wire.fetch }));
    const session = await host.createSession();
    for (let i = 0; i < 12; i++) await session.submit({ text: `retained ${i}` }, createScriptedModel({ text: "retained output" }));
    const pinned = await host.auth!.createModel({ catalogModel: choice, effort: { level: "high", mode: "exact" } });
    // The turn sends and overflows; the recovery compaction then asks for a conflicting effort and is refused.
    let calls = 0;
    const wrapper: Model = { provider: pinned.provider, id: pinned.id, stream: (request, call) => pinned.stream(++calls === 2 ? { ...request, thinking: "low" } : request, call) };
    const run = await session.submit({ text: "overflowing turn" }, wrapper, { clock: { now: () => Date.now(), sleep: (ms: number, signal?: AbortSignal) => ms < 60_000 ? Promise.resolve()
      : new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })) } });
    expect(run.outcome).toBe("error");
    if (run.outcome !== "error") throw new Error("expected error");
    expect(run.error.message).toBe("The request asked for a reasoning effort other than the model's pinned effort, so it was not sent. Leave the request's thinking unset or match the pin.");
    expect(wire.bodies).toHaveLength(1);
    await session.close(); await host.close();
  });
});

test("codex evidence comes from the adapter's own catalog parser, so non-standard rows widen nothing", async () => {
  const rows = [
    { slug: "bare-levels", visibility: "list", supported_reasoning_levels: ["low", "high"], default_reasoning_level: "low" },
    { slug: "camel-levels", visibility: "list", supportedThinking: ["low"] },
    { slug: "capability-levels", visibility: "list", capabilities: { reasoning_effort: ["high"] } },
    { slug: "standard", visibility: "list", supported_reasoning_levels: [{ effort: "none" }, { effort: "high" }], default_reasoning_level: "high", contextWindow: 1000, max_completion_tokens: 100 },
  ];
  const store = await seededStore("codex");
  const wire = rowsTransport("codex", rows);
  const listing = await listRouteModels({ route: "codex", store, fetch: wire.fetch });
  if (listing.status !== "listed") throw new Error("expected listing");
  // The adapter's catalog path, as the CLI and TUI use it, over the same rows.
  const { fetchSubscriptionCatalog } = await import("../src/model/providers/codex-subscription.ts");
  const adapter = await fetchSubscriptionCatalog({ store, fetch: wire.fetch });
  for (const row of rows) {
    const host = listing.models.find(model => model.id === row.slug)!;
    expect(host.effort).toEqual(effortSupport("codex", row.slug, adapter.find(capability => capability.id === row.slug)!));
  }
  expect(listing.models.find(model => model.id === "bare-levels")!.effort).toEqual({ levels: [], offSendable: false, default: null, evidence: "account-catalog" });
  expect(listing.models.find(model => model.id === "standard")!.effort).toEqual({ levels: ["off", "high"], offSendable: true, default: "high", evidence: "account-catalog" });
});

test("a logout during listing keeps the choice bound to the account that was listed", async () => {
  await withTempDir(async dir => {
    const base = await seededStore("grok");
    const lifecycle = createHostCredentialLifecycle({ store: base });
    const listing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "GET") { listing.resolve(); await release.promise; return Response.json({ data: [{ id: MODEL.grok, supported_reasoning_levels: ["low", "high"] }] }); }
      return answer("grok");
    }) as never;
    const pending = listRouteModels({ route: "grok", lifecycle, fetch });
    await listing.promise;
    await lifecycle.logout("grok");
    // Another account signs in while the old catalog is still in flight.
    await base.set(grokSubscriptionIdentity(), JSON.stringify({ accessToken: "next-account", refreshToken: "next-refresh", obtainedAt: Date.now(), expiresAt: Date.now() + 3_600_000 }));
    release.resolve();
    const result = await pending;
    if (result.status !== "listed") throw new Error(`expected listing, got ${result.status}`);
    const host = await createHost(await options(dir, { route: "grok", model: MODEL.grok, lifecycle, fetch }));
    await expect(host.auth!.createModel({ catalogModel: result.models[0]!, effort: { level: "high", mode: "exact" } })).rejects.toMatchObject({ code: "invalid-input" });
    await host.close(); await lifecycle.close();
  });
});

test("classifyAuthError maps each route-control refusal to model-unavailable with its own next step", async () => {
  const { dispatchRouteModel } = await import("../src/host/dispatch.ts");
  const { providerDispatch } = await import("../src/model/dispatch.ts");
  const { classifyAuthError } = await import("schway/host");
  const sending = (controls: { effort: string | null; outputCap: number | null }): Model => ({ provider: "xai", id: MODEL.grok, async *stream(_request, call) {
    providerDispatch(call)!.send("initial", "{}", controls);
  } });
  const failure = (model: Model, thinking?: ThinkingLevel) => drain(model, thinking).then(() => { throw new Error("expected refusal"); }, (error: unknown) => error as Error);
  const conflict = await failure(dispatchRouteModel(sending({ effort: "high", outputCap: null }), "grok", undefined, { effort: { level: "high", sent: "high" } }), "low");
  const effortNotSent = await failure(dispatchRouteModel(sending({ effort: "low", outputCap: null }), "grok", undefined, { effort: { level: "high", sent: "high" } }));
  const capNotSent = await failure(dispatchRouteModel(sending({ effort: null, outputCap: 9 }), "grok", undefined, { outputCap: { exact: 10, required: true } }));
  const selection = { route: "grok" as const, model: MODEL.grok };
  for (const [refusal, message] of [
    [conflict, "The request asked for a reasoning effort other than the model's pinned effort, so it was not sent. Leave the request's thinking unset or match the pin."],
    [effortNotSent, "The pinned reasoning effort could not be sent exactly, so the request was not sent. Pin a level this model lists."],
    [capNotSent, "The required output cap could not be sent exactly, so the request was not sent. Retry with a cap this route supports."],
  ] as const) {
    expect(isRouteControlRefused(refusal)).toBe(true);
    expect(classifyAuthError(refusal, selection)).toMatchObject({ status: "model-unavailable", nextAction: message });
    // Identity follows `cause`; a copied message is not a refusal.
    expect(classifyAuthError(new Error("wrapped", { cause: refusal }), selection)).toMatchObject({ status: "model-unavailable", nextAction: message });
    expect(classifyAuthError(new Error(message), selection).status).toBe("integration-unavailable");
  }
});
