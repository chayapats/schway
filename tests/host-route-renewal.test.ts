import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { beginDeviceSignIn, containsNoSecrets, createHost, createHostCredentialLifecycle, hostCapabilities, HostError, listRouteModels, renewAuthRoute,
  type HostAuthFetch, type HostAuthSelection, type HostCredentialLifecycle, type HostOptions, type HostRouteRenewal } from "schway/host";
import { codexSubscriptionIdentity, createNativeCredentialStore, credentialLockError, grokSubscriptionIdentity, type CredentialStore } from "../src/auth/store.ts";
import { withCredentialStoreLock } from "../src/auth/store-lock.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { withTempDir } from "./helpers.ts";
import { encodeXaiSse } from "./fixtures/xai.ts";
import { clearSubscriptionTokens, createSubscriptionTokenRefresher as createCodexRefresher, refreshSubscriptionTokens as refreshCodexTokens } from "../src/model/providers/codex-subscription.ts";
import { createSubscriptionTokenRefresher as createGrokRefresher, deleteSubscriptionTokens } from "../src/model/providers/grok-subscription.ts";
import { loadProviderModel } from "../src/model/loader.ts";
import { acquireCredentialLifecycle, holdRenewal } from "../src/host/credential-lifecycle.ts";
import { manualClock } from "./helpers/manual-clock.ts";
import { sampleRequest } from "./fixtures/openai.ts";
import { collect } from "./helpers/scripted-model.ts";

type Route = "codex" | "grok";
type Kind = "store" | "lifecycle";
const ROUTES = ["codex", "grok"] as const;
const KINDS = ["store", "lifecycle"] as const;
const MODEL: Record<Route, string> = { codex: "gpt-6-luna", grok: "grok-4.7" };
/** An exact pin each listing below supports: Codex lists none/low/high, xAI lists low/high. */
const PIN = { codex: { level: "high", sent: "high" }, grok: { level: "low", sent: "low" } } as const;
const SENTINELS = ["expired-access-sentinel", "stored-refresh-sentinel", "renewed-access-sentinel", "renewed-refresh-sentinel", "rotated-refresh-sentinel", "fresh-access-sentinel", "billing-bait", "guard-secret-sentinel"];
const BAIT = { OPENAI_API_KEY: "billing-bait", XAI_API_KEY: "billing-bait" };
// A fence that refuses the write after the provider rotated the token leaves the stored one invalid.
const FENCE_REFUSED = "The embedding application's credential fence refused the renewal. No credential was changed. Retry the renewal after the fence allows writes; if that renewal is rejected, sign in again.";
const LOCK_REASON = "Schway cannot write its lock file at ~/.schway/credential-store.lock. Make that location writable for this user, then retry.";
const UNREACHABLE: Record<Route, string> = {
  codex: "Could not reach the ChatGPT subscription to renew its credential. Retry the renewal later; Schway never falls back to API-key billing.",
  grok: "Could not reach the Grok subscription to renew its credential. Retry the renewal later; Schway never falls back to API-key billing.",
};
const RATE_LIMITED: Record<Route, string> = {
  codex: "The ChatGPT subscription is rate-limited (HTTP 429). Wait, then retry the renewal; renewal never retries on its own.",
  grok: "The Grok subscription is rate-limited. Wait, then retry the renewal; renewal never retries on its own.",
};
const INTERRUPTED = "The renewal stopped before the OS secure store returned the credential. Retry the renewal; if the store keeps waiting, unlock or allow access to your OS credential store.";

