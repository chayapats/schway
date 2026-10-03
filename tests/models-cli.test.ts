import { describe, expect, test } from "bun:test";
import { parseModelsCommand, runModelsCommand, resolveModelsConnection } from "../src/cli/models.ts";
import { discoverModels, safeCatalogMessage } from "../src/model/catalog-discovery.ts";
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

for (const [variant, raw] of [["trimmed", "  private-seed-527941\n"], ["ANSI", "private-\u001b[31mseed\u001b[0m-527941"], ["format control", "private-\u200bseed-527941"]] as const)
test(`catalog discovery copies ${variant} known secrets without changing exact safe IDs`, async () => {
  const secret = "private-seed-527941", knownSecrets = Object.freeze([raw, "", "  "]);
  const input = { provider: "openai-compatible" as const, baseUrl: "https://fixture.test/v1", auth: "none" as const,
    profile: `selected-${secret}`, env: {}, knownSecrets };
  const fixture = store();
  const fetch = async () => Response.json({ data: [{ id: "safe-model" }, { id: secret }] });
  const seeded = await discoverModels(input, { store: fixture.credentials, fetch });
  expect(JSON.stringify(seeded)).not.toContain(secret);
  expect(seeded.catalog).toMatchObject({ status: "partial", models: [{ id: "safe-model" }] });
  expect(seeded.catalog).not.toHaveProperty("profile");
  expect(knownSecrets).toEqual([raw, "", "  "]);
  const unseeded = await discoverModels({ ...input, knownSecrets: [] }, { store: fixture.credentials, fetch });
  expect(unseeded.catalog).toMatchObject({ status: "complete", profile: input.profile, models: [{ id: secret }, { id: "safe-model" }] });
  expect(fixture.reads).toEqual([]); expect(fixture.writes).toEqual([]);
});

for (const source of ["env", "cli", "header", "env-file"] as const) for (const json of [false, true]) {
  test(`${source} setup errors redact raw and trimmed credentials in ${json ? "JSON" : "plain"} output`, async () => {
    const secret = "opaque-setup-credential-527941", raw = `  ${secret}\n`;
    for (const reflected of [raw, secret, secret.replace("setup", "set\u001b[31mup\u001b[0m")]) {
      let stdout = "", stderr = "", requests = 0;
      const fixture = store();
      const exit = await runModelsCommand(["models", "list", "--provider=openai-compatible", ...(json ? ["--json"] : []),
        ...(source === "cli" ? ["--api-key", raw] : source === "header" ? ["--header", `X-Opaque:  ${secret}  `] : source === "env-file" ? ["--env-file=fixture.env"] : [])], {
        cwd: "/workspace", env: source === "env" ? { OPENAI_COMPATIBLE_API_KEY: raw } : {}, store: fixture.credentials,
        stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } },
        loadEnv: async () => ({ OPENAI_COMPATIBLE_API_KEY: raw }),
        loadConfig: async () => ({ error: `Invalid configuration at /workspace/${reflected}/config.json` }),
        fetch: async () => { requests++; throw new Error("Unexpected request"); },
      });
      expect(exit).toBe(1); expect(stdout + stderr).not.toContain(secret); expect(stdout + stderr).not.toContain("\u001b");
      expect(stderr).toContain("Invalid configuration"); expect(stderr).toContain("***");
      if (json) expect(JSON.parse(stdout)).toMatchObject({ status: "error", route: "unresolved", models: [] });
      expect(requests).toBe(0); expect(fixture.reads).toEqual([]); expect(fixture.writes).toEqual([]);
    }
  });
}

test("diagnostic normalization cannot reconstruct a known credential and blank variants do not redact ordinary spaces", () => {
  expect(safeCatalogMessage("Failed opaque\u0000credential", [" \topaque credential\n", " \t "])).toBe("Failed ***");
  expect(safeCatalogMessage("Keep ordinary spaces", [" \t ", " "])).toBe("Keep ordinary spaces");
  expect(safeCatalogMessage("Keep  ordinary  spaces", ["\u001b[31m  \u001b[0m", " \u200b "])).toBe("Keep  ordinary  spaces");
});

