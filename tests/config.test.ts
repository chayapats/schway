import { expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_INLINE_DIFF_LINES,
  loadResolvedSettings,
  mergeConfigLayers,
  parseConfigObject,
  projectConfigPath,
  readConfigFile,
  resolveSettings,
  userConfigPath,
} from "../src/config/config.ts";
import { parseEnvFile } from "../src/config/env-file.ts";
import { DEFAULT_MAX_TURNS } from "../src/agent/loop.ts";
import { DEFAULT_MAX_CONCURRENT_TOOLS } from "../src/agent/scheduler.ts";
import { UNKNOWN_MODEL_DEFAULTS } from "../src/model/catalog.ts";
import { withTempDir } from "./helpers.ts";

test("an empty object is a valid config layer", () => {
  expect(parseConfigObject({}, "test")).toEqual({});
});

test("invalid approval config exposes its safe field and supported values", () => {
  const result = parseConfigObject({ approval: { mode: "readonly" } }, "/user/config.json");
  expect(result).toMatchObject({ diagnostics: [{ source: "/user/config.json", path: "approval.mode", category: "enum", constraint: "Use auto, ask, or read-only", values: ["auto", "ask", "read-only"] }] });
  expect(result).toHaveProperty("error", "Invalid config at /user/config.json: Invalid approval.mode · Use auto, ask, or read-only");
  expect(JSON.stringify(result)).not.toContain("readonly");
});

test("each distinct invalid field has one primary cause even alongside a forbidden secret", () => {
  const result = parseConfigObject({ token: "private-secret", approval: { mode: "readonly" }, profiles: { sample: {} }, profile: "a".repeat(65) }, "/config.json");
  if (!("error" in result)) throw Error("expected invalid config");
  expect(result.diagnostics).toHaveLength(4);
  expect(result.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: "<unknown setting>", category: "secret" }),
    expect.objectContaining({ path: "approval.mode", category: "enum" }),
    expect.objectContaining({ path: "profiles.<unknown setting>.baseUrl", category: "type" }),
    expect.objectContaining({ path: "profile", category: "constraint", constraint: "Use at most 64 characters" }),
  ]));
  expect(JSON.stringify(result)).not.toContain("private-secret");
});

test("configuration reasons hide unknown fields, profile identifiers and invalid secret values", () => {
  const secret = "raw-private-token\u001b[31m\n";
  const cases: Array<[unknown, string, string]> = [
    [[], "", "root"],
    [{ [secret]: true }, "<unknown setting>", "unknown-setting"],
    [{ approval: { [secret]: true } }, "approval.<unknown setting>", "unknown-setting"],
    [{ xaiAuth: secret }, "xaiAuth", "enum"],
    [{ maxTurns: secret }, "maxTurns", "type"],
    [{ maxTurns: 0 }, "maxTurns", "range"],
    [{ profiles: { [secret]: { baseUrl: "https://example.com", model: 1 } } }, "profiles.<unknown setting>.model", "type"],
    [{ profiles: { [secret]: { baseUrl: "https://u:password@example.com?token=private" } } }, "profiles.<unknown setting>", "constraint"],
    [{ apiKey: secret }, "<unknown setting>", "secret"],
    [{ profiles: { valid: { baseUrl: "https://example.com", headers: { Authorization: secret } } } }, "profiles.<unknown setting>.headers.<unknown setting>", "secret"],
  ];
  for (const [value, path, category] of cases) {
    const result = parseConfigObject(value, "/config.json");
    expect(result).toMatchObject({ diagnostics: expect.arrayContaining([expect.objectContaining({ source: "/config.json", path, category })]) });
    for (const forbidden of ["raw-private-token", "password", "token=private", "\u001b", "Expected union value"]) expect(JSON.stringify(result)).not.toContain(forbidden);
  }
});

test("config reads carry JSON and access reasons and startup retains both invalid scopes", async () => withTempDir(async root => {
  const home = join(root, "home"), workspaceRoot = join(root, "work");
  await mkdir(join(home, ".schway"), { recursive: true }); await mkdir(join(workspaceRoot, ".schway"), { recursive: true });
  const user = userConfigPath(home), project = projectConfigPath(workspaceRoot);
  await writeFile(user, "{private-invalid-json");
  await mkdir(project);
  expect(await readConfigFile(user)).toMatchObject({ diagnostics: [{ source: user, path: "", category: "json", constraint: expect.any(String) }] });
  expect(await readConfigFile(project)).toMatchObject({ diagnostics: [{ source: project, path: "", category: "unreadable", constraint: expect.any(String) }] });
  const resolved = await loadResolvedSettings({ home, workspaceRoot });
  expect(resolved).toMatchObject({ diagnostics: [expect.objectContaining({ source: user }), expect.objectContaining({ source: project })] });
  expect(JSON.stringify(resolved)).not.toContain("private-invalid-json");
}));

