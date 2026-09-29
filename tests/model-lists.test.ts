import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { credentialIdentity } from "../src/auth/store.ts";
import { runCli } from "../src/cli/main.ts";
import { NO_MODEL_CONFIGURED_MESSAGE, loadResolvedSettings, validateThinking } from "../src/config/config.ts";
import { loadConfigEditor } from "../src/config/editing.ts";
import { InteractiveMemory } from "../src/config/interactive-memory.ts";
import { createContextManager } from "../src/context/manager.ts";
import { lookupModel, ROUTE_FALLBACK_MODELS } from "../src/model/catalog.ts";
import { stageInteractiveSettings } from "../src/tui/app.ts";
import { fetchProviderModelList, filterXaiModels, ModelListTooLargeError, parseModelList, recommendedListedModel, requireOpenAIApiKeyModels, requireXaiModels, xaiModelCapabilities } from "../src/model/model-list.ts";
import { createSession } from "../src/session/session.ts";
import { TuiController } from "../src/tui/controller.ts";
import { createConversationView } from "../src/tui/view.ts";
import { dispatchEditorInput } from "../src/tui/commands.ts";
import { modelPickerEntries } from "../src/tui/model-picker.ts";
import { preferenceRows } from "../src/tui/preferences.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { withTempDir } from "./helpers.ts";

test("a fresh install names no model, keeps typed text, and will not send", async () => {
  const terminal = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true });
  const workspace = { root: "/project", launchCwd: "/project", extraRoots: [] };
  const controller = new TuiController({
    session: createSession(), workspace, provider: "openai", modelId: "", sessionId: "fresh",
    contextManager: createContextManager(workspace),
    credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ error: "unused" }) },
  });
  const view = createConversationView(terminal.renderer, {
    controller, workspaceRoot: workspace.root, home: "/home/test", env: {}, secrets: [],
    quit: () => {}, openUrl: async () => {},
    submit: (value, accepted) => dispatchEditorInput(value, controller, async () => false, accepted),
  });
  try {
    await terminal.flush();
    const frame = terminal.captureCharFrame();
    expect(frame).toContain("No model yet · Sign in to choose one · Alt+L");
    expect(frame).not.toContain("gpt-");
    expect(frame).not.toContain("openai/");
    expect(frame).not.toContain("claude");
    await terminal.mockInput.pasteBracketedText("keep this task");
    terminal.mockInput.pressEnter();
    await Bun.sleep(5);
    view.refresh();
    await terminal.flush();
    const editor = terminal.renderer.root.findDescendantById("prompt") as unknown as { plainText: string };
    expect(editor.plainText).toBe("keep this task");
    expect(controller.snapshot().transcript.some(entry => entry.kind === "user")).toBe(false);
    expect(controller.snapshot().modelId).toBe("");
    expect(terminal.captureCharFrame()).not.toContain("gpt-");
  } finally {
    view.destroy();
    controller.dispose();
    terminal.renderer.destroy();
  }
});

test("headless without a provider and model exits with the configuration message", async () => {
  await withTempDir(async home => {
    let stderr = "";
    const code = await runCli(["-p", "hello"], {
      cwd: home, env: { HOME: home }, stdout: { write() {} }, stderr: { write(text) { stderr += text; } },
      credentialStore: fakeCredentialStore(),
    });
    expect(code).not.toBe(0);
    expect(stderr.trim()).toBe(NO_MODEL_CONFIGURED_MESSAGE);
    const resolved = await loadResolvedSettings({ home, workspaceRoot: home });
    expect("error" in resolved).toBe(false);
    if (!("error" in resolved)) expect(resolved.model).toBe("");
  });
});

