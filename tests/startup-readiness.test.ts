import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { TextareaRenderable } from "@opentui/core";
import { loadInteractiveModel } from "../src/tui/app.ts";
import { codexSubscriptionIdentity } from "../src/auth/store.ts";
import { TuiController } from "../src/tui/controller.ts";
import { createConversationView } from "../src/tui/view.ts";
import { createSession } from "../src/session/session.ts";
import { createContextManager } from "../src/context/manager.ts";
import { dispatchEditorInput } from "../src/tui/commands.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";

async function setup() {
  const terminal = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true });
  const session = createSession();
  const workspace = { root: "/isolated-workspace", launchCwd: "/isolated-workspace", extraRoots: [] };
  let requests = 0;
  const model = createScriptedModel({ provider: "openai", responses: [() => { requests++; return { text: "ตอบแล้ว" }; }] });
  const controller = new TuiController({ session, sessionId: "startup", workspace, provider: "openai", modelId: "fixture",
    contextManager: createContextManager(workspace), credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ model }) } });
  const view = createConversationView(terminal.renderer, { controller, workspaceRoot: workspace.root, home: "/isolated-home", env: {}, secrets: [], quit() {},
    submit: (text, accepted) => dispatchEditorInput(text, controller, async () => false, accepted) });
  const editor = terminal.renderer.root.findDescendantById("prompt") as TextareaRenderable;
  const settle = async () => { await Bun.sleep(5); view.refresh(); await terminal.flush(); };
  return { ...terminal, controller, session, model, editor, settle, requests: () => requests, close() { view.destroy(); controller.dispose(); terminal.renderer.destroy(); } };
}

test("contextual startup keeps Thai task and cursor through keyboard setup cancel and activation; only explicit send runs", async () => {
  const ui = await setup();
  try {
    await ui.controller.initializeStartup(async () => ({ error: "Missing API key" }));
    await ui.settle();
    expect(ui.captureCharFrame()).toContain("Connect to get started · Alt+L");
    expect(ui.captureCharFrame()).toContain("! ATTENTION");
    expect(ui.captureCharFrame()).not.toContain("NOT CONNECTED");
    expect(ui.captureCharFrame()).not.toContain("Enter send");
    expect(ui.captureCharFrame()).toContain("Ctrl+I failure details");
    expect(ui.captureCharFrame()).toContain("/isolated-workspace");
    expect(ui.captureCharFrame()).not.toContain("Missing credentials. Use /login");
    const draft = "ช่วยตรวจงานนี้\nแล้วอธิบายเป็นภาษาไทย";
    await ui.mockInput.pasteBracketedText(draft);
    ui.mockInput.pressArrow("left");
    const cursor = ui.editor.cursorOffset;
    ui.mockInput.pressKey("l", { meta: true });
    await ui.settle();
    expect(ui.controller.snapshot().loginChooser).toBeDefined();
    ui.mockInput.pressEscape();
    await ui.settle();
    expect(ui.editor.plainText).toBe(draft);
    expect(ui.editor.cursorOffset).toBe(cursor);
    ui.mockInput.pressKey("l", { meta: true });
    await ui.settle();
    while (ui.controller.snapshot().loginChooser?.selectedId !== "openai") ui.mockInput.pressArrow("down");
    ui.mockInput.pressEnter();
    await ui.settle();
    expect(ui.controller.snapshot().credentialEntry).toBeDefined();
    await ui.mockInput.pasteBracketedText("fixture-private-key");
    ui.mockInput.pressEnter();
    await ui.settle();
    expect(ui.controller.snapshot().readiness).toBe("ready");
    expect(ui.editor.plainText).toBe(draft);
    expect(ui.editor.cursorOffset).toBe(cursor);
    expect(ui.session.items).toHaveLength(0);
    expect(ui.requests()).toBe(0);
    ui.resize(44, 18);
    await ui.settle();
    expect(ui.editor.plainText).toBe(draft);
    ui.mockInput.pressEnter();
    await ui.controller.waitForIdle();
    await ui.settle();
    expect(ui.session.items.filter(item => item.type === "user")).toHaveLength(1);
    expect(ui.requests()).toBe(1);
    expect(ui.captureCharFrame()).not.toContain("fixture-private-key");
  } finally { ui.close(); }
});