for (const source of ["runtime", "env", "credential-env", "header", "config-header", "stored"] as const) for (const json of [false, true]) {
  test(`${source} normalized credential reflections omit unsafe IDs in ${json ? "JSON" : "plain"} output`, async () => {
    const secret = "opaque-model-credential-527941", raw = `  ${secret}  `, baseUrl = "https://fixture.test/v1";
    for (const withSafeModel of [false, true]) {
      let stdout = "", stderr = "";
      const identity = credentialIdentity({ provider: "openai-compatible", baseUrl });
      const fixture = store(source === "stored" ? { [identity.account]: raw } : {});
      const exit = await runModelsCommand(["models", "list", ...(json ? ["--json"] : []),
        ...(source === "credential-env" ? ["--profile=fixture"] : ["--provider=openai-compatible", `--base-url=${baseUrl}`, `--auth=${source === "header" || source === "config-header" ? "none" : "required"}`]),
        ...(source === "runtime" ? ["--api-key", raw] : source === "header" ? ["--header", `X-Opaque:${raw}`] : [])], {
        cwd: "/", env: source === "env" ? { OPENAI_COMPATIBLE_API_KEY: raw } : source === "credential-env" ? { SERVICE_AUTH: raw } : {}, store: fixture.credentials,
        stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } },
        loadConfig: async () => source === "credential-env" ? { project: { profiles: { fixture: { baseUrl, auth: "required", credentialEnv: "SERVICE_AUTH" } } } }
          : source === "config-header" ? { project: { headers: { "X-Opaque": raw } } } : {},
        fetch: async (_url, init) => {
          const header = source === "header" || source === "config-header";
          expect(new Headers(init?.headers).get(header ? "X-Opaque" : "Authorization")).toBe(header ? secret : `Bearer ${secret}`);
          return Response.json({ data: [{ id: secret }, { id: `prefix-${secret}-suffix` }, ...(withSafeModel ? [{ id: "org/exact:Model.v2", context_window: 1234 }] : [])] });
        },
      });
      expect(exit).toBe(1); expect(stdout + stderr).not.toContain(secret); expect(stdout + stderr).not.toContain("***");
      expect(stderr).toContain(withSafeModel ? "Discarded model IDs containing credential values" : "No safe selectable models");
      if (json) expect(JSON.parse(stdout)).toMatchObject({ status: withSafeModel ? "partial" : "error", models: withSafeModel ? [{ id: "org/exact:Model.v2", contextWindow: 1234 }] : [] });
      else if (withSafeModel) expect(stdout).toContain("org/exact:Model.v2  context 1234");
      expect(fixture.writes).toEqual([]);
    }
  });
}