test("picker rows come from the model list, and a failed list stays selectable", async () => {
  await withTempDir(async root => {
    const home = join(root, "home");
    await mkdir(home);
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({ home, workspaceRoot: root, cli: { provider: "openai", model: "gpt-4o", openaiAuth: "api-key" } });
    const store = fakeCredentialStore();
    await store.set(credentialIdentity({ provider: "openai" }), "api-secret");
    const listed = parseModelList({
      default: "listed-default",
      data: [
        { id: "gpt-6-astra" },
        { id: "listed-only", max_output_tokens: 4096 },
        { id: "listed-default" },
      ],
    }, "OpenAI");
    expect(recommendedListedModel("api-key", listed)).toBe("listed-default");
    expect(lookupModel("openai", "gpt-6-astra").maxOutput).toBe(128_000);
    expect(lookupModel("openai", "gpt-6-astra").maxOutput).not.toBe(16_384);

    const controller = new TuiController({
      session: createSession(), sessionId: "lists", workspace, configEditor: editor,
      provider: "openai", modelId: "gpt-4o", model: createScriptedModel({ provider: "openai", id: "gpt-4o" }),
      contextManager: createContextManager(workspace),
      credentials: {
        store, env: {}, reload: async () => ({ error: "unused" }),
        listRouteModels: async () => listed,
      },
      stageSettings: async settings => ({ model: createScriptedModel({ provider: settings.provider, id: settings.model }), contextManager: createContextManager(workspace) }),
    });
    try {
      controller.openModelPicker();
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      const entries = controller.snapshot().modelPicker?.entries ?? [];
      const astra = entries.find(entry => entry.authRoute === "api-key" && entry.modelId === "gpt-6-astra");
      const custom = entries.find(entry => entry.modelId === "listed-only");
      expect(astra?.maxOutput).toBe(128_000);
      expect(custom?.maxOutput).toBe(4096);
      expect(entries.some(entry => entry.authRoute === "api-key" && entry.modelId === "gpt-4o" && !entry.custom)).toBe(false);
    } finally { controller.dispose(); }

    const failed = new TuiController({
      session: createSession(), sessionId: "unavailable", workspace, configEditor: editor,
      provider: "openai", modelId: "gpt-4o", model: createScriptedModel({ provider: "openai", id: "gpt-4o" }),
      contextManager: createContextManager(workspace),
      credentials: {
        store, env: {}, reload: async () => ({ error: "unused" }),
        listRouteModels: async () => { throw new Error("offline"); },
      },
      stageSettings: async settings => ({ model: createScriptedModel({ provider: settings.provider, id: settings.model }), contextManager: createContextManager(workspace) }),
    });
    try {
      failed.openModelPicker();
      while (failed.snapshot().modelPicker?.loading) await Bun.sleep(1);
      const frameEntries = failed.snapshot().modelPicker?.entries ?? [];
      const fallback = frameEntries.find(entry => entry.listUnavailable && entry.modelId === "gpt-5.4");
      expect(fallback).toBeDefined();
      const index = frameEntries.findIndex(entry => entry.identity === fallback?.identity);
      failed.moveModelPicker(index - (failed.snapshot().modelPicker?.selectedIndex ?? 0));
      expect(await failed.selectPickerModel()).toBe(true);
      expect(failed.snapshot().modelId).toBe("gpt-5.4");
    } finally { failed.dispose(); }
  });
});