const identityFor = (route: Route) => route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity();
/** Expired access with a refresh token: the state a pinned host starts in after token expiry. */
const EXPIRED = JSON.stringify({ accessToken: "expired-access-sentinel", refreshToken: "stored-refresh-sentinel", obtainedAt: 1, expiresAt: 1 });
const fresh = () => JSON.stringify({ accessToken: "fresh-access-sentinel", refreshToken: "stored-refresh-sentinel", obtainedAt: Date.now(), expiresAt: Date.now() + 3_600_000 });
const renewedTokens = () => Response.json({ access_token: "renewed-access-sentinel", refresh_token: "renewed-refresh-sentinel", expires_in: 3600 });
/** A token endpoint that rotates the refresh token on every use and rejects reuse, as real providers do. */
function rotatingTokens(): (form: URLSearchParams) => Response {
  let current = "stored-refresh-sentinel", issued = 0;
  return form => {
    if (form.get("refresh_token") !== current) return Response.json({ error: "invalid_grant" }, { status: 400 });
    current = `rotated-refresh-sentinel-${++issued}`;
    return Response.json({ access_token: `renewed-access-sentinel-${issued}`, refresh_token: current, expires_in: 3600 });
  };
}
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
function transport(route: Route, tokenResponse: (form: URLSearchParams) => Response = renewedTokens) {
  const counts = { token: 0, catalog: 0, inference: 0, catalogAuth: [] as string[], efforts: [] as Array<string | null> };
  let gate: { started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
  const fetch: HostAuthFetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (isToken(url)) {
      counts.token++;
      // Like a transport that ignores cancellation: the response still arrives after the caller stopped.
      if (gate) { gate.started.resolve(); await gate.release.promise; }
      return tokenResponse(new URLSearchParams(typeof init?.body === "string" ? init.body : ""));
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
  // A renewal has no turn and never retries on its own.
  expect(result.auth.nextAction).not.toMatch(/\bturn\b|owns retries/);
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
      { raw: EXPIRED, response: () => new Response("upstream-body-sentinel", { status: 503 }),
        expected: { outcome: "failed", renewalRequests: 1, auth: { status: "integration-unavailable", nextAction: UNREACHABLE[route] } } },
      // Token endpoints answer errors with JSON; Codex reads an unreadable body as a reach failure, as runs do.
      { raw: EXPIRED, response: () => Response.json({ error: "upstream-body-sentinel" }, { status: 429 }),
        expected: { outcome: "failed", renewalRequests: 1, auth: { status: "quota-exceeded", nextAction: RATE_LIMITED[route] } } },
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

  for (const stop of ["abort", "deadline"] as const) test(`${route} ${kind}: ${stop} after the token request left settles promptly and still stores the rotated credential`, async () => {
    await withTempDir(async dir => {
      const store = await seeded(route, EXPIRED);
      const wire = transport(route, rotatingTokens());
      const { selection, lifecycle } = selectionFor(kind, route, store, { fetch: wire.fetch });
      const host = await createHost(await options(dir, { ...selection, model: MODEL[route] }));
      const held = wire.hold();
      const controller = new AbortController();
      const pending = host.auth!.renew(stop === "abort" ? { signal: controller.signal } : { deadlineMs: 1_000 });
      await Promise.race([held.started, pending.then(early => { throw new Error(`renewal settled before sending: ${early.outcome}`); })]);
      const stopped = performance.now();
      if (stop === "abort") controller.abort();
      const renewal = await pending;
      expect(performance.now() - stopped).toBeLessThan(2_000);
      // The request left, so it is counted; decide on the outcome, since auth is the verdict read before the stop.
      expect(renewal).toMatchObject({ outcome: stop === "abort" ? "cancelled" : "limit_exceeded", renewalRequests: 1, auth: { status: "configured-unverified" } });
      expectSafe(renewal, route);
      // The provider rotated the refresh token, so the response it sent is stored rather than thrown away.
      held.release();
      await until(() => store.writes === 1, "the rotated credential to be stored");
      await Bun.sleep(5);
      expect(await store.value()).toContain("rotated-refresh-sentinel-1");
      const next = await host.auth!.renew();
      expect(next).toMatchObject({ outcome: "fresh", renewalRequests: 0 });
      expect(await listRouteModels(selection)).toMatchObject({ status: "listed" });
      expect(wire.counts).toMatchObject({ token: 1, inference: 0 });
      // The participation held for the stored response has been released.
      await host.close(); await lifecycle?.close();
    });
  });

  test(`${route} ${kind}: a run arriving after a stopped renewal joins its in-flight request`, async () => {
    await withTempDir(async dir => {
      const store = await seeded(route, EXPIRED);
      const wire = transport(route, rotatingTokens());
      const { selection, lifecycle } = selectionFor(kind, route, store, { fetch: wire.fetch });
      const host = await createHost(await options(dir, { ...selection, model: MODEL[route] }));
      const session = await host.createSession();
      const held = wire.hold();
      const controller = new AbortController();
      const pending = host.auth!.renew({ signal: controller.signal });
      await held.started;
      controller.abort();
      expect(await pending).toMatchObject({ outcome: "cancelled", renewalRequests: 1 });
      const reads = store.reads;
      let settled = false;
      const running = session.submitWithRoute({ text: "after a stopped renewal" }).finally(() => { settled = true; });
      // Readiness and the refresher each read once, then the run waits on the request already in flight.
      await until(() => store.reads >= reads + 2, "the run to join");
      await Bun.sleep(5);
      expect(settled).toBe(false);
      expect(wire.counts.token).toBe(1);
      held.release();
      const run = await running;
      expect(run.outcome).toBe("completed");
      expect(run.usage.providerRequests).toEqual({ initialSends: 1, authRetrySends: 0, renewalRequests: 0 });
      expect(wire.counts).toMatchObject({ token: 1, inference: 1 });
      expect(await store.value()).toContain("rotated-refresh-sentinel-1");
      await session.close(); await host.close(); await lifecycle?.close();
    });
  });

  test(`${route} ${kind}: a stop while the write guard decides sends nothing afterwards`, async () => {
    const store = await seeded(route, EXPIRED);
    const wire = transport(route);
    const deciding = Promise.withResolvers<void>(), decide = Promise.withResolvers<void>();
    let guards = 0, frozen = false;
    const { selection, lifecycle } = selectionFor(kind, route, store, { fetch: wire.fetch,
      credentialWriteGuard: async identity => {
        guards++;
        frozen = Object.isFrozen(identity);
        deciding.resolve(); await decide.promise;
      } });
    const controller = new AbortController();
    const pending = renewAuthRoute(selection, { signal: controller.signal });
    await deciding.promise;
    controller.abort();
    const renewal = await pending;
    expect(renewal).toMatchObject({ outcome: "cancelled", renewalRequests: 0, auth: { status: "configured-unverified" } });
    expectSafe(renewal, route);
    decide.resolve();
    await Bun.sleep(20);
    expect(guards).toBe(1);
    // The guard receives a frozen reference, never an object a result also returns.
    expect(frozen).toBe(true);
    expect(wire.counts.token).toBe(0);
    expect(store.writes).toBe(0);
    await lifecycle?.close();
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

  test(`${route} a logout after a stopped renewal still fences its in-flight write`, async () => {
    const store = await seeded(route, EXPIRED);
    const wire = transport(route, rotatingTokens());
    const lifecycle = createHostCredentialLifecycle({ store });
    const held = wire.hold();
    const controller = new AbortController();
    const pending = renewAuthRoute({ route, lifecycle, fetch: wire.fetch }, { signal: controller.signal });
    await held.started;
    controller.abort();
    expect(await pending).toMatchObject({ outcome: "cancelled", renewalRequests: 1 });
    // The stopped renewal still takes part in its in-flight request, so the owner stays busy until it settles.
    await expect(lifecycle.close()).rejects.toMatchObject({ code: "busy" });
    await lifecycle.logout(route);
    held.release();
    await Bun.sleep(20);
    expect(await store.value()).toBeNull();
    expect(wire.counts.token).toBe(1);
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

for (const route of ROUTES) test(`${route} sends the token request in the same step that creates the shared renewal`, async () => {
  // Caller A creates the renewal; caller B joins one microtask later and, while joining, stops A. Any request
  // sent after that step would be counted on A after A settled with nothing counted, and on no one else.
  const base = await seeded(route, EXPIRED);
  const gate = Promise.withResolvers<void>();
  let reads = 0;
  const store: CredentialStore = { ...base, get: async identity => { await gate.promise; const value = await base.get(identity); reads++; return value; } };
  let sends = 0, counted = 0;
  const fetch: HostAuthFetch = async () => { sends++; return renewedTokens(); };
  const first = new AbortController(), second = new AbortController();
  let joined = false, atStop: { counted: number; sends: number } | undefined;
  const listen = second.signal.addEventListener.bind(second.signal);
  Object.defineProperty(second.signal, "addEventListener", { value: (...args: Parameters<AbortSignal["addEventListener"]>) => {
    // B's first registration after both reads answered is its join of A's renewal.
    if (reads === 2 && !joined) { joined = true; first.abort(); atStop = { counted, sends }; }
    return listen(...args);
  } });
  const refresher = route === "codex" ? createCodexRefresher({ store, fetch }) : createGrokRefresher({ store, fetch });
  const call = (signal: AbortSignal, onRenewal: () => void) => route === "codex"
    ? (refresher as ReturnType<typeof createCodexRefresher>).getValidAccessToken(signal, onRenewal)
    : (refresher as ReturnType<typeof createGrokRefresher>).getValidAccessToken(signal, undefined, onRenewal);
  const a = call(first.signal, () => { counted++; }).then(() => "renewed", () => "stopped");
  const b = call(second.signal, () => { throw new Error("the joiner never starts a request"); });
  gate.resolve();
  expect(await a).toBe("stopped");
  // When A stops, its request has already left and is already counted on A, the way a renewal snapshots it.
  expect(joined).toBe(true);
  expect(atStop).toEqual({ counted: 1, sends: 1 });
  await b;
  expect({ counted, sends }).toEqual({ counted: 1, sends: 1 });
});

/** Clock whose run-deadline sleep fires only when the test says so; backoff sleeps return at once. */
function deadlineClock() {
  const fire = Promise.withResolvers<void>();
  return { fire: () => fire.resolve(), clock: { now: () => Date.now(), sleep: (ms: number, signal?: AbortSignal) => ms < 60_000 ? Promise.resolve()
    : new Promise<void>((resolve, reject) => {
      void fire.promise.then(() => resolve());
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }) } };
}

// #456: a run stopped after its own renewal request left keeps the credential the provider already rotated.
for (const route of ROUTES) for (const kind of KINDS) {
  for (const stop of ["cancel", "deadline"] as const) test(`${route} ${kind}: a run ${stop === "cancel" ? "cancelled" : "timed out"} after its renewal left keeps the rotated credential`, async () => {
    await withTempDir(async dir => {
      const store = await seeded(route, EXPIRED);
      const wire = transport(route, rotatingTokens());
      const { selection, lifecycle } = selectionFor(kind, route, store, { fetch: wire.fetch });
      const host = await createHost(await options(dir, { ...selection, model: MODEL[route] }));
      const first = await host.createSession(), second = await host.createSession();
      const held = wire.hold();
      const controller = new AbortController(), deadline = deadlineClock();
      const pending = first.submitWithRoute({ text: "renew, then stop" }, stop === "cancel" ? { signal: controller.signal } : { clock: deadline.clock });
      await held.started;
      if (stop === "cancel") controller.abort(); else deadline.fire();
      const stopped = await pending;
      expect(stopped.outcome).toBe(stop === "cancel" ? "cancelled" : "limit_exceeded");
      // The run still reports the request it sent, once.
      expect(stopped.usage.providerRequests).toEqual({ initialSends: 0, authRetrySends: 0, renewalRequests: 1 });
      held.release();
      await until(() => store.writes === 1, "the rotated credential to be stored");
      await Bun.sleep(5);
      expect(await store.value()).toContain("rotated-refresh-sentinel-1");
      // The next run uses it: no second token request, which the provider would reject.
      const next = await second.submitWithRoute({ text: "after the stop" });
      expect(next.outcome).toBe("completed");
      expect(next.usage.providerRequests).toEqual({ initialSends: 1, authRetrySends: 0, renewalRequests: 0 });
      expect(await host.auth!.renew()).toMatchObject({ outcome: "fresh", renewalRequests: 0 });
      expect(wire.counts).toMatchObject({ token: 1, inference: 1 });
      await first.close(); await second.close(); await host.close(); await lifecycle?.close();
    });
  });

  for (const stop of ["cancel", "deadline"] as const) test(`${route} ${kind}: a run arriving after a ${stop === "cancel" ? "cancelled" : "timed-out"} run's renewal joins its in-flight request`, async () => {
    await withTempDir(async dir => {
      const store = await seeded(route, EXPIRED);
      const wire = transport(route, rotatingTokens());
      const { selection, lifecycle } = selectionFor(kind, route, store, { fetch: wire.fetch });
      const host = await createHost(await options(dir, { ...selection, model: MODEL[route] }));
      const first = await host.createSession(), second = await host.createSession();
      const held = wire.hold();
      const controller = new AbortController(), deadline = deadlineClock();
      const pending = first.submitWithRoute({ text: "renew, then stop" }, stop === "cancel" ? { signal: controller.signal } : { clock: deadline.clock });
      await held.started;
      if (stop === "cancel") controller.abort(); else deadline.fire();
      expect(await pending).toMatchObject({ outcome: stop === "cancel" ? "cancelled" : "limit_exceeded", usage: { providerRequests: { renewalRequests: 1 } } });
      const reads = store.reads;
      let settled = false;
      const running = second.submitWithRoute({ text: "join it" }).finally(() => { settled = true; });
      await until(() => store.reads >= reads + 2, "the next run to join");
      await Bun.sleep(5);
      expect(settled).toBe(false);
      expect(wire.counts.token).toBe(1);
      held.release();
      const run = await running;
      expect(run.outcome).toBe("completed");
      expect(run.usage.providerRequests).toEqual({ initialSends: 1, authRetrySends: 0, renewalRequests: 0 });
      expect(wire.counts).toMatchObject({ token: 1, inference: 1 });
      expect(await store.value()).toContain("rotated-refresh-sentinel-1");
      await first.close(); await second.close(); await host.close(); await lifecycle?.close();
    });
  });

  test(`${route} ${kind}: a cancelled direct route stream keeps the rotated credential its renewal received`, async () => {
    await withTempDir(async dir => {
      const store = await seeded(route, EXPIRED);
      const wire = transport(route, rotatingTokens());
      const { selection, lifecycle } = selectionFor(kind, route, store, { fetch: wire.fetch });
      const host = await createHost(await options(dir, { ...selection, model: MODEL[route] }));
      const session = await host.createSession();
      const held = wire.hold();
      const controller = new AbortController();
      const pending = session.submit({ text: "direct stream" }, await host.auth!.createModel(), { signal: controller.signal });
      await held.started;
      controller.abort();
      expect(await pending).toMatchObject({ outcome: "cancelled", usage: { providerRequests: { renewalRequests: 1 } } });
      held.release();
      await until(() => store.writes === 1, "the rotated credential to be stored");
      await Bun.sleep(5);
      expect(await store.value()).toContain("rotated-refresh-sentinel-1");
      expect(await host.auth!.renew()).toMatchObject({ outcome: "fresh", renewalRequests: 0 });
      expect(wire.counts.token).toBe(1);
      await session.close(); await host.close(); await lifecycle?.close();
    });
  });

  for (const stop of ["cancel", "deadline"] as const) test(`${route} ${kind}: a logout during a ${stop === "cancel" ? "cancelled" : "timed-out"} run's in-flight renewal still fences its write`, async () => {
    await withTempDir(async dir => {
      const store = await seeded(route, EXPIRED);
      const wire = transport(route, rotatingTokens());
      const { selection, lifecycle } = selectionFor(kind, route, store, { fetch: wire.fetch });
      const host = await createHost(await options(dir, { ...selection, model: MODEL[route] }));
      const session = await host.createSession();
      const held = wire.hold();
      const controller = new AbortController(), deadline = deadlineClock();
      const pending = session.submitWithRoute({ text: "renew, then stop" }, stop === "cancel" ? { signal: controller.signal } : { clock: deadline.clock });
      await held.started;
      if (stop === "cancel") controller.abort(); else deadline.fire();
      expect((await pending).outcome).toBe(stop === "cancel" ? "cancelled" : "limit_exceeded");
      await session.close(); await host.close();
      if (lifecycle) {
        // The stopped run still takes part in its in-flight renewal, so the owner stays busy until it settles.
        await expect(lifecycle.close()).rejects.toMatchObject({ code: "busy" });
        await lifecycle.logout(route);
        // Logout refused that participant, so nothing is left to keep the owner busy.
        await lifecycle.close();
      } else if (route === "codex") await clearSubscriptionTokens(store);
      else await deleteSubscriptionTokens(store);
      held.release();
      await Bun.sleep(20);
      expect(await store.value()).toBeNull();
      expect(wire.counts.token).toBe(1);
      await lifecycle?.close();
    });
  });
}

for (const route of ROUTES) test(`${route} CLI turn cancelled after its renewal left keeps the rotated credential`, async () => {
  // The CLI loads the same adapters and refreshers without a host or lifecycle.
  const store = await seeded(route, EXPIRED);
  const wire = transport(route, rotatingTokens());
  const model = route === "codex"
    ? await loadProviderModel({ provider: "openai", openaiAuth: "codex", model: "gpt-5.4", codexStore: store }, wire.fetch)
    : await loadProviderModel({ provider: "xai", xaiAuth: "grok", model: "grok-4.7", grokStore: store }, wire.fetch);
  const held = wire.hold();
  const controller = new AbortController();
  const cancelled = collect(model.stream({ ...sampleRequest(), signal: controller.signal })).then(() => "completed", (error: unknown) => (error as Error).name);
  await held.started;
  controller.abort();
  expect(await cancelled).toBe("AbortError");
  held.release();
  await until(() => store.writes === 1, "the rotated credential to be stored");
  await Bun.sleep(5);
  expect(await store.value()).toContain("rotated-refresh-sentinel-1");
  await collect(model.stream(sampleRequest()));
  expect(wire.counts).toMatchObject({ token: 1, inference: 1 });
});

for (const route of ROUTES) for (const kind of KINDS) {
  for (const stop of ["cancel", "deadline"] as const) test(`${route} ${kind}: a run ${stop === "cancel" ? "cancelled" : "timed out"} inside the refresher before it sends never sends`, async () => {
    await withTempDir(async dir => {
      const base = await seeded(route, EXPIRED);
      // The run's readiness read answers; the refresher's own read waits until after the stop.
      const reading = Promise.withResolvers<void>(), answer = Promise.withResolvers<void>();
      let reads = 0;
      const store: CredentialStore = { ...base, get: async identity => { if (++reads === 2) { reading.resolve(); await answer.promise; } return base.get(identity); },
        set: (identity, value) => base.set(identity, value) };
      const wire = transport(route, rotatingTokens());
      const { selection, lifecycle } = selectionFor(kind, route, store, { fetch: wire.fetch });
      const host = await createHost(await options(dir, { ...selection, model: MODEL[route] }));
      const session = await host.createSession();
      const controller = new AbortController(), deadline = deadlineClock();
      const pending = session.submitWithRoute({ text: "stop before sending" }, stop === "cancel" ? { signal: controller.signal } : { clock: deadline.clock });
      await reading.promise;
      if (stop === "cancel") controller.abort(); else deadline.fire();
      // The read answers only after the stop; Codex settles after that read, Grok as soon as it stops.
      answer.resolve();
      expect(await pending).toMatchObject({ outcome: stop === "cancel" ? "cancelled" : "limit_exceeded", usage: { providerRequests: { initialSends: 0, renewalRequests: 0 } } });
      await Bun.sleep(20);
      expect(wire.counts.token).toBe(0);
      expect(base.writes).toBe(0);
      await session.close(); await host.close(); await lifecycle?.close();
    });
  });

  test(`${route} ${kind}: a replacement device sign-in wins over a stopped run's late renewal`, async () => {
    await withTempDir(async dir => {
      const store = await seeded(route, EXPIRED);
      const wire = transport(route, rotatingTokens());
      const { selection, lifecycle } = selectionFor(kind, route, store, { fetch: wire.fetch });
      const host = await createHost(await options(dir, { ...selection, model: MODEL[route] }));
      const first = await host.createSession(), second = await host.createSession();
      const held = wire.hold();
      const controller = new AbortController();
      const pending = first.submitWithRoute({ text: "renew, then cancel" }, { signal: controller.signal });
      await held.started;
      controller.abort();
      expect((await pending).outcome).toBe("cancelled");
      // The user signs in again through the host's device flow, into the same store, while the old renewal is in flight.
      const clock = manualClock();
      const flow = await beginDeviceSignIn({ route, store, fetch: deviceSignInFetch(route), clock });
      if (flow.kind !== "pending") throw new Error(`expected a pending sign-in, got ${flow.kind}`);
      const signingIn = flow.poll(new AbortController().signal);
      await clock.advance(5_000);
      expect(await signingIn).toMatchObject({ kind: "ready" });
      expect(await store.value()).toContain("NEW-SIGNIN-access");
      held.release();
      await Bun.sleep(20);
      // The old account's late response never overwrites the new sign-in.
      expect(await store.value()).toContain("NEW-SIGNIN-access");
      expect(await store.value()).not.toContain("renewed-access-sentinel");
      const next = await second.submitWithRoute({ text: "after signing in again" });
      expect(next.outcome).toBe("completed");
      expect(next.usage.providerRequests).toEqual({ initialSends: 1, authRetrySends: 0, renewalRequests: 0 });
      expect(wire.counts.token).toBe(1);
      await first.close(); await second.close(); await host.close(); await lifecycle?.close();
    });
  });
}

/** Device-flow fixture whose approval yields a different account's login. */
function deviceSignInFetch(route: Route): HostAuthFetch {
  return async input => {
    const url = String(input);
    if (url.endsWith("usercode") || url.endsWith("device/code")) return Response.json({ device_auth_id: "device-id", device_code: "device-id", user_code: "ABCD-EFGH",
      verification_uri: route === "codex" ? "https://auth.openai.com/codex/device" : "https://accounts.x.ai/device", interval: 2, expires_in: 60 });
    const login = Response.json({ access_token: "NEW-SIGNIN-access", refresh_token: "NEW-SIGNIN-refresh", expires_in: 3600 });
    if (route === "codex" && url === "https://auth.openai.com/oauth/token") return login;
    return route === "codex" ? Response.json({ authorization_code: "device-auth-code", code_verifier: "device-verifier" }) : login;
  };
}

for (const route of ROUTES) {
  const refresherFor = (store: CredentialStore, fetch: HostAuthFetch, timeoutMs: number) => {
    const refresher = route === "codex" ? createCodexRefresher({ store, fetch, timeoutMs }) : createGrokRefresher({ store, fetch, timeoutMs });
    return (signal: AbortSignal, onRenewal: (settled: Promise<void>) => void) => route === "codex"
      ? (refresher as ReturnType<typeof createCodexRefresher>).getValidAccessToken(signal, onRenewal)
      : (refresher as ReturnType<typeof createGrokRefresher>).getValidAccessToken(signal, undefined, onRenewal);
  };

  test(`${route} a renewal whose transport never answers releases its stopped participant at the refresh ceiling`, async () => {
    const store = await seeded(route, EXPIRED);
    const lifecycle = createHostCredentialLifecycle({ store });
    const stop = new AbortController();
    const lease = acquireCredentialLifecycle(lifecycle, route, undefined, stop.signal);
    let sent = 0;
    // Ignores its signal and never answers, like a hung connection.
    const fetch: HostAuthFetch = () => { sent++; return new Promise<Response>(() => {}); };
    const waiting = refresherFor(lease.store, fetch, 50)(stop.signal, settled => holdRenewal(lease, settled)).then(() => "renewed", () => "stopped");
    await until(() => sent === 1, "the token request");
    stop.abort();
    lease.release();
    expect(await waiting).toBe("stopped");
    await expect(lifecycle.close()).rejects.toMatchObject({ code: "busy" });
    // The ceiling settles the renewal even though the transport never does, so the owner becomes idle.
    const started = performance.now();
    for (;;) {
      const closed = await lifecycle.close().then(() => true, () => false);
      if (closed) break;
      if (performance.now() - started > 2_000) throw new Error("The owner stayed busy past the refresh ceiling");
      await Bun.sleep(10);
    }
    expect(store.writes).toBe(0);
  });

  test(`${route} logout releases a stopped participant whose renewal is still in flight`, async () => {
    const store = await seeded(route, EXPIRED);
    const lifecycle = createHostCredentialLifecycle({ store });
    const stop = new AbortController();
    const lease = acquireCredentialLifecycle(lifecycle, route, undefined, stop.signal);
    let sent = 0;
    const fetch: HostAuthFetch = () => { sent++; return new Promise<Response>(() => {}); };
    void refresherFor(lease.store, fetch, 60_000)(stop.signal, settled => holdRenewal(lease, settled)).catch(() => {});
    await until(() => sent === 1, "the token request");
    stop.abort();
    lease.release();
    await expect(lifecycle.close()).rejects.toMatchObject({ code: "busy" });
    await lifecycle.logout(route);
    // A refused participant authorizes nothing, so it no longer holds the owner.
    await lifecycle.close();
  });
}

const NEWER_LOGIN = () => JSON.stringify({ accessToken: "NEW-SIGNIN-access", refreshToken: "NEW-SIGNIN-refresh", obtainedAt: Date.now(), expiresAt: Date.now() + 3_600_000 });
/** The exact pair the rotating endpoint's first renewal returns, as another store object or process would store it. */
const SAME_ROTATION = () => JSON.stringify({ accessToken: "renewed-access-sentinel-1", refreshToken: "rotated-refresh-sentinel-1", obtainedAt: 7, expiresAt: Date.now() + 3_600_000 });

for (const route of ROUTES) for (const kind of KINDS) for (const meanwhile of ["newer", "identical"] as const) {
  test(`${route} ${kind}: a renewal paused in its write guard never overwrites ${meanwhile === "newer" ? "a newer login" : "the same rotation"} stored meanwhile`, async () => {
    await withTempDir(async dir => {
      const store = await seeded(route, EXPIRED);
      const rotating = rotatingTokens();
      let armed = false;
      // The guard pauses on the first check after the token response arrives: the check that precedes the write.
      const wire = transport(route, form => { armed = true; return rotating(form); });
      const paused = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
      const credentialWriteGuard = async () => { if (armed) { armed = false; paused.resolve(); await resume.promise; } };
      const { selection, lifecycle } = selectionFor(kind, route, store, { fetch: wire.fetch, credentialWriteGuard });
      const host = await createHost(await options(dir, { ...selection, model: MODEL[route] }));
      const renewing = host.auth!.renew();
      await paused.promise;
      const stored = meanwhile === "newer" ? NEWER_LOGIN() : SAME_ROTATION();
      await store.set(identityFor(route), stored);
      resume.resolve();
      // A usable login is stored either way, so the waiting caller is not told to sign in again.
      expect(await renewing).toMatchObject({ outcome: "renewed", renewalRequests: 1, auth: { status: "configured-unverified" } });
      expect(await store.value()).toBe(stored);
      expect(wire.counts.token).toBe(1);
      await host.close(); await lifecycle?.close();
    });
  });
}

for (const route of ROUTES) for (const kind of KINDS) {
  test(`${route} ${kind}: a renewal waiting on the credential lock never overwrites a login stored under it`, async () => {
    await withTempDir(async dir => {
      const values = new Map<string, string>([[identityFor(route).account, EXPIRED]]);
      const backend = {
        async get({ name }: { name: string }) { return values.get(name) ?? null; },
        async set({ name, value }: { name: string; value: string }) { values.set(name, value); },
        async delete({ name }: { name: string }) { return values.delete(name); },
      } as unknown as typeof Bun.secrets;
      const native = createNativeCredentialStore(backend);
      const wire = transport(route, rotatingTokens());
      const { selection, lifecycle } = selectionFor(kind, route, native, { fetch: wire.fetch });
      const host = await createHost(await options(dir, { ...selection, model: MODEL[route] }));
      const held = wire.hold();
      const renewing = host.auth!.renew();
      await held.started;
      // Another writer holds the cross-process lock and stores a new sign-in while the renewal waits for it.
      const locked = Promise.withResolvers<void>(), unlock = Promise.withResolvers<void>();
      const holding = withCredentialStoreLock(async () => {
        locked.resolve();
        await unlock.promise;
        values.set(identityFor(route).account, NEWER_LOGIN());
      }, { operation: "save" });
      await locked.promise;
      held.release();
      await Bun.sleep(100);
      unlock.resolve();
      await holding;
      expect(await renewing).toMatchObject({ outcome: "renewed", renewalRequests: 1 });
      expect(values.get(identityFor(route).account)).toContain("NEW-SIGNIN-access");
      await host.close(); await lifecycle?.close();
    });
  });
}

test("a participant its guard refuses stops holding the owner while its renewal settles", async () => {
  const base = fakeCredentialStore();
  const held = createHostCredentialLifecycle({ store: base }), writer = createHostCredentialLifecycle({ store: base });
  const stop = new AbortController();
  const participant = acquireCredentialLifecycle(held, "codex", () => { throw new Error("guard-secret-sentinel"); }, stop.signal);
  const pending = Promise.withResolvers<void>();
  holdRenewal(participant, pending.promise);
  stop.abort();
  participant.release();
  await expect(held.close()).rejects.toMatchObject({ code: "busy" });
  // Another owner's write consults every participant's guard; this one refuses, so it authorizes nothing.
  const other = acquireCredentialLifecycle(writer, "codex");
  await other.store.set(codexSubscriptionIdentity(), fresh());
  await held.close();
  pending.resolve();
  other.release();
  await writer.close();
});

test("codex releases a stalled token body when the refresh ceiling ends it", async () => {
  const store = await seeded("codex", EXPIRED);
  const cancelled = Promise.withResolvers<void>();
  const fetch: HostAuthFetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"access_')); },
    cancel() { cancelled.resolve(); },
  }));
  const failure = await createCodexRefresher({ store, fetch, timeoutMs: 50 }).getValidAccessToken().then(() => undefined, (error: unknown) => error as Error);
  expect(failure?.message).toContain("timed out");
  await cancelled.promise;
  expect(store.writes).toBe(0);
});

test("codex releases a token response that lands after the refresh ceiling", async () => {
  const store = await seeded("codex", EXPIRED);
  const cancelled = Promise.withResolvers<void>();
  const fetch: HostAuthFetch = () => Bun.sleep(150).then(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"access_token":"late"')); },
    cancel() { cancelled.resolve(); },
  })));
  const failure = await createCodexRefresher({ store, fetch, timeoutMs: 50 }).getValidAccessToken().then(() => undefined, (error: unknown) => error as Error);
  expect(failure?.message).toContain("timed out");
  await cancelled.promise;
  expect(store.writes).toBe(0);
});

// A JSON 400 or 401 means the grant is gone; a page without a JSON body, such as a gateway or challenge, does not.
for (const entry of [
  { status: 400, json: true, text: "revoked or rejected by the provider", auth: "rejected" },
  { status: 400, json: false, text: "(status 400 with no readable error)", auth: "integration-unavailable" },
  { status: 401, json: true, text: "revoked or rejected by the provider", auth: "rejected" },
  { status: 401, json: false, text: "(status 401 with no readable error)", auth: "integration-unavailable" },
  { status: 403, json: true, text: "(HTTP 403)", auth: "rejected" },
  { status: 403, json: false, text: "(status 403 with no readable error)", auth: "integration-unavailable" },
  { status: 429, json: true, text: "(HTTP 429)", auth: "quota-exceeded" },
  { status: 429, json: false, text: "(HTTP 429)", auth: "quota-exceeded" },
  { status: 500, json: false, text: "(HTTP 500)", auth: "integration-unavailable" },
  { status: 502, json: false, text: "(HTTP 502)", auth: "integration-unavailable" },
] as const) test(`codex token endpoint ${entry.status} ${entry.json ? "JSON" : "HTML"} reads as ${entry.auth}`, async () => {
  const reply = () => entry.json ? Response.json({ error: "invalid_grant" }, { status: entry.status })
    : new Response("<html>upstream-body-sentinel</html>", { status: entry.status, headers: { "Content-Type": "text/html" } });
  const failure = await refreshCodexTokens({ refreshToken: "stored-refresh-sentinel", fetch: async () => reply() }).then(() => undefined, (error: unknown) => error as Error);
  expect(failure?.message).toContain(entry.text);
  expect(failure?.message).not.toContain("upstream-body-sentinel");
  const store = await seeded("codex", EXPIRED);
  const renewal = await renewAuthRoute({ route: "codex", store, fetch: async () => reply() });
  expect(renewal).toMatchObject({ outcome: "failed", renewalRequests: 1, auth: { status: entry.auth } });
  expect(containsNoSecrets(renewal, ["upstream-body-sentinel", "invalid_grant"])).toBe(true);
});
