import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  mergeProfileMaps,
  parseConfigObject,
  resolveSettings,
} from "../src/config/config.ts";
import { loadConfigEditor } from "../src/config/editing.ts";
import { cliOverridesFromArgs, parseArgs } from "../src/cli/args.ts";
import { runCli } from "../src/cli/main.ts";
import {
  COMPATIBLE_API_KEY_ENV,
  resolveProviderCredential,
} from "../src/auth/credentials.ts";
import { credentialIdentity } from "../src/auth/store.ts";
import { createOpenAICompatibleModel } from "../src/model/providers/openai-compatible.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { TuiController } from "../src/tui/controller.ts";
import { modelPickerEntries } from "../src/tui/model-picker.ts";
import { parseModelArgs } from "../src/tui/commands.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { createScriptedModel, collect } from "./helpers/scripted-model.ts";
import {
  encodeChatCompletionsSse,
  TEXT_STREAM_CHUNKS,
  sampleRequest,
} from "./fixtures/openai-compatible.ts";
import { withTempDir } from "./helpers.ts";

test("valid profile definitions parse with references only", () => {
  const parsed = parseConfigObject(
    {
      profiles: {
        "local-ollama": {
          baseUrl: "http://127.0.0.1:11434/v1",
          model: "llama3.2",
          contextWindow: 64000,
          maxOutput: 2048,
          headers: { "X-Tenant": "local" },
          extraBody: { temperature: 0.2 },
          auth: "optional",
          credentialEnv: "LOCAL_KEY",
          credentialIdentity: "local-id",
        },
      },
      profile: "local-ollama",
    },
    "test",
  );
  expect("error" in parsed).toBe(false);
});

test("profile names, base URLs, models, and credential references validate", () => {
  for (const profiles of [
    { "bad name": { baseUrl: "https://example.test/v1" } },
    { "": { baseUrl: "https://example.test/v1" } },
    { ok: { baseUrl: "   " } },
    { ok: { baseUrl: "https://example.test/v1", model: "  " } },
    { ok: { baseUrl: "https://example.test/v1", credentialEnv: "bad-name!" } },
    { ok: { baseUrl: "https://example.test/v1", credentialEnv: "lower case" } },
    { ok: { baseUrl: "https://example.test/v1", credentialIdentity: "bad id!" } },
  ]) {
    const result = parseConfigObject({ profiles }, "test");
    expect("error" in result).toBe(true);
  }
  const badProfile = parseConfigObject({ profile: "bad name!" }, "test");
  expect("error" in badProfile).toBe(true);
});

test("secret values and credential headers are rejected inside profiles", () => {
  const secretKey = parseConfigObject(
    { profiles: { a: { baseUrl: "https://example.test/v1", apiKey: "sk-secret" } } },
    "test",
  );
  expect("error" in secretKey).toBe(true);
  if ("error" in secretKey) {
    expect(secretKey.error).toContain("API key");
    expect(secretKey.error.includes("sk-secret")).toBe(false);
  }
  const secretHeader = parseConfigObject(
    {
      profiles: {
        a: {
          baseUrl: "https://example.test/v1",
          headers: { Authorization: "Bearer sk-header-secret" },
        },
      },
    },
    "test",
  );
  expect("error" in secretHeader).toBe(true);
  if ("error" in secretHeader) {
    expect(secretHeader.error.includes("sk-header-secret")).toBe(false);
  }
});

test("project profile definitions replace the whole same-name profile", () => {
  const merged = mergeProfileMaps(
    {
      a: {
        baseUrl: "https://user.example.test/a/v1",
        model: "model-a",
        headers: { "X-Tenant": "user" },
        extraBody: { temperature: 0.9 },
        auth: "required",
      },
      b: { baseUrl: "https://user.example.test/b/v1" },
    },
    {
      a: { baseUrl: "https://project.example.test/a/v1", model: "project-a" },
    },
  );
  expect(merged.b?.baseUrl).toBe("https://user.example.test/b/v1");
  expect(merged.a?.baseUrl).toBe("https://project.example.test/a/v1");
  expect(merged.a?.model).toBe("project-a");
  expect(merged.a?.headers).toBeUndefined();
  expect(merged.a?.extraBody).toBeUndefined();
  expect(merged.a?.auth).toBeUndefined();
});

