import { expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHost, hostCapabilities, HostError, checkAuthReadiness, classifyAuthError, describeAuthRoute, type HostOptions } from "schway/host";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { withTempDir, buildIsolatedCliEnv } from "./helpers.ts";
import { encodeXaiSse, XAI_TEXT_EVENTS } from "./fixtures/xai.ts";
import { CODEX_RESPONSES_URL } from "../src/model/providers/codex-subscription.ts";
import { grokSubscriptionIdentity, codexSubscriptionIdentity } from "../src/auth/store.ts";

async function options(dir: string, auth?: HostOptions["auth"]): Promise<HostOptions> {
  const workspaceRoot = join(dir, "work"), homeDirectory = join(dir, "home");
  await mkdir(workspaceRoot, { recursive: true }); await mkdir(homeDirectory, { recursive: true });
  return { workspaceRoot, homeDirectory, sessionDirectory: join(dir, "sessions"),
    context: { policy: "strict", systemPrompt: "Trusted host operator", sections: [], sources: [] },
    tools: { policy: "exact", hostedLookup: "off", definitions: [] },
    limits: { maxTurns: 3, maxConcurrentTools: 2, contextWindow: 32768, maxInputChars: 4096 },
    ...(auth ? { auth } : {}) };
}

function codexSse(text = "Hello world"): Response {
  const events = [
    { type: "response.created", response: { id: "r", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message" } },
    { type: "response.output_text.delta", output_index: 0, delta: text.slice(0, 5) },
    { type: "response.output_text.delta", output_index: 0, delta: text.slice(5) },
    { type: "response.output_item.done", output_index: 0, item: { type: "message" } },
    { type: "response.completed", response: { id: "r", status: "completed" } },
  ];
  const body = `${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

function xaiSse(): Response {
  return new Response(encodeXaiSse(XAI_TEXT_EVENTS), { headers: { "Content-Type": "text/event-stream" } });
}

test("capabilities advertise the auth-routes contract without inference claims", () => {
  const caps = hostCapabilities();
  expect(caps.contract).toBe("schway.host.base/v1");
  expect(caps.authContract).toBe("schway.host.auth-routes/v1");
  expect(caps.authRoutes).toEqual(["codex", "grok"]);
  expect(caps.observedInference).toBe("not-checked");
});

test("static description exposes opaque credential references without store or network", async () => {
  for (const route of ["codex", "grok"] as const) {
    const described = describeAuthRoute({ route, model: route === "codex" ? "gpt-5.4" : "grok-4.7" });
    expect(described.supported).toBe(true);
    expect(described.route).toBe(route);
    expect(described.credential.account).toBe(route === "codex" ? "codex-subscription:chatgpt" : "grok-subscription:xai");
    expect(JSON.stringify(described)).not.toMatch(/eyJ|Bearer|secret|token/i);
  }
});

test("host construction rejects raw tokens and unknown routes", async () => {
  await withTempDir(async dir => {
    const base = await options(dir);
    for (const auth of [
      { route: "codex", model: "gpt-5.4", apiKey: "sentinel" },
      { route: "grok", model: "grok-4.7", tokens: { accessToken: "sentinel" } },
      { route: "codex", model: "" },
      { route: "codex", model: "gpt-5.4", store: {} },
    ]) {
      await expect(createHost({ ...base, auth: auth as unknown as HostOptions["auth"] })).rejects.toBeInstanceOf(HostError);
    }
    await expect(createHost({ ...base, auth: { route: "api-key" as unknown as "codex", model: "x" } })).rejects.toMatchObject({ code: "unsupported-policy" });
    await expect(createHost({ ...base, auth: { route: "codex", model: "gpt-5.4", store: fakeCredentialStore() } })).resolves.toBeDefined();
  });
});

for (const route of ["codex", "grok"] as const) {
  test(`${route} readiness distinguishes configured, missing, locked and malformed stores`, async () => {
    const model = route === "codex" ? "gpt-5.4" : "grok-4.7";
    const empty = fakeCredentialStore();
    expect(await checkAuthReadiness({ route, model, store: empty })).toMatchObject({ status: "needs-login", route, model });
    const locked = { async get(): Promise<string | null> { throw new Error("native locked sentinel"); }, async set(): Promise<void> { throw new Error("x"); }, async delete(): Promise<boolean> { throw new Error("x"); } };
    const lockedReadiness = await checkAuthReadiness({ route, model, store: locked });
    expect(lockedReadiness.status).toBe("store-unavailable");
    expect(JSON.stringify(lockedReadiness)).not.toContain("sentinel");
    const malformed = fakeCredentialStore();
    await malformed.set(route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity(), "not-json{{{sentinel-secret");
    const malformedReadiness = await checkAuthReadiness({ route, model, store: malformed });
    expect(malformedReadiness.status).toBe("invalid-store");
    expect(JSON.stringify(malformedReadiness)).not.toContain("sentinel-secret");
    const valid = fakeCredentialStore();
    await valid.set(route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity(),
      JSON.stringify({ accessToken: "fixture-token", refreshToken: "fixture-refresh", expiresAt: Date.now() + 3_600_000, obtainedAt: Date.now() }));
    expect(await checkAuthReadiness({ route, model, store: valid })).toMatchObject({ status: "configured-unverified", observedInference: "not-checked" });
    const expiredNoRefresh = fakeCredentialStore();
    await expiredNoRefresh.set(route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity(),
      JSON.stringify({ accessToken: "old", expiresAt: Date.now() - 1000, obtainedAt: 0 }));
    expect(await checkAuthReadiness({ route, model, store: expiredNoRefresh })).toMatchObject({ status: "needs-login" });
  });
}

for (const route of ["codex", "grok"] as const) {
  test(`${route} explicit API-key env bait never switches billing or leaks`, async () => {
    const model = route === "codex" ? "gpt-5.4" : "grok-4.7";
    const sentinel = `env-bait-${route}-sentinel`;
    const env = route === "codex" ? { OPENAI_API_KEY: sentinel } : { XAI_API_KEY: sentinel };
    const store = fakeCredentialStore();
    const readiness = await checkAuthReadiness({ route, model, store, env });
    expect(readiness.status).toBe("needs-login");
    expect(JSON.stringify(readiness)).not.toContain(sentinel);
    expect(readiness.nextAction).not.toContain(sentinel);
  });
}

test("codex route-bound run completes through the subscription transport with observed inference", async () => {
  await withTempDir(async dir => {
    const store = fakeCredentialStore();
    await store.set(codexSubscriptionIdentity(), JSON.stringify({ accessToken: "codex-valid", refreshToken: "r", expiresAt: Date.now() + 3_600_000, obtainedAt: Date.now() }));
    const seen: string[] = [];
    const config = await options(dir, { route: "codex", model: "gpt-5.4", store,
      fetch: (async (url: string | URL | Request, _init?: RequestInit) => {
        seen.push(String(url));
        expect(String(_init?.body ?? "")).not.toContain("codex-valid");
        return codexSse();
      }) as unknown as HostOptions["auth"] extends { fetch?: infer F } ? F : never });
    const host = await createHost(config);
    expect(host.auth?.route).toBe("codex");
    expect(host.auth?.model).toBe("gpt-5.4");
    expect(host.auth?.credential.account).toBe("codex-subscription:chatgpt");
    expect((await host.auth!.checkReadiness()).status).toBe("configured-unverified");
    const session = await host.createSession();
    const run = await session.submitWithRoute({ text: "hello route" });
    expect(run.outcome).toBe("completed");
    if (run.outcome !== "completed") throw new Error("expected completion");
    expect(run.observedInference).toBe("observed");
    expect(run.message.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(seen).toEqual([CODEX_RESPONSES_URL]);
    expect(JSON.stringify(run)).not.toContain("codex-valid");
    await session.close(); await host.close();
  });
});

test("grok route-bound run completes through the subscription transport with observed inference", async () => {
  await withTempDir(async dir => {
    const store = fakeCredentialStore();
    await store.set(grokSubscriptionIdentity(), JSON.stringify({ accessToken: "grok-valid", refreshToken: "r", obtainedAt: Date.now(), expiresAt: Date.now() + 3_600_000 }));
    const seen: string[] = [];
    const config = await options(dir, { route: "grok", model: "grok-4.7", store,
      fetch: (async (url: string | URL | Request, _init?: RequestInit) => {
        seen.push(String(url));
        return xaiSse();
      }) as never });
    const host = await createHost(config);
    expect(host.auth?.credential.account).toBe("grok-subscription:xai");
    const session = await host.createSession();
    const run = await session.submitWithRoute({ text: "hello grok" });
    expect(run.outcome).toBe("completed");
    if (run.outcome !== "completed") throw new Error("expected completion");
    expect(run.message.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(seen.some(url => url.includes("/responses"))).toBe(true);
    expect(seen.some(url => url.includes("auth.x.ai"))).toBe(false);
    expect(JSON.stringify(run)).not.toContain("grok-valid");
    await session.close(); await host.close();
  });
});

for (const route of ["codex", "grok"] as const) {
  test(`${route} missing, locked and malformed stores return safe status without inference`, async () => {
    await withTempDir(async dir => {
      const model = route === "codex" ? "gpt-5.4" : "grok-4.7";
      for (const kind of ["missing", "locked", "malformed"] as const) {
        const store = kind === "missing" ? fakeCredentialStore()
          : kind === "locked" ? { async get(): Promise<string | null> { throw new Error("store-sentinel-secret"); }, async set(): Promise<void> {}, async delete(): Promise<boolean> { return false; } }
          : (() => { const s = fakeCredentialStore(); return s; })();
        if (kind === "malformed") await (store as ReturnType<typeof fakeCredentialStore>).set(route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity(), "{{{bad-sentinel");
        let fetches = 0;
        const config = await options(dir, { route, model, store, fetch: (async (_url?: unknown, _init?: unknown) => { fetches++; throw new Error("must not call transport"); }) as never });
        const host = await createHost(config);
        const session = await host.createSession();
        const run = await session.submitWithRoute({ text: "needs login" });
        expect(run.outcome).toBe("error");
        if (run.outcome === "error" || run.outcome === "cancelled" || run.outcome === "max_turns") {
          expect(run.auth.route).toBe(route);
          expect(run.auth.model).toBe(model);
          expect(["needs-login", "store-unavailable", "invalid-store"]).toContain(run.auth.status);
          expect(JSON.stringify(run)).not.toContain("sentinel");
          expect(run.auth.nextAction.length).toBeGreaterThan(0);
        } else throw new Error("expected auth error");
        expect(fetches).toBe(0);
        await session.close(); await host.close();
      }
    });
  });
}

for (const route of ["codex", "grok"] as const) {
  test(`${route} refresh succeeds without leaking tokens`, async () => {
    const model = route === "codex" ? "gpt-5.4" : "grok-4.7";
    const identity = route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity();
    await withTempDir(async dir => {
      const store = fakeCredentialStore();
      await store.set(identity, JSON.stringify({ accessToken: "stale-token", refreshToken: "fixture-refresh", expiresAt: 1, obtainedAt: 1 }));
      let refreshes = 0;
      const fetch = (async (url: string | URL | Request, _init?: RequestInit) => {
        if (String(url).includes("/oauth/token") || String(url).includes("auth.x.ai")) {
          refreshes++;
          return Response.json({ access_token: "fresh-token", refresh_token: "fixture-refresh", expires_in: 3600 });
        }
        return route === "codex" ? codexSse() : xaiSse();
      }) as never;
      const host = await createHost(await options(dir, { route, model, store, fetch }));
      const session = await host.createSession();
      const run = await session.submitWithRoute({ text: "refresh me" });
      expect(run.outcome).toBe("completed");
      expect(refreshes).toBe(1);
      expect(JSON.stringify(await store.get(identity))).toContain("fresh-token");
      await session.close(); await host.close();
    });
  });
  test(`${route} rejection maps to stable rejected without secrets`, async () => {
    const model = route === "codex" ? "gpt-5.4" : "grok-4.7";
    const identity = route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity();
    await withTempDir(async dir => {
      const store = fakeCredentialStore();
      await store.set(identity, JSON.stringify({ accessToken: "rejected-token-sentinel", refreshToken: "r", expiresAt: Date.now() + 3_600_000, obtainedAt: Date.now() }));
      const fetch = (async (_url?: unknown, _init?: unknown) => new Response("rejected-token-sentinel detail", { status: 401 })) as never;
      const host = await createHost(await options(dir, { route, model, store, fetch }));
      const session = await host.createSession();
      const run = await session.submitWithRoute({ text: "rejected" });
      expect(run.outcome).toBe("error");
      if (run.outcome !== "completed") {
        expect(run.auth.status).toBe("rejected");
        expect(run.auth.route).toBe(route);
        expect(JSON.stringify(run)).not.toContain("rejected-token-sentinel");
        expect(run.auth.nextAction).not.toContain("API-key billing");
      }
      expect(host.auth?.route).toBe(route);
      await session.close(); await host.close();
    });
  });
  test(`${route} quota maps to quota-exceeded without secrets`, async () => {
    const model = route === "codex" ? "gpt-5.4" : "grok-4.7";
    const identity = route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity();
    await withTempDir(async dir => {
      const store = fakeCredentialStore();
      await store.set(identity, JSON.stringify({ accessToken: "quota-token", refreshToken: "r", expiresAt: Date.now() + 3_600_000, obtainedAt: Date.now() }));
      const fetch = (async (_url?: unknown, _init?: unknown) => new Response("quota-token bodies", { status: 429 })) as never;
      const host = await createHost(await options(dir, { route, model, store, fetch }));
      const session = await host.createSession();
      const run = await session.submitWithRoute({ text: "quota" });
      expect(run.outcome).toBe("error");
      if (run.outcome !== "completed") {
        expect(run.auth.status).toBe("quota-exceeded");
        expect(JSON.stringify(run)).not.toContain("quota-token");
      }
      await session.close(); await host.close();
    });
  }, 15000);
  test(`${route} integration failure maps to integration-unavailable without secrets`, async () => {
    const model = route === "codex" ? "gpt-5.4" : "grok-4.7";
    const identity = route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity();
    await withTempDir(async dir => {
      const store = fakeCredentialStore();
      await store.set(identity, JSON.stringify({ accessToken: "integration-token-sentinel", refreshToken: "r", expiresAt: Date.now() + 3_600_000, obtainedAt: Date.now() }));
      const fetch = (async (_url?: unknown, _init?: unknown) => { throw new Error("integration-token-sentinel socket down"); }) as never;
      const host = await createHost(await options(dir, { route, model, store, fetch }));
      const session = await host.createSession();
      const run = await session.submitWithRoute({ text: "integration" });
      expect(run.outcome).toBe("error");
      if (run.outcome !== "completed") {
        expect(run.auth.status).toBe("integration-unavailable");
        expect(JSON.stringify(run)).not.toContain("integration-token-sentinel");
      }
      await session.close(); await host.close();
    });
  }, 15000);
}

for (const route of ["codex", "grok"] as const) {
  test(`${route} concurrent runs share one refresh`, async () => {
    await withTempDir(async dir => {
      const model = route === "codex" ? "gpt-5.4" : "grok-4.7";
      const identity = route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity();
      const store = fakeCredentialStore();
      await store.set(identity, JSON.stringify({ accessToken: "stale", refreshToken: "shared-refresh", expiresAt: 1, obtainedAt: 1 }));
      let refreshes = 0;
      const fetch = (async (url: string | URL | Request) => {
        if (String(url).includes("/oauth/token") || String(url).includes("auth.x.ai")) {
          refreshes++;
          await new Promise(resolve => setTimeout(resolve, 20));
          return Response.json({ access_token: "fresh-shared", refresh_token: "shared-refresh", expires_in: 3600 });
        }
        return route === "codex" ? codexSse() : xaiSse();
      }) as never;
      const config = await options(dir, { route, model, store, fetch });
      const first = await createHost(config), second = await createHost(config);
      const a = await first.createSession(), b = await second.createSession();
      const [ra, rb] = await Promise.all([a.submitWithRoute({ text: "one" }), b.submitWithRoute({ text: "two" })]);
      expect(ra.outcome).toBe("completed");
      expect(rb.outcome).toBe("completed");
      expect(refreshes).toBe(1);
      await a.close(); await b.close(); await first.close(); await second.close();
    });
  });
}

for (const route of ["codex", "grok"] as const) {
  test(`${route} cancelled peer does not corrupt shared renewal`, async () => {
    await withTempDir(async dir => {
      const model = route === "codex" ? "gpt-5.4" : "grok-4.7";
      const identity = route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity();
      const store = fakeCredentialStore();
      await store.set(identity, JSON.stringify({ accessToken: "stale", refreshToken: "shared", expiresAt: 1, obtainedAt: 1 }));
      const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      let refreshes = 0;
      const fetch = (async (url: string | URL | Request) => {
        if (String(url).includes("/oauth/token") || String(url).includes("auth.x.ai")) {
          refreshes++;
          started.resolve();
          await release.promise;
          return Response.json({ access_token: "fresh-after-cancel", refresh_token: "shared", expires_in: 3600 });
        }
        return route === "codex" ? codexSse("continued") : xaiSse();
      }) as never;
      const config = await options(dir, { route, model, store, fetch });
      const host = await createHost(config);
      const a = await host.createSession(), b = await host.createSession();
      const abort = new AbortController();
      const cancelled = a.submitWithRoute({ text: "cancel me" }, abort.signal);
      await started.promise;
      const continuing = b.submitWithRoute({ text: "continue" });
      // Let the second caller register before cancelling the first so the shared renewal stays alive.
      await Bun.sleep(10);
      abort.abort();
      release.resolve();
      const [ra, rb] = await Promise.all([cancelled, continuing]);
      expect(ra.outcome).toBe("cancelled");
      expect(rb.outcome).toBe("completed");
      expect(refreshes).toBe(1);
      await a.close(); await b.close(); await host.close();
    });
  });
}

for (const route of ["codex", "grok"] as const) {
  for (const mutation of ["logout", "replacement"] as const) {
    test(`${route} ${mutation} fences stale refresh writes`, async () => {
      const identity = route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity();
      const store = fakeCredentialStore();
      await store.set(identity, JSON.stringify({ accessToken: "old", refreshToken: "old-refresh", expiresAt: 1, obtainedAt: 1 }));
      const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      let refreshes = 0;
      const fetch = (async (url: string | URL | Request) => {
        if (String(url).includes("/oauth/token") || String(url).includes("auth.x.ai")) {
          refreshes++;
          started.resolve();
          await release.promise;
          return Response.json({ access_token: "stale-renewal", refresh_token: "stale-rotation", expires_in: 3600 });
        }
        throw new Error("must not reach inference after fencing");
      }) as never;
      const { createSubscriptionTokenRefresher: createGrok, saveSubscriptionTokens: saveGrok, deleteSubscriptionTokens: deleteGrok, loadSubscriptionTokens: loadGrok } =
        await import("../src/model/providers/grok-subscription.ts");
      const { createSubscriptionTokenRefresher: createCodex, saveSubscriptionTokens: saveCodex, clearSubscriptionTokens: clearCodex, loadSubscriptionTokens: loadCodex } =
        await import("../src/model/providers/codex-subscription.ts");
      const refresher = route === "codex" ? createCodex({ store, fetch: fetch as never }) : createGrok({ store, fetch: fetch as never });
      const pending = refresher.getValidAccessToken().catch(error => error);
      await started.promise;
      await Bun.sleep(0);
      if (mutation === "logout") {
        if (route === "codex") await clearCodex(store); else await deleteGrok(store);
      } else {
        if (route === "codex") await saveCodex(store, { accessToken: "new-account", obtainedAt: 123 });
        else await saveGrok(store, { accessToken: "new-account", obtainedAt: 123 });
      }
      release.resolve();
      const result = await pending;
      expect(String((result as Error)?.message ?? "")).toMatch(/revoked|login/i);
      const current = route === "codex" ? await loadCodex(store) : await loadGrok(store);
      expect(current?.accessToken ?? null).toBe(mutation === "logout" ? null : "new-account");
      expect(refreshes).toBe(1);
    });
  }
}

test("route isolation keeps identities separate and never falls back to API keys", async () => {
  await withTempDir(async dir => {
    const codexStore = fakeCredentialStore();
    await codexStore.set(codexSubscriptionIdentity(), JSON.stringify({ accessToken: "codex-only", refreshToken: "r", expiresAt: Date.now() + 3_600_000, obtainedAt: Date.now() }));
    await codexStore.set(grokSubscriptionIdentity(), JSON.stringify({ accessToken: "grok-only", refreshToken: "r", obtainedAt: Date.now(), expiresAt: Date.now() + 3_600_000 }));
    const codexReadiness = await checkAuthReadiness({ route: "codex", model: "gpt-5.4", store: codexStore });
    expect(codexReadiness.credential.account).toBe("codex-subscription:chatgpt");
    const grokReadiness = await checkAuthReadiness({ route: "grok", model: "grok-4.7", store: codexStore });
    expect(grokReadiness.credential.account).toBe("grok-subscription:xai");
    // Codex failure keeps codex route/model and never touches the grok identity.
    const failing = (async (_url?: unknown, _init?: unknown) => new Response("denied", { status: 401 })) as never;
    const host = await createHost(await options(dir, { route: "codex", model: "gpt-5.4", store: codexStore, fetch: failing, env: { OPENAI_API_KEY: "bait-codex", XAI_API_KEY: "bait-grok" } }));
    expect(host.auth?.route).toBe("codex");
    const session = await host.createSession();
    const run = await session.submitWithRoute({ text: "isolated" });
    expect(run.outcome).toBe("error");
    if (run.outcome !== "completed") {
      expect(run.auth.route).toBe("codex");
      expect(run.auth.model).toBe("gpt-5.4");
      expect(run.auth.status).toBe("rejected");
      expect(JSON.stringify(run)).not.toContain("bait-codex");
      expect(JSON.stringify(run)).not.toContain("bait-grok");
    }
    expect(await codexStore.get(grokSubscriptionIdentity())).toContain("grok-only");
    expect(host.auth?.model).toBe("gpt-5.4");
    await session.close(); await host.close();
  });
});

test("classifyAuthError never includes native secrets and never switches route", () => {
  const sentinel = "native-secret-sentinel-398";
  const error = new Error(`Cannot read credential: ${sentinel}`);
  for (const route of ["codex", "grok"] as const) {
    const classified = classifyAuthError(error, { route, model: route === "codex" ? "gpt-5.4" : "grok-4.7", store: fakeCredentialStore() });
    expect(classified.route).toBe(route);
    expect(JSON.stringify(classified)).not.toContain(sentinel);
    expect(classified.status).toBe("store-unavailable");
  }
  const plan = classifyAuthError(new Error("Your Grok plan doesn't include API access. Use an xAI API key instead. sentinel-x"), { route: "grok", model: "grok-4.7" });
  expect(plan.status).toBe("rejected");
  expect(JSON.stringify(plan)).not.toContain("sentinel-x");
});

test("status-less refusal and rate-limit bodies hit their documented categories", () => {
  for (const route of ["codex", "grok"] as const) {
    const selection = { route, model: route === "codex" ? "gpt-5.4" : "grok-4.7", store: fakeCredentialStore() };
    // Sanitized provider errors carry no status, so classification stays message-based.
    expect(classifyAuthError(new Error("request failed (HTTP 402)"), selection).status).toBe("rejected");
    expect(classifyAuthError(new Error("request failed (HTTP 403)"), selection).status).toBe("rejected");
    expect(classifyAuthError(new Error("request failed (HTTP 429)"), selection).status).toBe("quota-exceeded");
    expect(classifyAuthError(new Error("request failed (HTTP 500)"), selection).status).toBe("integration-unavailable");
  }
});

test("default native store is memoized per selection identity", async () => {
  const { effectiveStore } = await import("../src/host/auth-routes.ts");
  const selection = { route: "codex" as const, model: "gpt-5.4" };
  expect(effectiveStore(selection)).toBe(effectiveStore(selection));
  expect(effectiveStore({ route: "codex" as const, model: "gpt-5.4" })).not.toBe(effectiveStore(selection));
  const explicit = fakeCredentialStore();
  expect(effectiveStore({ route: "codex" as const, model: "gpt-5.4", store: explicit })).toBe(explicit);
});

test("containsNoSecrets covers values and circular input without throwing", async () => {
  const { containsNoSecrets } = await import("../src/host/auth-routes.ts");
  expect(containsNoSecrets("clean text", ["s3cr3t"])).toBe(true);
  expect(containsNoSecrets("has s3cr3t inside", ["s3cr3t"])).toBe(false);
  expect(containsNoSecrets({ nested: ["s3cr3t"] }, ["s3cr3t"])).toBe(false);
  expect(containsNoSecrets({ nested: ["clean"] }, ["s3cr3t"])).toBe(true);
  expect(containsNoSecrets({ anything: 1 }, [])).toBe(true);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(containsNoSecrets(circular, ["s3cr3t"])).toBe(false);
});

test("direct API users get the same env rejection as host construction", async () => {
  const store = fakeCredentialStore();
  const base = { route: "codex" as const, model: "gpt-5.4", store };
  await expect(checkAuthReadiness({ ...base, env: { lowercase: "x" } })).rejects.toThrow("invalid");
  await expect(checkAuthReadiness({ ...base, env: { GOOD: 1 as unknown as string } })).rejects.toThrow("invalid");
  expect(() => describeAuthRoute({ ...base, env: { "has-dash": "x" } })).toThrow("invalid");
  const oversized: Record<string, string> = {};
  for (let i = 0; i < 65; i++) oversized[`K${i}`] = "v";
  expect(() => describeAuthRoute({ ...base, env: oversized })).toThrow("invalid");
  expect(describeAuthRoute({ ...base, env: { GOOD: "v", EMPTY: undefined } }).supported).toBe(true);
  await withTempDir(async dir => {
    const config = await options(dir);
    await expect(createHost({ ...config, auth: { ...base, env: { lowercase: "x" } } })).rejects.toMatchObject({ code: "invalid-options" });
  });
});

test("SDK retries stay disabled; transport refresh and bounded core retries stay authoritative", async () => {
  await withTempDir(async dir => {
    // Persistent 401 is never retried by the SDK or the loop.
    const store = fakeCredentialStore();
    await store.set(codexSubscriptionIdentity(), JSON.stringify({ accessToken: "revoked", refreshToken: "r", expiresAt: Date.now() + 3_600_000, obtainedAt: Date.now() }));
    let calls = 0;
    const host = await createHost(await options(dir, { route: "codex", model: "gpt-5.4", store, fetch: (async (_url?: unknown, _init?: unknown) => { calls++; return new Response("denied", { status: 401 }); }) as never }));
    const session = await host.createSession();
    const run = await session.submitWithRoute({ text: "revoked" });
    expect(run.outcome).toBe("error");
    expect(calls).toBe(1);
    await session.close(); await host.close();
  });
  await withTempDir(async dir => {
    // Persistent 500 is retried only by Schway's bounded loop, not the SDK.
    const store = fakeCredentialStore();
    await store.set(grokSubscriptionIdentity(), JSON.stringify({ accessToken: "valid", refreshToken: "r", obtainedAt: Date.now(), expiresAt: Date.now() + 3_600_000 }));
    let calls = 0;
    const host = await createHost(await options(dir, { route: "grok", model: "grok-4.7", store, fetch: (async (_url?: unknown, _init?: unknown) => { calls++; return new Response("busy", { status: 500 }); }) as never }));
    const session = await host.createSession();
    const run = await session.submitWithRoute({ text: "flaky" });
    expect(run.outcome).toBe("error");
    expect(calls).toBe(3);
    await session.close(); await host.close();
  });
});

async function externalAuth(dir: string, input: Record<string, unknown>, guard: string): Promise<unknown> {
  const consumer = join(dir, `auth-${crypto.randomUUID()}`);
  await mkdir(join(consumer, "node_modules"), { recursive: true });
  try { await symlink(resolve(import.meta.dir, ".."), join(consumer, "node_modules/schway"), "dir"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  await Bun.write(join(consumer, "consumer.ts"), await Bun.file(join(import.meta.dir, "fixtures/host-auth-route-consumer.ts")).text());
  await Bun.write(join(consumer, "guard.ts"), guard);
  const workspaceRoot = join(consumer, "work"), homeDirectory = join(consumer, "home"), sessionDirectory = join(consumer, "sessions");
  await mkdir(workspaceRoot, { recursive: true }); await mkdir(homeDirectory, { recursive: true });
  const payload = { ...input, workspaceRoot, homeDirectory, sessionDirectory };
  const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", join(consumer, "guard.ts"), join(consumer, "consumer.ts")],
    { cwd: consumer, env: buildIsolatedCliEnv(homeDirectory), stdin: new Blob([JSON.stringify(payload)]), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, stderr).toBe(0); expect(stderr).toBe("");
  return JSON.parse(stdout);
}

test("capability discovery loads no provider or TUI", async () => {
  await withTempDir(async dir => {
    await mkdir(join(dir, "home"), { recursive: true });
    const result = await externalAuth(dir, { action: "capabilities" },
      `await Bun.plugin({name:'auth-guard',setup(builder){
        builder.onLoad({filter:/(?:[/\\\\](?:providers|tui)[/\\\\]|@opentui|[/\\\\]openai[/\\\\])/},()=>{throw new Error('Forbidden provider or TUI init');});
      }});`);
    expect(result).toMatchObject({ contract: "schway.host.base/v1", authContract: "schway.host.auth-routes/v1" });
  });
});

test("only the selected route adapter loads in a fresh process", async () => {
  await withTempDir(async dir => {
    await mkdir(join(dir, "home"), { recursive: true });
    const codex = await externalAuth(dir, { action: "codex-route" },
      `await Bun.plugin({name:'codex-guard',setup(builder){
        builder.onLoad({filter:/providers\\/grok-subscription/},()=>{throw new Error('unselected grok loaded');});
        builder.onLoad({filter:/providers\\/xai\\.ts/},()=>{throw new Error('unselected xai loaded');});
        builder.onLoad({filter:/providers\\/openai\\.ts/},()=>{throw new Error('native openai loaded');});
        builder.onLoad({filter:/providers\\/openai-compatible/},()=>{throw new Error('unselected compatible loaded');});
        builder.onLoad({filter:/\\/tui\\//},()=>{throw new Error('TUI loaded');});
        builder.onLoad({filter:/@opentui/},()=>{throw new Error('renderer loaded');});
      }});`);
    expect(codex).toMatchObject({ outcome: "completed" });
    const grok = await externalAuth(dir, { action: "grok-route" },
      `await Bun.plugin({name:'grok-guard',setup(builder){
        builder.onLoad({filter:/providers\\/codex-subscription/},()=>{throw new Error('unselected codex loaded');});
        builder.onLoad({filter:/providers\\/openai\\.ts/},()=>{throw new Error('native openai loaded');});
        builder.onLoad({filter:/providers\\/openai-compatible/},()=>{throw new Error('unselected compatible loaded');});
        builder.onLoad({filter:/\\/tui\\//},()=>{throw new Error('TUI loaded');});
        builder.onLoad({filter:/@opentui/},()=>{throw new Error('renderer loaded');});
      }});`);
    expect(grok).toMatchObject({ outcome: "completed" });
  });
});

test("independent runs may deliberately choose different routes", async () => {
  await withTempDir(async dir => {
    const codexStore = fakeCredentialStore();
    await codexStore.set(codexSubscriptionIdentity(), JSON.stringify({ accessToken: "codex-a", refreshToken: "r", expiresAt: Date.now() + 3_600_000, obtainedAt: Date.now() }));
    const grokStore = fakeCredentialStore();
    await grokStore.set(grokSubscriptionIdentity(), JSON.stringify({ accessToken: "grok-b", refreshToken: "r", obtainedAt: Date.now(), expiresAt: Date.now() + 3_600_000 }));
    const codexHost = await createHost(await options(join(dir, "a"), { route: "codex", model: "gpt-5.4", store: codexStore, fetch: (async (_url?: unknown, _init?: unknown) => codexSse()) as never }));
    const grokHost = await createHost(await options(join(dir, "b"), { route: "grok", model: "grok-4.7", store: grokStore, fetch: (async (_url?: unknown, _init?: unknown) => xaiSse()) as never }));
    const a = await codexHost.createSession(), b = await grokHost.createSession();
    const [ra, rb] = await Promise.all([a.submitWithRoute({ text: "codex run" }), b.submitWithRoute({ text: "grok run" })]);
    expect(ra.outcome).toBe("completed");
    expect(rb.outcome).toBe("completed");
    expect(codexHost.auth?.route).toBe("codex");
    expect(grokHost.auth?.route).toBe("grok");
    await a.close(); await b.close(); await codexHost.close(); await grokHost.close();
  });
});

test("submitWithRoute without a bound route rejects as invalid options", async () => {
  await withTempDir(async dir => {
    const host = await createHost(await options(dir));
    expect(host.auth).toBeUndefined();
    const session = await host.createSession();
    await expect(session.submitWithRoute({ text: "no route" })).rejects.toMatchObject({ code: "invalid-options" });
    await session.close(); await host.close();
  });
});

for (const route of ["codex", "grok"] as const) {
  test(`${route} credential-write guard fences refresh writes without touching reads`, async () => {
    const { effectiveStore } = await import("../src/host/auth-routes.ts");
    const { isCredentialWriteRefused } = await import("schway/host");
    const base = fakeCredentialStore();
    const identity = route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity();
    await base.set(identity, JSON.stringify({ accessToken: "v", refreshToken: "r", expiresAt: Date.now() + 3_600_000, obtainedAt: Date.now() }));
    const seen: string[] = [];
    const selection = { route, model: route === "codex" ? "gpt-5.4" : "grok-4.7", store: base,
      credentialWriteGuard: async (ref: { account: string; label: string }) => { seen.push(ref.account); } };
    const guarded = effectiveStore(selection);
    // Memoized per selection and guard, so concurrent runs share one renewal lifecycle.
    expect(effectiveStore(selection)).toBe(guarded);
    // Reads stay unfenced and undisturbed.
    expect(await guarded.get(identity)).toContain("v");
    expect(seen).toEqual([]);
    // Mutations invoke the guard before the write (opaque identity only)
    // and recheck it after the backend write completes.
    await guarded.set(identity, "next");
    expect(seen).toEqual([identity.account, identity.account]);
    expect(await base.get(identity)).toBe("next");
    expect(JSON.stringify(seen)).not.toMatch(/v|next/);
    // A refusing guard blocks the backend write and reports a stable refusal.
    const refusing = { ...selection, credentialWriteGuard: () => { throw new Error("owner-cancelled"); } };
    const fenced = effectiveStore(refusing);
    const setError = await fenced.set(identity, "blocked").then(() => null, (error: unknown) => error);
    expect(isCredentialWriteRefused(setError)).toBe(true);
    const deleteError = await fenced.delete(identity).then(() => null, (error: unknown) => error);
    expect(isCredentialWriteRefused(deleteError)).toBe(true);
    expect(await base.get(identity)).toBe("next");
  });

  test(`${route} guard refusal surfaces a terminal outcome with zero credential writes`, async () => {
    const model = route === "codex" ? "gpt-5.4" : "grok-4.7";
    const identity = route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity();
    await withTempDir(async dir => {
      const store = fakeCredentialStore();
      await store.set(identity, JSON.stringify({ accessToken: "stale-token", refreshToken: "fixture-refresh", expiresAt: 1, obtainedAt: 1 }));
      let writes = 0;
      const counting = { ...store,
        set: (async (id: never, value: never) => { writes++; return store.set(id, value); }) as typeof store.set,
        delete: (async (id: never) => { writes++; return store.delete(id); }) as typeof store.delete };
      let refreshes = 0;
      const fetch = (async (url: string | URL | Request, _init?: RequestInit) => {
        if (String(url).includes("/oauth/token") || String(url).includes("auth.x.ai")) {
          refreshes++;
          return Response.json({ access_token: "fresh-token", refresh_token: "fixture-refresh", expires_in: 3600 });
        }
        return route === "codex" ? codexSse() : xaiSse();
      }) as never;
      const host = await createHost(await options(dir, { route, model, store: counting, fetch,
        credentialWriteGuard: () => { throw new Error("owner-cancelled"); } }));
      const session = await host.createSession();
      const run = await session.submitWithRoute({ text: "fenced refresh" });
      expect(run.outcome).toBe("error");
      if (run.outcome === "error") expect(run.auth.status).toBe("store-unavailable");
      expect(refreshes).toBe(1);
      expect(writes).toBe(0);
      expect(JSON.stringify(run)).not.toMatch(/fresh-token|stale-token|fixture-refresh/);
      await session.close(); await host.close();
    });
  });
}

test("credential-write guard validation rejects non-function guards", async () => {
  const base = { route: "codex" as const, model: "gpt-5.4", store: fakeCredentialStore() };
  expect(() => describeAuthRoute({ ...base, credentialWriteGuard: "nope" as never })).toThrow("invalid");
  await expect(checkAuthReadiness({ ...base, credentialWriteGuard: 42 as never })).rejects.toThrow("invalid");
});

test("refusal marker is brand-stable and preserves the guard cause", async () => {
  const { credentialWriteRefusedError, isCredentialWriteRefused, preserveRefusal } = await import("../src/auth/store.ts");
  const cause = new Error("owner-cancelled");
  const refused = credentialWriteRefusedError(cause);
  expect(isCredentialWriteRefused(refused)).toBe(true);
  expect(refused.cause).toBe(cause);
  // Message fallback survives agent-loop sanitization, which rethrows provider
  // failures as plain messages; brand stays the primary direct-path signal.
  expect(isCredentialWriteRefused(new Error("Credential store write refused by the embedding-application fence. No credential was changed."))).toBe(true);
  expect(isCredentialWriteRefused(null)).toBe(false);
  // Preservation passes refusals through and sanitizes anything else.
  expect(preserveRefusal("save", refused)).toBe(refused);
  const converted = preserveRefusal("save", new Error("disk gone")) as Error;
  expect(isCredentialWriteRefused(converted)).toBe(false);
  expect(converted.message).toContain("Cannot save credential");
});

test("post-write guard failure removes exactly the late value", async () => {
  const { effectiveStore } = await import("../src/host/auth-routes.ts");
  const { isCredentialWriteRefused } = await import("schway/host");
  const values = new Map<string, string>();
  let releaseBackend!: () => void;
  const backendGate = new Promise<void>(resolve => { releaseBackend = resolve; });
  let refusing = false;
  const base = {
    get: async (identity: { account: string }) => values.get(identity.account) ?? null,
    set: async (identity: { account: string }, value: string) => {
      await backendGate;
      values.set(identity.account, value);
    },
    delete: async (identity: { account: string }) => values.delete(identity.account),
  };
  const selection = { route: "grok" as const, model: "grok-4.7", store: base,
    credentialWriteGuard: async () => { if (refusing) throw new Error("owner stopped"); } };
  const guarded = effectiveStore(selection);
  const pending = guarded.set({ account: "grok-subscription:xai", label: "Grok subscription" }, "late-token");
  // The stop lands while the backend write is still in flight.
  refusing = true;
  releaseBackend();
  const error = await pending.then(() => null, (failure: unknown) => failure);
  expect(isCredentialWriteRefused(error)).toBe(true);
  // Final visibility is fenced: nothing the stop did not allow stays stored.
  expect(values.size).toBe(0);
});

test("post-write invalidation never removes a concurrent legitimate value", async () => {
  const { effectiveStore } = await import("../src/host/auth-routes.ts");
  const { isCredentialWriteRefused } = await import("schway/host");
  const values = new Map<string, string>();
  let refusing = false;
  const base = {
    get: async (identity: { account: string }) => values.get(identity.account) ?? null,
    set: async (identity: { account: string }, value: string) => { values.set(identity.account, value); },
    delete: async (identity: { account: string }) => values.delete(identity.account),
  };
  const selection = { route: "grok" as const, model: "grok-4.7", store: base,
    credentialWriteGuard: async () => { if (refusing) throw new Error("owner stopped"); } };
  const guarded = effectiveStore(selection);
  await guarded.set({ account: "grok-subscription:xai", label: "x" }, "first-token");
  expect(values.get("grok-subscription:xai")).toBe("first-token");
  // A concurrent legitimate login replaces the value after our write but
  // before the post-write recheck observes the stop.
  refusing = true;
  const overwrite = (async () => {
    values.set("grok-subscription:xai", "fresh-login");
  })();
  const error = await guarded.set({ account: "grok-subscription:xai", label: "x" }, "stale-token")
    .then(() => null, (failure: unknown) => failure);
  await overwrite;
  expect(isCredentialWriteRefused(error)).toBe(true);
  expect(values.get("grok-subscription:xai")).toBe("fresh-login");
});

test("post-write cleanup prefers atomic compare-and-delete when offered", async () => {
  const { effectiveStore } = await import("../src/host/auth-routes.ts");
  const { isCredentialWriteRefused } = await import("schway/host");
  const calls: string[] = [];
  const backend = new Map<string, string>();
  const base = {
    get: async (identity: { account: string }) => { calls.push("get"); return backend.get(identity.account) ?? null; },
    set: async (identity: { account: string }, value: string) => { calls.push("set"); backend.set(identity.account, value); },
    delete: async (identity: { account: string }) => { calls.push("delete"); return backend.delete(identity.account); },
    compareAndDelete: async (identity: { account: string }, expected: string) => {
      calls.push("compareAndDelete");
      if (backend.get(identity.account) !== expected) return false;
      backend.delete(identity.account);
      return true;
    },
  };
  const selection = { route: "grok" as const, model: "grok-4.7", store: base,
    // Pass the pre-write check, refuse the post-write recheck: the late
    // value must be removed atomically. First set passes both checks;
    // the second set passes pre-write and fails post-write.
    credentialWriteGuard: (() => { let calls = 0; return async () => { calls++; if (calls >= 4) throw new Error("owner stopped"); }; })() };
  const guarded = effectiveStore(selection);
  await guarded.set({ account: "grok-subscription:xai", label: "x" }, "fresh-token");
  expect(backend.get("grok-subscription:xai")).toBe("fresh-token");
  const error = await guarded.set({ account: "grok-subscription:xai", label: "x" }, "late-token")
    .then(() => null, (failure: unknown) => failure);
  expect(isCredentialWriteRefused(error)).toBe(true);
  // Atomic path: no read-then-delete pair, exactly one guarded removal.
  expect(calls.filter(call => call === "compareAndDelete")).toHaveLength(1);
  expect(calls.filter(call => call === "get" || call === "delete")).toEqual([]);
  expect(backend.size).toBe(0);
});

test("native store compare-and-delete is best-effort on the injected backend", async () => {
  const { createNativeCredentialStore } = await import("../src/auth/store.ts");
  const backend = new Map<string, string>();
  const secrets = {
    get: async ({ name }: { service: string; name: string }) => backend.get(name) ?? null,
    set: async ({ name, value }: { service: string; name: string; value: string }) => { backend.set(name, value); },
    delete: async ({ name }: { service: string; name: string }) => backend.delete(name),
  };
  const store = createNativeCredentialStore(secrets as never);
  await store.set({ account: "a", label: "a" }, "v1");
  expect(await store.compareAndDelete!({ account: "a", label: "a" }, "other")).toBe(false);
  expect(backend.get("a")).toBe("v1");
  expect(await store.compareAndDelete!({ account: "a", label: "a" }, "v1")).toBe(true);
  expect(backend.has("a")).toBe(false);
});
