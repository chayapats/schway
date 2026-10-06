import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { TextareaRenderable, TextRenderable } from "@opentui/core";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createConversationView } from "../src/tui/view.ts";
import { TuiController } from "../src/tui/controller.ts";
import { fitModelLabel } from "../src/tui/presentation.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";

// L3 (#310): while work runs, the hint row owns the Esc action; the status bar names it only when the hint row is hidden.

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

/** Real view over a turn that runs until Esc stops it. */
async function running(width: number, height: number, modelId = "scripted-model") {
  const terminal = await createTestRenderer({ width, height, kittyKeyboard: true });
  const workspace = { root: "/project", launchCwd: "/project", extraRoots: [] };
  const controller = new TuiController({ session: createSession(), workspace, provider: "scripted", modelId, sessionId: "status-bar-esc",
    model: createScriptedModel({ waitForAbort: true }), contextManager: createContextManager(workspace) });
  const view = createConversationView(terminal.renderer, { controller, workspaceRoot: "/project", home: "/home/test", env: { SCHWAY_MOTION: "off", NO_COLOR: "1" },
    secrets: [], quit() {}, submit: async () => false });
  cleanups.push(() => { view.destroy(); controller.dispose(); terminal.renderer.destroy(); });
  const settle = async () => { await Bun.sleep(5); view.refresh(); await terminal.flush(); };
  const turn = controller.submit("work");
  for (let start = performance.now(); controller.snapshot().status !== "running";) {
    if (performance.now() - start > 2000) throw new Error("turn never started");
    await settle();
  }
  await settle();
  const editor = terminal.renderer.root.findDescendantById("prompt") as TextareaRenderable;
  const text = (id: string) => (terminal.renderer.root.findDescendantById(id) as TextRenderable).plainText;
  const hintsVisible = () => terminal.renderer.root.findDescendantById("hints")!.visible;
  return { ...terminal, controller, settle, turn, editor, footer: () => text("footer"), hints: () => text("hints"), hintsVisible };
}

test("model chips keep provider/model when it fits, then the model ID before shortening", () => {
  expect(fitModelLabel("scripted/claude-sonnet-4-5", "claude-sonnet-4-5", 40)).toBe("scripted/claude-sonnet-4-5");
  expect(fitModelLabel("scripted/claude-sonnet-4-5", "claude-sonnet-4-5", 17)).toBe("claude-sonnet-4-5");
  expect(fitModelLabel("scripted/claude-sonnet-4-5", "claude-sonnet-4-5", 11)).toBe("claude-son…");
  expect(fitModelLabel("openrouter/anthropic/claude-sonnet-4-5", "anthropic/claude-sonnet-4-5", 27)).toBe("anthropic/claude-sonnet-4-5");
  expect(fitModelLabel("scripted/m", "m", 0)).toBe("");
});

for (const [width, height] of [[29, 20], [30, 20], [50, 30], [80, 30], [120, 30]] as const) test(`running ${width}x${height} names Esc stop only in the hint row and Esc still stops`, async () => {
  const ui = await running(width, height);
  await ui.mockInput.pasteBracketedText("ร่างถัดไป\nบรรทัดสอง");
  ui.editor.cursorOffset = 3;
  await ui.settle();
  expect(ui.hintsVisible()).toBe(true);
  expect(ui.footer()).not.toContain("Esc");
  expect(ui.hints()).toContain("Esc stop");
  if (width >= 50) {
    expect(ui.footer()).toContain("scripted");
    expect(ui.footer()).toContain("ctx ~");
  }
  if (width >= 80) expect(ui.footer()).toContain("scripted/scripted-model");
  ui.mockInput.pressEscape();
  await ui.turn;
  await ui.settle();
  expect(ui.controller.snapshot().status).not.toBe("running");
  expect(ui.controller.snapshot().outcome?.reason).toBe("cancelled");
  expect(ui.editor.plainText).toBe("ร่างถัดไป\nบรรทัดสอง");
  expect(ui.editor.cursorOffset).toBe(3);
});

for (const [width, height] of [[24, 8], [29, 8], [30, 8], [40, 8], [50, 8]] as const) test(`running ${width}x${height} with the hint row hidden keeps Esc stop in the status bar`, async () => {
  const ui = await running(width, height);
  expect(ui.hintsVisible()).toBe(false);
  expect(ui.footer().trim()).toBe("Auto · Esc stop");
  ui.mockInput.pressEscape();
  await ui.turn;
  expect(ui.controller.snapshot().outcome?.reason).toBe("cancelled");
});

test("a long model ID at 50 columns shows the model, not the provider, in the running status bar", async () => {
  const ui = await running(50, 30, "claude-sonnet-4-5");
  const chip = ui.footer().split(/ {2,}/).find(part => part.startsWith("claude") || part.startsWith("scripted"));
  expect(chip).toStartWith("claude-");
  expect(ui.footer()).not.toContain("scripted/");
  expect(ui.footer()).toContain("ctx ~");
  ui.resize(120, 30); await ui.settle();
  expect(ui.footer()).toContain("scripted/claude-sonnet-4-5");
  ui.controller.cancel();
  await ui.turn;
});

test("Esc stops never returns to goldens, source or docs", async () => {
  const root = join(import.meta.dir, "..");
  const offenders: string[] = [];
  const scan = async (directory: string): Promise<void> => {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await scan(path);
      else if ((await readFile(join(root, path), "utf8")).includes("Esc stops")) offenders.push(path);
    }
  };
  for (const directory of ["src", "docs", join("tests", "screen-catalog", "goldens")]) await scan(directory);
  expect(offenders).toEqual([]);
});
