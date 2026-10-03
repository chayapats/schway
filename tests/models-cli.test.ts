import { describe, expect, test } from "bun:test";
import { parseModelsCommand, runModelsCommand, resolveModelsConnection } from "../src/cli/models.ts";
import { discoverModels } from "../src/model/catalog-discovery.ts";
import { parseModelListResult } from "../src/model/model-list.ts";
import { codexSubscriptionIdentity, credentialIdentity, grokSubscriptionIdentity, type CredentialStore } from "../src/auth/store.ts";

function store(values: Record<string, string> = {}) {
  const reads: string[] = [], writes: string[] = [];
  const credentials: CredentialStore = {
    async get(identity) { reads.push(identity.account); return values[identity.account] ?? null; },
    async set(identity, value) { writes.push(identity.account); values[identity.account] = value; },
    async delete() { throw new Error("Discovery must not delete credentials"); },
  };
  return { credentials, reads, writes };
}

describe("models command boundaries", () => {
  test("accepts only catalog and connection options without interpreting literal filters", () => {
    expect(parseModelsCommand(["models", "list", "--provider=xai", "--xai-auth=api-key", "--filter=GROK.[", "--json"]))
      .toMatchObject({ args: { provider: "xai", xaiAuth: "api-key", filter: "GROK.[", json: true } });
    for (const argument of ["--model=x", "-p", "--resume=x", "--approval=auto", "--debug", "--body=x", "--max-output=3", "--filter=", "--filter=  "]) {
      expect(parseModelsCommand(["models", "list", argument])).toHaveProperty("error");
    }
    expect(parseModelsCommand(["models", "--help", "--json"])).toHaveProperty("error");
  });

  test("usage and help do not load config, env files, credentials or network", async () => {
    for (const argv of [["models", "list", "--resume=secret"], ["models", "list", "--help"]]) {
      let stdout = "", stderr = "";
      const result = await runModelsCommand(argv, {
        cwd: "/", env: {}, stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } },
        loadConfig: async () => { throw new Error("Unexpected config read"); },
        fetch: async () => { throw new Error("Unexpected network"); },
      });
      expect(result).toBe(argv.includes("--help") ? 0 : 2);
      expect(argv.includes("--help") ? stdout : stderr).toContain("schway models list");
      if (!argv.includes("--help")) expect(stdout).toBe("");
      expect(stderr).not.toContain("secret");
    }
  });
});

test("runtime and renewed credentials cannot be reflected into catalog rows or save errors", async () => {
  const result = await discoverModels({ provider: "openai-compatible", baseUrl: "https://fixture.test/v1", auth: "none", runtimeApiKey: "opaque-private", env: {} }, {
    fetch: async () => Response.json({ data: [{ id: "opaque-private" }, { id: "safe-model" }] }),
  });
  expect(result.catalog).toMatchObject({ status: "partial", models: [{ id: "safe-model" }] });
  expect(JSON.stringify(result)).not.toContain("opaque-private");
  const fixture = store({ [codexSubscriptionIdentity().account]: JSON.stringify({ accessToken: "old", refreshToken: "refresh-private", expiresAt: 0 }) });
  fixture.credentials.set = async () => { throw new Error("Cannot save renewed-private-token"); };
  const renewal = await discoverModels({ provider: "openai", openaiAuth: "codex", env: {} }, {
    store: fixture.credentials, fetch: async () => Response.json({ access_token: "renewed-private-token", expires_in: 3_600 }),
  });
  expect(renewal.catalog.status).toBe("error"); expect(JSON.stringify(renewal)).not.toContain("renewed-private-token");
});

