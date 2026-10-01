import { ConfigEditor, loadConfigEditor } from "../src/config/editing.ts";
import { parseArgs, cliOverridesFromArgs } from "../src/cli/args.ts";
import { withTempDir } from "./helpers.ts";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { readTool } from "../src/tools/read.ts";
import { editTool } from "../src/tools/edit.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { TextRenderable } from "@opentui/core";
import { createConversationView } from "../src/tui/view.ts";
import { TuiController, type TuiControllerOptions } from "../src/tui/controller.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

/** Render the real app with a deterministic adapter and configurable controller dependencies. */
async function setup(width = 80, kittyKeyboard = true, overrides: Partial<TuiControllerOptions> = {}) {
  const terminal = await createTestRenderer({ width, height: 28, kittyKeyboard });
  const workspace = { root: "/project", launchCwd: "/project", extraRoots: [] };
  const controller = new TuiController({ session: createSession(), workspace, provider: "scripted", modelId: "test-model", sessionId: "test-session",
    model: createScriptedModel(), contextManager: createContextManager(workspace), ...overrides });
  const view = createConversationView(terminal.renderer, { controller, workspaceRoot: workspace.root, home: "/home/test", env: { SCHWAY_MOTION: "off" },
    secrets: [], quit() {}, submit: (text, accepted) => controller.submit(text, accepted) });
  cleanups.push(() => { view.destroy(); controller.dispose(); terminal.renderer.destroy(); });
  const settle = async () => { await Bun.sleep(5); view.refresh(); await terminal.flush(); };
  await settle();
  return { ...terminal, controller, view, settle };
}

test("Shift+Tab cycles read-only with a persistent chip and leading hint at every width", async () => {
  for (const width of [120, 80, 50]) {
    const ui = await setup(width);
    const hints = () => (ui.renderer.root.findDescendantById("hints") as TextRenderable).chunks.map(chunk => chunk.text).join("");
    const autoHints = hints();
    expect(autoHints).not.toContain("Shift+Tab");
    ui.mockInput.pressTab({ shift: true }); await ui.settle();
    expect(ui.controller.snapshot().approvalMode).toBe("read-only");
    expect(ui.captureCharFrame()).toContain("◆ READ-ONLY");
    expect(hints()).toStartWith("Shift+Tab read-only");
    ui.mockInput.pressTab({ shift: true }); await ui.settle();
    expect(ui.controller.snapshot().approvalMode).toBe("auto");
    expect(ui.captureCharFrame()).not.toContain("◆ READ-ONLY");
    expect(hints()).toBe(autoHints);
  }
});


test("legacy ESC [ Z cycles approval and preferences retain Shift+Tab scope navigation", async () => {
  const legacy = await setup(80, false);
  await legacy.mockInput.pressKeys(["\x1b[Z"]); await legacy.settle();
  expect(legacy.controller.snapshot().approvalMode).toBe("read-only");
  expect(legacy.captureCharFrame()).toContain("◆ READ-ONLY");
  const editor = new ConfigEditor({ user: { model: "gpt-5.4" } }, { user: "/tmp/user-config", project: "/tmp/project-config" });
  const ui = await setup(80, true, { configEditor: editor });
  ui.mockInput.pressKey("p", { meta: true }); await ui.settle();
  expect(ui.controller.snapshot().preferences?.scope).toBe("session");
  ui.mockInput.pressTab({ shift: true }); await ui.settle();
  expect(ui.controller.snapshot().preferences?.scope).not.toBe("session");
  expect(ui.controller.snapshot().approvalMode).toBe("auto");
});

test("completion and search own Shift+Tab without changing approval", async () => {
  const ui = await setup();
  await ui.controller.refreshCommands();
  await ui.mockInput.typeText("/"); await ui.settle();
  ui.mockInput.pressTab({ shift: true }); await ui.settle();
  expect(ui.controller.snapshot().approvalMode).toBe("auto");
  ui.mockInput.pressEscape(); await ui.settle();
  ui.mockInput.pressKey("f", { ctrl: true }); await ui.settle();
  ui.mockInput.pressTab({ shift: true }); await ui.settle();
  expect(ui.controller.snapshot().approvalMode).toBe("auto");
});

test("CLI read-only starts with the chip and process mode survives session and model switches", async () => {
  const parsed = parseArgs(["--approval", "read-only"]);
  if ("error" in parsed) throw new Error(parsed.error);
  const editor = new ConfigEditor({ cli: cliOverridesFromArgs(parsed.args) }, { user: "/tmp/user-config", project: "/tmp/project-config" });
  const ui = await setup(80, true, { configEditor: editor });
  expect(ui.controller.snapshot().approvalMode).toBe("read-only");
  expect(ui.captureCharFrame()).toContain("◆ READ-ONLY");
  ui.controller.cycleApprovalMode();
  ui.controller.replaceSession(createSession(), "new-session");
  ui.controller.setModel(createScriptedModel(), "scripted", "another-model");
  await ui.settle();
  expect(ui.controller.snapshot().approvalMode).toBe("auto");
  expect(ui.captureCharFrame()).not.toContain("◆ READ-ONLY");
});

