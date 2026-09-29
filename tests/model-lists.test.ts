import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { credentialIdentity } from "../src/auth/store.ts";
import { runCli } from "../src/cli/main.ts";
import { NO_MODEL_CONFIGURED_MESSAGE, loadResolvedSettings } from "../src/config/config.ts";
import { loadConfigEditor } from "../src/config/editing.ts";
import { InteractiveMemory } from "../src/config/interactive-memory.ts";
import { createContextManager } from "../src/context/manager.ts";
import { lookupModel, ROUTE_FALLBACK_MODELS } from "../src/model/catalog.ts";
import { parseModelList, recommendedListedModel } from "../src/model/model-list.ts";
import { createSession } from "../src/session/session.ts";
import { TuiController } from "../src/tui/controller.ts";
import { createConversationView } from "../src/tui/view.ts";
import { dispatchEditorInput } from "../src/tui/commands.ts";
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