test("sign-in activates the route fallback and restores it on the next launch", async () => {
  await withTempDir(async root => {
    const home = join(root, "home");
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({ home, workspaceRoot: root, interactiveMemory: true });
    expect(editor.settings.model).toBe("");
    const store = fakeCredentialStore();
    const controller = new TuiController({
      session: createSession(), sessionId: "sign-in", workspace, configEditor: editor, home,
      provider: editor.settings.provider, modelId: editor.settings.model, contextManager: createContextManager(workspace),
      credentials: {
        store, env: {}, rememberSecret: () => {},
        reload: async () => ({ error: "unused" }),
        listRouteModels: async () => [{ id: "other-model" }, { id: ROUTE_FALLBACK_MODELS.openai }],
      },
      stageSettings: async settings => ({ model: createScriptedModel({ provider: "openai", id: settings.model }), contextManager: createContextManager(workspace) }),
    });
    try {
      expect(controller.beginLogin("openai")).toBe(true);
      controller.enterCredentialText("signed-in-key");
      expect(await controller.submitCredential()).toBe(true);
      expect(controller.snapshot().modelId).toBe(ROUTE_FALLBACK_MODELS.openai);
      expect(await controller.submit("hello")).toBe(true);
    } finally { controller.dispose(); }
    const restored = await loadConfigEditor({ home, workspaceRoot: root, interactiveMemory: true });
    expect(restored.settings.model).toBe(ROUTE_FALLBACK_MODELS.openai);
    expect(restored.origins.model).toBe("interactive memory");
    const memory = await InteractiveMemory.load(home, root);
    expect(memory.choice?.model).toBe(ROUTE_FALLBACK_MODELS.openai);
  });
});

test("compatible sign-in keeps the selected profile", async () => {
  await withTempDir(async root => {
    const home = join(root, "home");
    const editor = await loadConfigEditor({
      home, workspaceRoot: root,
      cli: { profile: "local", profiles: { local: { baseUrl: "http://127.0.0.1:9/v1", auth: "required" } } },
    });
    const transaction = await editor.prepareModel("openai-compatible", "listed-model", "local");
    expect(transaction.settings.profile).toBe("local");
    expect(transaction.settings.model).toBe("listed-model");
    expect(transaction.settings.baseUrl).toBe("http://127.0.0.1:9/v1");
  });
});

test("fetched model budgets outrank static lookup unless config sets an explicit limit", async () => {
  await withTempDir(async root => {
    const home = join(root, "home");
    const editor = await loadConfigEditor({ home, workspaceRoot: root, cli: { provider: "openai", model: "gpt-4o" } });
    const workspace = { root, launchCwd: root, extraRoots: [] };
    let maxTokens: number | undefined;
    const staged = await stageInteractiveSettings(editor.settings, editor.settings, {
      forceLoad: true, workspace, home, signal: AbortSignal.timeout(1_000), runtimeApiKey: "sk-test", env: {}, secrets: [],
      fetchedMaxOutput: 4096, fetchedContextWindow: 111_000,
      createModel: async input => { maxTokens = input.maxTokens; return createScriptedModel({ id: input.model }); },
    });
    expect(maxTokens).toBe(4096);
    expect(staged.contextManager).toBeDefined();
    const explicit = await loadConfigEditor({ home, workspaceRoot: root, cli: { provider: "openai", model: "gpt-4o", maxOutput: 1024 } });
    let explicitTokens: number | undefined;
    await stageInteractiveSettings(explicit.settings, explicit.settings, {
      forceLoad: true, workspace, home, signal: AbortSignal.timeout(1_000), runtimeApiKey: "sk-test", env: {}, secrets: [],
      fetchedMaxOutput: 4096,
      createModel: async input => { explicitTokens = input.maxTokens; return createScriptedModel({ id: input.model }); },
    });
    expect(explicitTokens).toBe(1024);
  });
});