test("ignored-project approval notices appear once per path across config edits and workspace switches", async () => {
  await withTempDir(async dir => {
    const home = join(dir, "home"), root = join(dir, "project"), other = join(dir, "other");
    for (const path of [home, root, other]) await mkdir(join(path, ".schway"), { recursive: true });
    await writeFile(join(home, ".schway/config.json"), JSON.stringify({ approval: { mode: "read-only" } }));
    for (const path of [root, other]) await writeFile(join(path, ".schway/config.json"), JSON.stringify({ approval: { mode: "auto" } }));
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({ home, workspaceRoot: root });
    const ui = await setup(120, true, { configEditor: editor, workspace, stageSettings: async (_settings, _signal, workspace) => ({ contextManager: createContextManager(workspace!) }) });
    const notices = () => ui.controller.snapshot().transcript.filter(entry => entry.text.startsWith("Ignored approval.mode"));
    const notice = `Ignored approval.mode "auto" in ${join(root, ".schway/config.json")}: project config can only make approval stricter than your "read-only" setting.`;
    expect(notices().map(entry => entry.text)).toEqual([notice]);
    expect(await ui.controller.configCommand('set approval {"mode":"auto"} --scope project')).toBe(true);
    expect(notices().map(entry => entry.text)).toEqual([notice]);
    ui.controller.cycleApprovalMode();
    const next = { root: other, launchCwd: other, extraRoots: [] };
    expect(await ui.controller.switchSession(createSession(), "other", { workspace: next, contextManager: createContextManager(next) })).toBe(true);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]!.text).toContain(join(other, ".schway/config.json"));
    expect(ui.controller.snapshot().approvalMode).toBe("auto");
    expect(await ui.controller.switchSession(createSession(), "back", { workspace, contextManager: createContextManager(workspace) })).toBe(true);
    expect(notices()).toHaveLength(0);
    expect(ui.controller.snapshot().approvalMode).toBe("auto");
  });
});

test("switching to read-only between tool rounds denies the next edit and expands its failure", async () => {
  await withTempDir(async root => {
    await Bun.write(join(root, "note.txt"), "before");
    const workspace = { root, launchCwd: root, extraRoots: [] };
    let waiting = () => {}, release = () => {};
    const secondRound = new Promise<void>(resolve => { waiting = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let rounds = 0;
    const scripted = createScriptedModel({ responses: [
      { toolCalls: [{ id: "read-call", name: "read", arguments: { path: "note.txt" } }] },
      { toolCalls: [{ id: "edit-call", name: "edit", arguments: { path: "note.txt", edits: [{ oldText: "before", newText: "after" }] } }] },
      { text: "done" },
    ] });
    const model = { ...scripted, async *stream(request: Parameters<typeof scripted.stream>[0]) {
      if (++rounds === 2) { waiting(); await gate; }
      yield* scripted.stream(request);
    } };
    const events: import("../src/agent/events.ts").RuntimeEvent[] = [];
    const ui = await setup(120, true, { workspace, model, tools: createToolRegistry([readTool, editTool]), contextManager: createContextManager(workspace), onRuntimeEvent: event => { events.push(event); } });
    const turn = ui.controller.submit("investigate then edit");
    try {
      await secondRound; await ui.settle();
      expect(ui.controller.running).toBe(true);
      ui.mockInput.pressTab({ shift: true }); await ui.settle();
      expect(ui.controller.snapshot().approvalMode).toBe("read-only");
    } finally { release(); }
    expect(await turn).toBe(true);
    await ui.settle();
    expect(await Bun.file(join(root, "note.txt")).text()).toBe("before");
    expect(events.find(event => event.type === "tool.denied")).toMatchObject({ mode: "read-only", toolCallId: "edit-call" });
    const denied = ui.controller.snapshot().transcript.find(entry => entry.toolCallId === "edit-call");
    expect(denied?.toolStatus).toBe("error");
    expect(denied?.text).toBe("Read-only mode: file changes and commands are off. The user can switch modes with Shift+Tab.");
    expect(ui.captureCharFrame()).toContain("Read-only mode:");
  });
});


test("read-only chip survives the smallest footer fallback and disconnected state", async () => {
  const ui = await setup(50);
  ui.controller.cycleApprovalMode(); await ui.settle();
  ui.resize(28, 28); await ui.settle();
  expect(ui.captureCharFrame()).toContain("◆ READ-ONLY");
  const disconnected = await setup(50, true, { model: undefined, modelId: "", provider: "openai" });
  disconnected.mockInput.pressTab({ shift: true }); await disconnected.settle();
  expect(disconnected.captureCharFrame()).toContain("◆ READ-ONLY");
  expect(disconnected.captureCharFrame()).toContain("Shift+Tab read-only");
});