test("selected profile resolves by normal config CLI session precedence", () => {
  const withProject = resolveSettings({
    user: {
      profiles: {
        a: { baseUrl: "https://a.example.test/v1" },
        b: { baseUrl: "https://b.example.test/v1" },
        c: { baseUrl: "https://c.example.test/v1" },
        d: { baseUrl: "https://d.example.test/v1" },
      },
      profile: "a",
    },
    project: { profile: "b" },
    cli: { profile: "c" },
    session: { profile: "d" },
  });
  expect("error" in withProject).toBe(false);
  if ("error" in withProject) throw new Error(withProject.error);
  expect(withProject.profile).toBe("d");
  expect(withProject.baseUrl).toBe("https://d.example.test/v1");
});

test("explicit CLI and session flags apply last over the selected profile", () => {
  const resolved = resolveSettings({
    user: {
      profiles: {
        a: {
          baseUrl: "https://a.example.test/v1",
          model: "model-a",
          headers: { "X-Tenant": "a" },
          extraBody: { temperature: 0.2 },
          auth: "required",
          contextWindow: 64000,
          maxOutput: 2048,
        },
      },
      profile: "a",
    },
    cli: { model: "override-model", headers: { "X-Tenant": "cli" } },
    session: { maxOutput: 4096 },
  });
  expect("error" in resolved).toBe(false);
  if ("error" in resolved) throw new Error(resolved.error);
  expect(resolved.profile).toBe("a");
  expect(resolved.provider).toBe("openai-compatible");
  expect(resolved.baseUrl).toBe("https://a.example.test/v1");
  expect(resolved.model).toBe("override-model");
  expect(resolved.headers).toEqual({ "X-Tenant": "cli" });
  expect(resolved.extraBody).toEqual({ temperature: 0.2 });
  expect(resolved.maxOutput).toBe(4096);
  expect(resolved.contextWindow).toBe(64000);
});

test("unknown and malformed profiles fail before any provider request", () => {
  const unknown = resolveSettings({
    user: { profiles: { a: { baseUrl: "https://a.example.test/v1" } }, profile: "missing" },
  });
  expect("error" in unknown).toBe(true);
  if (!("error" in unknown)) throw new Error("expected unknown profile error");
  expect(unknown.error).toContain('Invalid profile · Select a configured compatible profile');
  expect(unknown).toMatchObject({ diagnostics: [{ source: "user settings", path: "profile", category: "constraint" }] });

  const empty = resolveSettings({ user: { profiles: {}, profile: "a" } });
  expect("error" in empty).toBe(true);

  const badName = parseArgs(["--profile", "bad name!"]);
  expect("error" in badName).toBe(true);
});

test("selected profile diagnostics identify the definition source across merged profile maps", () => {
  const result = resolveSettings({
    user: { profiles: { broken: { baseUrl: "https://user:private-secret@example.com?token=private-secret" } } },
    project: { profiles: { other: { baseUrl: "https://example.com" } }, profile: "broken" },
    configSources: { user: "/home/test/.schway/config.json", project: "/work/.schway/config.json" },
  });
  expect(result).toMatchObject({ diagnostics: [{ source: "/home/test/.schway/config.json", path: "profiles.<unknown setting>.baseUrl", category: "constraint" }] });
  expect(JSON.stringify(result)).not.toContain("private-secret");
});

test("prototype-named profiles resolve only own definitions and retain the owning source", () => {
  for (const name of ["constructor", "toString", "hasOwnProperty"]) {
    const input = { user: { profiles: { [name]: { baseUrl: "https://user:private-secret@example.com" } } }, project: { profiles: { unrelated: { baseUrl: "https://example.com" } }, profile: name }, configSources: { user: "/actual/user/config.json", project: "/other/project/config.json" } };
    expect(resolveSettings(input)).toMatchObject({ diagnostics: [{ source: input.configSources.user, path: "profiles.<unknown setting>.baseUrl", category: "constraint" }] });
    input.user.profiles[name]!.baseUrl = "https://example.com";
    expect(resolveSettings(input)).toMatchObject({ profile: name, baseUrl: "https://example.com" });
  }
});

