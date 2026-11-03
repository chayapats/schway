import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { containsNoSecrets, createHost, createHostCredentialLifecycle, hostCapabilities, HostError, listRouteModels, renewAuthRoute,
  type HostAuthFetch, type HostAuthSelection, type HostCredentialLifecycle, type HostOptions, type HostRouteRenewal } from "schway/host";
import { codexSubscriptionIdentity, credentialLockError, grokSubscriptionIdentity, type CredentialStore } from "../src/auth/store.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { withTempDir } from "./helpers.ts";
import { encodeXaiSse } from "./fixtures/xai.ts";

type Route = "codex" | "grok";
type Kind = "store" | "lifecycle";
const ROUTES = ["codex", "grok"] as const;
const KINDS = ["store", "lifecycle"] as const;
const MODEL: Record<Route, string> = { codex: "gpt-6-luna", grok: "grok-4.7" };
/** An exact pin each listing below supports: Codex lists none/low/high, xAI lists low/high. */
const PIN = { codex: { level: "high", sent: "high" }, grok: { level: "low", sent: "low" } } as const;
const SENTINELS = ["expired-access-sentinel", "stored-refresh-sentinel", "renewed-access-sentinel", "renewed-refresh-sentinel", "fresh-access-sentinel", "billing-bait", "guard-secret-sentinel"];
const BAIT = { OPENAI_API_KEY: "billing-bait", XAI_API_KEY: "billing-bait" };
const FENCE_REFUSED = "The embedding application's credential fence refused a credential write. No credential was changed. Retry the turn after the fence allows writes.";
const LOCK_REASON = "Schway cannot write its lock file at ~/.schway/credential-store.lock. Make that location writable for this user, then retry.";
const INTERRUPTED = "The renewal stopped before the OS secure store returned the credential. Retry the renewal; if the store keeps waiting, unlock or allow access to your OS credential store.";

const identityFor = (route: Route) => route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity();
/** Expired access with a refresh token: the state a pinned host starts in after token expiry. */
const EXPIRED = JSON.stringify({ accessToken: "expired-access-sentinel", refreshToken: "stored-refresh-sentinel", obtainedAt: 1, expiresAt: 1 });
const fresh = () => JSON.stringify({ accessToken: "fresh-access-sentinel", refreshToken: "stored-refresh-sentinel", obtainedAt: Date.now(), expiresAt: Date.now() + 3_600_000 });
const renewedTokens = () => Response.json({ access_token: "renewed-access-sentinel", refresh_token: "renewed-refresh-sentinel", expires_in: 3600 });
const isToken = (url: string) => url.includes("auth.x.ai") || url.includes("/oauth/token");

async function options(dir: string, auth: HostOptions["auth"]): Promise<HostOptions> {
  const workspaceRoot = join(dir, "work"), homeDirectory = join(dir, "home");
  await mkdir(workspaceRoot, { recursive: true }); await mkdir(homeDirectory, { recursive: true });
  return { workspaceRoot, homeDirectory, sessionDirectory: join(dir, `sessions-${crypto.randomUUID()}`),
    context: { policy: "strict", systemPrompt: "Trusted host operator", sections: [], sources: [] },
    tools: { policy: "exact", hostedLookup: "off", definitions: [] },
    limits: { maxTurns: 3, maxConcurrentTools: 2, contextWindow: 32768, maxInputChars: 4096 }, auth };
}

function catalog(route: Route): Response {
  return route === "codex"
    ? Response.json({ models: [{ slug: MODEL.codex, visibility: "list", supported_reasoning_levels: [{ effort: "none" }, { effort: "low" }, { effort: "high" }], default_reasoning_level: "low" }] })
    : Response.json({ data: [{ id: MODEL.grok, supported_reasoning_levels: ["low", "high"], default_reasoning_effort: "high" }] });
}