for (const route of ["codex", "grok"] as const) {
  test(`${route} stored token fields retain normalized redaction for IDs and refresh-save errors`, async () => {
    const provider = route === "codex" ? "openai" as const : "xai" as const;
    const auth = route === "codex" ? { openaiAuth: route } : { xaiAuth: route };
    const identity = route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity();
    const access = "opaque-access-527941", refresh = "opaque-refresh-527941", account = "opaque-account-527941";
    const tokens = { accessToken: `  ${access}  `, refreshToken: `  ${refresh}  `, accountId: `  ${account}  `, obtainedAt: 0 };
    const fixture = store({ [identity.account]: JSON.stringify({ ...tokens, expiresAt: Date.now() + 600_000 }) });
    const prefix = route === "codex" ? "gpt" : "grok", safe = `${prefix}-safe-exact`;
    const catalog = await discoverModels({ provider, ...auth, env: {} }, { store: fixture.credentials, fetch: async (_url, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${access}`);
      if (route === "codex") expect(new Headers(init?.headers).get("ChatGPT-Account-Id")).toBe(account);
      const ids = [safe, ...[access, refresh, account].map(value => `${prefix}-${value}`)];
      return Response.json(route === "codex" ? { models: ids.map(slug => ({ slug, visibility: "list" })) } : { data: ids.map(id => ({ id })) });
    } });
    expect(catalog.catalog).toMatchObject({ status: "partial", models: [{ id: safe }] });
    for (const secret of [access, refresh, account]) expect(JSON.stringify(catalog)).not.toContain(secret);
    const expired = store({ [identity.account]: JSON.stringify({ ...tokens, expiresAt: 0 }) });
    expired.credentials.set = async () => { throw new Error(`Cannot save ${access} / ${refresh} / ${account} / renewed-private-token`); };
    const result = await discoverModels({ provider, ...auth, env: {} }, {
      store: expired.credentials, fetch: async () => Response.json({ access_token: "  renewed-private-token  ", expires_in: 3_600 }),
    });
    expect(result.catalog.status).toBe("error");
    for (const secret of [access, refresh, account, "renewed-private-token"]) expect(JSON.stringify(result)).not.toContain(secret);
  });
}

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

for (const mode of ["online", "offline", "cancelled", "failure"] as const) for (const json of [false, true]) {
  test(`${mode} ${json ? "JSON" : "plain"} catalogs omit profile names containing supplied credentials`, async () => {
    for (const source of ["runtime", "env", "credential-env", "header"] as const) {
      const secret = "opaque-profile-credential-92754", profile = `selected-${secret}`, raw = `  ${secret}  `;
      const fixture = store(), controller = new AbortController();
      let stdout = "", stderr = "", requests = 0;
      if (mode === "cancelled") controller.abort();
      const exit = await runModelsCommand(["models", "list", `--profile=${profile}`, ...(json ? ["--json"] : []), ...(mode === "offline" ? ["--offline"] : []),
        ...(source === "runtime" ? ["--api-key", raw] : source === "header" ? ["--header", `X-Fixture:${raw}`] : [])], {
        cwd: "/", env: source === "env" ? { OPENAI_COMPATIBLE_API_KEY: raw } : source === "credential-env" ? { SERVICE_AUTH: raw } : {},
        signal: controller.signal, store: fixture.credentials,
        stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } },
        loadConfig: async () => ({ project: { profiles: { [profile]: { baseUrl: "https://fixture.test/v1", auth: source === "header" ? "none" : "required",
          ...(source === "credential-env" ? { credentialEnv: "SERVICE_AUTH" } : {}) } } } }),
        fetch: async () => { requests++; return mode === "failure" ? new Response(null, { status: 401 }) : Response.json({ data: [{ id: "safe-model" }] }); },
      });
      expect(exit).toBe(1); expect(stdout + stderr).not.toContain(secret);
      expect(stdout).toContain("Omitted profile name containing a credential value");
      if (json) {
        const catalog = JSON.parse(stdout);
        expect(catalog.profile).toBeUndefined();
        expect(catalog.status).toBe(mode === "failure" || mode === "cancelled" ? "error" : "partial");
        expect(catalog.models).toEqual(mode === "online" ? [{ id: "safe-model" }] : []);
      }
      if (mode === "offline" || mode === "cancelled") { expect(requests).toBe(0); expect(fixture.reads).toEqual([]); }
      expect(fixture.writes).toEqual([]);
    }
  });
}

test("profile privacy also incorporates the selected stored key learned during discovery", async () => {
  const secret = "opaque-stored-profile-92754", baseUrl = "https://fixture.test/v1";
  const identity = credentialIdentity({ provider: "openai-compatible", baseUrl, profile: secret });
  const fixture = store({ [identity.account]: ` ${secret} ` });
  const result = await discoverModels({ provider: "openai-compatible", baseUrl, profile: secret, auth: "required", env: {} }, {
    store: fixture.credentials, fetch: async () => Response.json({ data: [{ id: "safe-model" }] }),
  });
  expect(result.catalog).toMatchObject({ status: "partial", models: [{ id: "safe-model" }] });
  expect(result.catalog.profile).toBeUndefined(); expect(JSON.stringify(result)).not.toContain(secret);
});

test("Grok replacement credentials read through lifecycle fencing cannot appear in model IDs", async () => {
  const { saveSubscriptionTokens } = await import("../src/model/providers/grok-subscription.ts");
  const identity = grokSubscriptionIdentity(), next = { accessToken: "opaque-new-access-92754", refreshToken: "opaque-new-refresh-92754", obtainedAt: 0, expiresAt: Date.now() + 600_000 };
  const fixture = store({ [identity.account]: JSON.stringify({ accessToken: "old-access", refreshToken: "old-refresh", obtainedAt: 0, expiresAt: Date.now() + 600_000 }) });
  const read = fixture.credentials.get;
  let firstRead = true;
  fixture.credentials.get = async selected => {
    const value = await read(selected);
    if (firstRead) { firstRead = false; await saveSubscriptionTokens(fixture.credentials, next); }
    return value;
  };
  const result = await discoverModels({ provider: "xai", xaiAuth: "grok", env: {} }, { store: fixture.credentials, fetch: async (_url, init) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${next.accessToken}`);
    return Response.json({ data: [{ id: `grok-${next.accessToken}` }, { id: `grok-${next.refreshToken}` }, { id: "grok-safe" }] });
  } });
  expect(result.catalog).toMatchObject({ status: "partial", models: [{ id: "grok-safe" }] });
  expect(result.catalog.warnings).toEqual(["Discarded model IDs containing credential values. Check the endpoint and retry schway models list."]);
  for (const secret of [next.accessToken, next.refreshToken]) expect(JSON.stringify(result)).not.toContain(secret);
  expect(fixture.reads).toEqual([identity.account, identity.account]); expect(fixture.writes).toEqual([identity.account]);
});

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
    expect(calls).toBe(2);
    // Grok renewal has a shared lifetime; this caller's original deadline still owns the catalog body.
    expect(signals[1]).toBe(clock.controller.signal); expect(signals[1]!.aborted).toBe(true);
    if (route === "codex") expect(signals[0]).toBe(signals[1]);
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
  expect(signals[0]).toBe(clock.controller.signal); expect(signals[2]).toBe(signals[0]);
  expect(signals[2]!.aborted).toBe(true); expect(cancelled).toBe(true); expect(fixture.writes).toEqual([identity.account]);
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