test("OpenAI API-key picker rows keep chat models and drop non-chat IDs", async () => {
  const parsed = parseModelList({
    data: [
      { id: "gpt-6-astra" },
      { id: "text-embedding-3-large" },
      { id: "whisper-1" },
      { id: "dall-e-3" },
      { id: "tts-1" },
      { id: "omni-moderation-latest" },
      { id: "babbage-002" },
      { id: "gpt-4o-realtime-preview" },
    ],
  }, "OpenAI");
  expect(requireOpenAIApiKeyModels(parsed).map(model => model.id)).toEqual(["gpt-6-astra"]);
  await withTempDir(async root => {
    const home = join(root, "home");
    await mkdir(home);
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({ home, workspaceRoot: root, cli: { provider: "openai", model: "gpt-4o", openaiAuth: "api-key" } });
    const store = fakeCredentialStore();
    await store.set(credentialIdentity({ provider: "openai" }), "api-secret");
    const controller = new TuiController({
      session: createSession(), sessionId: "chat-only", workspace, configEditor: editor,
      provider: "openai", modelId: "gpt-4o", model: createScriptedModel({ provider: "openai", id: "gpt-4o" }),
      contextManager: createContextManager(workspace),
      credentials: {
        store, env: {}, reload: async () => ({ error: "unused" }),
        listRouteModels: async route => route === "api-key" ? requireOpenAIApiKeyModels(parsed) : parsed,
      },
      stageSettings: async settings => ({ model: createScriptedModel({ provider: settings.provider, id: settings.model }), contextManager: createContextManager(workspace) }),
    });
    try {
      controller.openModelPicker();
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      const rows = controller.snapshot().modelPicker?.entries.filter(entry => entry.authRoute === "api-key" && !entry.custom) ?? [];
      expect(rows.map(entry => entry.modelId)).toEqual(["gpt-6-astra"]);
    } finally { controller.dispose(); }

    const failed = new TuiController({
      session: createSession(), sessionId: "chat-empty", workspace, configEditor: editor,
      provider: "openai", modelId: "gpt-4o", model: createScriptedModel({ provider: "openai", id: "gpt-4o" }),
      contextManager: createContextManager(workspace),
      credentials: {
        store, env: {}, reload: async () => ({ error: "unused" }),
        listRouteModels: async () => requireOpenAIApiKeyModels(parseModelList({ data: [{ id: "whisper-1" }, { id: "dall-e-3" }] }, "OpenAI")),
      },
      stageSettings: async settings => ({ model: createScriptedModel({ provider: settings.provider, id: settings.model }), contextManager: createContextManager(workspace) }),
    });
    try {
      failed.openModelPicker();
      while (failed.snapshot().modelPicker?.loading) await Bun.sleep(1);
      const rows = failed.snapshot().modelPicker?.entries.filter(entry => entry.authRoute === "api-key" && !entry.custom) ?? [];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(entry => entry.listUnavailable)).toBe(true);
    } finally { failed.dispose(); }
  });
});

test("sign-in recommendation prefers a catalog chat model over an arbitrary first ID", () => {
  expect(recommendedListedModel("api-key", [{ id: "whisper-1" }, { id: "gpt-4.1" }])).toBe("gpt-4.1");
  expect(recommendedListedModel("api-key", [{ id: "gpt-6-astra" }, { id: "marked", recommended: true }])).toBe("marked");
  expect(recommendedListedModel("compatible", [{ id: "custom-a" }, { id: "custom-b" }])).toBe("custom-a");
});

test("large compatible lists parse and stay available in the picker", async () => {
  const listed = parseModelList({ data: Array.from({ length: 600 }, (_, index) => ({ id: `custom-${index}` })) }, "Compatible");
  expect(listed).toHaveLength(600);
  expect(parseModelList({ data: Array.from({ length: 5_001 }, (_, index) => ({ id: `m${index}` })) }, "Compatible")).toHaveLength(5_000);
  await withTempDir(async root => {
    const home = join(root, "home");
    await mkdir(home);
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({
      home, workspaceRoot: root,
      cli: { provider: "openai-compatible", model: "gpt-4o", baseUrl: "http://127.0.0.1:9/v1", auth: "none" },
    });
    const controller = new TuiController({
      session: createSession(), sessionId: "large-list", workspace, configEditor: editor,
      provider: "openai-compatible", modelId: "gpt-4o", model: createScriptedModel({ provider: "openai-compatible", id: "gpt-4o" }),
      contextManager: createContextManager(workspace),
      credentials: {
        store: fakeCredentialStore(), env: {}, reload: async () => ({ error: "unused" }),
        listRouteModels: async () => listed,
      },
      stageSettings: async settings => ({ model: createScriptedModel({ provider: settings.provider, id: settings.model }), contextManager: createContextManager(workspace) }),
    });
    try {
      controller.openModelPicker();
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      const rows = controller.snapshot().modelPicker?.entries.filter(entry => entry.provider === "openai-compatible") ?? [];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some(entry => entry.listUnavailable)).toBe(false);
    } finally { controller.dispose(); }
  });
});