function controlledDeadline() {
  let elapsed = 0, budget = 0, started = 0, cleared = 0;
  const controller = new AbortController();
  return {
    controller,
    startDeadline(milliseconds: number) { started++; budget = milliseconds; return { signal: controller.signal, clear() { cleared++; } }; },
    advance(milliseconds: number) { elapsed += milliseconds; if (elapsed >= budget) controller.abort(new DOMException("Fixture deadline", "TimeoutError")); },
    inspect: () => ({ elapsed, budget, started, cleared }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

for (const route of ["codex", "grok"] as const) {
  const provider = route === "codex" ? "openai" as const : "xai" as const;
  const auth = route === "codex" ? { openaiAuth: route } : { xaiAuth: route };
  const identity = route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity();

  test(`${route} total deadline includes refresh and a stalled catalog body`, async () => {
    const fixture = store({ [identity.account]: JSON.stringify({ accessToken: "expired", refreshToken: "refresh-private", expiresAt: 0, obtainedAt: 0 }) });
    const clock = controlledDeadline(), bodyStarted = deferred<void>();
    const signals: AbortSignal[] = [];
    let calls = 0, bodyCancelled = false;
    const pending = discoverModels({ provider, ...auth, env: {} }, {
      ...clock, store: fixture.credentials, fetch: async (url, init) => {
        calls++; signals.push(init!.signal!);
        if (String(url).includes("/token")) {
          clock.advance(4_900);
          return Response.json({ access_token: "renewed", refresh_token: "renewed-refresh", expires_in: 3_600 });
        }
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer renewed");
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"data":[')); bodyStarted.resolve(); }, cancel() { bodyCancelled = true; } }));
      },
    });
    await bodyStarted.promise;
    clock.advance(100);
    const result = await pending;
    expect(result.catalog).toMatchObject({ route, status: "error", models: [] });
    expect(result.error).toContain("timed out after 5 seconds");
    expect(calls).toBe(2); expect(new Set(signals).size).toBe(1);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(bodyCancelled).toBe(true); expect(fixture.writes).toEqual([identity.account]);
    expect(clock.inspect()).toEqual({ elapsed: 5_000, budget: 5_000, started: 1, cleared: 1 });
  });

  for (const cancel of ["deadline", "parent"] as const) test(`${route} ${cancel} abort reaches a late refresh and prevents token writes`, async () => {
    const fixture = store({ [identity.account]: JSON.stringify({ accessToken: "expired", refreshToken: "private-refresh", expiresAt: 0, obtainedAt: 0 }) });
    const clock = controlledDeadline(), parent = new AbortController();
    const started = deferred<void>(), response = deferred<Response>();
    let requestSignal: AbortSignal | undefined, bodyCancelled = false;
    const pending = discoverModels({ provider, ...auth, env: {}, signal: parent.signal }, {
      ...clock, store: fixture.credentials, fetch: async (_url, init) => { requestSignal = init!.signal!; started.resolve(); return response.promise; },
    });
    await started.promise;
    if (cancel === "deadline") clock.advance(5_000); else parent.abort();
    const result = await pending;
    expect(result.catalog).toMatchObject({ route, status: "error", models: [] });
    expect(result.error).toContain(cancel === "deadline" ? "timed out" : "cancelled");
    expect(requestSignal?.aborted).toBe(true);
    response.resolve(new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"access_token":"too-late","expires_in":3600}')); }, cancel() { bodyCancelled = true; } })));
    await Bun.sleep(0);
    expect(fixture.writes).toEqual([]); expect(bodyCancelled).toBe(true);
  });
}

test("auto API precedence reads only the required identities and uses one selected key", async () => {
  for (const provider of ["openai", "xai"] as const) {
    const subscription = provider === "openai" ? codexSubscriptionIdentity() : grokSubscriptionIdentity();
    const key = credentialIdentity({ provider });
    const fixture = store({ [key.account]: "selected-key" });
    const result = await discoverModels({ provider, env: {} }, { store: fixture.credentials, fetch: async (_url, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer selected-key");
      return Response.json({ data: [{ id: provider === "openai" ? "gpt-test" : "grok-test" }] });
    } });
    expect(result.catalog.status).toBe("complete");
    expect(fixture.reads).toEqual([subscription.account, key.account]);
  }
});

test("profile resolution isolates endpoint, headers and credential identity without requiring a model", async () => {
  const connection = resolveModelsConnection({
    user: { provider: "openai", model: "old", thinking: "ultra", headers: { "X-Old": "user" }, profiles: { local: { baseUrl: "https://old.test/v1", credentialEnv: "OLD_KEY" } } },
    project: { profiles: { local: { baseUrl: "https://new.test/v1/", credentialEnv: "LOCAL_KEY", credentialIdentity: "own", auth: "required", headers: { "X-Own": "profile" }, model: "unused" } } },
    args: { profile: "local", help: false, json: true, offline: false },
  });
  expect(connection).toMatchObject({ provider: "openai-compatible", baseUrl: "https://new.test/v1/", credentialEnv: "LOCAL_KEY", credentialIdentity: "own", headers: { "X-Own": "profile" }, modelConfigured: false });
  if ("error" in connection) throw new Error(connection.error);
  const fixture = store();
  const result = await discoverModels({ ...connection, env: { LOCAL_KEY: "local-only", OPENAI_API_KEY: "wrong" } }, {
    store: fixture.credentials, fetch: async (url, init) => {
      expect(String(url)).toBe("https://new.test/v1/models");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer local-only");
      expect(new Headers(init?.headers).get("X-Old")).toBeNull();
      return Response.json({ data: [{ id: "org/exact:ID", max_output_tokens: 100 }, { id: "unknown" }] });
    },
  });
  expect(result.catalog).toMatchObject({ profile: "local", route: "compatible", status: "complete", models: [{ id: "org/exact:ID", maxOutput: 100 }, { id: "unknown" }] });
  expect(fixture.reads).toEqual([]);
});

test("caps report partial, while duplicates and intentional visibility filtering stay complete", () => {
  const result = parseModelListResult({ data: [{ id: "b" }, { id: "b" }, { id: "hidden", visibility: "hide" }, { id: "a" }] }, "Fixture");
  expect(result.partial).toBe(false); expect(result.models).toEqual([{ id: "b" }, { id: "a" }]);
  const capped = parseModelListResult({ data: Array.from({ length: 5_001 }, (_, index) => ({ id: `m-${index}` })) }, "Fixture");
  expect(capped.partial).toBe(true); expect(capped.models).toHaveLength(5_000); expect(capped.warnings.join(" ")).toContain("truncated");
});

test("JSON operational failures remain parseable, distinguish failures and contain no raw credentials", async () => {
  for (const failure of [401, 403, 429, "invalid", "oversized", "empty", "network"] as const) {
    let stdout = "", stderr = "";
    const exit = await runModelsCommand(["models", "list", "--provider=openai", "--openai-auth=api-key", "--api-key=opaque-private", "--json"], {
      cwd: "/", env: {}, loadConfig: async () => ({}), store: store().credentials,
      stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } },
      fetch: async () => {
        if (typeof failure === "number") return new Response("opaque-private\u001b[31m", { status: failure });
        if (failure === "invalid") return new Response("not-json opaque-private");
        if (failure === "oversized") return new Response("x".repeat(1_048_577));
        if (failure === "empty") return Response.json({ data: [] });
        throw new Error("opaque-private\u001b[31m https://user:pass@example.test?token=hidden");
      },
    });
    expect(exit).toBe(1); expect(JSON.parse(stdout)).toMatchObject({ schemaVersion: 1, provider: "openai", route: "api-key", status: "error", models: [] });
    expect(stdout + stderr).not.toContain("opaque-private"); expect(stdout + stderr).not.toContain("\u001b");
    const expected = typeof failure === "number" ? `HTTP ${failure}` : failure === "invalid" ? "invalid JSON" : failure === "oversized" ? "1 MiB" : failure === "empty" ? "no selectable" : "Could not reach";
    expect(stderr).toContain(expected);
  }
});

test("unknown provider errors use null, known explicit providers survive setup failure", async () => {
  for (const provider of [undefined, "xai"] as const) {
    let stdout = "";
    const exit = await runModelsCommand(["models", "list", "--json", ...(provider ? [`--provider=${provider}`] : [])], {
      cwd: "/", env: {}, stdout: { write: value => { stdout += value; } }, stderr: { write() {} }, loadConfig: async () => ({ error: "Invalid configuration. Check the config file." }),
    });
    expect(exit).toBe(1); expect(JSON.parse(stdout)).toMatchObject({ provider: provider ?? null, route: "unresolved", status: "error", models: [] });
  }
});

test("literal filtering with no matches is complete and explains how to clear it", async () => {
  let stdout = "", stderr = "";
  const exit = await runModelsCommand(["models", "list", "--provider=openai", "--openai-auth=api-key", "--api-key=key", "--filter=[", "--json"], {
    cwd: "/", env: {}, loadConfig: async () => ({}), stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } },
    fetch: async () => Response.json({ data: [{ id: "gpt-new" }] }),
  });
  expect(exit).toBe(0); expect(stderr).toBe(""); expect(JSON.parse(stdout)).toMatchObject({ status: "complete", models: [] });
  expect(JSON.parse(stdout).warnings.join(" ")).toContain("Remove --filter");
});