test("slow startup allows paste and resize, blocks duplicate setup, and offline failure has explicit repair", async () => {
  const ui = await setup();
  let finish!: () => void;
  let loads = 0;
  let catalogRequests = 0;
  const store = fakeCredentialStore();
  await store.set(codexSubscriptionIdentity(), JSON.stringify({ accessToken: "isolated-subscription", expiresAt: Date.now() + 600_000 }));
  try {
    const startup = ui.controller.initializeStartup(async signal => {
      loads++;
      return loadInteractiveModel("openai", "remembered-account-model", { openaiAuth: "codex", verifySubscriptionChoice: true,
        env: {}, runtimeApiKey: undefined, secrets: [], credentialStore: store, signal,
        fetch: async () => {
          catalogRequests++;
          return new Promise<Response>((_, reject) => { finish = () => reject(new Error("Offline catalog: network unavailable")); });
        },
      });
    });
    await ui.settle();
    expect(ui.captureCharFrame()).toContain("Checking selected connection");
    expect(ui.captureCharFrame()).not.toContain("Enter send");
    expect(ui.captureCharFrame()).not.toContain("Ctrl+I failure details");
    await ui.mockInput.pasteBracketedText("รอได้\nอย่าลบงาน");
    ui.resize(44, 18);
    ui.mockInput.pressKey("m", { meta: true });
    ui.mockInput.pressKey("l", { meta: true });
    ui.mockInput.pressEnter();
    await ui.controller.initializeStartup(async () => { loads++; return { model: ui.model }; });
    await ui.settle();
    expect(loads).toBe(1);
    expect(ui.controller.snapshot().modelPicker).toBeUndefined();
    expect(ui.controller.snapshot().loginChooser).toBeUndefined();
    expect(ui.session.items).toHaveLength(0);
    expect(catalogRequests).toBe(1);
    finish();
    await startup;
    await ui.settle();
    expect(ui.captureCharFrame()).toContain("Repair connection");
    expect(ui.editor.plainText).toBe("รอได้\nอย่าลบงาน");
    ui.mockInput.pressKey("i", { ctrl: true });
    await ui.settle();
    expect(ui.captureCharFrame()).toContain("ChatGPT subscription model catalog");
    expect(ui.requests()).toBe(0);
  } finally { ui.close(); }
});

test("cancelled or disposed startup cannot publish a late adapter", async () => {
  for (const dispose of [false, true]) {
    const ui = await setup();
    let finish!: (result: { model: typeof ui.model; activate: () => void }) => void;
    let activated = false;
    try {
      const startup = ui.controller.initializeStartup(async () => new Promise(resolve => { finish = resolve; }));
      if (dispose) ui.controller.dispose(); else ui.controller.cancel();
      await startup;
      finish({ model: ui.model, activate: () => { activated = true; } });
      await ui.settle();
      expect(activated).toBe(false);
      expect(ui.controller.snapshot().readiness).not.toBe("ready");
      expect(ui.requests()).toBe(0);
    } finally { ui.close(); }
  }
});

test("real API adapters accept custom IDs offline and readiness does not claim provider validation", async () => {
  let network = 0;
  const store = fakeCredentialStore();
  for (const provider of ["openai"] as const) {
    const loaded = await loadInteractiveModel(provider, "custom-deployment-not-in-catalog", {
      openaiAuth: "api-key", runtimeApiKey: "fixture-api-key", env: {}, secrets: [], credentialStore: store,
      fetch: async () => { network++; throw new Error("No startup model probe is allowed"); },
    });
    expect("error" in loaded).toBe(false);
    if ("model" in loaded) expect(loaded.model.id).toBe("custom-deployment-not-in-catalog");
  }
  expect(network).toBe(0);
  const ui = await setup();
  try {
    await ui.controller.initializeStartup(async () => ({ model: ui.model }));
    await ui.settle();
    expect(ui.captureCharFrame()).toContain("configured, unverified");
    expect(ui.requests()).toBe(0);
  } finally { ui.close(); }
});