test("model-list authorization follows the completion header precedence", async () => {
  let headers = new Headers();
  await fetchProviderModelList({
    url: "https://example.test/models", apiKey: "k1", headers: { Authorization: "Bearer k2", "X-Org": "a" }, label: "Compatible",
    fetch: async (_input, init) => {
      headers = new Headers(init?.headers);
      return Response.json({ data: [{ id: "gpt-4o" }] });
    },
  });
  expect(headers.get("Authorization")).toBe("Bearer k1");
  expect(headers.get("X-Org")).toBe("a");
  let custom = new Headers();
  await fetchProviderModelList({
    url: "https://example.test/models", headers: { Authorization: "Bearer k2" }, label: "Compatible",
    fetch: async (_input, init) => {
      custom = new Headers(init?.headers);
      return Response.json({ data: [{ id: "gpt-4o" }] });
    },
  });
  expect(custom.get("Authorization")).toBe("Bearer k2");
});

test("an oversized model list is a dedicated size error", async () => {
  await expect(fetchProviderModelList({
    url: "https://example.test/models", label: "OpenAI",
    fetch: async () => new Response(new Uint8Array(1_048_577)),
  })).rejects.toBeInstanceOf(ModelListTooLargeError);
});

test("a slow sign-in does not overwrite a newer picker choice or remember that late model", async () => {
  await withTempDir(async root => {
    const home = join(root, "home");
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({ home, workspaceRoot: root, interactiveMemory: true });
    const store = fakeCredentialStore();
    let release: (models: { id: string; recommended?: boolean }[]) => void = () => {};
    const pending = new Promise<{ id: string; recommended?: boolean }[]>(resolve => { release = resolve; });
    let calls = 0;
    const controller = new TuiController({
      session: createSession(), sessionId: "slow-sign-in", workspace, configEditor: editor, home,
      provider: editor.settings.provider, modelId: editor.settings.model, contextManager: createContextManager(workspace),
      credentials: {
        store, env: {}, rememberSecret: () => {}, reload: async () => ({ error: "unused" }),
        listRouteModels: async () => { calls += 1; return pending; },
      },
      stageSettings: async settings => ({ model: createScriptedModel({ provider: "openai", id: settings.model }), contextManager: createContextManager(workspace) }),
    });
    try {
      expect(controller.beginLogin("openai")).toBe(true);
      controller.enterCredentialText("signed-in-key");
      const submitted = controller.submitCredential();
      while (calls < 1) await Bun.sleep(1);
      expect(controller.openModelPicker()).toBe(true);
      while (controller.snapshot().modelPicker?.accessLoading) await Bun.sleep(1);
      const entries = controller.snapshot().modelPicker?.entries ?? [];
      const target = entries.find(entry => entry.authRoute === "api-key" && entry.modelId === "gpt-4.1");
      expect(target).toBeDefined();
      controller.moveModelPicker(entries.findIndex(entry => entry.identity === target?.identity) - (controller.snapshot().modelPicker?.selectedIndex ?? 0));
      expect(await controller.selectPickerModel()).toBe(true);
      expect(controller.snapshot().modelId).toBe("gpt-4.1");
      const remembered = (await InteractiveMemory.load(home, root)).choice?.model;
      release([{ id: "late-default", recommended: true }]);
      expect(await submitted).toBe(true);
      expect(controller.snapshot().modelId).toBe("gpt-4.1");
      expect(controller.snapshot().transcript.some(entry => entry.text.includes("Signed in. Using"))).toBe(false);
      expect((await InteractiveMemory.load(home, root)).choice?.model).toBe(remembered);
      expect((await InteractiveMemory.load(home, root)).choice?.model).not.toBe("late-default");
    } finally { controller.dispose(); }
  });
});

