import { expect, test } from "bun:test";
import { SCREENS, variantsFor } from "./screen-catalog/screens.ts";
import { buildScreen } from "./screen-catalog/harness.ts";
import { TuiController } from "../src/tui/controller.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { codexSubscriptionIdentity } from "../src/auth/store.ts";
import { modelPickerErrorRows } from "../src/tui/model-picker.ts";
import { withTempDir } from "./helpers.ts";

const F2 = "\u001bOQ";
const screen = (id: string) => SCREENS.find(entry => entry.id === id)!;
/** Open a catalog picker screen at dark-80 and wait for its scripted discovery state. */
async function openPicker(id: string) {
  const fixture = screen(id), ui = await buildScreen(fixture, variantsFor(fixture).find(variant => variant.id === "dark-80")!);
  await fixture.drive(ui); await ui.waitFor(snapshot => fixture.ready(snapshot, ui)); await ui.settle();
  return ui;
}
/** The picker panel rows between its heading and the composer, as painted. */
const panel = (frame: string) => frame.split(/Choose model|Discovery details/)[1]!.split("▄")[0]!;

for (const [id, status, diagnostic] of [
  ["model-picker-offline", "Models offline", "getaddrinfo ENOTFOUND chatgpt.com"],
  ["model-picker-failed", "Models unavailable", "HTTP 500 Internal Server Error"],
  ["model-picker-partial", "Endpoint models unavailable", "HTTP 502 Bad Gateway"],
] as const) test(`${id}: primary row names the state, F2 opens the redacted diagnostic, Esc returns and Ctrl+R retries`, async () => {
  const ui = await openPicker(id);
  try {
    const picker = ui.controller.snapshot().modelPicker!;
    expect(picker.error).toBe(`${status} · Ctrl+R retry · F2 details`);
    expect(picker.errorDetails).toContain(diagnostic);
    // The diagnostic stays out of the primary row until F2 asks for it.
    expect(ui.captureCharFrame()).toContain(`${status} · Ctrl+R retry · F2 details`);
    expect(ui.captureCharFrame()).not.toContain(diagnostic);
    // Models from routes that loaded stay selectable.
    expect(picker.entries.some(entry => entry.kind === "model")).toBe(true);
    ui.mockInput.pressKey(F2); await ui.settle();
    expect(ui.controller.snapshot().modelPicker?.details).toBe(true);
    const details = panel(ui.captureCharFrame()).replace(/\s+/g, " ");
    expect(details).toContain(diagnostic);
    expect(details).toContain(`${status} · Esc back`);
    expect(details).not.toMatch(/context · .* output/);
    ui.mockInput.pressEscape(); await ui.settle();
    expect(ui.controller.snapshot().modelPicker).toMatchObject({ details: false, error: picker.error });
    expect(panel(ui.captureCharFrame())).not.toContain(diagnostic);
    ui.mockInput.pressKey("r", { ctrl: true });
    expect(ui.controller.snapshot().modelPicker).toMatchObject({ loading: true, catalogState: "loading" });
    expect(ui.controller.snapshot().modelPicker?.error).toBeUndefined();
    await ui.waitFor(snapshot => !!snapshot.modelPicker && !snapshot.modelPicker.loading);
    expect(ui.controller.snapshot().modelPicker?.error).toBe(picker.error);
  } finally { await ui.dispose(); }
});

test("with the diagnostic open, list keys cannot move, select, pin or search the hidden models, and hints name only live keys", async () => {
  const ui = await openPicker("model-picker-partial");
  try {
    const before = ui.controller.snapshot(), picker = before.modelPicker!;
    expect(picker.entries.filter(entry => entry.kind === "model").length).toBeGreaterThan(1);
    ui.mockInput.pressKey(F2); await ui.settle();
    expect(ui.controller.snapshot().modelPicker?.details).toBe(true);
    ui.mockInput.pressArrow("down"); ui.mockInput.pressArrow("down"); await ui.settle();
    ui.mockInput.pressEnter(); await ui.settle();
    ui.mockInput.pressKey("p", { ctrl: true }); await ui.settle();
    await ui.mockInput.typeText("gpt"); await ui.settle();
    const after = ui.controller.snapshot();
    expect({ provider: after.provider, modelId: after.modelId, route: after.activeRoute }).toEqual({ provider: before.provider, modelId: before.modelId, route: before.activeRoute });
    expect(after.modelPicker).toMatchObject({ details: true, query: "", selectedIndex: picker.selectedIndex, error: picker.error });
    expect(after.modelPicker!.entries.map(entry => [entry.identity, !!entry.favorite])).toEqual(picker.entries.map(entry => [entry.identity, !!entry.favorite]));
    expect(ui.editor.plainText).toBe("");
    const frame = ui.captureCharFrame();
    expect(frame).toContain("Discovery details · Esc back");
    expect(frame).toContain("Ctrl+R retry · F2 back · Esc back");
    expect(frame).not.toMatch(/↑↓ select|Enter use|Enter open|Ctrl\+P/);
    ui.mockInput.pressEscape(); await ui.settle();
    expect(ui.controller.snapshot().modelPicker).toMatchObject({ details: false, selectedIndex: picker.selectedIndex, query: "" });
    expect(ui.captureCharFrame()).toContain("↑↓ select · Enter use · Esc back");
  } finally { await ui.dispose(); }
});