test("--profile selects the compatible provider and rejects other providers", () => {
  const parsed = parseArgs(["--profile", "tenant-a"]);
  expect("error" in parsed).toBe(false);
  if ("error" in parsed) throw new Error(parsed.error);
  expect(parsed.args.profile).toBe("tenant-a");
  expect(cliOverridesFromArgs(parsed.args).profile).toBe("tenant-a");

  const conflict = parseArgs(["--profile", "a", "--provider", "openai"]);
  expect("error" in conflict).toBe(true);
  if (!("error" in conflict)) throw new Error("expected provider conflict");
  expect(conflict.error).toContain("openai-compatible");
});

test("direct compatible flags keep working without any profile", () => {
  const resolved = resolveSettings({
    cli: { provider: "openai-compatible", baseUrl: "https://direct.example.test/v1", model: "direct-model" },
  });
  expect("error" in resolved).toBe(false);
  if ("error" in resolved) throw new Error(resolved.error);
  expect(resolved.profile).toBeUndefined();
  expect(resolved.baseUrl).toBe("https://direct.example.test/v1");
});

test("profile credentials resolve through env references with runtime highest", async () => {
  const store = fakeCredentialStore();
  await store.set(
    credentialIdentity({ provider: "openai-compatible", baseUrl: "https://a.example.test/v1", profile: "a" }),
    "stored-a",
  );
  const env = { TENANT_A_KEY: "env-a", [COMPATIBLE_API_KEY_ENV]: "generic" };
  expect(
    await resolveProviderCredential({
      provider: "openai-compatible",
      baseUrl: "https://a.example.test/v1",
      profile: "a",
      credentialEnv: "TENANT_A_KEY",
      runtimeApiKey: "runtime",
      env,
      store,
    }),
  ).toEqual({ apiKey: "runtime", source: "runtime" });
  expect(
    await resolveProviderCredential({
      provider: "openai-compatible",
      baseUrl: "https://a.example.test/v1",
      profile: "a",
      credentialEnv: "TENANT_A_KEY",
      env,
      store,
    }),
  ).toEqual({ apiKey: "env-a", source: "env" });
  expect(
    await resolveProviderCredential({
      provider: "openai-compatible",
      baseUrl: "https://a.example.test/v1",
      profile: "a",
      credentialEnv: "MISSING_KEY",
      env,
      store,
    }),
  ).toEqual({ apiKey: "stored-a", source: "stored" });
});

test("profile store identities isolate endpoints and custom suffixes", async () => {
  const store = fakeCredentialStore();
  await store.set(
    credentialIdentity({ provider: "openai-compatible", baseUrl: "https://example.test/a/v1", profile: "a" }),
    "key-a",
  );
  await store.set(
    credentialIdentity({ provider: "openai-compatible", baseUrl: "https://example.test/b/v1", profile: "b" }),
    "key-b",
  );
  const forA = await resolveProviderCredential({
    provider: "openai-compatible",
    baseUrl: "https://example.test/a/v1",
    profile: "a",
    auth: "required",
    env: {},
    store,
  });
  expect(forA).toEqual({ apiKey: "key-a", source: "stored" });
  // Same endpoint with a different profile must not reuse the other profile's key.
  const cross = await resolveProviderCredential({
    provider: "openai-compatible",
    baseUrl: "https://example.test/a/v1",
    profile: "b",
    auth: "optional",
    env: {},
    store,
  });
  expect(cross).toEqual({ source: "none" });
  // Same profile with a changed endpoint must not silently send the old key.
  const moved = await resolveProviderCredential({
    provider: "openai-compatible",
    baseUrl: "https://example.test/a/v2",
    profile: "a",
    auth: "optional",
    env: {},
    store,
  });
  expect(moved).toEqual({ source: "none" });
  const movedRequired = await resolveProviderCredential({
    provider: "openai-compatible",
    baseUrl: "https://example.test/a/v2",
    profile: "a",
    auth: "required",
    env: {},
    store,
  });
  expect("error" in movedRequired).toBe(true);
});

