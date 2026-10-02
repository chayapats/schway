import { expect, test } from "bun:test";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import type { TextareaRenderable } from "@opentui/core";
import { modelPickerEntries, modelPickerIdentity, modelPickerName, presentModelPicker, rememberedPickerModels } from "../src/tui/model-picker.ts";
import { ModelPreferences } from "../src/config/model-preferences.ts";
import { loadConfigEditor } from "../src/config/editing.ts";
import { TuiController, type TuiControllerOptions } from "../src/tui/controller.ts";
import { createConversationView } from "../src/tui/view.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { codexSubscriptionIdentity, credentialIdentity } from "../src/auth/store.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { withTempDir } from "./helpers.ts";

const api = Array.from({ length: 20 }, (_, n) => ({ id: `model-${n}` }));
const access = { providers: {}, profiles: {}, subscription: "Login required" as const, grok: "Login required" as const, openaiApiKey: "API key" as const, xaiApiKey: "Login required" as const };

/** Build connected deterministic choices for shortlist and search assertions. */
function entries(query = "") { return modelPickerEntries(query, "openai", "model-0", {}, { access, apiModels: api }); }

/** Wait for bounded deterministic discovery to settle. */
async function settled(controller: TuiController) {
  const deadline = Date.now() + 2_000;
  while (controller.snapshot().modelPicker?.loading && Date.now() < deadline) await Bun.sleep(1);
  expect(controller.snapshot().modelPicker?.loading).toBeFalsy();
}

/** Create an isolated API controller with user-wide preference storage and a complete catalog. */
async function fixture(home: string, workspaceRoot = home, credentials: Partial<NonNullable<TuiControllerOptions["credentials"]>> = {}) {
  const workspace = { root: workspaceRoot, launchCwd: workspaceRoot, extraRoots: [] };
  const configEditor = await loadConfigEditor({ home, workspaceRoot, cli: { provider: "openai", model: "model-0", openaiAuth: "api-key" } });
  const store = fakeCredentialStore();
  await store.set(credentialIdentity({ provider: "openai" }), "fixture-key");
  const controller = new TuiController({ home, session: createSession(), sessionId: "picker", workspace, configEditor,
    provider: "openai", modelId: "model-0", model: createScriptedModel({ provider: "openai", id: "model-0" }), contextManager: createContextManager(workspace),
    credentials: { store, env: {}, reload: async () => ({ error: "unused" }), listRouteModels: async () => api, ...credentials },
    stageSettings: async settings => ({ model: createScriptedModel({ provider: "openai", id: settings.model }), contextManager: createContextManager(workspace) }),
  });
  return { controller, store };
}

test("shortlist orders current, favorites, recents and caps actual models at eight", () => {
  const all = entries().filter(entry => entry.kind === "model");
  const rows = presentModelPicker(entries(), { query: "", favorites: all.slice(1, 6).map(row => row.identity), recents: all.slice(4).map(row => row.identity) });
  expect(rows.filter(row => row.kind === "model").map(row => row.modelId)).toEqual(api.slice(0, 8).map(row => row.id));
  expect(new Set(rows.map(row => row.identity)).size).toBe(rows.length);
  expect(rows.slice(-2).map(row => row.kind)).toEqual(["browse", "connect"]);
  expect(rows.some(row => row.kind === "header" || row.kind === "sign-in")).toBe(false);
  expect(presentModelPicker(entries(), { query: "", favorites: [], recents: [] }).filter(row => row.kind === "model").length).toBeLessThanOrEqual(4);
});

test("search finds outside the shortlist and accepts the exact displayed model label", () => {
  expect(presentModelPicker(entries("model-19"), { query: "model-19", favorites: [], recents: [] })[0]?.modelId).toBe("model-19");
  for (const id of ["gpt-6-astra", "gpt-5-mini", "grok-4.7"]) {
    const rows = modelPickerEntries(modelPickerName(id), "openai", "", {}, { access, apiModels: [{ id }] });
    expect(rows.find(row => row.kind === "model")?.modelId).toBe(id);
  }
});

test("equal names on distinct billing routes stay separate and disconnected favorites stay hidden", () => {
  const all = modelPickerEntries("", "openai", "shared", {}, { access: { ...access, subscription: "ChatGPT" }, subscriptionModels: ["shared"], apiModels: [{ id: "shared" }] });
  const models = all.filter(row => row.kind === "model");
  expect(new Set(models.map(row => row.identity)).size).toBe(2);
  const favorites = models.map(row => row.identity);
  const shown = presentModelPicker(all, { query: "", favorites, recents: favorites });
  expect(shown.filter(row => row.kind === "model").map(row => row.authRoute)).toEqual(["api-key", "codex"]);
  const disconnected = modelPickerEntries("", "openai", "shared", {}, { access, apiModels: [{ id: "shared" }] });
  expect(presentModelPicker(disconnected, { query: "", favorites, recents: [] }).filter(row => row.kind === "model").map(row => row.authRoute)).toEqual(["api-key"]);
});

