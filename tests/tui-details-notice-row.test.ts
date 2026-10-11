import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createConversationView } from "../src/tui/view.ts";
import { TuiController } from "../src/tui/controller.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { withTempDir } from "./helpers.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { chipPresses, discoverChips, type ChipEncoding } from "./helpers/chip-liveness.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

/** Seed an unavailable snapshot without making a Git subprocess fail nondeterministically. */
class NoticeController extends TuiController {
  snapshotUnavailable(): void { this.gitSnapshotError = "Store busy"; }
}

/** Render local notices with enough room to compare their headers and literal bodies. */
async function noticeView(root = "/project", encoding: ChipEncoding = "kitty") {
  const terminal = await createTestRenderer({ width: 120, height: 40, kittyKeyboard: encoding === "kitty" });
  const workspace = { root, launchCwd: root, extraRoots: [] };
  const controller = new NoticeController({
    session: createSession(), workspace, provider: "scripted", modelId: "test-model", sessionId: "details-notice-row",
    model: createScriptedModel({ responses: [{ text: "F2 details · model literal\nEsc keep editing" }] }), contextManager: createContextManager(workspace), changeTracking: "on-demand",
  });
  const view = createConversationView(terminal.renderer, {
    controller, workspaceRoot: root, home: "/home/test", env: {}, secrets: [], motion: "off",
    quit: () => {}, openUrl: async () => {}, submit: async () => false,
  });
  let disposed = false;
  const dispose = () => { if (disposed) return; disposed = true; view.destroy(); controller.dispose(); terminal.renderer.destroy(); };
  cleanups.push(dispose);
  const settle = async () => { view.refresh(); await terminal.flush(); };
  const press = async (key: "F2" | "Esc") => {
    terminal.mockInput.pressKey(chipPresses(key, encoding)[0]!.bytes);
    const start = performance.now();
    while (true) {
      await settle();
      if (key === "F2" ? !!view.detailsKind() : !view.detailsKind()) return;
      if (performance.now() - start > 3000) throw new Error(`Timed out waiting for ${key} details action\n${terminal.captureCharFrame()}`);
      await Bun.sleep(1);
    }
  };
  await settle();
  return { controller, view, settle, press, frame: () => terminal.captureCharFrame(), chips: () => discoverChips(terminal.captureSpans()), dispose };
}

for (const encoding of ["kitty", "legacy"] as const) {
  test(`notice details hide only key offers and Esc restores them (${encoding})`, async () => {
    const ui = await noticeView("/project", encoding);
    ui.controller.notice("Choice used for this session · F2 details", "Local evidence\nF2 details · diagnostic literal");
    await ui.settle();
    expect(ui.frame()).toContain("Choice used for this session · F2 details");
    expect(ui.chips().some(chip => chip.label === "F2 details")).toBe(true);
    await ui.press("F2");
    expect(ui.view.detailsKind()).toBe("notice");
    expect(ui.frame()).toContain("Choice used for this session");
    expect(ui.frame()).not.toContain("Choice used for this session · F2 details");
    expect(ui.frame()).not.toContain("Esc keep editing");
    expect(ui.frame()).toContain("Esc back");
    expect(ui.frame()).toContain("F2 details · diagnostic literal");
    expect(ui.chips().some(chip => chip.label === "F2 details")).toBe(false);
    await ui.press("Esc");
    expect(ui.view.detailsKind()).toBeUndefined();
    expect(ui.frame()).toContain("Choice used for this session · F2 details");
  });
}

test("controller.fail hides its first-line F2 offer while notice details are open", async () => {
  const ui = await noticeView();
  ui.controller.fail("Cannot delete session: Undo store busy · /delete-session retry · F2 details", "Store is busy");
  await ui.settle();
  expect(ui.frame()).toContain("/delete-session retry · F2 details");
  await ui.press("F2");
  expect(ui.frame()).toContain("Cannot delete session: Undo store busy · /delete-session retry");
  expect(ui.frame()).not.toContain("F2 details");
  expect(ui.frame()).not.toContain("Esc keep editing");
  await ui.press("Esc");
  expect(ui.frame()).toContain("/delete-session retry · F2 details");
});