test("auth none sends no credentials and required reports missing before requests", async () => {
  const store = fakeCredentialStore();
  await store.set(
    credentialIdentity({ provider: "openai-compatible", baseUrl: "https://example.test/v1", profile: "a" }),
    "stored",
  );
  expect(
    await resolveProviderCredential({
      provider: "openai-compatible",
      baseUrl: "https://example.test/v1",
      profile: "a",
      auth: "none",
      env: { TENANT_A_KEY: "env" },
      credentialEnv: "TENANT_A_KEY",
      store,
    }),
  ).toEqual({ source: "none" });
  const requiredMissing = await resolveProviderCredential({
    provider: "openai-compatible",
    baseUrl: "https://example.test/v1",
    profile: "missing",
    auth: "required",
    env: {},
    store: fakeCredentialStore(),
  });
  expect("error" in requiredMissing).toBe(true);
});

type Captured = { url?: string; body?: unknown; headers?: Headers; calls: number };

function capturingFetch(captured: Captured) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    captured.calls += 1;
    captured.url = String(input);
    captured.headers = new Headers(init?.headers);
    captured.body = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(encodeChatCompletionsSse(TEXT_STREAM_CHUNKS), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
}

test("two protocol endpoints receive only their profile model body headers credential", async () => {
  const user = {
    profiles: {
      a: {
        baseUrl: "http://127.0.0.1:8101/v1",
        model: "model-a",
        headers: { "X-Tenant": "a" },
        extraBody: { temperature: 0.2 },
        auth: "optional",
        credentialEnv: "PROFILE_A_KEY",
      },
      b: {
        baseUrl: "http://127.0.0.1:8102/v1",
        model: "model-b",
        headers: { "X-Tenant": "b" },
        extraBody: { temperature: 0.7 },
        auth: "optional",
        credentialEnv: "PROFILE_B_KEY",
      },
    },
  } as never;
  const env = { PROFILE_A_KEY: "sentinel-a", PROFILE_B_KEY: "sentinel-b" };
  for (const [name, expected] of [
    ["a", { url: "http://127.0.0.1:8101/v1/chat/completions", model: "model-a", tenant: "a", temperature: 0.2, key: "sentinel-a" }],
    ["b", { url: "http://127.0.0.1:8102/v1/chat/completions", model: "model-b", tenant: "b", temperature: 0.7, key: "sentinel-b" }],
  ] as const) {
    const resolved = resolveSettings({ user, cli: { profile: name } });
    expect("error" in resolved).toBe(false);
    if ("error" in resolved) throw new Error(resolved.error);
    const credential = await resolveProviderCredential({
      provider: resolved.provider,
      baseUrl: resolved.baseUrl,
      auth: resolved.auth,
      profile: resolved.profile,
      credentialEnv: resolved.credentialEnv,
      env,
      store: fakeCredentialStore(),
    });
    expect("error" in credential).toBe(false);
    if ("error" in credential) throw new Error(credential.error);
    const captured: Captured = { calls: 0 };
    const model = createOpenAICompatibleModel({
      baseUrl: resolved.baseUrl!,
      model: resolved.model,
      apiKey: credential.apiKey,
      auth: resolved.auth,
      headers: resolved.headers,
      extraBody: resolved.extraBody,
      fetch: capturingFetch(captured),
    });
    await collect(model.stream(sampleRequest()));
    expect(captured.url).toBe(expected.url);
    expect((captured.body as { model: string }).model).toBe(expected.model);
    expect((captured.body as { temperature: number }).temperature).toBe(expected.temperature);
    expect(captured.headers?.get("X-Tenant")).toBe(expected.tenant);
    expect(captured.headers?.get("Authorization")).toBe(`Bearer ${expected.key}`);
    expect(JSON.stringify(captured)).not.toContain(name === "a" ? "sentinel-b" : "sentinel-a");
  }
});

