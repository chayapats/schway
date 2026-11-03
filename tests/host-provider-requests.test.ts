import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { checkAuthReadiness, createHost, createHostCredentialLifecycle, HostError, type HostOptions, type HostProgressEvent, type Model } from "schway/host";
import { codexSubscriptionIdentity, grokSubscriptionIdentity, type CredentialStore } from "../src/auth/store.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { withTempDir } from "./helpers.ts";
import { encodeXaiSse, XAI_PARALLEL_TOOL_EVENTS, XAI_TEXT_EVENTS } from "./fixtures/xai.ts";

type Route = "codex" | "grok";
const modelFor = (route: Route) => route === "codex" ? "gpt-5.4" : "grok-4.7";
const identityFor = (route: Route) => route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity();
/** Skips retry backoff only; the run deadline sleep still waits for abort, so it never fires early. */
const fastClock = { now: () => Date.now(), sleep: (ms: number, signal?: AbortSignal) => ms < 60_000 ? Promise.resolve()
  : new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })) };
const valid = () => JSON.stringify({ accessToken: "fixture-access", refreshToken: "fixture-refresh", obtainedAt: Date.now(), expiresAt: Date.now() + 3_600_000 });

async function options(dir: string, auth?: HostOptions["auth"], limits?: Partial<HostOptions["limits"]>): Promise<HostOptions> {
  const workspaceRoot = join(dir, "work"), homeDirectory = join(dir, "home");
  await mkdir(workspaceRoot, { recursive: true }); await mkdir(homeDirectory, { recursive: true });
  return { workspaceRoot, homeDirectory, sessionDirectory: join(dir, "sessions"),
    context: { policy: "strict", systemPrompt: "Trusted host operator", sections: [], sources: [] },
    tools: { policy: "exact", hostedLookup: "off", definitions: [] },
    limits: { maxTurns: 3, maxConcurrentTools: 2, contextWindow: 32768, maxInputChars: 4096, ...limits },
    ...(auth ? { auth } : {}) };
}