function answer(route: Route): Response {
  if (route === "codex") {
    const events = [
      { type: "response.created", response: { id: "r", status: "in_progress" } },
      { type: "response.output_text.delta", output_index: 0, delta: "pinned answer" },
      { type: "response.output_item.done", output_index: 0, item: { type: "message" } },
      { type: "response.completed", response: { id: "r", status: "completed" } },
    ];
    return new Response(`${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  }
  const events = [
    { type: "response.created", response: { id: "resp", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { id: "msg", type: "message", role: "assistant", status: "in_progress", content: [] } },
    { type: "response.output_text.delta", output_index: 0, delta: "pinned answer" },
    { type: "response.output_item.done", output_index: 0, item: { id: "msg", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "pinned answer" }] } },
    { type: "response.completed", response: { id: "resp", status: "completed", usage: { input_tokens: 3, output_tokens: 2 } } },
  ];
  return new Response(encodeXaiSse(events), { headers: { "Content-Type": "text/event-stream" } });
}

/** Fake transport counting token, catalog and inference requests; `hold()` parks token requests until released, ignoring abort. */
function transport(route: Route, tokenResponse: () => Response = renewedTokens) {
  const counts = { token: 0, catalog: 0, inference: 0, catalogAuth: [] as string[], efforts: [] as Array<string | null> };
  let gate: { started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
  const fetch: HostAuthFetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (isToken(url)) {
      counts.token++;
      // Like a transport that ignores cancellation: the response still arrives after the caller stopped.
      if (gate) { gate.started.resolve(); await gate.release.promise; }
      return tokenResponse();
    }
    if (init?.method === "GET") { counts.catalog++; counts.catalogAuth.push(new Headers(init.headers).get("Authorization") ?? ""); return catalog(route); }
    counts.inference++;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as { reasoning?: { effort?: string } } : {};
    counts.efforts.push(body.reasoning?.effort ?? null);
    return answer(route);
  };
  return { fetch, counts, hold() {
    gate = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    const current = gate;
    return { started: current.started.promise, release: () => current.release.resolve() };
  } };
}

type Probe = CredentialStore & { reads: number; writes: number; value(): Promise<string | null> };
/** In-memory store counting reads and write attempts, seeded with one route credential. */
async function seeded(route: Route, raw: string | null): Promise<Probe> {
  const base = fakeCredentialStore();
  if (raw !== null) await base.set(identityFor(route), raw);
  const probe: Probe = {
    reads: 0, writes: 0,
    async get(identity) { probe.reads++; return base.get(identity); },
    async set(identity, value) { probe.writes++; await base.set(identity, value); },
    async delete(identity) { probe.writes++; return base.delete(identity); },
    value: () => base.get(identityFor(route)),
  };
  return probe;
}

/** A model-free selection over `store`, directly or through a new shared lifecycle. */
function selectionFor(kind: Kind, route: Route, store: CredentialStore, extra: Partial<HostAuthSelection> = {}): { selection: Omit<HostAuthSelection, "model">; lifecycle?: HostCredentialLifecycle } {
  if (kind === "lifecycle") {
    const lifecycle = createHostCredentialLifecycle({ store });
    return { selection: { route, lifecycle, env: BAIT, ...extra }, lifecycle };
  }
  return { selection: { route, store, env: BAIT, ...extra } };
}

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(1);
  }
}

function expectSafe(result: HostRouteRenewal, route: Route): void {
  expect(result.auth.route).toBe(route);
  expect(result.auth.credential).toEqual({ account: identityFor(route).account, label: identityFor(route).label });
  expect(result.auth.observedInference).toBe("not-checked");
  // Renewal belongs to the route credential, never to a model.
  expect("model" in result.auth).toBe(false);
  expect(containsNoSecrets(result, SENTINELS)).toBe(true);
}

test("capabilities advertise the route-renewal contract", () => {
  expect(hostCapabilities().routeRenewalContract).toBe("schway.host.route-renewal/v1");
  expect(hostCapabilities().releaseContract).toBe("schway.host.release/v2");
});

for (const route of ROUTES) for (const kind of KINDS) {
  test(`${route} ${kind}: a pinned host that starts after token expiry renews without inference, then lists and runs pinned`, async () => {
    await withTempDir(async dir => {
      const store = await seeded(route, EXPIRED);
      const wire = transport(route);
      const { selection, lifecycle } = selectionFor(kind, route, store, { fetch: wire.fetch });
      const host = await createHost(await options(dir, { ...selection, model: MODEL[route] }));
      // The stuck state from the report: listing refuses renewal, so no exact pin can be built.
      const stuck = await listRouteModels(selection);
      // Its guidance names the renewal that sends no inference, not an unpinned route-bound request.
      expect(stuck).toMatchObject({ status: "needs-login", route,
        nextAction: "Renew the route credential, which sends no inference, or sign in again. Then retry listing models. Catalog requests never renew or write credentials." });
      expect(wire.counts).toMatchObject({ token: 0, catalog: 0, inference: 0 });

      const renewal = await host.auth!.renew();
      expect(renewal).toMatchObject({ outcome: "renewed", renewalRequests: 1, auth: { status: "configured-unverified" } });
      expectSafe(renewal, route);
      expect(wire.counts).toMatchObject({ token: 1, catalog: 0, inference: 0 });
      expect(await store.value()).toContain("renewed-access-sentinel");

      const listing = await listRouteModels(selection);
      if (listing.status !== "listed") throw new Error(`expected a listing, got ${listing.status}`);
      expect(wire.counts.catalogAuth).toEqual(["Bearer renewed-access-sentinel"]);
      const choice = listing.models.find(model => model.id === MODEL[route])!;
      const model = await host.auth!.createModel({ catalogModel: choice, effort: { level: PIN[route].level, mode: "exact" } });
      const session = await host.createSession();
      const run = await session.submit({ text: "pinned" }, model);
      expect(run.outcome).toBe("completed");
      expect(run.usage.providerRequests).toEqual({ initialSends: 1, authRetrySends: 0, renewalRequests: 0 });
      expect(wire.counts).toMatchObject({ token: 1, catalog: 1, inference: 1 });
      expect(wire.counts.efforts).toEqual([PIN[route].sent]);
      await session.close(); await host.close(); await lifecycle?.close();
    });
  });

  test(`${route} ${kind}: renewAuthRoute renews before any runtime exists`, async () => {
    await withTempDir(async dir => {
      const store = await seeded(route, EXPIRED);
      const wire = transport(route);
      const { selection, lifecycle } = selectionFor(kind, route, store, { fetch: wire.fetch });
      const renewal = await renewAuthRoute(selection);
      expect(renewal).toMatchObject({ outcome: "renewed", renewalRequests: 1, auth: { status: "configured-unverified" } });
      expectSafe(renewal, route);
      expect(wire.counts).toMatchObject({ token: 1, catalog: 0, inference: 0 });
      const listing = await listRouteModels(selection);
      if (listing.status !== "listed") throw new Error(`expected a listing, got ${listing.status}`);
      const host = await createHost(await options(dir, { ...selection, model: MODEL[route] }));
      const session = await host.createSession();
      const choice = listing.models.find(model => model.id === MODEL[route])!;
      const run = await session.submit({ text: "pinned" }, await host.auth!.createModel({ catalogModel: choice, effort: { level: PIN[route].level, mode: "exact" } }));
      expect(run.outcome).toBe("completed");
      expect(wire.counts).toMatchObject({ token: 1, inference: 1 });
      await session.close(); await host.close(); await lifecycle?.close();
    });
  });

  test(`${route} ${kind}: a fresh token reports fresh and sends nothing`, async () => {
    await withTempDir(async dir => {
      const store = await seeded(route, fresh());
      const wire = transport(route);
      let guards = 0;
      const { selection, lifecycle } = selectionFor(kind, route, store, { fetch: wire.fetch, credentialWriteGuard: () => { guards++; } });
      const host = await createHost(await options(dir, { ...selection, model: MODEL[route] }));
      for (const renewal of [await host.auth!.renew(), await renewAuthRoute(selection)]) {
        expect(renewal).toMatchObject({ outcome: "fresh", renewalRequests: 0, auth: { status: "configured-unverified" } });
        expectSafe(renewal, route);
      }
      expect(wire.counts).toMatchObject({ token: 0, catalog: 0, inference: 0 });
      expect(store.writes).toBe(0);
      expect(guards).toBe(0);
      await host.close(); await lifecycle?.close();
    });
  });

  test(`${route} ${kind}: a refusing write guard fails before any token request`, async () => {
    await withTempDir(async dir => {
      const store = await seeded(route, EXPIRED);
      const wire = transport(route);
      let guards = 0;
      const { selection, lifecycle } = selectionFor(kind, route, store, { fetch: wire.fetch,
        credentialWriteGuard: () => { guards++; throw new Error("guard-secret-sentinel"); } });
      const host = await createHost(await options(dir, { ...selection, model: MODEL[route] }));
      for (const renewal of [await host.auth!.renew(), await renewAuthRoute(selection)]) {
        expect(renewal).toMatchObject({ outcome: "failed", renewalRequests: 0, auth: { status: "store-unavailable", nextAction: FENCE_REFUSED } });
        expectSafe(renewal, route);
      }
      expect(guards).toBe(2);
      expect(wire.counts).toMatchObject({ token: 0, catalog: 0, inference: 0 });
      expect(store.writes).toBe(0);
      await host.close(); await lifecycle?.close();
    });
  });

  test(`${route} ${kind}: a credential-lock refusal reports the lock's next action and leaves the route usable`, async () => {
    await withTempDir(async dir => {
      const base = await seeded(route, EXPIRED);
      const refusal = credentialLockError("save", LOCK_REASON);
      let locked = true;
      // Like the native store, cleanup under the same refused lock fails too.
      const store: CredentialStore = { get: identity => base.get(identity),
        set: async (identity, value) => { if (locked) throw refusal; await base.set(identity, value); },
        delete: async identity => base.delete(identity),
        compareAndDelete: async () => { if (locked) throw credentialLockError("delete", "Lock held."); return false; } };
      const wire = transport(route);
      const { selection, lifecycle } = selectionFor(kind, route, store, { fetch: wire.fetch });
      const host = await createHost(await options(dir, { ...selection, model: MODEL[route] }));
      const first = await host.auth!.renew();
      expect(first).toMatchObject({ outcome: "failed", renewalRequests: 1, auth: { status: "store-unavailable", nextAction: refusal.message } });
      expectSafe(first, route);
      expect(await base.value()).toBe(EXPIRED);
      // Nothing was written, so nothing is quarantined: once the lock is fixed, renewal succeeds.
      locked = false;
      const second = await host.auth!.renew();
      expect(second).toMatchObject({ outcome: "renewed", renewalRequests: 1 });
      expect(await listRouteModels(selection)).toMatchObject({ status: "listed" });
      expect(wire.counts).toMatchObject({ token: 2, inference: 0 });
      await host.close(); await lifecycle?.close();
    });
  });

  test(`${route} ${kind}: an uncertain cleanup never reports that nothing changed`, async () => {
    await withTempDir(async dir => {
      const base = await seeded(route, EXPIRED);
      // The write lands, the fence then refuses, and cleanup fails under a refused lock.
      const store: CredentialStore = { ...base, get: identity => base.get(identity), set: (identity, value) => base.set(identity, value),
        compareAndDelete: async () => { throw credentialLockError("delete", "Lock held."); } };
      const wire = transport(route);
      const credentialWriteGuard = async () => { if ((await base.value())?.includes("renewed-access-sentinel")) throw new Error("guard-secret-sentinel"); };
      const { selection, lifecycle } = selectionFor(kind, route, store, { fetch: wire.fetch, credentialWriteGuard });
      const host = await createHost(await options(dir, { ...selection, model: MODEL[route] }));
      const renewal = await host.auth!.renew();
      expect(renewal).toMatchObject({ outcome: "failed", renewalRequests: 1, auth: { status: "store-unavailable" } });
      expect(renewal.auth.nextAction).not.toContain("No credential was changed");
      expect(renewal.auth.nextAction).toMatch(/may have landed|verify the OS credential store/);
      expectSafe(renewal, route);
      expect(wire.counts.inference).toBe(0);
      await host.close(); await lifecycle?.close();
    });
  });

  test(`${route} ${kind}: missing logins and refused grants keep the route classification`, async () => {
    const cases = [
      { raw: null, response: renewedTokens, expected: { outcome: "failed", renewalRequests: 0, auth: { status: "needs-login" } } },
      { raw: JSON.stringify({ accessToken: "expired-access-sentinel", obtainedAt: 1, expiresAt: 1 }), response: renewedTokens,
        expected: { outcome: "failed", renewalRequests: 0, auth: { status: "needs-login" } } },
      { raw: "not-json-sentinel", response: renewedTokens, expected: { outcome: "failed", renewalRequests: 0, auth: { status: "invalid-store" } } },
      { raw: EXPIRED, response: () => Response.json({ error: "invalid_grant" }, { status: 400 }), expected: { outcome: "failed", renewalRequests: 1, auth: { status: "rejected" } } },
      { raw: EXPIRED, response: () => new Response("upstream-body-sentinel", { status: 503 }), expected: { outcome: "failed", renewalRequests: 1, auth: { status: "integration-unavailable" } } },
    ] as const;
    for (const entry of cases) {
      const store = await seeded(route, entry.raw);
      const wire = transport(route, entry.response);
      const { selection, lifecycle } = selectionFor(kind, route, store, { fetch: wire.fetch });
      const renewal = await renewAuthRoute(selection);
      expect(renewal).toMatchObject(entry.expected);
      expectSafe(renewal, route);
      expect(containsNoSecrets(renewal, ["not-json-sentinel", "upstream-body-sentinel", "invalid_grant"])).toBe(true);
      expect(wire.counts.token).toBe(entry.expected.renewalRequests);
      expect(wire.counts.inference).toBe(0);
      expect(store.writes).toBe(0);
      await lifecycle?.close();
    }
  });

  test(`${route} ${kind}: a redirected refresh is one counted request that never reaches the target`, async () => {
    let tokenPosts = 0, redirected = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      if (new URL(request.url).pathname === "/elsewhere") { redirected++; return renewedTokens(); }
      tokenPosts++;
      return new Response(null, { status: 307, headers: { Location: "/elsewhere" } });
    } });
    try {
      const store = await seeded(route, EXPIRED);
      let inference = 0;
      const fetch: HostAuthFetch = async (input, init) => {
        if (isToken(String(input))) return globalThis.fetch(new URL(route === "codex" ? "/oauth/token" : "/oauth2/token", server.url), init);
        inference++;
        return answer(route);
      };
      const { selection, lifecycle } = selectionFor(kind, route, store, { fetch });
      const renewal = await renewAuthRoute(selection);
      expect(renewal).toMatchObject({ outcome: "failed", renewalRequests: 1, auth: { status: "integration-unavailable" } });
      expect(renewal.auth.nextAction).toContain("answered with an HTTP redirect");
      expect(tokenPosts).toBe(1); expect(redirected).toBe(0); expect(inference).toBe(0);
      expect(store.writes).toBe(0);
      await lifecycle?.close();
    } finally { server.stop(true); }
  });

  for (const stop of ["abort", "deadline"] as const) test(`${route} ${kind}: ${stop} during the token request settles promptly and never stores the late response`, async () => {
    await withTempDir(async dir => {
      const store = await seeded(route, EXPIRED);
      const wire = transport(route);
      const { selection, lifecycle } = selectionFor(kind, route, store, { fetch: wire.fetch });
      const host = await createHost(await options(dir, { ...selection, model: MODEL[route] }));
      const held = wire.hold();
      const controller = new AbortController();
      const pending = host.auth!.renew(stop === "abort" ? { signal: controller.signal } : { deadlineMs: 50 });
      await held.started;
      const stopped = performance.now();
      if (stop === "abort") controller.abort();
      const renewal = await pending;
      expect(performance.now() - stopped).toBeLessThan(2_000);
      // The request left, so it is counted; the credential verdict is the one read before the stop.
      expect(renewal).toMatchObject({ outcome: stop === "abort" ? "cancelled" : "limit_exceeded", renewalRequests: 1, auth: { status: "configured-unverified" } });
      expectSafe(renewal, route);
      held.release();
      await Bun.sleep(20);
      expect(store.writes).toBe(0);
      expect(await store.value()).toBe(EXPIRED);
      // The abandoned renewal is gone: the next one starts its own request.
      const next = await host.auth!.renew();
      expect(next).toMatchObject({ outcome: "renewed", renewalRequests: 1 });
      expect(wire.counts).toMatchObject({ token: 2, inference: 0 });
      await host.close(); await lifecycle?.close();
    });
  });

  for (const stop of ["abort", "deadline", "pre-aborted"] as const) test(`${route} ${kind}: ${stop} before the store answers reports no verdict and sends nothing`, async () => {
    const reading = Promise.withResolvers<void>(), gate = Promise.withResolvers<string | null>();
    const store = { reads: 0, writes: 0,
      async get() { store.reads++; reading.resolve(); return gate.promise; },
      async set() { store.writes++; }, async delete() { store.writes++; return false; } };
    const wire = transport(route);
    const { selection, lifecycle } = selectionFor(kind, route, store, { fetch: wire.fetch });
    const controller = new AbortController();
    if (stop === "pre-aborted") controller.abort();
    const pending = renewAuthRoute(selection, stop === "deadline" ? { deadlineMs: 50 } : { signal: controller.signal });
    if (stop !== "pre-aborted") { await reading.promise; if (stop === "abort") controller.abort(); }
    const renewal = await pending;
    expect(renewal).toEqual({ outcome: stop === "deadline" ? "limit_exceeded" : "cancelled", renewalRequests: 0,
      auth: { route, credential: { account: identityFor(route).account, label: identityFor(route).label }, status: "store-unavailable", nextAction: INTERRUPTED, observedInference: "not-checked" } });
    gate.resolve(EXPIRED);
    await Bun.sleep(20);
    expect(store.reads).toBe(stop === "pre-aborted" ? 0 : 1);
    expect(store.writes).toBe(0);
    expect(wire.counts.token).toBe(0);
    await lifecycle?.close();
  });
}