test("project replacement and runtime overrides appear in actual protocol requests", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const project = join(dir, "project");
    await mkdir(join(home, ".schway"), { recursive: true });
    await mkdir(join(project, ".schway"), { recursive: true });
    await writeFile(
      join(home, ".schway", "config.json"),
      JSON.stringify({
        profiles: {
          shared: {
            baseUrl: "https://global.example.test/v1",
            model: "global-model",
            headers: { "X-Tenant": "global" },
            auth: "optional",
            credentialEnv: "GLOBAL_KEY",
          },
        },
        profile: "shared",
      }),
    );
    await writeFile(
      join(project, ".schway", "config.json"),
      JSON.stringify({
        profiles: {
          shared: { baseUrl: "https://project.example.test/v1", model: "project-model", auth: "optional" },
        },
      }),
    );
    const { loadResolvedSettings } = await import("../src/config/config.ts");
    const resolved = await loadResolvedSettings({
      home,
      workspaceRoot: project,
      cli: { profile: "shared", model: "runtime-model" },
    });
    expect("error" in resolved).toBe(false);
    if ("error" in resolved) throw new Error(resolved.error);
    expect(resolved.baseUrl).toBe("https://project.example.test/v1");
    expect(resolved.model).toBe("runtime-model");
    expect(resolved.headers).toBeUndefined();
    const credential = await resolveProviderCredential({
      provider: resolved.provider,
      baseUrl: resolved.baseUrl,
      auth: resolved.auth,
      profile: resolved.profile,
      env: { RUNTIME_KEY: "runtime-sentinel" },
      store: fakeCredentialStore(),
      runtimeApiKey: "runtime-sentinel",
    });
    expect(credential).toEqual({ apiKey: "runtime-sentinel", source: "runtime" });
  });
});

test("headless --profile fails before provider requests for unknown profiles", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const project = join(dir, "project");
    await mkdir(home);
    await mkdir(project);
    let created = false;
    const stdout = { write(_: string) {} };
    let stderr = "";
    const exitCode = await runCli(["-p", "hello", "--profile", "missing"], {
      stdout,
      stderr: { write(chunk: string) { stderr += chunk; } },
      env: { HOME: home },
      cwd: project,
      credentialStore: fakeCredentialStore(),
      createModel: async () => {
        created = true;
        return createScriptedModel({ text: "unreachable" });
      },
    });
    expect(exitCode).toBe(1);
    expect(created).toBe(false);
    expect(stderr).toContain('Invalid profile · Select a configured compatible profile');
  });
});

test("controller switches profiles atomically and retains previous on unknown names", async () => {
  await withTempDir(async (root) => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const home = join(root, "home");
    const editor = await loadConfigEditor({
      home,
      workspaceRoot: root,
      cli: {
        profiles: {
          a: { baseUrl: "https://a.example.test/v1", model: "model-a", auth: "optional" },
          b: { baseUrl: "https://b.example.test/v1", model: "model-b", auth: "optional" },
        },
        profile: "a",
      },
    });
    let previous = editor.settings;
    const controller = new TuiController({
      session: createSession(),
      sessionId: "profiles",
      workspace,
      configEditor: editor,
      provider: previous.provider,
      modelId: previous.model,
      model: createScriptedModel({ text: "from-a" }),
      contextManager: createContextManager(workspace),
      stageSettings: async (next, signal, nextWorkspace, _model) => {
        void signal;
        void _model;
        previous = next;
        return {
          model: createScriptedModel({ provider: next.provider, id: next.model, text: `from-${next.profile}` }),
          contextManager: createContextManager(nextWorkspace ?? workspace, { contextWindow: next.contextWindow }),
        };
      },
    });
    expect(controller.snapshot().modelId).toBe("model-a");
    expect(await controller.selectProfile("b")).toBe(true);
    expect(controller.snapshot().modelId).toBe("model-b");
    expect(controller.snapshot().profile).toBe("b");
    expect(controller.describeConfig()).toContain('profile: b');
    expect(await controller.selectProfile("missing")).toBe(false);
    expect(controller.snapshot().profile).toBe("b");
    expect(controller.snapshot().modelId).toBe("model-b");
    await controller.submit("still usable");
    expect(controller.snapshot().transcript.some((entry) => entry.text === "from-b")).toBe(true);
  });
});