test("splash defaults to first-run and rejects unknown modes and ui keys", () => {
  expect(resolveSettings({})).toMatchObject({ splash: "first-run" });
  for (const splash of ["always", "first-run", "never"] as const) {
    expect(parseConfigObject({ ui: { splash } }, "test")).toEqual({ ui: { splash } });
    expect(resolveSettings({ user: { ui: { splash } } })).toMatchObject({ splash });
  }
  for (const ui of [{ splash: "sometimes" }, { splash: true }, { animation: "off" }]) expect(parseConfigObject({ ui }, "test")).toHaveProperty("error");
});

test("inline diff limits accept nonnegative integers and an empty ui object", () => {
  expect(parseConfigObject({ ui: {} }, "test")).toEqual({ ui: {} });
  for (const inlineDiffLines of [0, 12, 30]) {
    expect(parseConfigObject({ ui: { inlineDiffLines } }, "test")).toEqual({ ui: { inlineDiffLines } });
  }
});

test.each([-1, 1.5, "12"])("invalid inline diff limit %j uses the schema error path", inlineDiffLines => {
  const result = parseConfigObject({ ui: { inlineDiffLines } }, "project-config");
  expect("error" in result).toBe(true);
  if (!("error" in result)) throw new Error("expected validation error");
  expect(result.error).toContain("Invalid config at project-config:");
  expect(result.error).toContain("ui.inlineDiffLines");
});

test("ui rejects unknown nested properties and non-object values", () => {
  for (const ui of [{ inlineDifLines: 12 }, null, [], 12]) {
    const result = parseConfigObject({ ui }, "test");
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("expected validation error");
    expect(result.error).toContain("ui");
  }
});

test("inline diff defaults and overrides resolve with or without a configured model", () => {
  expect(DEFAULT_INLINE_DIFF_LINES).toBe(12);
  for (const model of [undefined, "gpt-5.4"]) {
    const user = model === undefined ? {} : { model };
    expect(resolveSettings({ user })).toMatchObject({ inlineDiffLines: DEFAULT_INLINE_DIFF_LINES });
    expect(resolveSettings({ user: { ...user, ui: { inlineDiffLines: 0 } } })).toMatchObject({ inlineDiffLines: 0 });
    expect(resolveSettings({ user: { ...user, ui: { inlineDiffLines: 30 } } })).toMatchObject({ inlineDiffLines: 30 });
  }
});

test("inline diff limits follow user, project, CLI and session precedence", () => {
  const user = { ui: { inlineDiffLines: 24 } };
  const project = { ui: { inlineDiffLines: 18 } };
  const cli = { ui: { inlineDiffLines: 6 } };
  const session = { ui: { inlineDiffLines: 0 } };
  expect(resolveSettings({ user })).toMatchObject({ inlineDiffLines: 24 });
  expect(resolveSettings({ user, project })).toMatchObject({ inlineDiffLines: 18 });
  expect(resolveSettings({ user, project, cli })).toMatchObject({ inlineDiffLines: 6 });
  expect(resolveSettings({ user, project, cli, session })).toMatchObject({ inlineDiffLines: 0 });
  expect(resolveSettings({ user, project: { ui: {} } })).toMatchObject({ inlineDiffLines: DEFAULT_INLINE_DIFF_LINES });
});

test("an unset model keeps profile, connection, appearance, git tracking, and explicit limits", () => {
  const resolved = resolveSettings({
    user: {
      profile: "local",
      profiles: {
        local: {
          baseUrl: "http://127.0.0.1:9/v1",
          auth: "required",
          credentialEnv: "LOCAL_KEY",
          credentialIdentity: "desk",
          headers: { "X-Org": "a" },
        },
      },
      appearance: "dark",
      git: { changeTracking: "snapshot" },
      contextWindow: 64_000,
      maxOutput: 2_048,
    },
  });
  expect(resolved).toMatchObject({
    model: "",
    modelConfigured: false,
    profile: "local",
    credentialEnv: "LOCAL_KEY",
    credentialIdentity: "desk",
    baseUrl: "http://127.0.0.1:9/v1",
    headers: { "X-Org": "a" },
    appearance: "dark",
    gitChangeTracking: "snapshot",
    explicitContextWindow: 64_000,
    explicitMaxOutput: 2_048,
  });
});