test("Grok authorization retry shares the original refresh and body deadline", async () => {
  const identity = grokSubscriptionIdentity();
  const fixture = store({ [identity.account]: JSON.stringify({ accessToken: "rejected", refreshToken: "refresh", expiresAt: Date.now() + 600_000, obtainedAt: 0 }) });
  const clock = controlledDeadline(), bodyStarted = deferred<void>();
  let calls = 0, cancelled = false;
  const signals: AbortSignal[] = [];
  const pending = discoverModels({ provider: "xai", xaiAuth: "grok", env: {} }, {
    ...clock, store: fixture.credentials, fetch: async (url, init) => {
      calls++; signals.push(init!.signal!);
      if (calls === 1) { clock.advance(2_000); return new Response(null, { status: 401 }); }
      if (String(url).includes("/token")) { clock.advance(1_900); return Response.json({ access_token: "renewed", expires_in: 3_600 }); }
      return new Response(new ReadableStream({ start() { bodyStarted.resolve(); }, cancel() { cancelled = true; } }));
    },
  });
  await bodyStarted.promise; clock.advance(1_100);
  const result = await pending;
  expect(result.error).toContain("timed out after 5 seconds"); expect(calls).toBe(3);
  expect(new Set(signals).size).toBe(1); expect(cancelled).toBe(true); expect(fixture.writes).toEqual([identity.account]);
});