test("dispose during a pending sign-in listing leaves settings unchanged", async () => {
  await withTempDir(async root => {
    const home = join(root, "home");
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({ home, workspaceRoot: root, interactiveMemory: true });
    const store = fakeCredentialStore();
    let release: (models: { id: string }[]) => void = () => {};
    const pending = new Promise<{ id: string }[]>(resolve => { release = resolve; });
    let calls = 0;
    let signal: AbortSignal | undefined;
    const controller = new TuiController({
      session: createSession(), sessionId: "dispose-listing", workspace, configEditor: editor, home,
      provider: editor.settings.provider, modelId: editor.settings.model, contextManager: createContextManager(workspace),
      credentials: {
        store, env: {}, rememberSecret: () => {}, reload: async () => ({ error: "unused" }),
        listRouteModels: async (_route, next) => { calls += 1; signal = next; return pending; },
      },
      stageSettings: async settings => ({ model: createScriptedModel({ provider: "openai", id: settings.model }), contextManager: createContextManager(workspace) }),
    });
    expect(controller.beginLogin("openai")).toBe(true);
    controller.enterCredentialText("signed-in-key");
    const submitted = controller.submitCredential();
    while (calls < 1) await Bun.sleep(1);
    expect(() => controller.dispose()).not.toThrow();
    expect(signal?.aborted).toBe(true);
    release([{ id: "gpt-6-astra" }]);
    await expect(submitted).resolves.toBe(true);
    expect((await loadConfigEditor({ home, workspaceRoot: root, interactiveMemory: true })).settings.model).toBe("");
  });
});

test("Esc during a pending sign-in listing does not activate a model", async () => {
  await withTempDir(async root => {
    const home = join(root, "home");
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({ home, workspaceRoot: root, interactiveMemory: true });
    const store = fakeCredentialStore();
    let release: (models: { id: string }[]) => void = () => {};
    const pending = new Promise<{ id: string }[]>(resolve => { release = resolve; });
    let calls = 0;
    let signal: AbortSignal | undefined;
    const controller = new TuiController({
      session: createSession(), sessionId: "esc-listing", workspace, configEditor: editor, home,
      provider: editor.settings.provider, modelId: editor.settings.model, contextManager: createContextManager(workspace),
      credentials: {
        store, env: {}, rememberSecret: () => {}, reload: async () => ({ error: "unused" }),
        listRouteModels: async (_route, next) => { calls += 1; signal = next; return pending; },
      },
      stageSettings: async settings => ({ model: createScriptedModel({ provider: "openai", id: settings.model }), contextManager: createContextManager(workspace) }),
    });
    try {
      expect(controller.beginLogin("openai")).toBe(true);
      controller.enterCredentialText("signed-in-key");
      const submitted = controller.submitCredential();
      while (calls < 1) await Bun.sleep(1);
      expect(controller.cancelPendingSignInListing()).toBe(true);
      expect(signal?.aborted).toBe(true);
      release([{ id: "gpt-6-astra", recommended: true } as { id: string }]);
      expect(await submitted).toBe(true);
      expect(controller.snapshot().modelId).toBe("");
      expect(controller.snapshot().transcript.some(entry => entry.text.includes("Signed in. Using"))).toBe(false);
      expect((await InteractiveMemory.load(home, root)).choice).toBeUndefined();
    } finally { controller.dispose(); }
  });
});

import { XAI_MODELS_PAYLOAD } from "./fixtures/xai.ts";