test("manual IDs are recovered only on their exact connected API endpoint", () => {
  const endpoint = "https://user:secret@example.test/path?key=secret";
  const route = { provider: "openai-compatible", authRoute: "provider" as const, modelId: "typed-id" };
  const saved = { [modelPickerIdentity(route, endpoint)]: { modelId: "typed-id", groupIdentity: modelPickerIdentity({ ...route, modelId: "" }, endpoint) } };
  const all = modelPickerEntries("", "openai-compatible", "listed", {}, { baseUrl: endpoint, compatibleModels: [{ id: "listed" }], access: { ...access, providers: { "openai-compatible": "No key required" } } });
  expect(rememberedPickerModels(all, saved).find(row => row.modelId === "typed-id")?.identity).toBe(Object.keys(saved)[0]);
  const changed = modelPickerEntries("", "openai-compatible", "listed", {}, { baseUrl: "https://example.test/other", compatibleModels: [{ id: "listed" }] });
  expect(rememberedPickerModels(changed, saved).some(row => row.modelId === "typed-id")).toBe(false);
});

test("controller favorites, manual recents and browsing survive restart across workspaces", async () => {
  await withTempDir(async home => {
    const { controller } = await fixture(home);
    try {
      controller.openModelPicker(); await settled(controller);
      controller.searchModels("model-19"); expect(controller.togglePickerFavorite()).toBe(true);
      expect(await controller.selectPickerModel()).toBe(true);
      expect(await controller.selectModel("openai/typed-exact-id")).toBe(true);
    } finally { controller.dispose(); }
    const { controller: next, store } = await fixture(home, join(home, "other"));
    try {
      next.openModelPicker(); await settled(next);
      expect(next.snapshot().modelPicker!.entries.filter(row => row.kind === "model").map(row => row.modelId)).toEqual(["model-0", "model-19", "typed-exact-id"]);
      next.browsePickerModels(); expect(next.snapshot().modelPicker!.entries.filter(row => row.kind === "model").length).toBeGreaterThan(8);
      next.backModelPicker(); expect(next.snapshot().modelPicker?.browsing).toBe(false);
      next.searchModels("model-19"); expect(next.togglePickerFavorite()).toBe(true);
      expect(new ModelPreferences(home).read().favorites).toEqual([]);
      next.closeModelPicker(); await store.delete(credentialIdentity({ provider: "openai" }));
      next.openModelPicker(); await settled(next);
      expect(next.snapshot().modelPicker!.entries.map(row => row.kind)).toEqual(["connect"]);
    } finally { next.dispose(); }
  });
});

test("API search and pinning finish while subscription discovery is still pending", async () => {
  await withTempDir(async home => {
    let release!: (models: []) => void;
    const pending = new Promise<[]>(resolve => { release = resolve; });
    const { controller, store } = await fixture(home, home, { listSubscriptionCatalog: () => pending });
    await store.set(codexSubscriptionIdentity(), "subscription");
    try {
      controller.openModelPicker(); controller.searchModels("model-19");
      const deadline = Date.now() + 1_000;
      while (controller.snapshot().modelPicker!.entries[0]?.modelId !== "model-19" && Date.now() < deadline) await Bun.sleep(1);
      expect(controller.snapshot().modelPicker?.loading).toBe(true);
      const picker = controller.snapshot().modelPicker!;
      expect(picker.entries[0]?.modelId).toBe("model-19");
      controller.moveModelPicker(-picker.selectedIndex);
      expect(controller.togglePickerFavorite()).toBe(true);
      expect(controller.snapshot().modelPicker!.entries[0]?.favorite).toBe(true);
      release([]); await settled(controller);
      expect(controller.snapshot().modelPicker!.entries[controller.snapshot().modelPicker!.selectedIndex]?.modelId).toBe("model-19");
    } finally { release([]); controller.dispose(); }
  });
});

