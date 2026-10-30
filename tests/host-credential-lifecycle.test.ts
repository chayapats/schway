import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHost, createHostCredentialLifecycle, containsNoSecrets, isCleanupUncertain, isCredentialWriteRefused, type HostAuthRoute,
  type HostClock, type HostCredentialStore, type HostCredentialWriteGuard, type HostOptions, type Model } from "schway/host";
import { withTempDir } from "./helpers.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { encodeXaiSse, XAI_TEXT_EVENTS } from "./fixtures/xai.ts";

const deferred = () => Promise.withResolvers<void>();
const identity = (route: HostAuthRoute) => ({ account: route === "codex" ? "codex-subscription:chatgpt" : "grok-subscription:xai", label: "fixture" });
const expired = JSON.stringify({ accessToken: "old-secret", refreshToken: "refresh-secret", expiresAt: 1, obtainedAt: 1 });

function response(route: HostAuthRoute): Response {
  if (route === "grok") return new Response(encodeXaiSse(XAI_TEXT_EVENTS), { headers: { "Content-Type": "text/event-stream" } });
  const events = [
    { type: "response.created", response: { id: "r", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message" } },
    { type: "response.output_text.delta", output_index: 0, delta: "done" },
    { type: "response.output_item.done", output_index: 0, item: { type: "message" } },
    { type: "response.completed", response: { id: "r", status: "completed" } },
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
}

async function options(dir: string, name: string): Promise<HostOptions> {
  const workspaceRoot = join(dir, name), homeDirectory = join(dir, "home");
  await mkdir(workspaceRoot, { recursive: true }); await mkdir(homeDirectory, { recursive: true });
  return { workspaceRoot, homeDirectory, sessionDirectory: join(dir, `sessions-${name}`),
    context: { policy: "strict", systemPrompt: `operator-${name}`, sections: [] },
    tools: { policy: "exact", hostedLookup: "off", definitions: [] },
    limits: { maxTurns: 2, maxConcurrentTools: 1, contextWindow: 32768, maxInputChars: name === "a" ? 100 : 200, maxAttempts: 1 } };
}

function fakeClock(): HostClock {
  return { now: () => 10, monotonicNow: () => 10, sleep: (_ms, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
  }) };
}

for (const route of ["codex", "grok"] as const) {
  for (const scenario of ["overlap", "failure", "cancel", "guard", "mutate", "logout", "logout-write", "dispose"] as const) {
    test(`${route} isolated hosts share renewal through ${scenario} barriers`, async () => {
      await withTempDir(async dir => {
        const base = fakeCredentialStore(); await base.set(identity(route), expired);
        const refreshing = deferred(), release = deferred(), joined = deferred(), stored = deferred(), finishWrite = deferred();
        let secondEntered = false, firstAllowed = true, refreshingNow = false, refreshes = 0, sends = 0, writes = 0;
        const store: HostCredentialStore = {
          async get(key) {
            if (secondEntered && refreshingNow) joined.resolve();
            return base.get(key);
          },
          async set(key, value) {
            writes++; await base.set(key, value);
            if (scenario === "dispose" || scenario === "logout-write") { stored.resolve(); await finishWrite.promise; }
          },
          delete: key => base.delete(key),
        };
        const lifecycle = createHostCredentialLifecycle({ store });
        const fetch = async (url: string | URL | Request, init?: RequestInit) => {
          if (String(url).includes("/oauth/token") || String(url).includes("auth.x.ai")) {
            refreshes++; refreshingNow = true; refreshing.resolve(); await release.promise;
            if (scenario === "failure") return Response.json({ error: "invalid_grant", detail: "provider-secret" }, { status: 400 });
            return Response.json({ access_token: "fresh-secret", refresh_token: "rotated-secret", expires_in: 3600 });
          }
          sends++;
          expect(String(init?.body)).not.toContain("rotated-secret");
          return response(route);
        };
        const guardA: HostCredentialWriteGuard = key => {
          if (scenario === "mutate") (key as { account: string }).account = "api-key:openai";
          if (!firstAllowed) throw new Error("guard-secret");
        };
        const guardB: HostCredentialWriteGuard = () => { secondEntered = true; };
        const a = await createHost({ ...await options(dir, "a"), auth: { route, model: "fixture-model", lifecycle, fetch, credentialWriteGuard: guardA } });
        const b = await createHost({ ...await options(dir, "b"), auth: { route, model: "fixture-model", lifecycle, fetch, credentialWriteGuard: guardB } });
        const sa = await a.createSession(), sb = await b.createSession();
        expect(sa.reference.id).not.toBe(sb.reference.id);
        const ra = sa.submitWithRoute({ text: "one" }, { clock: fakeClock() });
        await refreshing.promise;
        const rb = sb.submitWithRoute({ text: "two" }, { clock: fakeClock() });
        await joined.promise;
        await expect(lifecycle.close()).rejects.toMatchObject({ code: "busy" });
        await expect(a.close()).rejects.toMatchObject({ code: "busy" });
        let logout: Promise<void> | undefined;
        if (scenario === "cancel") sa.cancel();
        if (scenario === "guard") firstAllowed = false;
        if (scenario === "logout") logout = lifecycle.logout(route);
        release.resolve();
        if (scenario === "logout-write") {
          await stored.promise; logout = lifecycle.logout(route);
          await expect(lifecycle.close()).rejects.toMatchObject({ code: "busy" });
          finishWrite.resolve();
        }
        if (scenario === "dispose") {
          await stored.promise;
          sa.cancel(); sb.cancel();
          await expect(lifecycle.close()).rejects.toMatchObject({ code: "busy" });
          finishWrite.resolve();
          // Readiness waits behind the credential write and its post-cancellation cleanup.
          await b.auth!.checkReadiness();
        }
        const results = await Promise.all([ra, rb]);
        await logout;
        expect(refreshes).toBe(1);
        if (scenario === "overlap") expect(results.map(result => result.outcome)).toEqual(["completed", "completed"]);
        if (scenario === "cancel") expect(results.map(result => result.outcome)).toEqual(["cancelled", "completed"]);
        if (scenario === "guard" || scenario === "mutate") {
          expect(results[0]!.outcome).toBe("error");
          expect(results[1]!.outcome).toBe("completed");
          expect(sends).toBe(1);
          expect(await base.get({ account: "api-key:openai", label: "bait" })).toBeNull();
        }
        if (scenario === "logout" || scenario === "failure") {
          expect(results.every(result => result.outcome !== "completed")).toBe(true);
          expect(sends).toBe(0); expect(writes).toBe(0);
        }
        if (scenario === "logout-write") { expect(sends).toBe(0); expect(results.every(result => result.outcome !== "completed")).toBe(true); }
        if (scenario === "logout" || scenario === "logout-write" || scenario === "dispose") expect(await base.get(identity(route))).toBeNull();
        expect(containsNoSecrets({ lifecycle, results }, ["old-secret", "refresh-secret", "fresh-secret", "rotated-secret", "guard-secret", "provider-secret"])).toBe(true);
        await sa.close(); await a.close();
        if (scenario === "overlap" || scenario === "cancel" || scenario === "guard") {
          // Closing one runtime leaves the other usable with the same exact route/model.
          expect((await sb.submitWithRoute({ text: "again" }, { clock: fakeClock() })).outcome).toBe("completed");
          expect(refreshes).toBe(1);
        }
        await sb.close(); await b.close(); await lifecycle.close(); await lifecycle.close();
        await expect(createHost({ ...await options(dir, "c"), auth: { route, model: "fixture-model", lifecycle } })).rejects.toMatchObject({ code: "invalid-options" });
      });
    });
  }
}

test("an admitted route run pins its owner while local readiness is blocked", async () => {
  await withTempDir(async dir => {
    const base = fakeCredentialStore(); await base.set(identity("codex"), JSON.stringify({ accessToken: "fresh-secret", expiresAt: Date.now() + 3_600_000, obtainedAt: 1 }));
    const entered = deferred(), release = deferred();
    const lifecycle = createHostCredentialLifecycle({ store: { ...base, async get(key) { entered.resolve(); await release.promise; return base.get(key); } } });
    const owner = await createHost({ ...await options(dir, "a"), auth: { route: "codex", model: "fixture-model", lifecycle, fetch: async () => response("codex") } });
    const session = await owner.createSession(), pending = session.submitWithRoute({ text: "readiness" }, { clock: fakeClock() });
    await entered.promise; await expect(lifecycle.close()).rejects.toMatchObject({ code: "busy" });
    release.resolve(); expect((await pending).outcome).toBe("completed");
    await session.close(); await owner.close(); await lifecycle.close();
  });
});

test("lifecycle owners are opaque, branded and share only the same store and route", async () => {
  const store = fakeCredentialStore();
  const first = createHostCredentialLifecycle({ store }), sibling = createHostCredentialLifecycle({ store });
  expect(Object.keys(first)).toEqual(["logout", "close"]);
  expect(JSON.stringify(first)).toBe("{}");
  await store.set(identity("codex"), expired); await store.set(identity("grok"), expired);
  await first.logout("codex");
  expect(await store.get(identity("codex"))).toBeNull();
  expect(await store.get(identity("grok"))).toBe(expired);
  await first.close(); await sibling.logout("grok"); await sibling.close();
  expect(() => createHostCredentialLifecycle({ store: {} as HostCredentialStore })).toThrow();
  expect(() => createHostCredentialLifecycle([] as never)).toThrow();
});

test("all caller fences refusing a renewal remove a late write without retaining secrets", async () => {
  await withTempDir(async dir => {
    const base = fakeCredentialStore(); await base.set(identity("codex"), expired);
    const stored = deferred(), release = deferred(); let allowed = true;
    const lifecycle = createHostCredentialLifecycle({ store: { get: key => base.get(key), delete: key => base.delete(key), async set(key, value) {
      await base.set(key, value); stored.resolve(); await release.promise;
    } } });
    const host = await createHost({ ...await options(dir, "a"), auth: { route: "codex", model: "fixture-model", lifecycle,
      credentialWriteGuard: () => { if (!allowed) throw new Error("secret"); },
      fetch: async url => String(url).includes("/oauth/token") ? Response.json({ access_token: "fresh-secret", expires_in: 3600 }) : response("codex") } });
    const model = await host.auth!.createModel();
    const pending = drain(model).catch(error => error);
    await stored.promise; allowed = false; release.resolve();
    expect(isCredentialWriteRefused(await pending)).toBe(true);
    expect(await base.get(identity("codex"))).toBeNull();
    await host.close(); await lifecycle.close();
  });
});

async function drain(model: Model): Promise<void> {
  for await (const _event of model.stream({ systemPrompt: "fixture", context: [], items: [] })) { /* Drain protocol fixture. */ }
}

for (const route of ["codex", "grok"] as const) {
  test(`${route} uncertain cleanup blocks subsequent credential use until logout succeeds`, async () => {
    await withTempDir(async dir => {
      const base = fakeCredentialStore(); await base.set(identity(route), expired);
      let allowed = true, deletionFails = true;
      const lifecycle = createHostCredentialLifecycle({ store: { get: key => base.get(key), async set(key, value) {
        await base.set(key, value); allowed = false;
      }, async delete(key) { if (deletionFails) throw new Error("store-secret"); return base.delete(key); } } });
      const owner = await createHost({ ...await options(dir, "a"), auth: { route, model: "fixture-model", lifecycle,
        credentialWriteGuard: () => { if (!allowed) throw new Error("guard-secret"); },
        fetch: async url => String(url).includes("/oauth/token") || String(url).includes("auth.x.ai")
          ? Response.json({ access_token: "fresh-secret", expires_in: 3600 }) : response(route) } });
      const failure = await drain(await owner.auth!.createModel()).catch(error => error);
      expect(isCleanupUncertain(failure)).toBe(true);
      expect(String(failure)).not.toContain("store-secret");
      expect((await owner.auth!.checkReadiness()).status).toBe("store-unavailable");
      await expect(lifecycle.logout(route)).rejects.toMatchObject({ code: "storage" });
      expect((await owner.auth!.checkReadiness()).status).toBe("store-unavailable");
      deletionFails = false; await lifecycle.logout(route);
      expect((await owner.auth!.checkReadiness()).status).toBe("needs-login");
      await owner.close(); await lifecycle.close();
    });
  });
}

test("different store identities and routes renew independently while handles for one store share", async () => {
  await withTempDir(async dir => {
    const stores = [fakeCredentialStore(), fakeCredentialStore()];
    for (const store of stores) for (const route of ["codex", "grok"] as const) await store.set(identity(route), expired);
    const owners = stores.map(store => createHostCredentialLifecycle({ store }));
    const sameStore = createHostCredentialLifecycle({ store: stores[0]! });
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let refreshes = 0;
    const hosts = await Promise.all(([0, 1, 2] as const).map(async (n) => {
      const route = n === 2 ? "grok" : "codex";
      return createHost({ ...await options(dir, String(n)), auth: { route, model: "fixture-model", lifecycle: owners[n === 1 ? 1 : 0]!,
        fetch: async url => {
          if (String(url).includes("/oauth/token") || String(url).includes("auth.x.ai")) {
            refreshes++; if (refreshes === 3) entered.resolve(); await release.promise;
            return Response.json({ access_token: "fresh-secret", expires_in: 3600 });
          }
          return response(route);
        } } });
    }));
    const models = await Promise.all(hosts.map(item => item.auth!.createModel()));
    const pending = models.map(drain); await entered.promise;
    expect(refreshes).toBe(3); release.resolve(); await Promise.all(pending);
    // A second handle for the same store sees the already-renewed credential.
    const peer = await createHost({ ...await options(dir, "peer"), auth: { route: "codex", model: "fixture-model", lifecycle: sameStore, fetch: async () => response("codex") } });
    await owners[0]!.close(); await drain(await peer.auth!.createModel());
    await Promise.all([...hosts, peer].map(item => item.close()));
    await owners[1]!.close(); await sameStore.close();
  });
});