test("compaction repair details hides its marked offer and preserves the same diagnostic literal", async () => {
  const ui = await noticeView();
  // The runtime's failed-compaction event reaches the same notice producer used by manual /compact.
  ui.controller.applyEvent({ type: "compaction.finished", reason: "manual", status: "failed", message: "F2 repair details" });
  await ui.settle();
  expect(ui.frame()).toContain("Compaction failed · F2 repair details");
  await ui.press("F2");
  expect(ui.view.detailsKind()).toBe("notice");
  expect(ui.frame()).not.toContain("Compaction failed · F2 repair details");
  expect(ui.frame()).toContain("Compaction failed");
  expect(ui.frame().split("\n").map(line => line.trim())).toContain("F2 repair details");
  expect(ui.frame()).not.toContain("Esc keep editing");
  expect(ui.frame()).toContain("Esc back");
  await ui.press("Esc");
  expect(ui.frame()).toContain("Compaction failed · F2 repair details");
});

test("opening details preserves unmarked model and compaction literals", async () => {
  const ui = await noticeView();
  await ui.controller.submit("Show an example");
  await ui.controller.waitForIdle();
  ui.controller.notice("Context compacted (saved summary): F2 details · model summary literal");
  ui.controller.notice("Saved locally · F2 details", "F2 details\nEsc keep editing\nLiteral diagnostics");
  await ui.press("F2");
  expect(ui.frame()).toContain("Context compacted (saved summary): F2 details · model summary literal");
  expect(ui.frame()).toContain("F2 details · model literal");
  expect(ui.frame()).not.toContain("Saved locally · F2 details");
  expect(ui.frame().split("\n").map(line => line.trim())).toContain("F2 details");
  expect(ui.frame()).toContain("Esc keep editing");
  expect(ui.frame()).toContain("Literal diagnostics");
});

test("multiline changes diff and status keep literal paths and diff rows while hiding header offers", async () => {
  await withTempDir(async root => {
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: root }).exitCode).toBe(0);
    const path = "F2 details";
    await writeFile(join(root, path), "F2 details · diff literal\nEsc keep editing\n");
    const ui = await noticeView(root);
    expect(await ui.controller.changesCommand(`diff -- ${path}`)).toBe(true);
    await ui.settle();
    expect(ui.frame()).toContain("Review diff · F2 details · Enter continue");
    await ui.press("F2");
    expect(ui.frame()).toContain("Review diff · Enter continue");
    expect(ui.frame()).not.toContain("Review diff · F2 details");
    expect(ui.frame()).toContain("1 + F2 details · diff literal");
    expect(ui.frame()).toContain("2 + Esc keep editing");
    // The standalone path and diagnostics are literal content, even when they spell a key offer exactly.
    expect(ui.frame()).toContain("F2 details");
    await ui.press("Esc");
    expect(ui.frame()).toContain("Review diff · F2 details · Enter continue");
    expect(await ui.controller.changesCommand("status")).toBe(true);
    await ui.settle();
    expect(ui.frame()).toContain("1 changed file · /changes diff inspect · F2 details");
    await ui.press("F2");
    expect(ui.frame()).toContain("1 changed file · /changes diff inspect");
    expect(ui.frame()).not.toContain("/changes diff inspect · F2 details");
    expect(ui.frame()).not.toContain("Review diff · F2 details");
    expect(ui.frame()).toContain("1 + F2 details · diff literal");
    ui.dispose();
  });
});

test("snapshot-unavailable status hides both header offers while preserving literal filenames", async () => {
  await withTempDir(async root => {
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: root }).exitCode).toBe(0);
    await writeFile(join(root, "F2 details"), "literal\n");
    const ui = await noticeView(root);
    ui.controller.snapshotUnavailable();
    expect(await ui.controller.changesCommand("status")).toBe(true);
    await ui.settle();
    expect(ui.frame()).toContain("Snapshot unavailable · F2 details");
    expect(ui.frame()).toContain("/changes diff inspect · F2 details");
    await ui.press("F2");
    expect(ui.frame()).not.toContain("Snapshot unavailable · F2 details");
    expect(ui.frame()).not.toContain("/changes diff inspect · F2 details");
    expect(ui.frame().split("\n").map(line => line.trim())).toContain("F2 details");
    await ui.press("Esc");
    expect(ui.frame()).toContain("Snapshot unavailable · F2 details");
    expect(ui.frame()).toContain("/changes diff inspect · F2 details");
    ui.dispose();
  });
});