test("Grok retry preserves missing-refresh guidance without API billing fallback", async () => {
  const fixture = store({ [grokSubscriptionIdentity().account]: JSON.stringify({ accessToken: "rejected", obtainedAt: 0 }) });
  const result = await discoverModels({ provider: "xai", xaiAuth: "grok", env: {} }, { store: fixture.credentials, fetch: async () => new Response(null, { status: 401 }) });
  expect(result.error).toContain("no refresh token"); expect(result.catalog.route).toBe("grok");
  expect(fixture.reads).toEqual([grokSubscriptionIdentity().account]); expect(fixture.writes).toEqual([]);
});

test("Codex metadata is observed, visibility and duplicates are intentional, and its cap is partial", async () => {
  const fixture = store({ [codexSubscriptionIdentity().account]: JSON.stringify({ accessToken: "subscription", expiresAt: Date.now() + 600_000 }) });
  const result = await discoverModels({ provider: "openai", openaiAuth: "codex", env: {} }, { store: fixture.credentials, fetch: async (_url, init) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer subscription");
    return Response.json({ models: [{ slug: "gpt-Z", visibility: "list", context_window: 2_000, max_output_tokens: 100, is_default: true, supported_reasoning_levels: [{ effort: "none" }, { effort: "high" }] },
      { slug: "hidden", visibility: "hide" }, { slug: "gpt-Z", visibility: "list" }, ...Array.from({ length: 256 }, (_, index) => ({ slug: `gpt-${index}`, visibility: "list" }))] });
  } });
  expect(result.catalog).toMatchObject({ route: "codex", status: "partial" }); expect(result.catalog.models).toHaveLength(256);
  expect(result.catalog.models.find(model => model.id === "gpt-Z")).toEqual({ id: "gpt-Z", contextWindow: 2_000, maxOutput: 100, supportedThinking: ["off", "high"], recommended: true });
  expect(result.catalog.warnings.join(" ")).toContain("truncated");
});