test("a valid partial config parses known settings", () => {
  expect(
    parseConfigObject(
      {
        provider: "openai",
        model: "gpt-5.4",
        maxTurns: 8,
        maxConcurrentTools: 2,
        contextWindow: 10000,
        maxOutput: 1024,
        baseUrl: "http://127.0.0.1:11434/v1",
        headers: { "X-Test": "ok" },
        extraBody: { temperature: 0.2 },
        auth: "optional",
      },
      "test",
    ),
  ).toEqual({
    provider: "openai",
    model: "gpt-5.4",
    maxTurns: 8,
    maxConcurrentTools: 2,
    contextWindow: 10000,
    maxOutput: 1024,
    baseUrl: "http://127.0.0.1:11434/v1",
    headers: { "X-Test": "ok" },
    extraBody: { temperature: 0.2 },
    auth: "optional",
  });
});

test("misspelled settings fail with a redacted unknown name and repair action", () => {
  const result = parseConfigObject({ modell: "gpt-5.4" }, "user-config");
  expect("error" in result).toBe(true);
  if (!("error" in result)) {
    throw new Error("expected validation error");
  }
  expect(result.error).toContain("user-config");
  expect(result.error).toContain("<unknown setting>");
  expect(result.error).not.toContain("modell");
  expect(result.error).toContain("model");
  expect(result.error.toLowerCase()).toContain("unknown");
});

test("API keys in ordinary config fail with an actionable secret error", () => {
  const result = parseConfigObject({ apiKey: "sk-secret" }, "project-config");
  expect("error" in result).toBe(true);
  if (!("error" in result)) {
    throw new Error("expected validation error");
  }
  expect(result.error).toContain("API key");
  expect(result.error.includes("sk-secret")).toBe(false);
  expect(result.error).toContain("--api-key");
});

test("invalid types and non-positive limits fail with a redacted unknown setting", () => {
  const provider = parseConfigObject({ provider: "codex" }, "test");
  expect("error" in provider).toBe(true);
  if ("error" in provider) {
    expect(provider.error).toContain("provider");
  }

  const turns = parseConfigObject({ maxTurns: 0 }, "test");
  expect("error" in turns).toBe(true);
  if ("error" in turns) {
    expect(turns.error).toContain("maxTurns");
  }

  const extra = parseConfigObject({ extraBody: [1] }, "test");
  expect("error" in extra).toBe(true);
  if ("error" in extra) {
    expect(extra.error).toContain("extraBody");
  }
});

test("layers merge built-in, user, project, then CLI overrides", () => {
  const merged = mergeConfigLayers(
    { provider: "openai-compatible", maxTurns: 32, model: "gpt-4o" },
    { provider: "openai", maxTurns: 16 },
    { model: "gpt-5.4", maxConcurrentTools: 4 },
    { maxTurns: 3 },
  );
  expect(merged).toEqual({
    provider: "openai",
    maxTurns: 3,
    model: "gpt-5.4",
    maxConcurrentTools: 4,
  });
});

test("changing provider without a model drops the inherited model", () => {
  const merged = mergeConfigLayers(
    { provider: "openai", model: "gpt-5.4" },
    { provider: "openai-compatible" },
  );
  expect(merged.provider).toBe("openai-compatible");
  expect(merged.model).toBeUndefined();
});

