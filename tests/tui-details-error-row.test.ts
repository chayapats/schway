import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createConversationView } from "../src/tui/view.ts";
import { TuiController } from "../src/tui/controller.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const F2 = "\u001bOQ";
const OFFERED = "Ctrl+R continue · F2 details · Esc keep editing";
const OPEN = "Ctrl+R continue";

/** Render a real view over a turn that fails every retry, leaving a recovery that offers F2 details. */
async function failedTurn() {
  const terminal = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true });
  const workspace = { root: "/project", launchCwd: "/project", extraRoots: [] };
  const controller = new TuiController({
    session: createSession(), workspace, provider: "scripted", modelId: "test-model", sessionId: "details-error-row",
    model: createScriptedModel({ responses: Array.from({ length: 3 }, () => ({ error: "Service unavailable", status: 503 })) }),
    contextManager: createContextManager(workspace), changeTracking: "off", agentClock: { now: () => 0, sleep: async () => {} },
    credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ model: createScriptedModel() }) },
  });
  const view = createConversationView(terminal.renderer, {
    controller, workspaceRoot: "/project", home: "/home/test", env: {}, secrets: [], motion: "off",
    quit: () => {}, openUrl: async () => {}, submit: async () => false,
  });
  cleanups.push(() => { view.destroy(); controller.dispose(); terminal.renderer.destroy(); });
  const settle = async () => { await Bun.sleep(5); view.refresh(); await terminal.flush(); };
  await controller.submit("Summarize the changes");
  await controller.waitForIdle();
  await settle();
  const recovery = controller.snapshot().recovery!;
  expect(recovery.actions).toContain("details");
  /** The painted action line of the recovery's error row. */
  const actionRow = () => terminal.captureCharFrame().split("\n").map(line => line.replace(/^[\s▌]+/, "").trimEnd()).find(line => line.startsWith("Ctrl+R continue"));
  const press = async (key: string) => { if (key === "escape") terminal.mockInput.pressEscape(); else terminal.mockInput.pressKey(key); await settle(); };
  return { controller, view, recovery, actionRow, press, frame: () => terminal.captureCharFrame() };
}

test("open failure details hide F2 and keep-editing offers and Esc restores both", async () => {
  const ui = await failedTurn();
  expect(ui.actionRow()).toBe(OFFERED);
  await ui.press(F2);
  expect(ui.view.detailsKind()).toBe("recovery");
  expect(ui.actionRow()).toBe(OPEN);
  expect(ui.frame()).not.toContain("Esc keep editing");
  expect(ui.frame()).toContain("Esc back");
  // The view hides the dead key; the stored row keeps it for when details close.
  expect(ui.controller.snapshot().transcript.find(entry => entry.id === ui.recovery.entryId)?.text).toEndWith(OFFERED);
  // F2 is ignored while details are open, so the row would have offered a dead key.
  const count = ui.controller.snapshot().transcript.length;
  await ui.press(F2);
  expect(ui.controller.snapshot().transcript).toHaveLength(count);
  await ui.press("escape");
  expect(ui.view.detailsKind()).toBeUndefined();
  expect(ui.actionRow()).toBe(OFFERED);
});

test("open notice details hide F2 and keep-editing offers on the recovery and notice rows", async () => {
  const ui = await failedTurn();
  ui.controller.notice("Saved locally · F2 details", "Local evidence");
  await ui.press(F2);
  expect(ui.view.detailsKind()).toBe("notice");
  expect(ui.actionRow()).toBe(OPEN);
  expect(ui.frame()).not.toContain("F2 details");
  expect(ui.frame()).not.toContain("Esc keep editing");
  expect(ui.frame()).toContain("Esc back");
  await ui.press("escape");
  expect(ui.view.detailsKind()).toBeUndefined();
  expect(ui.actionRow()).toBe(OFFERED);
});