function codexSse(): Response {
  const events = [
    { type: "response.created", response: { id: "r", status: "in_progress" } },
    { type: "response.output_text.delta", output_index: 0, delta: "ok" },
    { type: "response.output_item.done", output_index: 0, item: { type: "message" } },
    { type: "response.completed", response: { id: "r", status: "completed" } },
  ];
  return new Response(`${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
}
const xaiSse = () => new Response(encodeXaiSse(XAI_TEXT_EVENTS), { headers: { "Content-Type": "text/event-stream" } });
const routeSse = (route: Route) => route === "codex" ? codexSse() : xaiSse();
const isToken = (input: string | URL | Request) => { const url = String(input); return url.includes("auth.x.ai") || url.includes("/oauth/token"); };

/** Store whose reads block until released, counting reads and every write attempt. */
function blockingStore(): CredentialStore & { reads: number; writes: number; reading: Promise<void>; release(value: string | null): void } {
  const reading = Promise.withResolvers<void>(), gate = Promise.withResolvers<string | null>();
  const store = {
    reads: 0, writes: 0, reading: reading.promise,
    release: (value: string | null) => gate.resolve(value),
    async get() { store.reads++; reading.resolve(); return gate.promise; },
    async set() { store.writes++; },
    async delete() { store.writes++; return false; },
  };
  return store;
}

/** A stored value that records every property readiness reads from it; promise adoption's `then` probe is excluded. */
function probedValue(): { value: string; touched: string[] } {
  const touched: string[] = [];
  const value = new Proxy(new String(valid()), { get(target, key) {
    if (key !== "then") touched.push(String(key));
    const field = Reflect.get(target, key, target);
    return typeof field === "function" ? field.bind(target) : field;
  } }) as unknown as string;
  return { value, touched };
}

for (const route of ["codex", "grok"] as const) {
  test(`${route} readiness rejects promptly on abort and never uses the late value`, async () => {
    // Control: an unabandoned check does read the value.
    const control = probedValue();
    const answered = fakeCredentialStore();
    await checkAuthReadiness({ route, model: modelFor(route), store: { ...answered, get: async () => control.value } });
    expect(control.touched.length).toBeGreaterThan(0);

    const store = blockingStore();
    const controller = new AbortController();
    const pending = checkAuthReadiness({ route, model: modelFor(route), store }, { signal: controller.signal });
    await store.reading;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const late = probedValue();
    store.release(late.value);
    await Bun.sleep(5);
    expect(late.touched).toEqual([]);
    expect(store.writes).toBe(0);
  });

  test(`${route} readiness deadline rejects with a timeout and never writes`, async () => {
    await withTempDir(async dir => {
      const store = blockingStore();
      const host = await createHost(await options(dir, { route, model: modelFor(route), store }));
      const started = performance.now();
      await expect(host.auth!.checkReadiness({ deadlineMs: 25 })).rejects.toMatchObject({ name: "TimeoutError" });
      expect(performance.now() - started).toBeLessThan(2_000);
      store.release(valid());
      await Bun.sleep(5);
      expect(store.writes).toBe(0);
      await host.close();
    });
  });
}

test("readiness with an already-aborted signal never reads the store", async () => {
  const store = blockingStore();
  await expect(checkAuthReadiness({ route: "codex", model: "gpt-5.4", store }, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
  expect(store.reads).toBe(0);
});

test("readiness without bounds is unchanged and malformed bounds are rejected", async () => {
  const store = fakeCredentialStore();
  await store.set(codexSubscriptionIdentity(), valid());
  expect(await checkAuthReadiness({ route: "codex", model: "gpt-5.4", store })).toMatchObject({ status: "configured-unverified" });
  expect(await checkAuthReadiness({ route: "codex", model: "gpt-5.4", store }, { signal: new AbortController().signal, deadlineMs: 5_000 }))
    .toMatchObject({ status: "configured-unverified" });
  for (const bad of [{ signal: "nope" }, { deadlineMs: 0 }, { deadlineMs: 1.5 }, { deadlineMs: 86_400_001 }, { extra: true }, null]) {
    const failure = await checkAuthReadiness({ route: "codex", model: "gpt-5.4", store }, bad as never).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(HostError);
    expect((failure as HostError).code).toBe("invalid-input");
  }
});

for (const route of ["codex", "grok"] as const) {
  test(`${route} route runs report exact initial sends with no renewal`, async () => {
    await withTempDir(async dir => {
      const store = fakeCredentialStore(); await store.set(identityFor(route), valid());
      let inference = 0;
      const fetch = (async () => { inference++; return routeSse(route); }) as never;
      const host = await createHost(await options(dir, { route, model: modelFor(route), store, fetch }));
      const session = await host.createSession();
      const run = await session.submitWithRoute({ text: "count" });
      expect(run.outcome).toBe("completed");
      expect(run.usage.providerRequests).toEqual({ initialSends: inference, authRetrySends: 0, renewalRequests: 0 });
      expect(inference).toBe(1);
      await session.close(); await host.close();
    });
  });

  test(`${route} shared renewal is counted once, for the run that performed it`, async () => {
    await withTempDir(async dir => {
      const base = fakeCredentialStore();
      await base.set(identityFor(route), JSON.stringify({ accessToken: "stale", refreshToken: "shared-refresh", obtainedAt: 1, expiresAt: 1 }));
      const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), joined = Promise.withResolvers<void>();
      let refreshing = false, peerEntered = false;
      const tracked: CredentialStore = { ...base, async get(identity) { if (refreshing && peerEntered) joined.resolve(); return base.get(identity); } };
      const lifecycle = createHostCredentialLifecycle({ store: tracked });
      let renewals = 0, inference = 0;
      const fetch = (async (input: string | URL | Request) => {
        if (isToken(input)) {
          renewals++; refreshing = true; started.resolve(); await release.promise;
          return Response.json({ access_token: "fresh", refresh_token: "shared-refresh", expires_in: 3600 });
        }
        inference++;
        return routeSse(route);
      }) as never;
      const config = await options(dir, { route, model: modelFor(route), lifecycle, fetch });
      const host = await createHost(config);
      const peer = await createHost({ ...config, sessionDirectory: join(dir, "peer-sessions"),
        auth: { ...config.auth!, credentialWriteGuard: () => { peerEntered = true; } } });
      const first = await host.createSession(), second = await peer.createSession();
      const pendingOne = first.submitWithRoute({ text: "renewal one" });
      await started.promise;
      const pendingTwo = second.submitWithRoute({ text: "renewal two" });
      await joined.promise;
      release.resolve();
      const [one, two] = await Promise.all([pendingOne, pendingTwo]);
      expect(one.outcome).toBe("completed"); expect(two.outcome).toBe("completed");
      expect(one.usage.providerRequests).toEqual({ initialSends: 1, authRetrySends: 0, renewalRequests: 1 });
      expect(two.usage.providerRequests).toEqual({ initialSends: 1, authRetrySends: 0, renewalRequests: 0 });
      const total = [one, two].reduce((sum, run) => sum + run.usage.providerRequests!.renewalRequests, 0);
      expect(total).toBe(renewals);
      expect(renewals).toBe(1);
      expect(inference).toBe(2);
      await first.close(); await second.close(); await host.close(); await peer.close(); await lifecycle.close();
    });
  });
}

test("bounded transient retries count every physical inference send", async () => {
  await withTempDir(async dir => {
    const store = fakeCredentialStore(); await store.set(grokSubscriptionIdentity(), valid());
    let inference = 0;
    const fetch = (async () => { inference++; return new Response("busy", { status: 500 }); }) as never;
    const host = await createHost(await options(dir, { route: "grok", model: "grok-4.7", store, fetch }, { maxAttempts: 3 }));
    const session = await host.createSession();
    const run = await session.submitWithRoute({ text: "flaky" }, { clock: fastClock });
    expect(run.outcome).toBe("error");
    expect(inference).toBe(3);
    expect(run.usage.providerRequests).toEqual({ initialSends: 3, authRetrySends: 0, renewalRequests: 0 });
    await session.close(); await host.close();
  });
});

test("submit and compact count route models, including forwarding wrappers, and report null otherwise", async () => {
  await withTempDir(async dir => {
    const store = fakeCredentialStore(); await store.set(codexSubscriptionIdentity(), valid());
    let inference = 0;
    const fetch = (async () => { inference++; return codexSse(); }) as never;
    const host = await createHost(await options(dir, { route: "codex", model: "gpt-5.4", store, fetch }));
    const session = await host.createSession();
    const route = await host.auth!.createModel();
    const direct = await session.submit({ text: "direct" }, route);
    expect(direct.outcome).toBe("completed");
    expect(direct.usage.providerRequests).toEqual({ initialSends: 1, authRetrySends: 0, renewalRequests: 0 });
    const forwarding: Model = { provider: route.provider, id: route.id, stream: (request, call) => route.stream(request, call) };
    expect((await session.submit({ text: "forwarding" }, forwarding)).usage.providerRequests).toEqual({ initialSends: 1, authRetrySends: 0, renewalRequests: 0 });
    const dropping: Model = { provider: route.provider, id: route.id, stream: request => route.stream(request) };
    expect((await session.submit({ text: "dropping" }, dropping)).usage.providerRequests).toBeNull();
    expect((await session.submit({ text: "scripted" }, createScriptedModel({ text: "ok" }))).usage.providerRequests).toBeNull();
    expect(inference).toBe(3);
    for (let i = 0; i < 12; i++) await session.submit({ text: `retained ${i}` }, createScriptedModel({ text: "retained output" }));
    const scripted = await session.compact(createScriptedModel({ text: "Summary from a scripted model." }));
    expect(scripted.outcome).toBe("completed");
    expect(scripted.usage.providerRequests).toBeNull();
    const noop = await session.compact(route);
    expect(noop.outcome).toBe("noop");
    expect(noop.usage.providerRequests).toEqual({ initialSends: 0, authRetrySends: 0, renewalRequests: 0 });
    await session.close(); await host.close();
  });
});

/** Store that answers its first `answered` reads, then blocks every later read until released. */
function gatedStore(answered: number) {
  const blocked = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  const store = {
    reads: 0, writes: 0, blocked: blocked.promise, release: () => gate.resolve(),
    async get() { store.reads++; if (store.reads > answered) { blocked.resolve(); await gate.promise; } return valid(); },
    async set() { store.writes++; },
    async delete() { store.writes++; return false; },
  };
  return store;
}

/** Clock whose run-deadline sleep fires only when the test says so; backoff sleeps return at once. */
function deadlineClock() {
  const fire = Promise.withResolvers<void>();
  return { fire: () => fire.resolve(), clock: { now: () => Date.now(), sleep: (ms: number, signal?: AbortSignal) => ms < 60_000 ? Promise.resolve()
    : new Promise<void>((resolve, reject) => {
      void fire.promise.then(() => resolve());
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }) } };
}

type Stop = "cancel" | "signal" | "deadline";
const stops: Stop[] = ["cancel", "signal", "deadline"];

for (const route of ["codex", "grok"] as const) {
  for (const stop of stops) {
    test(`${route} ${stop} during a blocked admission read settles the route run`, async () => {
      await withTempDir(async dir => {
        const store = gatedStore(0);
        let requests = 0;
        const fetch = (async () => { requests++; return routeSse(route); }) as never;
        const host = await createHost(await options(dir, { route, model: modelFor(route), store, fetch }));
        const session = await host.createSession();
        const controller = new AbortController(), deadline = deadlineClock();
        const pending = session.submitWithRoute({ text: "blocked admission" }, { signal: controller.signal, clock: deadline.clock });
        await store.blocked;
        if (stop === "cancel") session.cancel();
        else if (stop === "signal") controller.abort();
        else deadline.fire();
        const run = await pending;
        expect(run.outcome).toBe(stop === "deadline" ? "limit_exceeded" : "cancelled");
        if (!("auth" in run)) throw new Error("expected auth detail");
        expect(run.auth).toMatchObject({ route, status: "store-unavailable" });
        expect(run.usage.providerRequests).toEqual({ initialSends: 0, authRetrySends: 0, renewalRequests: 0 });
        expect(requests).toBe(0);
        // The lease is released: the idle session closes, and the late read changes nothing.
        await session.close();
        store.release();
        await Bun.sleep(5);
        expect(store.writes).toBe(0);
        await host.close();
      });
    });
  }
}

const toolSse = () => new Response(encodeXaiSse(XAI_PARALLEL_TOOL_EVENTS), { headers: { "Content-Type": "text/event-stream" } });

test("an unblocked route run that exhausts its rounds reports max_turns", async () => {
  await withTempDir(async dir => {
    const store = gatedStore(Number.MAX_SAFE_INTEGER);
    const host = await createHost(await options(dir, { route: "grok", model: "grok-4.7", store, fetch: (async () => toolSse()) as never }, { maxTurns: 1 }));
    const session = await host.createSession();
    const run = await session.submitWithRoute({ text: "tools" });
    expect(run.outcome).toBe("max_turns");
    expect(store.reads).toBe(3);
    await session.close(); await host.close();
  });
});

for (const stop of stops) {
  test(`${stop} during the blocked settling read after max_turns settles the route run`, async () => {
    await withTempDir(async dir => {
      // Read 1 admits, read 2 is the adapter's credential, read 3 is the settling readiness read.
      const store = gatedStore(2);
      let requests = 0;
      const fetch = (async () => { requests++; return toolSse(); }) as never;
      const host = await createHost(await options(dir, { route: "grok", model: "grok-4.7", store, fetch }, { maxTurns: 1 }));
      const session = await host.createSession();
      const controller = new AbortController(), deadline = deadlineClock();
      const pending = session.submitWithRoute({ text: "tools" }, { signal: controller.signal, clock: deadline.clock });
      await store.blocked;
      if (stop === "cancel") session.cancel();
      else if (stop === "signal") controller.abort();
      else deadline.fire();
      const run = await pending;
      expect(run.outcome).toBe(stop === "deadline" ? "limit_exceeded" : "cancelled");
      if (!("auth" in run)) throw new Error("expected auth detail");
      // The run had not settled, so it reports the admission verdict, never "could not reach".
      expect(run.auth).toMatchObject({ route: "grok", status: "configured-unverified" });
      expect(run.usage.providerRequests).toEqual({ initialSends: requests, authRetrySends: 0, renewalRequests: 0 });
      expect(requests).toBe(1);
      await session.close();
      store.release();
      await host.close();
    });
  });
}

test("a caller-cancelled route run reports its admission verdict without another store read", async () => {
  await withTempDir(async dir => {
    const store = gatedStore(Number.MAX_SAFE_INTEGER);
    const started = Promise.withResolvers<void>();
    const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      started.resolve();
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    }) as never;
    const host = await createHost(await options(dir, { route: "codex", model: "gpt-5.4", store, fetch }));
    const session = await host.createSession();
    const controller = new AbortController();
    const pending = session.submitWithRoute({ text: "cancel mid-send" }, { signal: controller.signal });
    await started.promise;
    const readsBefore = store.reads;
    controller.abort();
    const run = await pending;
    expect(run.outcome).toBe("cancelled");
    if (!("auth" in run)) throw new Error("expected auth detail");
    expect(run.auth.status).toBe("configured-unverified");
    expect(store.reads).toBe(readsBefore);
    await session.close(); await host.close();
  });
});

test("a redirected codex refresh is one counted renewal request and never reaches the target", async () => {
  await withTempDir(async dir => {
    let tokenPosts = 0, redirected = 0, inference = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      if (new URL(request.url).pathname === "/elsewhere") { redirected++; return Response.json({ access_token: "fresh", expires_in: 3600 }); }
      tokenPosts++;
      return new Response(null, { status: 307, headers: { Location: "/elsewhere" } });
    } });
    try {
      const store = fakeCredentialStore();
      await store.set(codexSubscriptionIdentity(), JSON.stringify({ accessToken: "stale", refreshToken: "redirect-refresh", obtainedAt: 1, expiresAt: 1 }));
      const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        if (isToken(input)) return globalThis.fetch(new URL("/oauth/token", server.url), init);
        inference++;
        return codexSse();
      }) as never;
      const host = await createHost(await options(dir, { route: "codex", model: "gpt-5.4", store, fetch }));
      const session = await host.createSession();
      const progress: HostProgressEvent[] = [];
      const run = await session.submitWithRoute({ text: "renew" }, { clock: fastClock, onProgress: event => progress.push(event) });
      expect(run.outcome).toBe("error");
      expect(redirected).toBe(0);
      expect(inference).toBe(0);
      expect(tokenPosts).toBe(1);
      expect(progress.filter(event => event.type === "retry")).toHaveLength(0);
      expect(run.usage.providerRequests).toEqual({ initialSends: 0, authRetrySends: 0, renewalRequests: 1 });
      if (!("auth" in run)) throw new Error("expected auth detail");
      expect(run.auth.status).toBe("integration-unavailable");
      expect(run.auth.nextAction).toBe("The ChatGPT subscription answered with an HTTP redirect, which route requests never follow. Retry later; Schway never falls back to API-key billing.");
      // submit (and the CLI) show the fixed refresh message, never the transport text or token URL.
      const submitted = await session.submit({ text: "renew again" }, await host.auth!.createModel(), { clock: fastClock });
      if (submitted.outcome !== "error") throw new Error("expected error");
      expect(submitted.error.message).toBe("The ChatGPT subscription refresh endpoint answered with an HTTP redirect. Session renewal never follows redirects, so the renewal request was not resent. Retry later.");
      expect(tokenPosts).toBe(2);
      expect(redirected).toBe(0);
      await session.close(); await host.close();
    } finally { server.stop(true); }
  });
});

/** A response whose body stays open until the request is aborted, like a healthy stream mid-answer. */
function openStream(init?: RequestInit): Response {
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
  } });
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

// Codex reports a 5xx without a status, so the loop retries only Grok's; the retried variant uses Grok.
for (const [route, failFirst] of [["codex", false], ["grok", false], ["grok", true]] as const) {
  test(`a ${route} deadline mid-stream reports ${failFirst ? "the observed provider failure" : "the admission verdict"}`, async () => {
    await withTempDir(async dir => {
      const store = fakeCredentialStore(); await store.set(identityFor(route), valid());
      const streaming = Promise.withResolvers<void>();
      let requests = 0;
      const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        requests++;
        if (failFirst && requests === 1) return new Response("busy", { status: 503 });
        streaming.resolve();
        return openStream(init);
      }) as never;
      const host = await createHost(await options(dir, { route, model: modelFor(route), store, fetch }));
      const session = await host.createSession();
      const deadline = deadlineClock();
      const pending = session.submitWithRoute({ text: "long answer" }, { clock: deadline.clock });
      await streaming.promise;
      deadline.fire();
      const run = await pending;
      expect(run.outcome).toBe("limit_exceeded");
      if (!("auth" in run)) throw new Error("expected auth detail");
      // A deadline alone is not evidence the route is unreachable; a retried 503 still is.
      expect(run.auth.status).toBe(failFirst ? "integration-unavailable" : "configured-unverified");
      expect(run.usage.providerRequests).toEqual({ initialSends: requests, authRetrySends: 0, renewalRequests: 0 });
      await session.close(); await host.close();
    });
  });
}

test("a stream that aborts on its own leaves the run signal live, so the settling read runs", async () => {
  await withTempDir(async dir => {
    const store = gatedStore(Number.MAX_SAFE_INTEGER);
    const fetch = (async () => {
      // The injected transport aborts by itself; the caller never cancelled the run.
      const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new DOMException("Aborted", "AbortError")); } });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    }) as never;
    const host = await createHost(await options(dir, { route: "codex", model: "gpt-5.4", store, fetch }));
    const session = await host.createSession();
    const run = await session.submitWithRoute({ text: "self abort" });
    expect(run.outcome).toBe("cancelled");
    if (!("auth" in run)) throw new Error("expected auth detail");
    expect(run.auth.status).toBe("configured-unverified");
    // Admission, the adapter's credential, then the settling read.
    expect(store.reads).toBe(3);
    await session.close(); await host.close();
  });
});