test("xAI model list fields become context, thinking levels and the listed default", () => {
  const models = parseModelList(XAI_MODELS_PAYLOAD, "xAI");
  expect(models.find(model => model.id === "grok-4.7")).toMatchObject({
    contextWindow: 256_000,
    supportedThinking: ["low", "medium", "high", "xhigh"],
    defaultThinking: "high",
  });
  expect(models.find(model => model.id === "grok-4.5")?.supportedThinking).toEqual(["off", "low", "medium", "high"]);
  expect(models.find(model => model.id === "grok-3")?.supportedThinking).toBeUndefined();
  expect(validateThinking("xai", "grok-4.7", "off", undefined, { id: "grok-4.7", supportedThinking: ["low", "medium", "high", "xhigh"] })).toBe(
    'Thinking level "off" is not listed for xai/grok-4.7 in the xAI model list. Leave thinking unset or select a listed level.',
  );
});

test("xAI thinking offers only the listed efforts", async () => {
  await withTempDir(async root => {
    const home = join(root, "home");
    const editor = await loadConfigEditor({ home, workspaceRoot: root, cli: { provider: "xai", model: "grok-4.7" } });
    editor.setModelCapabilities(xaiModelCapabilities(parseModelList(XAI_MODELS_PAYLOAD, "xAI")));
    const thinking = preferenceRows(editor, "session", []).find(row => row.key === "thinking");
    expect(thinking?.choices).toEqual([undefined, "low", "medium", "high", "xhigh"]);
    const noReasoning = await loadConfigEditor({ home, workspaceRoot: root, cli: { provider: "xai", model: "grok-3" } });
    noReasoning.setModelCapabilities(xaiModelCapabilities(parseModelList(XAI_MODELS_PAYLOAD, "xAI")));
    expect(preferenceRows(noReasoning, "session", []).find(row => row.key === "thinking")?.choices).toEqual([undefined, "off"]);
  });
});

test("xAI chat filter keeps grok-4.7 and treats an excluded-only list as a failed list", () => {
  const listed = parseModelList({ data: ["grok-4.7", "grok-imagine-1", "grok-2-image", "grok-video-1", "grok-embed-1", "other-model"].map(id => ({ id })) }, "xAI");
  expect(filterXaiModels(listed).map(model => model.id)).toEqual(["grok-4.7"]);
  const rows = modelPickerEntries("", "xai", "", {}, { xaiModels: filterXaiModels(listed), access: { providers: { xai: "API key" }, profiles: {}, subscription: "Login required", openaiApiKey: "Login required", xaiApiKey: "API key" } });
  expect(rows.filter(row => row.provider === "xai" && row.authRoute === "api-key").map(row => row.modelId)).toEqual(["grok-4.7"]);
  expect(rows.find(row => row.modelId === "grok-4.7")).toMatchObject({ provider: "xai", authRoute: "api-key", access: "API key" });
  expect(() => requireXaiModels(filterXaiModels(parseModelList({ data: [{ id: "grok-imagine-1" }, { id: "other-model" }] }, "xAI")))).toThrow(/no selectable models/);
});

