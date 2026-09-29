import { expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  loadResolvedSettings,
  mergeConfigLayers,
  parseConfigObject,
  projectConfigPath,
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

test("misspelled settings fail with the unknown name and valid keys", () => {
  const result = parseConfigObject({ modell: "gpt-5.4" }, "user-config");
  expect("error" in result).toBe(true);
  if (!("error" in result)) {
    throw new Error("expected validation error");
  }
  expect(result.error).toContain("user-config");
  expect(result.error).toContain("modell");
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

test("invalid types and non-positive limits fail with the setting name", () => {
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