test("a provider change without a model leaves the model unset", () => {
  const resolved = resolveSettings({
    user: { provider: "openai", model: "gpt-5.4" },
    cli: { provider: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1" },
  });
  expect("error" in resolved).toBe(false);
  if ("error" in resolved) {
    throw new Error(resolved.error);
  }
  expect(resolved.provider).toBe("openai-compatible");
  expect(resolved.model).toBe("");
  expect(resolved.modelConfigured).toBe(false);
});

test("credential headers are rejected in ordinary config", () => {
  const result = parseConfigObject(
    {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      headers: { Authorization: "Bearer sk-config-secret" },
    },
    "project-config",
  );
  expect("error" in result).toBe(true);
  if (!("error" in result)) {
    throw new Error("expected validation error");
  }
  expect(result.error).toContain("API key");
  expect(result.error.includes("sk-config-secret")).toBe(false);
});

test("zero-config uses built-in defaults and does not create config files", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const project = join(dir, "project");
    await mkdir(home);
    await mkdir(project);

    const resolved = await loadResolvedSettings({
      home,
      workspaceRoot: project,
    });
    expect("error" in resolved).toBe(false);
    if ("error" in resolved) {
      throw new Error(resolved.error);
    }
    expect(resolved.provider).toBe("openai");
    expect(resolved.model).toBe("");
    expect(resolved.modelConfigured).toBe(false);
    expect(resolved.maxTurns).toBe(DEFAULT_MAX_TURNS);
    expect(resolved.maxConcurrentTools).toBe(DEFAULT_MAX_CONCURRENT_TOOLS);
    expect(resolved.inlineDiffLines).toBe(DEFAULT_INLINE_DIFF_LINES);
    expect(resolved.catalog.id).toBe("");

    expect(await readdir(home)).toEqual([]);
    expect(await readdir(project)).toEqual([]);
  });
});

test("user, project, and CLI config layers apply in precedence order", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const project = join(dir, "project");
    await mkdir(join(home, ".schway"), { recursive: true });
    await mkdir(join(project, ".schway"), { recursive: true });
    await writeFile(
      userConfigPath(home),
      JSON.stringify({
        provider: "openai",
        model: "from-user",
        maxTurns: 16,
        maxOutput: 4096,
      }),
    );
    await writeFile(
      projectConfigPath(project),
      JSON.stringify({
        model: "from-project",
        maxTurns: 8,
        maxConcurrentTools: 2,
      }),
    );

    const resolved = await loadResolvedSettings({
      home,
      workspaceRoot: project,
      cli: { maxTurns: 4, contextWindow: 9000 },
    });
    expect("error" in resolved).toBe(false);
    if ("error" in resolved) {
      throw new Error(resolved.error);
    }
    expect(resolved.provider).toBe("openai");
    expect(resolved.model).toBe("from-project");
    expect(resolved.maxTurns).toBe(4);
    expect(resolved.maxConcurrentTools).toBe(2);
    expect(resolved.contextWindow).toBe(9000);
    expect(resolved.maxOutput).toBe(4096);
    expect(resolved.catalog.id).toBe("from-project");
    expect(resolved.catalog.contextWindow).toBe(9000);
    expect(resolved.catalog.maxOutput).toBe(4096);
    expect(resolved.catalog.supportsThinking).toBe(
      UNKNOWN_MODEL_DEFAULTS.supportsThinking,
    );
  });
});

test("project config is read from the workspace root, not the launch cwd", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const root = join(dir, "repo");
    const nested = join(root, "pkg");
    await mkdir(home);
    await mkdir(join(root, ".schway"), { recursive: true });
    await mkdir(join(nested, ".schway"), { recursive: true });
    await writeFile(
      projectConfigPath(root),
      JSON.stringify({ model: "from-workspace-root" }),
    );
    await writeFile(
      join(nested, ".schway", "config.json"),
      JSON.stringify({ model: "from-cwd" }),
    );

    const resolved = await loadResolvedSettings({
      home,
      workspaceRoot: root,
    });
    expect("error" in resolved).toBe(false);
    if ("error" in resolved) {
      throw new Error(resolved.error);
    }
    expect(resolved.model).toBe("from-workspace-root");
  });
});

test("invalid project config reports the file path and does not ignore it", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const project = join(dir, "project");
    await mkdir(home);
    await mkdir(join(project, ".schway"), { recursive: true });
    const path = projectConfigPath(project);
    await writeFile(path, "{");

    const resolved = await loadResolvedSettings({
      home,
      workspaceRoot: project,
    });
    expect("error" in resolved).toBe(true);
    if (!("error" in resolved)) {
      throw new Error("expected invalid JSON error");
    }
    expect(resolved.error).toContain(path);
    expect(await readFile(path, "utf8")).toBe("{");
  });
});

test("OpenAI-compatible settings require a base URL after merge", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const project = join(dir, "project");
    await mkdir(home);
    await mkdir(project);
    const resolved = await loadResolvedSettings({
      home,
      workspaceRoot: project,
      cli: { provider: "openai-compatible" },
    });
    expect("error" in resolved).toBe(true);
    if (!("error" in resolved)) {
      throw new Error("expected missing baseUrl error");
    }
    expect(resolved.error.toLowerCase()).toContain("base");
  });
});