test("xAI API key sign-in activates grok-4.7 and restores it without openaiAuth", async () => {
  await withTempDir(async root => {
    const home = join(root, "home");
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({ home, workspaceRoot: root, interactiveMemory: true });
    const store = fakeCredentialStore();
    let activated: { provider: string; authRoute: string } | undefined;
    const controller = new TuiController({
      session: createSession(), sessionId: "xai-sign-in", workspace, configEditor: editor, home,
      provider: editor.settings.provider, modelId: editor.settings.model, contextManager: createContextManager(workspace),
      credentials: {
        store, env: { XAI_API_KEY: "env-xai" }, rememberSecret: () => {}, reload: async () => ({ error: "unused" }),
        listRouteModels: async route => route === "xai" ? [{ id: "grok-4.7" }, { id: "grok-imagine-1" }] : [],
      },
      stageSettings: async settings => ({ model: createScriptedModel({ provider: settings.provider, id: settings.model }), contextManager: createContextManager(workspace) }),
      onModelActivated: choice => { activated = choice; },
    });
    try {
      expect(controller.beginLogin("xai")).toBe(true);
      controller.enterCredentialText("saved-xai-key");
      expect(await controller.submitCredential()).toBe(true);
      expect(controller.snapshot().modelId).toBe("grok-4.7");
      expect(controller.snapshot().transcript.some(entry => entry.text.includes("Signed in. Using xai/grok-4.7."))).toBe(true);
      expect(controller.snapshot().transcript.some(entry => entry.text.includes("XAI_API_KEY still takes precedence over the saved key."))).toBe(true);
      expect(activated).toMatchObject({ provider: "xai", authRoute: "api-key" });
    } finally { controller.dispose(); }
    const restored = await loadConfigEditor({ home, workspaceRoot: root, interactiveMemory: true });
    expect(restored.settings).toMatchObject({ provider: "xai", model: "grok-4.7" });
    expect(restored.origins.model).toBe("interactive memory");
    const memory = await InteractiveMemory.load(home, root);
    expect(memory.choice).toEqual({ provider: "xai", model: "grok-4.7", xaiAuth: "api-key" });
  });
});

test("xAI model discovery starts before a slow OpenAI list finishes", async () => {
  await withTempDir(async root => {
    const home = join(root, "home");
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({ home, workspaceRoot: root, cli: { provider: "openai", model: "gpt-4o" } });
    let releaseOpenAI: () => void = () => {};
    const openaiHold = new Promise<void>(resolve => { releaseOpenAI = resolve; });
    let xaiStarted = false;
    const controller = new TuiController({
      session: createSession(), sessionId: "parallel-lists", workspace, configEditor: editor, home,
      provider: "openai", modelId: "gpt-4o", contextManager: createContextManager(workspace),
      credentials: {
        store: fakeCredentialStore(), env: { OPENAI_API_KEY: "openai", XAI_API_KEY: "xai" },
        reload: async () => ({ error: "unused" }),
        listRouteModels: async route => {
          if (route === "xai") { xaiStarted = true; return [{ id: "grok-4.7" }]; }
          if (route === "api-key") { await openaiHold; return [{ id: "gpt-4o" }]; }
          return [];
        },
      },
    });
    try {
      controller.openModelPicker();
      const deadline = Date.now() + 2_000;
      while (!xaiStarted && Date.now() < deadline) await Bun.sleep(5);
      expect(xaiStarted).toBe(true);
      releaseOpenAI();
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(5);
      expect(controller.snapshot().modelPicker?.entries.some(entry => entry.provider === "xai" && entry.modelId === "grok-4.7")).toBe(true);
    } finally { controller.dispose(); }
  });
});

test("a failed xAI list drops capabilities installed by the previous list", async () => {
  await withTempDir(async root => {
    const home = join(root, "home");
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({ home, workspaceRoot: root, cli: { provider: "xai", model: "grok-4.7" } });
    let fail = false;
    const controller = new TuiController({
      session: createSession(), sessionId: "stale-xai", workspace, configEditor: editor, home,
      provider: "xai", modelId: "grok-4.7", contextManager: createContextManager(workspace),
      credentials: {
        store: fakeCredentialStore(), env: { XAI_API_KEY: "xai" },
        reload: async () => ({ error: "unused" }),
        listRouteModels: async route => {
          if (route !== "xai") return [];
          if (fail) throw new Error("offline");
          return [{ id: "grok-4.7", supportedThinking: ["low", "high"], defaultThinking: "high" }];
        },
      },
    });
    try {
      controller.openModelPicker();
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(5);
      expect(editor.modelCapability("grok-4.7")?.supportedThinking).toEqual(["low", "high"]);
      fail = true;
      controller.openModelPicker();
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(5);
      expect(editor.modelCapability("grok-4.7")).toBeUndefined();
    } finally { controller.dispose(); }
  });
});