for (const first of ["ordinary", "discovery"] as const) for (const ending of ["complete", "discovery-timeout", "ordinary-cancel"] as const) {
  test(`Grok ${first}-first callers share renewal with independent ${ending} lifetimes`, async () => {
    const { createSubscriptionTokenRefresher, GROK_TOKEN_URL } = await import("../src/model/providers/grok-subscription.ts");
    const identity = grokSubscriptionIdentity();
    const fixture = store({ [identity.account]: JSON.stringify({ accessToken: "expired", refreshToken: "old-private-refresh", expiresAt: 0, obtainedAt: 0 }) });
    const started = deferred<void>(), joined = deferred<void>(), release = deferred<void>();
    const clock = controlledDeadline(), ordinaryAbort = new AbortController(), discoveryAbort = new AbortController();
    const read = fixture.credentials.get;
    fixture.credentials.get = async selected => {
      const value = await read(selected);
      if (fixture.reads.length === (first === "ordinary" ? 3 : 2)) joined.resolve();
      return value;
    };
    let refreshes = 0;
    const signals: AbortSignal[] = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === GROK_TOKEN_URL) {
        refreshes++; signals.push(init!.signal!); started.resolve(); await release.promise;
        return Response.json({ access_token: "shared-private-access", refresh_token: "shared-private-refresh", expires_in: 3600 });
      }
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer shared-private-access");
      return Response.json({ data: [{ id: "grok-safe" }, { id: "grok-shared-private-access" }, { id: "grok-shared-private-refresh" }] });
    };
    const ordinary = () => createSubscriptionTokenRefresher({ store: fixture.credentials, fetch }).getValidAccessToken(ordinaryAbort.signal)
      .then(token => ({ token, error: undefined }), error => ({ token: undefined, error }));
    const discovery = () => discoverModels({ provider: "xai", xaiAuth: "grok", env: {}, signal: discoveryAbort.signal }, { ...clock, store: fixture.credentials, fetch });
    let execution: ReturnType<typeof ordinary> | undefined, listing: ReturnType<typeof discovery> | undefined;
    let expired = false;
    const watchdog = setTimeout(() => { expired = true; ordinaryAbort.abort(); discoveryAbort.abort(); release.resolve(); started.resolve(); joined.resolve(); }, 1500);
    try {
      if (first === "ordinary") execution = ordinary(); else listing = discovery();
      await started.promise;
      if (first === "ordinary") listing = discovery(); else execution = ordinary();
      await joined.promise;
      clock.advance(4900);
      if (ending === "discovery-timeout") { clock.advance(100); expect((await listing!).error).toContain("timed out after 5 seconds"); expect(signals[0]!.aborted).toBe(false); }
      if (ending === "ordinary-cancel") { ordinaryAbort.abort(); expect((await execution!).error?.name).toBe("AbortError"); expect(signals[0]!.aborted).toBe(false); }
      release.resolve();
      const [executed, discovered] = await Promise.all([execution!, listing!]);
      expect(expired).toBe(false); expect(refreshes).toBe(1); expect(fixture.writes).toEqual([identity.account]);
      if (ending !== "ordinary-cancel") expect(executed).toEqual({ token: "shared-private-access", error: undefined });
      if (ending !== "discovery-timeout") {
        expect(discovered.catalog).toMatchObject({ route: "grok", status: "partial", models: [{ id: "grok-safe" }] });
        expect(discovered.error).toBeUndefined();
        expect(JSON.stringify(discovered)).not.toContain("shared-private-access"); expect(JSON.stringify(discovered)).not.toContain("shared-private-refresh");
      }
      expect(clock.inspect()).toEqual({ elapsed: ending === "discovery-timeout" ? 5000 : 4900, budget: 5000, started: 1, cleared: 1 });
    } finally {
      clearTimeout(watchdog); ordinaryAbort.abort(); discoveryAbort.abort(); release.resolve();
      await Promise.allSettled([execution, listing]);
    }
  });
}