test("intentional non-chat filtering does not consume the selectable-model cap", async () => {
  const result = await discoverModels({ provider: "openai", openaiAuth: "api-key", env: { OPENAI_API_KEY: "private" } }, { fetch: async () => Response.json({ data: [
    ...Array.from({ length: 5_001 }, (_, index) => ({ id: `text-embedding-${index}` })), { id: "gpt-chat" },
  ] }) });
  expect(result.catalog).toMatchObject({ status: "complete", models: [{ id: "gpt-chat" }], warnings: [] });
});

test("explicit env files override inherited keys in order and leave the input environment unchanged", async () => {
  const env = { OPENAI_API_KEY: "inherited" }, fixture = store();
  let stdout = "";
  const exit = await runModelsCommand(["models", "list", "--provider=openai", "--openai-auth=api-key", "--env-file=first", "--env-file=second", "--json"], {
    cwd: "/launch", env, store: fixture.credentials, stdout: { write: value => { stdout += value; } }, stderr: { write() {} },
    loadEnv: async (paths, original) => { expect(paths).toEqual(["/launch/first", "/launch/second"]); expect(original).toBe(env); return { ...original, OPENAI_API_KEY: "second" }; },
    loadConfig: async context => { expect(context.env.OPENAI_API_KEY).toBe("second"); return {}; },
    fetch: async (_url, init) => { expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer second"); return Response.json({ data: [{ id: "gpt-new" }] }); },
  });
  expect(exit).toBe(0); expect(env).toEqual({ OPENAI_API_KEY: "inherited" }); expect(fixture.reads).toEqual([]);
  expect(JSON.parse(stdout).models).toEqual([{ id: "gpt-new" }]);
});

test("compatible profiles keep distinct stored identities even when sharing an endpoint", async () => {
  const ids = ["first", "second"].map(profile => credentialIdentity({ provider: "openai-compatible", profile, baseUrl: "https://same.test/v1" }));
  const fixture = store({ [ids[0]!.account]: "first-key", [ids[1]!.account]: "second-key" });
  const result = await discoverModels({ provider: "openai-compatible", profile: "second", baseUrl: "https://same.test/v1", auth: "required", env: {} }, {
    store: fixture.credentials, fetch: async (_url, init) => { expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer second-key"); return Response.json({ data: [{ id: "model:exact" }] }); },
  });
  expect(result.catalog.status).toBe("complete"); expect(fixture.reads).toEqual([ids[1]!.account]);
});

test("pre-cancelled offline discovery is cancelled without external work", async () => {
  const controller = new AbortController(); controller.abort();
  const result = await discoverModels({ provider: "openai", env: {}, offline: true, signal: controller.signal }, { store: store().credentials });
  expect(result.catalog).toMatchObject({ status: "error", models: [] }); expect(result.error).toContain("cancelled");
});

test("Grok discovery does not reuse route-selection credentials after a concurrent logout", async () => {
  const { deleteSubscriptionTokens } = await import("../src/model/providers/grok-subscription.ts");
  const identity = grokSubscriptionIdentity();
  const values = { [identity.account]: JSON.stringify({ accessToken: "old-access", obtainedAt: 0, expiresAt: Date.now() + 600_000 }) };
  const fixture = store(values), read = fixture.credentials.get;
  let firstRead = true, requests = 0;
  fixture.credentials.delete = async selected => { delete values[selected.account]; return true; };
  fixture.credentials.get = async selected => {
    const value = await read(selected);
    if (firstRead) { firstRead = false; await deleteSubscriptionTokens(fixture.credentials); }
    return value;
  };
  const result = await discoverModels({ provider: "xai", xaiAuth: "grok", env: {} }, {
    store: fixture.credentials, fetch: async () => { requests++; return Response.json({ data: [{ id: "grok-new" }] }); },
  });
  expect(result.catalog.status).toBe("error"); expect(result.error).toContain("No Grok subscription login");
  expect(requests).toBe(0); expect(fixture.writes).toEqual([]);
});

test("HTTP token refresh failures stay distinguishable even without a JSON error body", async () => {
  const fixture = store({ [codexSubscriptionIdentity().account]: JSON.stringify({ accessToken: "expired", refreshToken: "refresh-private", expiresAt: 0 }) });
  const result = await discoverModels({ provider: "openai", openaiAuth: "codex", env: {} }, {
    store: fixture.credentials, fetch: async () => new Response("gateway html", { status: 429 }),
  });
  expect(result.error).toContain("HTTP 429"); expect(result.error).toContain("rate limit");
  expect(fixture.writes).toEqual([]);
});

describe("model catalog discovery", () => {
  test("offline never accesses credentials or network and does not claim an auto route", async () => {
    const credentials: CredentialStore = { async get() { throw new Error("Unexpected read"); }, async set() { throw new Error("Unexpected write"); }, async delete() { throw new Error("Unexpected delete"); } };
    for (const input of [{ provider: "openai" as const }, { provider: "openai" as const, openaiAuth: "codex" as const }, { provider: "xai" as const, xaiAuth: "grok" as const }, { provider: "openai-compatible" as const, baseUrl: "https://example.test/v1" }]) {
      const result = await discoverModels({ ...input, env: {}, offline: true }, { store: credentials, fetch: async () => { throw new Error("Unexpected fetch"); } });
      expect(result.catalog).toMatchObject({ source: "builtin", status: "complete", route: input.provider === "openai-compatible" ? "compatible" : "openaiAuth" in input ? "codex" : "xaiAuth" in input ? "grok" : "unresolved" });
      expect(result.catalog.warnings.join(" ")).toContain("account access unverified");
      if (input.provider !== "openai" || "openaiAuth" in input) expect(result.catalog.models).toEqual([]);
    }
  });

  test("API catalog reports invalid discarded entries, exact sorted IDs and unknown metadata", async () => {
    const fixture = store();
    const result = await discoverModels({ provider: "openai", openaiAuth: "api-key", runtimeApiKey: "private", env: {} }, {
      store: fixture.credentials,
      fetch: async (url, init) => {
        expect(String(url)).toBe("https://api.openai.com/v1/models");
        expect(init?.method).toBe("GET"); expect(init?.redirect).toBe("error");
        return Response.json({ data: [{ id: "gpt-z" }, { id: "gpt-A", context_window: 900 }, { id: "gpt-A" }, { id: "gpt-bad\u001b" }, { id: "text-embedding-3" }] });
      },
    });
    expect(result.catalog).toMatchObject({ provider: "openai", route: "api-key", source: "remote", status: "partial", models: [{ id: "gpt-A", contextWindow: 900 }, { id: "gpt-z" }] });
    expect(fixture.reads).toEqual([]); expect(fixture.writes).toEqual([]);
  });

  test("auto stops looking once the stored subscription wins and never falls back", async () => {
    const fixture = store({ [codexSubscriptionIdentity().account]: JSON.stringify({ accessToken: "subscription", expiresAt: Date.now() + 600_000 }), [credentialIdentity({ provider: "openai" }).account]: "unselected" });
    const result = await discoverModels({ provider: "openai", env: {} }, { store: fixture.credentials, fetch: async () => new Response("do not echo", { status: 403 }) });
    expect(result.catalog).toMatchObject({ route: "codex", status: "error", models: [] });
    expect(fixture.reads).toEqual([codexSubscriptionIdentity().account]);
    expect(fixture.writes).toEqual([]);
  });

  test("explicit Grok touches only its subscription identity", async () => {
    const fixture = store({ [grokSubscriptionIdentity().account]: JSON.stringify({ accessToken: "grok-sub", obtainedAt: Date.now(), expiresAt: Date.now() + 600_000 }) });
    const result = await discoverModels({ provider: "xai", xaiAuth: "grok", runtimeApiKey: "ignored", env: { XAI_API_KEY: "ignored-env" } }, {
      store: fixture.credentials, fetch: async (_url, init) => {
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer grok-sub");
        return Response.json({ data: [{ id: "grok-new" }] });
      },
    });
    expect(result.catalog).toMatchObject({ route: "grok", status: "complete", models: [{ id: "grok-new" }] });
    expect(fixture.reads).toEqual([grokSubscriptionIdentity().account]);
  });
});