test("compatible connection options survive merge without a named profile", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const project = join(dir, "project");
    await mkdir(home);
    await mkdir(join(project, ".schway"), { recursive: true });
    await writeFile(
      projectConfigPath(project),
      JSON.stringify({
        provider: "openai-compatible",
        model: "llama3.2",
        baseUrl: "http://127.0.0.1:11434/v1",
        headers: { "X-Test": "ok" },
        extraBody: { temperature: 0.2 },
        auth: "none",
      }),
    );

    const resolved = await loadResolvedSettings({
      home,
      workspaceRoot: project,
    });
    expect("error" in resolved).toBe(false);
    if ("error" in resolved) {
      throw new Error(resolved.error);
    }
    expect(resolved.provider).toBe("openai-compatible");
    expect(resolved.model).toBe("llama3.2");
    expect(resolved.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(resolved.headers).toEqual({ "X-Test": "ok" });
    expect(resolved.extraBody).toEqual({ temperature: 0.2 });
    expect(resolved.auth).toBe("none");
  });
});

test("parseEnvFile reads assignments and ignores comments", () => {
  const parsed = parseEnvFile(
    [
      "# comment",
      "OPENAI_COMPATIBLE_API_KEY=sk-from-file",
      "export OPENAI_API_KEY=\"sk-quoted\"",
      "",
      "OTHER=plain value",
    ].join("\n"),
  );
  expect(parsed).toEqual({
    OPENAI_COMPATIBLE_API_KEY: "sk-from-file",
    OPENAI_API_KEY: "sk-quoted",
    OTHER: "plain value",
  });
});


test("undo retention uses positive integers, rejects unknown keys, and resolves defaults", () => {
  expect(resolveSettings({})).toMatchObject({ undoMaxAgeDays: 30, undoMaxSizeMB: 500 });
  expect(parseConfigObject({ undo: { maxAgeDays: 14, maxSizeMB: 10 } }, "test")).toEqual({ undo: { maxAgeDays: 14, maxSizeMB: 10 } });
  expect(resolveSettings({ user: { undo: { maxAgeDays: 14 } } })).toMatchObject({ undoMaxAgeDays: 14, undoMaxSizeMB: 500 });
  expect(resolveSettings({ user: { undo: { maxAgeDays: 14, maxSizeMB: 10 } }, project: { undo: { maxAgeDays: 7 } } })).toMatchObject({ undoMaxAgeDays: 7, undoMaxSizeMB: 500 });
  for (const undo of [{ maxAgeDays: 0 }, { maxSizeMB: -1 }, { maxAgeDays: 1.5 }, { maxSizeMB: "10" }, { maxAge: 30 }]) {
    expect(parseConfigObject({ undo }, "test")).toHaveProperty("error");
  }
});


test.each([
  [undefined, "read-only", undefined, undefined, "read-only", undefined],
  ["read-only", "auto", undefined, undefined, "read-only", "auto"],
  ["auto", "auto", undefined, undefined, "auto", undefined],
  ["auto", "ask", undefined, undefined, "ask", undefined],
  ["ask", "auto", undefined, undefined, "ask", "auto"],
  ["ask", "read-only", undefined, undefined, "read-only", undefined],
  ["read-only", "ask", undefined, undefined, "read-only", "ask"],
  ["read-only", "auto", "auto", undefined, "auto", "auto"],
  ["auto", "read-only", undefined, "auto", "auto", undefined],
] as const)("approval precedence user=%s project=%s cli=%s session=%s", (user, project, cli, session, effective, ignored) => {
  const layer = (mode: "auto" | "ask" | "read-only" | undefined) => mode ? { approval: { mode } } : undefined;
  const settings = resolveSettings({ user: layer(user), project: layer(project), cli: layer(cli), session: layer(session) });
  if ("error" in settings) throw new Error(settings.error);
  expect(settings.approvalMode).toBe(effective);
  expect(settings.ignoredProjectApprovalMode).toBe(ignored);
});