test("controller credential failure and cancellation retain the active profile", async () => {
  await withTempDir(async (root) => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({
      home: join(root, "home"),
      workspaceRoot: root,
      cli: {
        profiles: {
          ok: { baseUrl: "https://ok.example.test/v1", model: "model-ok", auth: "optional" },
          locked: { baseUrl: "https://locked.example.test/v1", model: "model-locked", auth: "required" },
        },
        profile: "ok",
      },
    });
    let release: (() => void) | undefined;
    let block = false;
    const controller = new TuiController({
      session: createSession(),
      sessionId: "profile-failure",
      workspace,
      configEditor: editor,
      provider: "openai-compatible",
      modelId: "model-ok",
      model: createScriptedModel({ text: "working" }),
      contextManager: createContextManager(workspace),
      stageSettings: async (next) => {
        if (next.profile === "locked") throw new Error("Missing API key for OpenAI-compatible endpoint");
        if (block) await new Promise<void>((resolve) => { release = resolve; });
        return {
          model: createScriptedModel({ provider: next.provider, id: next.model, text: "next" }),
          contextManager: createContextManager(workspace, { contextWindow: next.contextWindow }),
        };
      },
    });
    expect(await controller.selectProfile("locked")).toBe(false);
    expect(controller.snapshot().profile).toBe("ok");
    expect(controller.snapshot().modelId).toBe("model-ok");
    block = true;
    const pending = controller.selectProfile("ok");
    while (!release) await Bun.sleep(1);
    expect(controller.running).toBe(true);
    controller.cancel();
    release();
    expect(await pending).toBe(false);
    expect(controller.snapshot().profile).toBe("ok");
    await controller.submit("still works");
    expect(controller.snapshot().transcript.some((entry) => entry.text === "working")).toBe(true);
  });
});

test("model picker lists profiles and /model profile syntax selects them", async () => {
  await withTempDir(async (root) => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({
      home: join(root, "home"),
      workspaceRoot: root,
      cli: {
        profiles: {
          alpha: { baseUrl: "https://alpha.example.test/v1", model: "alpha-model" },
        },
        profile: "alpha",
      },
    });
    const entries = modelPickerEntries("", "openai-compatible", "alpha-model", {}, {
      profiles: editor.profiles,
      activeProfile: editor.settings.profile,
    });
    expect(entries.some((entry) => entry.profile === "alpha" && entry.active)).toBe(true);
    expect(parseModelArgs("profile:alpha", "openai")).toEqual({
      provider: "openai-compatible",
      modelId: "",
      profile: "alpha",
    });
    const controller = new TuiController({
      session: createSession(),
      sessionId: "picker-profile",
      workspace,
      configEditor: editor,
      provider: "openai-compatible",
      modelId: "alpha-model",
      model: createScriptedModel({ text: "alpha" }),
      contextManager: createContextManager(workspace),
      stageSettings: async (next, _signal, nextWorkspace) => ({
        model: createScriptedModel({ provider: next.provider, id: next.model, text: "switched" }),
        contextManager: createContextManager(nextWorkspace ?? workspace, { contextWindow: next.contextWindow }),
      }),
    });
    controller.openModelPicker();
    controller.searchModels("alpha");
    expect(controller.snapshot().modelPicker?.entries.some((entry) => entry.profile === "alpha")).toBe(true);
    expect(await controller.selectModel("profile:alpha")).toBe(true);
    expect(controller.snapshot().profile).toBe("alpha");
    expect(controller.describeConfig()).toContain("alpha");
  });
});

test("status and config display the active profile with redacted settings", async () => {
  await withTempDir(async (root) => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const secret = "profile-display-sentinel";
    const editor = await loadConfigEditor({
      home: join(root, "home"),
      workspaceRoot: root,
      cli: {
        profiles: {
          shown: {
            baseUrl: "https://shown.example.test/v1",
            model: "shown-model",
            headers: { "X-Custom": "hidden-value" },
            extraBody: { nested: "hidden-body" },
            auth: "optional",
            credentialEnv: "SHOWN_KEY",
          },
        },
        profile: "shown",
      },
    });
    const controller = new TuiController({
      session: createSession(),
      sessionId: "display",
      workspace,
      configEditor: editor,
      provider: "openai-compatible",
      modelId: "shown-model",
      model: createScriptedModel(),
      contextManager: createContextManager(workspace),
      secrets: [secret, "hidden-value", "hidden-body"],
    });
    const snapshot = controller.snapshot();
    expect(snapshot.profile).toBe("shown");
    const text = controller.describeConfig();
    expect(text).toContain("shown");
    expect(text).toContain("credentialEnv: SHOWN_KEY");
    expect(text).not.toContain("hidden-value");
    expect(text).not.toContain("hidden-body");
    expect(text).not.toContain(secret);
  });
});