test("Grok shared renewal cancels a stalled token body only after its last interested caller leaves", async () => {
  const { createSubscriptionTokenRefresher, GROK_TOKEN_URL } = await import("../src/model/providers/grok-subscription.ts");
  const identity = grokSubscriptionIdentity(), fixture = store({ [identity.account]: JSON.stringify({ accessToken: "expired", refreshToken: "private-refresh", expiresAt: 0, obtainedAt: 0 }) });
  const bodyStarted = deferred<void>(), joined = deferred<void>(), bodyCancelled = deferred<void>();
  const read = fixture.credentials.get;
  fixture.credentials.get = async selected => { const value = await read(selected); if (fixture.reads.length === 2) joined.resolve(); return value; };
  const clock = controlledDeadline(), ordinaryAbort = new AbortController();
  let refreshes = 0, signal: AbortSignal | undefined;
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(GROK_TOKEN_URL); refreshes++; signal = init!.signal!;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"access_token":"never-completed"')); bodyStarted.resolve(); }, cancel() { bodyCancelled.resolve(); } }));
  };
  let expired = false;
  const watchdog = setTimeout(() => { expired = true; ordinaryAbort.abort(); clock.advance(5000); bodyStarted.resolve(); bodyCancelled.resolve(); joined.resolve(); }, 1500);
  const listing = discoverModels({ provider: "xai", xaiAuth: "grok", env: {} }, { ...clock, store: fixture.credentials, fetch });
  let execution: Promise<unknown> | undefined;
  try {
    await bodyStarted.promise;
    execution = createSubscriptionTokenRefresher({ store: fixture.credentials, fetch }).getValidAccessToken(ordinaryAbort.signal).catch(error => error);
    await joined.promise; clock.advance(5000);
    expect((await listing).error).toContain("timed out"); expect(signal?.aborted).toBe(false);
    ordinaryAbort.abort(); expect(await execution).toMatchObject({ name: "AbortError" });
    await bodyCancelled.promise; expect(expired).toBe(false); expect(signal?.aborted).toBe(true); expect(refreshes).toBe(1); expect(fixture.writes).toEqual([]);
  } finally { clearTimeout(watchdog); ordinaryAbort.abort(); clock.advance(5000); await Promise.allSettled([listing, execution]); }
});

test("Grok failed credential readers detach and cannot keep an abandoned discovery renewal alive", async () => {
  const { createSubscriptionTokenRefresher } = await import("../src/model/providers/grok-subscription.ts");
  const identity = grokSubscriptionIdentity(), fixture = store({ [identity.account]: JSON.stringify({ accessToken: "expired", refreshToken: "private-refresh", expiresAt: 0, obtainedAt: 0 }) });
  const read = fixture.credentials.get;
  fixture.credentials.get = async selected => { const value = await read(selected); if (fixture.reads.length === 2) throw new Error("Controlled credential read failure"); return value; };
  const clock = controlledDeadline(), started = deferred<void>(), response = deferred<Response>(), cancelledBody = deferred<void>();
  const ordinaryAbort = new AbortController();
  let requestSignal: AbortSignal | undefined, expired = false;
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => { requestSignal = init!.signal!; started.resolve(); return response.promise; };
  const watchdog = setTimeout(() => { expired = true; ordinaryAbort.abort(); clock.advance(5000); started.resolve(); cancelledBody.resolve(); }, 1500);
  const listing = discoverModels({ provider: "xai", xaiAuth: "grok", env: {} }, { ...clock, store: fixture.credentials, fetch });
  let execution: Promise<string> | undefined;
  try {
    await started.promise;
    execution = createSubscriptionTokenRefresher({ store: fixture.credentials, fetch }).getValidAccessToken(ordinaryAbort.signal);
    await expect(execution).rejects.toThrow("credential store");
    clock.advance(5000); expect((await listing).error).toContain("timed out"); expect(requestSignal?.aborted).toBe(true);
    response.resolve(new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"access_token":"too-late"}')); }, cancel() { cancelledBody.resolve(); } })));
    await cancelledBody.promise; expect(expired).toBe(false); expect(fixture.writes).toEqual([]);
  } finally {
    clearTimeout(watchdog); ordinaryAbort.abort(); clock.advance(5000); response.resolve(Response.json({ access_token: "discarded" }));
    await Promise.allSettled([listing, execution]);
  }
});