test("offline and failed discovery render different primary copy", async () => {
  const offline = await openPicker("model-picker-offline");
  const failed = await openPicker("model-picker-failed");
  try {
    const offlineRow = panel(offline.captureCharFrame()).split("\n").find(line => line.includes("Ctrl+R retry"))!;
    const failedRow = panel(failed.captureCharFrame()).split("\n").find(line => line.includes("Ctrl+R retry"))!;
    expect(offlineRow.trim()).not.toBe(failedRow.trim());
    expect(offlineRow).toContain("offline");
    expect(failedRow).not.toContain("offline");
  } finally { await offline.dispose(); await failed.dispose(); }
});

test("without an error, F2 keeps toggling the selected model's details", async () => {
  const ui = await openPicker("model-picker");
  try {
    expect(ui.controller.snapshot().modelPicker?.error).toBeUndefined();
    ui.mockInput.pressKey(F2); await ui.settle();
    expect(ui.controller.snapshot().modelPicker?.details).toBe(true);
    expect(panel(ui.captureCharFrame())).toMatch(/gpt-6-astra · 1,050,000 context · 128,000 output/);
    ui.mockInput.pressKey(F2); await ui.settle();
    expect(ui.controller.snapshot().modelPicker?.details).toBe(false);
  } finally { await ui.dispose(); }
});

test("several failed route lists show a count, and F2 names each route with its redacted diagnostic", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const store = fakeCredentialStore();
    await store.set(codexSubscriptionIdentity(), "fixture-token");
    const controller = new TuiController({ session: createSession(), sessionId: "partial", workspace, home: root, provider: "openai", modelId: "gpt-6-astra",
      model: createScriptedModel({ provider: "codex-subscription", id: "gpt-6-astra" }), contextManager: createContextManager(workspace), secrets: ["sk-secret-sentinel-1234"],
      credentials: { store, env: { OPENAI_API_KEY: "sk-secret-sentinel-1234", XAI_API_KEY: "xai-fixture" }, reload: async () => ({ error: "unused" }),
        listSubscriptionCatalog: async () => [{ id: "gpt-6-astra", supportedThinking: [] }],
        listRouteModels: async route => { throw new Error(`${route} list failed: Authorization: Bearer sk-secret-sentinel-1234`); } } });
    try {
      controller.openModelPicker();
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      const picker = controller.snapshot().modelPicker!;
      expect(picker.error).toBe("2 model lists unavailable · Ctrl+R retry · F2 details");
      expect(picker.errorDetails?.split("\n").map(line => line.replace(/\*\*\*( \*\*\*)*/, "***"))).toEqual(["OpenAI API models: api-key list failed: Authorization: ***", "xAI models: xai list failed: Authorization: ***"]);
      expect(JSON.stringify(controller.snapshot())).not.toContain("sk-secret-sentinel");
      expect(picker.entries.some(entry => entry.kind === "model" && entry.modelId === "gpt-6-astra")).toBe(true);
      controller.togglePickerDetails();
      expect(controller.snapshot().modelPicker?.details).toBe(true);
      controller.backModelPicker();
      expect(controller.snapshot().modelPicker).toMatchObject({ details: false, error: picker.error });
    } finally { controller.dispose(); }
  });
});

test("diagnostic rows wrap to the panel, drop control characters and mark a cut", () => {
  const picker = { error: "Models unavailable · Ctrl+R retry · F2 details", errorDetails: "ChatGPT model list: \u001b[31mHTTP 500\u001b[0m from the account catalog endpoint", details: true };
  expect(modelPickerErrorRows({ ...picker, details: false }, 20, 4)).toBeUndefined();
  const rows = modelPickerErrorRows(picker, 20, 3)!;
  expect(rows).toHaveLength(3);
  expect(rows.every(row => Bun.stringWidth(row) <= 20)).toBe(true);
  expect(rows.join(" ")).not.toContain("\u001b");
  expect(rows.at(-1)).toEndWith("…");
  expect(modelPickerErrorRows(picker, 80, 4)).toEqual(["ChatGPT model list: HTTP 500 from the account catalog endpoint"]);
});