test("profile baseUrl values reject non-absolute userinfo and query URLs", () => {
  for (const baseUrl of [
    "not-a-url",
    "https://user:pass@example.test/v1",
    "https://user@example.test/v1",
    "https://example.test/v1?region=test",
    "https://example.test/v1?region=test#frag",
  ]) {
    const parsed = parseConfigObject({ profiles: { a: { baseUrl } } }, "test");
    expect("error" in parsed).toBe(true);
    if ("error" in parsed) {
      expect(parsed.error).toContain("profiles.<unknown setting>.baseUrl");
      expect(parsed.error.includes(baseUrl)).toBe(false);
    }
    const resolved = resolveSettings({
      user: { profiles: { a: { baseUrl } }, profile: "a" },
    });
    expect("error" in resolved).toBe(true);
    if ("error" in resolved) {
      expect(resolved.error).toContain("profiles.<unknown setting>.baseUrl");
    }
  }
});

test("secret-like keys inside profile extraBody are rejected", () => {
  for (const extraBody of [
    { apiKey: "sk-extra-secret" },
    { api_key: "sk-extra-secret" },
    { "api-key": "sk-extra-secret" },
    { token: "extra-token-secret" },
    { SECRET: "extra-secret-value" },
    { credentials: "extra-credentials" },
  ]) {
    const parsed = parseConfigObject(
      { profiles: { a: { baseUrl: "https://example.test/v1", extraBody } } },
      "test",
    );
    expect("error" in parsed).toBe(true);
    if ("error" in parsed) {
      expect(parsed.error).toContain("API key");
      expect(parsed.error.includes("sk-extra-secret")).toBe(false);
      expect(parsed.error.includes("extra-token-secret")).toBe(false);
      expect(parsed.error.includes("extra-secret-value")).toBe(false);
    }
    const resolved = resolveSettings({
      user: {
        profiles: { a: { baseUrl: "https://example.test/v1", extraBody } as never },
        profile: "a",
      },
    });
    expect("error" in resolved).toBe(true);
  }
});

test("bare model tokens never switch profiles", async () => {
  await withTempDir(async (root) => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({
      home: join(root, "home"),
      workspaceRoot: root,
      cli: {
        profiles: {
          alpha: { baseUrl: "https://alpha.example.test/v1", model: "alpha-model" },
        },
      },
    });
    const controller = new TuiController({
      session: createSession(),
      sessionId: "bare-name",
      workspace,
      configEditor: editor,
      provider: "openai",
      modelId: "test-model",
      model: createScriptedModel({ text: "direct" }),
      contextManager: createContextManager(workspace),
      stageSettings: async (next, _signal, nextWorkspace) => ({
        model: createScriptedModel({ provider: next.provider, id: next.model, text: "switched" }),
        contextManager: createContextManager(nextWorkspace ?? workspace, { contextWindow: next.contextWindow }),
      }),
    });
    expect(controller.snapshot().profile).toBeUndefined();
    expect(await controller.selectModel("alpha")).toBe(true);
    expect(controller.snapshot().profile).toBeUndefined();
    expect(controller.snapshot().provider).toBe("openai");
    expect(controller.snapshot().modelId).toBe("alpha");
  });
});

test("selected profiles ignore direct file connection fields but keep file budgets", () => {
  const resolved = resolveSettings({
    user: {
      profiles: {
        a: { baseUrl: "https://a.example.test/v1", credentialEnv: "A_KEY" },
      },
      profile: "a",
      provider: "openai-compatible",
      baseUrl: "https://direct.example.test/v1",
      model: "direct-model",
      headers: { "X-Tenant": "other" },
      extraBody: { temperature: 0.9 },
      auth: "none",
      contextWindow: 32000,
      maxOutput: 4000,
    },
  });
  expect("error" in resolved).toBe(false);
  if ("error" in resolved) throw new Error(resolved.error);
  expect(resolved.profile).toBe("a");
  expect(resolved.baseUrl).toBe("https://a.example.test/v1");
  expect(resolved.model).toBe("");
  expect(resolved.headers).toBeUndefined();
  expect(resolved.extraBody).toBeUndefined();
  expect(resolved.auth).toBe("optional");
  expect(resolved.credentialEnv).toBe("A_KEY");
  expect(resolved.contextWindow).toBe(32000);
  expect(resolved.maxOutput).toBe(4000);
});