test("Grok shared renewal cannot begin saving after every caller cancels at the pre-write boundary", async () => {
  const { createSubscriptionTokenRefresher, fetchDiscoveryCatalog } = await import("../src/model/providers/grok-subscription.ts");
  const identity = grokSubscriptionIdentity(), fixture = store({ [identity.account]: JSON.stringify({ accessToken: "expired", refreshToken: "private-refresh", expiresAt: 0, obtainedAt: 0 }) });
  const first = new AbortController(), second = new AbortController(), started = deferred<void>(), joined = deferred<void>(), release = deferred<void>();
  const read = fixture.credentials.get;
  fixture.credentials.get = async selected => { const value = await read(selected); if (fixture.reads.length === 2) joined.resolve(); return value; };
  let renewals = 0, reachedBoundary = false;
  const fetch = async () => { renewals++; started.resolve(); await release.promise; return Response.json({ access_token: "renewed-private", expires_in: 3600 }); };
  let expired = false;
  const watchdog = setTimeout(() => { expired = true; first.abort(); second.abort(); release.resolve(); started.resolve(); joined.resolve(); }, 1500);
  const listing = fetchDiscoveryCatalog({ store: fixture.credentials, signal: first.signal, fetch, onCredential: raw => {
    if (JSON.parse(raw).accessToken === "renewed-private") { reachedBoundary = true; first.abort(); second.abort(); }
  } }).catch(error => error);
  let execution: Promise<unknown> | undefined;
  try {
    await started.promise;
    execution = createSubscriptionTokenRefresher({ store: fixture.credentials, fetch }).getValidAccessToken(second.signal).catch(error => error);
    await joined.promise; release.resolve();
    const outcomes = await Promise.all([listing, execution]);
    expect(expired).toBe(false); expect(reachedBoundary).toBe(true); expect(outcomes).toEqual([expect.objectContaining({ name: "AbortError" }), expect.objectContaining({ name: "AbortError" })]);
    expect(renewals).toBe(1); expect(fixture.writes).toEqual([]);
  } finally { clearTimeout(watchdog); first.abort(); second.abort(); release.resolve(); await Promise.allSettled([listing, execution]); }
});

test("public Grok discovery never starts HTTP or leaves unhandled reads across credential-resolution microtask handoffs", async () => {
  const { GROK_TOKEN_URL } = await import("../src/model/providers/grok-subscription.ts");
  const unhandled: unknown[] = [], observe = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", observe);
  try {
    // Sweep the surrounding scheduler interleavings as well as the explicit read barriers in provider tests.
    for (let handoff = 1; handoff <= 32; handoff++) {
      const abort = new AbortController();
      let reads = 0, postAbortCalls = 0, postAbortWrites = 0, expired = false;
      const raw = JSON.stringify({ accessToken: "expired", refreshToken: "private-refresh", obtainedAt: 0, expiresAt: 0 });
      const fixture: CredentialStore = {
        async get() {
          if (!reads++) {
            let remaining = handoff;
            const next = () => { if (--remaining) queueMicrotask(next); else abort.abort(); };
            queueMicrotask(next);
          }
          return raw;
        },
        async set() { if (abort.signal.aborted) postAbortWrites++; }, async delete() { throw new Error("Unexpected deletion"); },
      };
      const watchdog = setTimeout(() => { expired = true; abort.abort(); }, 1500);
      try {
        const result = await discoverModels({ provider: "xai", xaiAuth: "grok", env: {}, signal: abort.signal }, { store: fixture, fetch: async url => {
          if (abort.signal.aborted) postAbortCalls++;
          return String(url) === GROK_TOKEN_URL ? Response.json({ access_token: "renewed", expires_in: 3600 }) : Response.json({ data: [{ id: "grok-safe" }] });
        } });
        expect(result.catalog.status).toBe("error"); expect(result.error).toContain("cancelled");
        expect(expired).toBe(false); expect(postAbortCalls).toBe(0); expect(postAbortWrites).toBe(0);
      } finally { clearTimeout(watchdog); abort.abort(); await new Promise<void>(resolve => setImmediate(resolve)); }
    }
    expect(unhandled).toEqual([]);
  } finally { process.removeListener("unhandledRejection", observe); }
});