for (const width of [50, 80, 120]) test(`picker keyboard browse, pin and cancellation preserve the draft at ${width} columns without color`, async () => {
  await withTempDir(async home => {
    const { controller } = await fixture(home);
    const terminal = await createTestRenderer({ width, height: 30, kittyKeyboard: true });
    const view = createConversationView(terminal.renderer, { controller, home, workspaceRoot: home, env: { NO_COLOR: "1", SCHWAY_MOTION: "off" }, secrets: [], quit() {}, submit: async () => {} });
    const editor = terminal.renderer.root.findDescendantById("prompt") as TextareaRenderable;
    try {
      await terminal.mockInput.typeText("Keep my unsent draft ภาษาไทย");
      terminal.mockInput.pressKey("m", { meta: true }); await settled(controller); view.refresh(); await terminal.flush();
      expect(terminal.captureCharFrame()).toContain("OpenAI API key");
      expect(terminal.captureCharFrame()).toContain("Ctrl+P pin");
      expect(terminal.captureCharFrame()).not.toContain("context ·");
      terminal.mockInput.pressKey("i", { ctrl: true }); view.refresh(); await terminal.flush();
      expect(terminal.captureCharFrame()).toContain("32,768 context");
      expect(terminal.captureCharFrame()).toContain("16,384 output");
      terminal.mockInput.pressKey("i", { ctrl: true }); view.refresh(); await terminal.flush();
      terminal.mockInput.pressKey("p", { ctrl: true }); view.refresh(); await terminal.flush();
      expect(terminal.captureCharFrame()).toContain("★");
      const picker = controller.snapshot().modelPicker!;
      const index = picker.entries.findIndex(row => row.kind === "browse");
      for (let n = picker.selectedIndex; n < index; n++) terminal.mockInput.pressArrow("down");
      terminal.mockInput.pressEnter(); view.refresh(); await terminal.flush();
      expect(controller.snapshot().modelPicker?.browsing).toBe(true);
      terminal.mockInput.pressEscape(); view.refresh(); await terminal.flush();
      expect(controller.snapshot().modelPicker?.browsing).toBe(false);
      terminal.mockInput.pressEscape(); view.refresh(); await terminal.flush();
      expect(editor.plainText).toBe("Keep my unsent draft ภาษาไทย");
    } finally { view.destroy(); controller.dispose(); terminal.renderer.destroy(); }
  });
});

test("cached search and favorites work while access refresh waits, then a disconnected selection cannot jump routes", async () => {
  await withTempDir(async home => {
    const { controller, store } = await fixture(home);
    const original = store.get;
    const readers: (() => void)[] = [];
    try {
      controller.openModelPicker(); await settled(controller); controller.closeModelPicker();
      store.get = target => new Promise(resolve => readers.push(() => { void original(target).then(resolve); }));
      controller.openModelPicker();
      expect(controller.snapshot().modelPicker?.accessLoading).toBe(true);
      controller.searchModels("model-19");
      expect(controller.snapshot().modelPicker!.entries[0]?.modelId).toBe("model-19");
      expect(controller.togglePickerFavorite()).toBe(true);
      expect(await controller.selectPickerModel()).toBe(false);
      await store.delete(credentialIdentity({ provider: "openai" }));
      store.get = original;
      for (const release of readers) release();
      await settled(controller);
      expect(controller.snapshot().modelPicker?.selectedIndex).toBe(-1);
      expect(await controller.selectPickerModel()).toBe(false);
      expect(controller.snapshot().activeRoute).toBe("OpenAI API key");
      expect(controller.snapshot().modelId).toBe("model-0");
    } finally { store.get = original; for (const release of readers) release(); controller.dispose(); }
  });
});

test("late API discovery cannot overwrite a newer picker catalog", async () => {
  await withTempDir(async home => {
    let release!: (models: { id: string }[]) => void;
    let calls = 0;
    const { controller } = await fixture(home, home, { listRouteModels: async () => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : [{ id: "newer" }] });
    try {
      controller.openModelPicker();
      while (!calls) await Bun.sleep(1);
      controller.closeModelPicker(); controller.openModelPicker(); await settled(controller);
      release([{ id: "stale" }]); await Bun.sleep(1);
      controller.browsePickerModels();
      expect(controller.snapshot().modelPicker!.entries.some(row => row.modelId === "newer")).toBe(true);
      expect(controller.snapshot().modelPicker!.entries.some(row => row.modelId === "stale")).toBe(false);
    } finally { release?.([]); controller.dispose(); }
  });
});

test("Connect clears a model search and Back restores it without changing the active choice", async () => {
  await withTempDir(async home => {
    const { controller } = await fixture(home);
    try {
      controller.openModelPicker(); await settled(controller); controller.searchModels("no such model");
      controller.browsePickerModels();
      expect(controller.snapshot().modelPicker?.query).toBe("");
      expect(controller.snapshot().modelPicker!.entries.filter(row => row.kind === "model").length).toBeGreaterThan(8);
      expect(controller.snapshot().modelPicker!.entries[controller.snapshot().modelPicker!.selectedIndex]?.kind).toBe("model");
      controller.backModelPicker();
      expect(controller.snapshot().modelPicker?.query).toBe("no such model");
      const picker = controller.snapshot().modelPicker!;
      controller.moveModelPicker(picker.entries.findIndex(row => row.kind === "connect") - picker.selectedIndex);
      expect(await controller.selectPickerModel()).toBe(true);
      expect(controller.snapshot().modelPicker?.query).toBe("");
      expect(controller.snapshot().modelPicker?.entries.some(row => row.groupLabel === "ChatGPT subscription")).toBe(true);
      controller.backModelPicker();
      expect(controller.snapshot().modelPicker?.query).toBe("no such model");
      expect(controller.snapshot().modelId).toBe("model-0");
    } finally { controller.dispose(); }
  });
});