test("approval origins ignore looser project settings and schema accepts ask and rejects unknown keys", async () => {
  const { configOrigins } = await import("../src/config/editing.ts");
  expect(configOrigins({ user: { approval: { mode: "read-only" } }, project: { approval: { mode: "auto" } } }).approval).toBe("user-global");
  expect(parseConfigObject({ approval: { mode: "ask" } }, "test")).not.toHaveProperty("error");
  for (const approval of [{ mode: "auto", other: true }, null]) expect(parseConfigObject({ approval }, "test")).toHaveProperty("error");
  expect(resolveSettings({ memory: { approval: { mode: "read-only" } } })).toMatchObject({ approvalMode: "auto" });
});

for (const [old, modern, key, replacement] of [
  [{ oldTurns: 7 }, { maxTurns: 7 }, "oldTurns", "maxTurns"],
  [{ ui: { oldSplash: "never" } }, { ui: { splash: "never" } }, "ui.oldSplash", "ui.splash"],
  [{ legacy: { splash: "never" } }, { ui: { splash: "never" } }, "legacy.splash", "ui.splash"],
] as const) test(`deprecated ${key} resolves exactly like ${replacement} without mutating input`, () => {
  const original = structuredClone(old);
  const parsed = parseConfigObject(old, "/home/test/config.json", [{ key, replacement, since: "1.1.0", removeIn: "2.0" }]);
  const expected = parseConfigObject(modern, "/home/test/config.json");
  expect("error" in parsed).toBe(false); expect("error" in expected).toBe(false);
  if ("error" in parsed || "error" in expected) throw Error("Invalid fixture");
  expect(resolveSettings({ user: parsed })).toEqual(resolveSettings({ user: expected }));
  expect(parsed.deprecationWarnings?.map(w => w.message)).toEqual([`Config: "${key}" in /home/test/config.json is deprecated; use "${replacement}". It will be removed in 2.0.`]);
  expect(old).toEqual(original);
  expect(JSON.stringify(parsed)).toBe(JSON.stringify(modern));
});

test("explicit replacements win, even when the ignored legacy value fails the replacement schema", () => {
  const parsed = parseConfigObject({ ui: { oldSplash: 42, splash: "never" } }, "/config.json", [{ key: "ui.oldSplash", replacement: "ui.splash", since: "1.1.0", removeIn: "2.0" }]);
  if ("error" in parsed) throw Error(parsed.error);
  expect(parsed.ui?.splash).toBe("never");
  expect(parsed.deprecationWarnings?.[0]?.message).toBe('Config: "ui.oldSplash" in /config.json is deprecated; use "ui.splash". It will be removed in 2.0. "ui.oldSplash" is ignored because "ui.splash" is set.');
});

test("deprecations without replacements retain supported behavior and accept retired no-op keys", () => {
  for (const [value, key] of [[{ maxTurns: 7 }, "maxTurns"], [{ ui: { splash: "never" } }, "ui.splash"], [{ legacy: true }, "legacy"], [{ ui: { legacy: true } }, "ui.legacy"], [{ retired: { toggle: true } }, "retired.toggle"]] as const) {
    const parsed = parseConfigObject(value, "/config.json", [{ key, since: "1.1.0", removeIn: "2.0" }]);
    if ("error" in parsed) throw Error(parsed.error);
    expect(parsed.deprecationWarnings?.[0]?.message).toBe(`Config: "${key}" in /config.json is deprecated and has no replacement. It will be removed in 2.0.`);
    if (key === "maxTurns") expect(parsed.maxTurns).toBe(7);
    if (key === "ui.splash") expect(parsed.ui?.splash).toBe("never");
  }
  expect(parseConfigObject({ legacy: true }, "/config.json", [])).toMatchObject({ error: expect.stringContaining('<unknown setting>') });
  expect(parseConfigObject({ oldTurns: "invalid" }, "/config.json", [{ key: "oldTurns", replacement: "maxTurns", since: "1.1.0", removeIn: "2.0" }])).toMatchObject({ error: expect.stringContaining("maxTurns") });
});

test("retired nested settings cannot hide unknown siblings or malformed replacement parents", () => {
  const table = [{ key: "retired.toggle", since: "1.1.0", removeIn: "2.0" }];
  expect(parseConfigObject({ retired: { toggle: true, typo: true } }, "/config.json", table)).toMatchObject({ error: expect.stringContaining('<unknown setting>') });
  expect(parseConfigObject({ oldSplash: "never", ui: false }, "/config.json", [{ key: "oldSplash", replacement: "ui.splash", since: "1.1.0", removeIn: "2.0" }])).toMatchObject({ error: "Invalid config at /config.json: Invalid ui · Use a JSON object" });
});