test("profile origins attribute connection fields to the profile and keep file budgets", async () => {
  const { ConfigEditor } = await import("../src/config/editing.ts");
  const editor = new ConfigEditor(
    {
      user: {
        profiles: {
          a: { baseUrl: "https://a.example.test/v1", model: "model-a" },
        },
        profile: "a",
        headers: { "X-Tenant": "other" },
        model: "direct-model",
        maxOutput: 4000,
      },
    },
    { user: "user", project: "project" },
  );
  expect(editor.settings.headers).toBeUndefined();
  expect(editor.origins.headers).toBeUndefined();
  expect(editor.origins.baseUrl).toBe('profile "a" [user-global]');
  expect(editor.settings.model).toBe("model-a");
  expect(editor.origins.model).toBe('profile "a" [user-global]');
  expect(editor.settings.maxOutput).toBe(4000);
  expect(editor.origins.maxOutput).toBe("user-global");
  const bare = new ConfigEditor(
    {
      user: {
        profiles: { b: { baseUrl: "https://b.example.test/v1" } },
        profile: "b",
        provider: "openai-compatible",
        model: "direct-model",
      },
    },
    { user: "user", project: "project" },
  );
  expect(bare.settings.model).toBe("");
  expect(bare.origins.model).toBeUndefined();
});

test("direct model selection clears profiles selected through CLI layers", async () => {
  await withTempDir(async (root) => {
    const input = {
      home: join(root, "home"),
      workspaceRoot: root,
      cli: {
        profiles: { a: { baseUrl: "https://a.example.test/v1", model: "model-a" } },
        profile: "a",
      },
    };
    const editor = await loadConfigEditor(input);
    expect(editor.settings.profile).toBe("a");
    const staged = await editor.prepareModel("openai", "gpt-5.4");
    expect(staged.settings.provider).toBe("openai");
    expect(staged.settings.model).toBe("gpt-5.4");
    expect(staged.settings.profile).toBeUndefined();
    await staged.commit();
    expect(editor.settings.profile).toBeUndefined();
    expect(editor.settings.provider).toBe("openai");
    const resetEditor = await loadConfigEditor(input);
    const reset = await resetEditor.prepare({ scope: "session", key: "profile", value: undefined });
    expect(reset.settings.profile).toBeUndefined();
    await reset.commit();
    expect(resetEditor.settings.profile).toBeUndefined();
  });
});

test("non-HTTP(S) profile base URLs fail before any provider request", () => {
  for (const baseUrl of ["ftp://host/v1", "file:///tmp/x", "data:text/plain,hi"]) {
    const parsed = parseConfigObject({ profiles: { a: { baseUrl } } }, "test");
    expect("error" in parsed).toBe(true);
    const resolved = resolveSettings({
      user: { profiles: { a: { baseUrl } }, profile: "a" },
    });
    expect("error" in resolved).toBe(true);
    if ("error" in resolved) {
      expect(resolved.error).toContain("profiles.<unknown setting>.baseUrl");
    }
  }
  const ok = parseConfigObject(
    { profiles: { a: { baseUrl: "https://example.test/v1" } } },
    "test",
  );
  expect("error" in ok).toBe(false);
});

test("narrow picker queries do not surface unrelated profiles", () => {
  const profiles = { a: { baseUrl: "https://a.example.test/v1", model: "model-a" } };
  const unrelated = modelPickerEntries("claude", "openai", "gpt-5.4", {}, { profiles });
  expect(unrelated.some((entry) => entry.profile === "a")).toBe(false);
  const matched = modelPickerEntries("model-a", "openai", "gpt-5.4", {}, { profiles });
  expect(matched.some((entry) => entry.profile === "a")).toBe(true);
});