for (const route of ROUTES) {
  test(`${route} renew joins a run's in-flight renewal on one lifecycle; the run alone counts it`, async () => {
    await withTempDir(async dir => {
      const store = await seeded(route, EXPIRED);
      const wire = transport(route);
      const lifecycle = createHostCredentialLifecycle({ store });
      const host = await createHost(await options(dir, { route, model: MODEL[route], lifecycle, fetch: wire.fetch }));
      const session = await host.createSession();
      const held = wire.hold();
      const running = session.submitWithRoute({ text: "renew in the run" });
      await held.started;
      const reads = store.reads;
      let settled = false;
      const renewing = host.auth!.renew().finally(() => { settled = true; });
      // Readiness and the refresher each read once, then the call waits on the shared request.
      await until(() => store.reads >= reads + 2, "renew to join");
      await Bun.sleep(5);
      expect(settled).toBe(false);
      expect(wire.counts.token).toBe(1);
      held.release();
      const [run, renewal] = await Promise.all([running, renewing]);
      expect(run.outcome).toBe("completed");
      expect(run.usage.providerRequests).toEqual({ initialSends: 1, authRetrySends: 0, renewalRequests: 1 });
      expect(renewal).toMatchObject({ outcome: "renewed", renewalRequests: 0, auth: { status: "configured-unverified" } });
      expect(run.usage.providerRequests!.renewalRequests + renewal.renewalRequests).toBe(wire.counts.token);
      expect(wire.counts).toMatchObject({ token: 1, inference: 1 });
      await session.close(); await host.close(); await lifecycle.close();
    });
  });

  test(`${route} a run joins renewAuthRoute's in-flight renewal on one lifecycle; renewal alone counts it`, async () => {
    await withTempDir(async dir => {
      const store = await seeded(route, EXPIRED);
      const wire = transport(route);
      const lifecycle = createHostCredentialLifecycle({ store });
      const host = await createHost(await options(dir, { route, model: MODEL[route], lifecycle, fetch: wire.fetch }));
      const session = await host.createSession();
      const held = wire.hold();
      const renewing = renewAuthRoute({ route, lifecycle, fetch: wire.fetch });
      await held.started;
      const reads = store.reads;
      let settled = false;
      const running = session.submitWithRoute({ text: "join the renewal" }).finally(() => { settled = true; });
      await until(() => store.reads >= reads + 2, "the run to join");
      await Bun.sleep(5);
      expect(settled).toBe(false);
      expect(wire.counts.token).toBe(1);
      held.release();
      const [renewal, run] = await Promise.all([renewing, running]);
      expect(renewal).toMatchObject({ outcome: "renewed", renewalRequests: 1 });
      expect(run.outcome).toBe("completed");
      expect(run.usage.providerRequests).toEqual({ initialSends: 1, authRetrySends: 0, renewalRequests: 0 });
      expect(wire.counts).toMatchObject({ token: 1, inference: 1 });
      await session.close(); await host.close(); await lifecycle.close();
    });
  });

  test(`${route} a cancelled renewal never cancels the run it joined`, async () => {
    await withTempDir(async dir => {
      const store = await seeded(route, EXPIRED);
      const wire = transport(route);
      const lifecycle = createHostCredentialLifecycle({ store });
      const host = await createHost(await options(dir, { route, model: MODEL[route], lifecycle, fetch: wire.fetch }));
      const session = await host.createSession();
      const held = wire.hold();
      const running = session.submitWithRoute({ text: "keep renewing" });
      await held.started;
      const reads = store.reads;
      const controller = new AbortController();
      const renewing = host.auth!.renew({ signal: controller.signal });
      await until(() => store.reads >= reads + 2, "renew to join");
      controller.abort();
      expect(await renewing).toMatchObject({ outcome: "cancelled", renewalRequests: 0 });
      held.release();
      const run = await running;
      expect(run.outcome).toBe("completed");
      expect(await store.value()).toContain("renewed-access-sentinel");
      expect(wire.counts.token).toBe(1);
      await session.close(); await host.close(); await lifecycle.close();
    });
  });

  test(`${route} a logout racing renewal's store read reports the fence, not keychain guidance`, async () => {
    const store = await seeded(route, EXPIRED);
    const wire = transport(route);
    const lifecycle = createHostCredentialLifecycle({ store });
    // The read is parked behind earlier writes when the logout rotates the route, so the old route store refuses it.
    const pending = renewAuthRoute({ route, lifecycle, fetch: wire.fetch });
    const loggedOut = lifecycle.logout(route);
    const renewal = await pending;
    await loggedOut;
    expect(renewal).toMatchObject({ outcome: "failed", renewalRequests: 0, auth: { status: "store-unavailable", nextAction: FENCE_REFUSED } });
    expectSafe(renewal, route);
    expect(wire.counts.token).toBe(0);
    await lifecycle.close();
  });

  test(`${route} logout during renewal fences it, and renew never mints catalog evidence`, async () => {
    await withTempDir(async dir => {
      const store = await seeded(route, fresh());
      const wire = transport(route);
      const lifecycle = createHostCredentialLifecycle({ store });
      const selection = { route, lifecycle, fetch: wire.fetch } as const;
      const host = await createHost(await options(dir, { ...selection, model: MODEL[route] }));
      const listing = await listRouteModels(selection);
      if (listing.status !== "listed") throw new Error("expected a listing");
      const choice = listing.models.find(model => model.id === MODEL[route])!;
      // An expired sign-in replaces the login, then a logout lands while its renewal is in flight.
      await store.set(identityFor(route), EXPIRED);
      const held = wire.hold();
      const renewing = host.auth!.renew();
      await held.started;
      await lifecycle.logout(route);
      held.release();
      const fenced = await renewing;
      expect(fenced).toMatchObject({ outcome: "failed", renewalRequests: 1, auth: { status: "store-unavailable" } });
      expect(await store.value()).toBeNull();
      // A replacement sign-in, renewed: the choice listed before logout is still not evidence.
      await store.set(identityFor(route), EXPIRED);
      expect(await host.auth!.renew()).toMatchObject({ outcome: "renewed", renewalRequests: 1 });
      await expect(host.auth!.createModel({ catalogModel: choice, effort: { level: PIN[route].level, mode: "exact" } })).rejects.toMatchObject({ code: "invalid-input" });
      expect(wire.counts.inference).toBe(0);
      await host.close(); await lifecycle.close();
    });
  });
}

test("renewal rejects malformed bounds and selections", async () => {
  const store = await seeded("codex", fresh());
  for (const bad of [{ signal: "nope" }, { deadlineMs: 0 }, { deadlineMs: 1.5 }, { deadlineMs: 86_400_001 }, { extra: true }, null]) {
    const failure = await renewAuthRoute({ route: "codex", store }, bad as never).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(HostError);
    expect((failure as HostError).code).toBe("invalid-input");
  }
  for (const input of [{ route: "codex", model: "gpt-5.4", store }, { route: "codex", apiKey: "secret-sentinel" }, { route: "api-key" }, null]) {
    await expect(renewAuthRoute(input as never)).rejects.toThrow();
  }
  expect(store.reads).toBe(0);
});
