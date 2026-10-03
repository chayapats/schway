import { ConfigEditor, loadConfigEditor } from "../src/config/editing.ts";
import { parseArgs, cliOverridesFromArgs } from "../src/cli/args.ts";
import { withTempDir } from "./helpers.ts";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { dispatchEditorInput } from "../src/tui/commands.ts";
import { handleSlashCommand } from "../src/tui/app.ts";
import { createJsonlSession, loadJsonlSession, sessionsDirectory } from "../src/session/jsonl.ts";
import { bashTool } from "../src/tools/bash.ts";
import { writeTool } from "../src/tools/write.ts";
import { pathToFileURL } from "node:url";
import type { ScriptedTurnFactory } from "./helpers/scripted-model.ts";
import { statusPill } from "../src/tui/presentation.ts";
import { loadExtensions } from "../src/extensions/loader.ts";
import type { TuiSnapshot } from "../src/tui/controller-types.ts";
import type { ConversationViewOptions } from "../src/tui/view.ts";
import { openDraftStore } from "../src/drafts/store.ts";
import { readTool } from "../src/tools/read.ts";
import { editTool } from "../src/tools/edit.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { ScrollBoxRenderable, TextareaRenderable, TextRenderable } from "@opentui/core";
import { createConversationView } from "../src/tui/view.ts";
import { TuiController, type TuiControllerOptions } from "../src/tui/controller.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

/** Render the real app with a deterministic adapter and configurable controller dependencies. */
async function setup(width = 80, kittyKeyboard = true, overrides: Partial<TuiControllerOptions> = {}, viewOptions: Partial<ConversationViewOptions> = {}) {
  const terminal = await createTestRenderer({ width, height: 28, kittyKeyboard, exitOnCtrlC: false, exitSignals: [] });
  const workspace = { root: "/project", launchCwd: "/project", extraRoots: [] };
  const controller = new TuiController({ session: createSession(), workspace, provider: "scripted", modelId: "test-model", sessionId: "test-session",
    model: createScriptedModel(), contextManager: createContextManager(workspace), ...overrides });
  const root = overrides.workspace?.root ?? workspace.root;
  const home = overrides.home ?? "/home/test";
  const settings = new ConfigEditor({}, { user: join(home, "config.json"), project: join(root, "config.json") }).settings;
  const ctx = { controller, home, workspaceRoot: root, skillScope: { workspaceRoot: root }, sessionsDir: sessionsDirectory(home), settings: () => settings, env: {}, secrets: [], finishQuit() {}, stderr: { write() {} } };
  const view = createConversationView(terminal.renderer, { controller, workspaceRoot: root, home, env: { SCHWAY_MOTION: "off" },
    secrets: [], quit() {}, submit: (text, accepted) => dispatchEditorInput(text, controller, command => handleSlashCommand(command.name, command.args, ctx), accepted), ...viewOptions });
  cleanups.push(() => { view.destroy(); controller.dispose(); terminal.renderer.destroy(); });
  const settle = async () => { await Bun.sleep(5); view.refresh(); await terminal.flush(); };
  await settle();
  const waitFor = async (predicate: (snapshot: TuiSnapshot) => boolean) => {
    const start = performance.now();
    while (!predicate(controller.snapshot())) {
      if (performance.now() - start > 2000) throw new Error(`Approval state timed out\n${terminal.captureCharFrame()}`);
      await settle();
    }
    await settle();
  };
  return { ...terminal, controller, view, settle, waitFor, editor: terminal.renderer.root.findDescendantById("prompt") as TextareaRenderable };
}

test("Shift+Tab cycles auto, ask and read-only with a persistent chip and leading hint at every width", async () => {
  for (const width of [120, 80, 50]) {
    const ui = await setup(width);
    const hints = () => (ui.renderer.root.findDescendantById("hints") as TextRenderable).chunks.map(chunk => chunk.text).join("");
    const autoHints = hints();
    expect(autoHints).toContain("Shift+Tab change mode");
    expect(ui.captureCharFrame()).toContain("◆ Auto");
    ui.mockInput.pressTab({ shift: true }); await ui.settle();
    expect(ui.controller.snapshot().approvalMode).toBe("ask");
    expect(ui.captureCharFrame()).toContain("◆ Ask");
    ui.mockInput.pressTab({ shift: true }); await ui.settle();
    expect(ui.controller.snapshot().approvalMode).toBe("read-only");
    expect(ui.captureCharFrame()).toContain("◆ Read-only");
    expect(hints()).toStartWith("Shift+Tab change mode");
    ui.mockInput.pressTab({ shift: true }); await ui.settle();
    expect(ui.controller.snapshot().approvalMode).toBe("auto");
    expect(ui.captureCharFrame()).toContain("◆ Auto");
    expect(hints()).toBe(autoHints);
  }
});


test("legacy ESC [ Z cycles approval and preferences retain Shift+Tab scope navigation", async () => {
  const legacy = await setup(80, false);
  await legacy.mockInput.pressKeys(["\x1b[Z"]); await legacy.settle();
  expect(legacy.controller.snapshot().approvalMode).toBe("ask");
  expect(legacy.captureCharFrame()).toContain("◆ Ask");
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
  expect(ui.captureCharFrame()).not.toContain("Shift+Tab change mode");
  expect(ui.captureCharFrame()).toContain("◆ Auto");
  ui.mockInput.pressTab({ shift: true }); await ui.settle();
  expect(ui.controller.snapshot().approvalMode).toBe("auto");
  ui.mockInput.pressEscape(); await ui.settle();
  ui.mockInput.pressKey("f", { ctrl: true }); await ui.settle();
  expect(ui.captureCharFrame()).not.toContain("Shift+Tab change mode");
  expect(ui.captureCharFrame()).toContain("◆ Auto");
  ui.mockInput.pressTab({ shift: true }); await ui.settle();
  expect(ui.controller.snapshot().approvalMode).toBe("auto");
});

test("mode cycling preserves a multiline Thai draft, selection, cursor and transcript scroll", async () => {
  const ui = await setup();
  ui.controller.notice(Array.from({ length: 60 }, (_, i) => `Earlier work ${i}`).join("\n"));
  await ui.mockInput.pasteBracketedText("ช่วยอ่านไฟล์นี้\nแล้วเพิ่มการทดสอบ");
  await ui.settle();
  const transcript = ui.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable;
  transcript.scrollTo(8); await ui.settle();
  ui.editor.setSelection(2, 6);
  const text = ui.editor.plainText, cursor = ui.editor.cursorOffset, selected = ui.editor.getSelectedText(), scroll = transcript.scrollTop;
  expect(selected).not.toBe("");
  for (const [mode, label] of [["ask", "Ask"], ["read-only", "Read-only"], ["auto", "Auto"]] as const) {
    ui.mockInput.pressTab({ shift: true }); await ui.settle();
    expect(ui.controller.snapshot().approvalMode).toBe(mode);
    expect(ui.captureCharFrame()).toContain(`◆ ${label}`);
    expect(ui.editor.plainText).toBe(text);
    expect(ui.editor.cursorOffset).toBe(cursor);
    expect(ui.editor.getSelectedText()).toBe(selected);
    expect(transcript.scrollTop).toBe(scroll);
  }
});

test("preferences explain every approval mode without applying or saving a mode", async () => {
  const editor = new ConfigEditor({}, { user: "/tmp/user-config", project: "/tmp/project-config" });
  const ui = await setup(80, true, { configEditor: editor });
  await ui.mockInput.pasteBracketedText("ข้อความร่าง\nคงไว้");
  ui.editor.cursorOffset = 4;
  ui.mockInput.pressKey("p", { meta: true }); await ui.settle();
  expect(ui.captureCharFrame()).not.toContain("Shift+Tab change mode");
  ui.mockInput.pressKey("pagedown"); await ui.settle();
  const frame = ui.captureCharFrame();
  for (const line of ["Auto: Run tools without asking.", "Ask: Ask before tools that need approval.", "Read-only: Allow read-only tools."]) expect(frame).toContain(line);
  expect(ui.controller.snapshot().approvalMode).toBe("auto");
  expect(editor.settings.approvalMode).toBe("auto");
  ui.mockInput.pressEscape(); await ui.settle();
  expect(ui.editor.plainText).toBe("ข้อความร่าง\nคงไว้");
  expect(ui.editor.cursorOffset).toBe(4);
});

const shortLayouts = [[24, 8], [29, 8], [30, 8], [40, 8], [49, 8], [50, 8], [80, 13], [120, 8]] as const;

test("short footer retains each mode and idle, stop, panel or sign-in actions without color", async () => {
  for (const [mode, label] of [["auto", "Auto"], ["ask", "Ask"], ["read-only", "Read-only"]] as const) {
    const editor = new ConfigEditor({ cli: { approval: { mode } } }, { user: "/tmp/user-config", project: "/tmp/project-config" });
    const ui = await setup(24, true, { configEditor: editor, model: createScriptedModel({ waitForAbort: true }) }, { env: { SCHWAY_MOTION: "off", NO_COLOR: "1" } });
    const assertAction = async (terminal: typeof ui, action: string) => {
      for (const [width, height] of shortLayouts) {
        terminal.resize(width, height); await terminal.settle();
        const footer = terminal.renderer.root.findDescendantById("footer") as TextRenderable;
        expect(terminal.renderer.root.findDescendantById("hints")!.visible).toBe(false);
        expect(footer.plainText).toContain(label);
        expect(footer.plainText).toContain(action);
        expect(terminal.captureCharFrame()).toContain(action);
        expect(Bun.stringWidth(footer.plainText)).toBeLessThanOrEqual(width);
        expect(footer.y).toBeGreaterThanOrEqual(terminal.editor.y + terminal.editor.height);
      }
    };
    await assertAction(ui, "Enter send");
    const turn = ui.controller.submit("wait");
    await ui.waitFor(snapshot => snapshot.status === "running");
    await assertAction(ui, "Esc stop");
    ui.mockInput.pressEscape(); await turn;
    ui.controller.openPreferences(); await ui.settle();
    await assertAction(ui, "Esc back");
    ui.mockInput.pressEscape(); await ui.settle();
    const disconnected = await setup(24, true, { configEditor: editor, model: undefined, modelId: "" });
    await assertAction(disconnected, "Alt+L");
  }
}, 15_000);

for (const [query, status] of [["", "Type a query"], ["Needle", "Find 1/60"], ["absent", "No matches"]] as const) {
  test(`narrow search retains mode and Escape for ${query || "an empty query"} without changing editor state`, async () => {
    for (const [mode, label] of [["auto", "Auto"], ["ask", "Ask"], ["read-only", "Read-only"]] as const) {
      const settings = new ConfigEditor({ cli: { approval: { mode } } }, { user: "/tmp/user-config", project: "/tmp/project-config" });
      const ui = await setup(80, true, { configEditor: settings }, { env: { SCHWAY_MOTION: "off", NO_COLOR: "1" } });
      for (let i = 0; i < 60; i++) ui.controller.notice(`Needle ${i}`);
      const draft = "ช่วยอ่านไฟล์นี้\nแล้วเพิ่มการทดสอบ";
      await ui.mockInput.pasteBracketedText(draft);
      ui.editor.cursorOffset = 4;
      await ui.settle();
      const transcript = ui.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable;
      transcript.scrollTo(8); await ui.settle();
      const originalScroll = transcript.scrollTop;
      ui.mockInput.pressKey("f", { ctrl: true }); await ui.settle();
      if (query) await ui.mockInput.typeText(query);
      await ui.settle();
      expect(ui.captureCharFrame()).toContain(status);
      for (const [width, height] of shortLayouts) {
        ui.resize(width, height); await ui.settle();
        if (query) ui.editor.setSelection(1, 3);
        const cursor = ui.editor.cursorOffset, selection = ui.editor.getSelectedText(), searchScroll = transcript.scrollTop;
        ui.mockInput.pressTab({ shift: true }); await ui.settle();
        const footer = ui.renderer.root.findDescendantById("footer") as TextRenderable;
        expect(ui.renderer.root.findDescendantById("hints")!.visible).toBe(false);
        expect(footer.plainText).toContain(`${label} · Esc restore`);
        expect(ui.captureCharFrame()).toContain(`${label} · Esc restore`);
        expect(ui.captureCharFrame()).not.toContain("Enter send");
        expect(ui.captureCharFrame()).not.toContain("Shift+Tab change mode");
        expect(Bun.stringWidth(footer.plainText)).toBeLessThanOrEqual(width);
        expect(footer.y).toBeGreaterThanOrEqual(ui.editor.y + ui.editor.height);
        expect(ui.controller.snapshot().approvalMode).toBe(mode);
        expect(ui.editor.plainText).toBe(query);
        expect(ui.editor.cursorOffset).toBe(cursor);
        expect(ui.editor.getSelectedText()).toBe(selection);
        expect(transcript.scrollTop).toBe(searchScroll);
      }
      ui.resize(80, 14); await ui.settle();
      expect(ui.renderer.root.findDescendantById("hints")!.visible).toBe(true);
      expect(ui.captureCharFrame()).toContain(`◆ ${label}`);
      expect(ui.captureCharFrame()).toContain("Esc restore");
      ui.mockInput.pressEscape(); await ui.settle();
      expect(ui.editor.plainText).toBe(draft);
      expect(ui.editor.cursorOffset).toBe(4);
      expect(transcript.scrollTop).toBe(originalScroll);
    }
  });
}

test("configured modes stay visible through disk resume, startup, completed and stopped turns without saving a preference", async () => withTempDir(async home => {
  const workspace = { root: home, launchCwd: home, extraRoots: [] };
  const directory = sessionsDirectory(home);
  const original = await createJsonlSession({ directory, workspace });
  original.append({ type: "user", id: "prior-task", content: [{ type: "text", text: "Explain this project" }] },
    { type: "assistant", id: "prior-answer", content: [{ type: "text", text: "The entry point starts the application." }] });
  for (const [mode, label] of [["auto", "Auto"], ["ask", "Ask"], ["read-only", "Read-only"]] as const) {
    const config = JSON.stringify({ approval: { mode } });
    const configPath = join(home, ".schway/config.json");
    await writeFile(configPath, config);
    const loaded = await loadJsonlSession({ directory, id: original.header.id });
    const editor = await loadConfigEditor({ home, workspaceRoot: home });
    const ui = await setup(80, true, { session: loaded, sessionId: loaded.header.id, configEditor: editor,
      home, workspace, contextManager: createContextManager(workspace), model: undefined });
    const assertMode = () => {
      expect(ui.controller.snapshot().approvalMode).toBe(mode);
      expect(ui.captureCharFrame()).toContain(`◆ ${label}`);
    };
    assertMode();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const startup = ui.controller.initializeStartup(async () => {
      await gate;
      return { model: createScriptedModel({ responses: [{ text: "Done." }, { waitForAbort: true }] }) };
    });
    await ui.settle(); expect(ui.controller.snapshot().readiness).toBe("loading"); assertMode();
    release(); await startup; await ui.settle(); assertMode();
    expect(await ui.controller.submit("complete a turn")).toBe(true);
    await ui.settle(); expect(ui.controller.snapshot().outcome?.reason).toBe("completed"); assertMode();
    const turn = ui.controller.submit("stop a turn");
    await ui.waitFor(snapshot => snapshot.status === "running"); assertMode();
    ui.mockInput.pressEscape(); await turn; await ui.settle();
    expect(ui.controller.snapshot().outcome?.reason).toBe("cancelled"); assertMode();
    for (let i = 0; i < 3; i++) ui.mockInput.pressTab({ shift: true });
    await ui.settle(); assertMode();
    expect(await Bun.file(configPath).text()).toBe(config);
  }
}));

test("CLI read-only starts with the chip and process mode survives session and model switches", async () => {
  const parsed = parseArgs(["--approval", "read-only"]);
  if ("error" in parsed) throw new Error(parsed.error);
  const editor = new ConfigEditor({ cli: cliOverridesFromArgs(parsed.args) }, { user: "/tmp/user-config", project: "/tmp/project-config" });
  const ui = await setup(80, true, { configEditor: editor });
  expect(ui.controller.snapshot().approvalMode).toBe("read-only");
  expect(ui.captureCharFrame()).toContain("◆ Read-only");
  ui.controller.cycleApprovalMode();
  ui.controller.replaceSession(createSession(), "new-session");
  ui.controller.setModel(createScriptedModel(), "scripted", "another-model");
  await ui.settle();
  expect(ui.controller.snapshot().approvalMode).toBe("auto");
  expect(ui.captureCharFrame()).toContain("◆ Auto");
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
      ui.mockInput.pressTab({ shift: true }); ui.mockInput.pressTab({ shift: true }); await ui.settle();
      expect(ui.controller.snapshot().approvalMode).toBe("read-only");
      expect(ui.captureCharFrame()).toContain("◆ Read-only");
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
  ui.controller.cycleApprovalMode(); ui.controller.cycleApprovalMode(); await ui.settle();
  ui.resize(28, 28); await ui.settle();
  const footer = ui.renderer.root.findDescendantById("footer") as TextRenderable;
  expect(footer.plainText).toContain("Read-only");
  expect(footer.plainText).toContain("Enter send");
  const disconnected = await setup(50, true, { model: undefined, modelId: "", provider: "openai" });
  disconnected.mockInput.pressTab({ shift: true }); disconnected.mockInput.pressTab({ shift: true }); await disconnected.settle();
  expect(disconnected.captureCharFrame()).toContain("◆ Read-only");
  expect(disconnected.captureCharFrame()).toContain("Shift+Tab change mode");
});

test("inspection keeps the visible mode while owning Shift+Tab", async () => {
  const ui = await setup(80, true, { model: createScriptedModel({ text: "```ts\nconst n = 1;\n```" }) });
  await ui.controller.submit("show code"); await ui.settle();
  ui.mockInput.pressKey("i", { meta: true }); await ui.settle();
  expect(ui.captureCharFrame()).toContain("◆ Auto");
  expect(ui.captureCharFrame()).not.toContain("Shift+Tab change mode");
  ui.mockInput.pressTab({ shift: true }); await ui.settle();
  expect(ui.controller.snapshot().approvalMode).toBe("auto");
  ui.mockInput.pressEscape(); await ui.settle();
  expect(ui.captureCharFrame()).toContain("Shift+Tab change mode");
});


test("ask edit previews exact diff and Esc returns the prescribed denial to the model", async () => {
  await withTempDir(async root => {
    await Bun.write(join(root, "clamp.ts"), "function clamp(n, lo, hi) {\n  return Math.max(lo, n);\n}\n");
    const workspace = { root, launchCwd: root, extraRoots: [] };
    let result = "";
    const model = createScriptedModel({ responses: [
      { toolCalls: [{ id: "edit-call", name: "edit", arguments: { path: "clamp.ts", edits: [{ oldText: "  return Math.max(lo, n);", newText: "  return Math.min(hi, Math.max(lo, n));" }] } }] },
      request => { result = request.items.filter(item => item.type === "tool_result").at(-1)?.content ?? ""; return { text: "done" }; },
    ] });
    const editor = new ConfigEditor({ cli: { approval: { mode: "ask" } } }, { user: "/tmp/user-config", project: "/tmp/project-config" });
    const ui = await setup(50, true, { configEditor: editor, workspace, model, tools: createToolRegistry([editTool]), contextManager: createContextManager(workspace) });
    const turn = ui.controller.submit("fix clamp");
    await ui.waitFor(s => !!s.toolApproval?.diff);
    expect(ui.captureCharFrame()).toContain("Allow edit? · ask mode");
    expect(ui.captureCharFrame()).toContain("clamp.ts  +1 −1");
    expect(ui.captureCharFrame()).toContain("2 │-  return Math.max(lo, n);");
    expect(ui.captureCharFrame()).toContain("2 │+  return Math.min(hi, Math.max(lo, n));");
    ui.mockInput.pressEscape(); await ui.settle();
    expect(await turn).toBe(true);
    expect(result).toBe("Denied by the user.");
    expect(await Bun.file(join(root, "clamp.ts")).text()).toContain("return Math.max(lo, n);");
  });
});

/** Start an isolated ask-mode app with real built-in file tools and scripted rounds. */
async function askSetup(root: string, responses: ScriptedTurnFactory[], overrides: Partial<TuiControllerOptions> = {}, viewOptions: Partial<ConversationViewOptions> = {}) {
  const workspace = { root, launchCwd: root, extraRoots: [] };
  const configEditor = new ConfigEditor({ cli: { approval: { mode: "ask" } } }, { user: join(root, "user-config"), project: join(root, "project-config") });
  return setup(80, true, { workspace, configEditor, model: createScriptedModel({ responses }), tools: createToolRegistry([editTool, writeTool, bashTool, readTool]), contextManager: createContextManager(workspace), ...overrides }, viewOptions);
}
const editCall = (id: string, oldText = "before", newText = "after", path = "note.txt") => ({ id, name: "edit", arguments: { path, edits: [{ oldText, newText }] } });

test("bash allow once runs only the current command and the next call asks again", async () => withTempDir(async root => {
  const ui = await askSetup(root, [
    { toolCalls: [{ id: "first", name: "bash", arguments: { command: "printf first > first.txt" } }] },
    { toolCalls: [{ id: "second", name: "bash", arguments: { command: "printf second > second.txt" } }] }, { text: "done" },
  ]);
  const turn = ui.controller.submit("run commands");
  await ui.waitFor(s => s.toolApproval?.content.includes("printf first") === true);
  expect(ui.captureCharFrame()).toContain("printf first > first.txt");
  expect(ui.captureCharFrame()).toContain("› Allow once");
  ui.mockInput.pressEnter();
  await ui.waitFor(s => s.toolApproval?.request.toolCallId === "second");
  expect(await Bun.file(join(root, "first.txt")).text()).toBe("first");
  expect(await Bun.file(join(root, "second.txt")).exists()).toBe(false);
  ui.mockInput.pressEnter(); await turn; await ui.settle();
  expect(await Bun.file(join(root, "second.txt")).text()).toBe("second");
}));

test("allow edit for this session survives mode cycling, bypasses later asks, and /new clears it", async () => withTempDir(async root => {
  await Bun.write(join(root, "note.txt"), "before");
  const ui = await askSetup(root, [
    { toolCalls: [editCall("first")] }, { toolCalls: [editCall("second", "after", "twice")] }, { text: "done" },
    { toolCalls: [editCall("read-only", "twice", "forbidden")] }, { text: "done" },
    { toolCalls: [editCall("allowed", "twice", "third")] }, { text: "done" },
    { toolCalls: [editCall("new-session", "third", "fourth")] }, { text: "done" },
  ], { home: join(root, "home") });
  const turn = ui.controller.submit("edit twice");
  await ui.waitFor(s => !!s.toolApproval?.diff);
  ui.mockInput.pressArrow("down"); await ui.settle();
  expect(ui.captureCharFrame()).toContain("› Allow edit for this session");
  ui.mockInput.pressEnter(); await turn; await ui.settle();
  expect(await Bun.file(join(root, "note.txt")).text()).toBe("twice");
  expect(ui.controller.snapshot().toolApproval).toBeUndefined();
  ui.mockInput.pressTab({ shift: true }); await ui.settle();
  expect(ui.controller.snapshot().approvalMode).toBe("read-only");
  await ui.controller.submit("refuse edit");
  expect(await Bun.file(join(root, "note.txt")).text()).toBe("twice");
  ui.mockInput.pressTab({ shift: true }); ui.mockInput.pressTab({ shift: true }); await ui.settle();
  await ui.controller.submit("edit again");
  expect(await Bun.file(join(root, "note.txt")).text()).toBe("third");
  const previous = ui.controller.snapshot().sessionId;
  await ui.mockInput.typeText("/new"); ui.mockInput.pressEnter();
  await ui.waitFor(s => s.sessionId !== previous && !ui.controller.running);
  expect(ui.controller.snapshot().approvalMode).toBe("ask");
  const next = ui.controller.submit("edit new session");
  await ui.waitFor(s => s.toolApproval?.request.toolCallId === "new-session");
  expect(ui.captureCharFrame()).toContain("Allow edit? · ask mode");
  ui.mockInput.pressEscape(); await next;
  expect(await Bun.file(join(root, "note.txt")).text()).toBe("third");
}));

test("denial entry trims the reason, restores the exact draft cursor, and checkpoints only the draft", async () => withTempDir(async root => {
  await Bun.write(join(root, "note.txt"), "before");
  let content = "";
  const home = join(root, "home");
  await mkdir(home);
  const ui = await askSetup(root, [{ toolCalls: [editCall("reason")] }, request => {
    content = request.items.filter(item => item.type === "tool_result").at(-1)?.content ?? ""; return { text: "done" };
  }], { home }, { draftPersistence: true });
  await ui.mockInput.typeText("draft stays here"); ui.editor.cursorOffset = 5;
  const turn = ui.controller.submit("edit");
  await ui.waitFor(s => !!s.toolApproval?.diff);
  ui.mockInput.pressArrow("down"); ui.mockInput.pressArrow("down"); ui.mockInput.pressEnter(); await ui.settle();
  expect(ui.controller.snapshot().toolApproval?.enteringReason).toBe(true);
  expect(ui.captureCharFrame()).toContain("Why? The agent will see this…");
  await ui.mockInput.pasteBracketedText("  use a smaller change  "); await ui.settle();
  expect(ui.view.flushDraft()).toEqual({ saved: true, failed: false });
  const saved = () => openDraftStore({ home, workspaceRoot: root, sessionId: "test-session" }).checkpoint?.text;
  expect(saved()).toBe("draft stays here");
  ui.mockInput.pressEnter(); await turn; await ui.settle();
  expect(content).toBe("Denied by the user: use a smaller change");
  expect(ui.editor.plainText).toBe("draft stays here");
  expect(ui.editor.cursorOffset).toBe(5);
  expect(saved()).toBe("draft stays here");
  ui.mockInput.pressArrow("up"); await ui.settle();
  expect(ui.editor.plainText).not.toContain("use a smaller change");
  expect(await Bun.file(join(root, "note.txt")).text()).toBe("before");
}));

for (const exit of ["escape", "empty", "cancel", "dispose"] as const) test(`approval ${exit} keeps the draft and leaves files unchanged`, async () => withTempDir(async root => {
  await Bun.write(join(root, "note.txt"), "before");
  const session = createSession();
  const ui = await askSetup(root, [{ toolCalls: [editCall("first"), editCall("queued")] }, { text: "done" }], { session });
  await ui.mockInput.typeText("saved draft"); ui.editor.cursorOffset = 3;
  const turn = ui.controller.submit("edit");
  await ui.waitFor(s => !!s.toolApproval?.diff);
  if (exit === "empty") {
    ui.mockInput.pressArrow("down"); ui.mockInput.pressArrow("down"); ui.mockInput.pressEnter(); await ui.settle(); ui.mockInput.pressEnter();
  } else if (exit === "escape") ui.mockInput.pressEscape();
  else if (exit === "cancel") ui.mockInput.pressKey("c", { ctrl: true });
  else ui.controller.dispose();
  if (exit === "escape" || exit === "empty") {
    await ui.waitFor(s => s.toolApproval?.request.toolCallId === "queued"); ui.mockInput.pressEscape();
  }
  await turn; await ui.settle();
  expect(ui.controller.snapshot().toolApproval).toBeUndefined();
  expect(ui.editor.plainText).toBe("saved draft");
  expect(ui.editor.cursorOffset).toBe(3);
  expect(await Bun.file(join(root, "note.txt")).text()).toBe("before");
  const results = session.items.filter(item => item.type === "tool_result");
  expect(results.map(item => item.content)).toEqual(exit === "cancel" || exit === "dispose" ? ["Tool call cancelled", "Tool call cancelled"] : ["Denied by the user.", "Denied by the user."]);
  if (exit === "cancel") expect(ui.controller.snapshot().outcome?.reason).toBe("cancelled");
  if (exit === "dispose") { const release = session.acquireOperation(); release(); }
}));

test("Shift+Tab cannot change an open request or its ask chip, including after resize", async () => withTempDir(async root => {
  await Bun.write(join(root, "note.txt"), "before");
  const ui = await askSetup(root, [{ toolCalls: [editCall("first")] }, { text: "done" }]);
  const turn = ui.controller.submit("edit"); await ui.waitFor(s => !!s.toolApproval?.diff);
  const request = ui.controller.snapshot().toolApproval;
  ui.mockInput.pressTab({ shift: true }); ui.resize(50, 28); await ui.settle();
  expect(ui.controller.snapshot().approvalMode).toBe("ask");
  expect(ui.controller.snapshot().toolApproval).toEqual(request);
  expect(ui.captureCharFrame()).toContain("◆ Ask");
  expect(ui.captureCharFrame()).not.toContain("Shift+Tab change mode");
  expect(ui.captureCharFrame()).not.toContain("Esc stops");
  expect(ui.captureCharFrame()).toContain("Ctrl+C cancel");
  expect(ui.captureCharFrame()).toContain("Enter choose · Esc deny · Ctrl+C cancel turn");
  for (const [width, height] of shortLayouts) {
    ui.resize(width, height); await ui.settle();
    const footer = ui.renderer.root.findDescendantById("footer") as TextRenderable;
    expect(ui.renderer.root.findDescendantById("hints")!.visible).toBe(false);
    expect(footer.plainText).toContain("Ask · Ctrl+C cancel");
    expect(ui.captureCharFrame()).toContain("Ask · Ctrl+C cancel");
    expect(ui.captureCharFrame()).not.toContain("Esc stops");
    expect(ui.controller.snapshot().toolApproval).toEqual(request);
    expect(Bun.stringWidth(footer.plainText)).toBeLessThanOrEqual(width);
  }
  ui.mockInput.pressEscape(); await turn;
}));

for (const panel of ["model", "preferences", "help", "search"] as const) test(`${panel} stays open while approval waits and Esc opens the request`, async () => withTempDir(async root => {
  await Bun.write(join(root, "note.txt"), "before");
  const ui = await askSetup(root, [{ toolCalls: [editCall("pending")] }, { text: "done" }]);
  if (panel === "model") ui.mockInput.pressKey("m", { meta: true });
  if (panel === "preferences") ui.mockInput.pressKey("p", { meta: true });
  if (panel === "help") ui.mockInput.pressKey("h", { meta: true });
  if (panel === "search") ui.mockInput.pressKey("f", { ctrl: true });
  await ui.settle();
  const turn = ui.controller.submit("edit"); await ui.waitFor(s => !!s.toolApproval?.diff);
  expect(ui.captureCharFrame()).not.toContain("Allow edit? · ask mode");
  expect(statusPill(ui.controller.snapshot())).toMatchObject({ label: "APPROVAL", tone: "stopping" });
  expect(ui.captureCharFrame()).toContain("APPROVAL");
  expect(ui.captureCharFrame()).not.toContain("Esc stops");
  expect(ui.captureCharFrame()).not.toContain("Esc stop");
  const hints = ui.renderer.root.findDescendantById("hints") as TextRenderable;
  expect(hints.plainText).toBe("Esc close to review request");
  if (panel === "model") expect(ui.controller.snapshot().modelPicker).toBeDefined();
  ui.mockInput.pressEscape(); await ui.settle();
  expect(ui.captureCharFrame()).toContain("Allow edit? · ask mode");
  ui.mockInput.pressEscape(); await turn;
}));

test("beforeTool rewritten path is previewed and is the only file changed after approval", async () => withTempDir(async root => {
  await Bun.write(join(root, "note.txt"), "before"); await Bun.write(join(root, "rewritten.txt"), "before");
  const path = join(root, "rewrite.ts");
  await Bun.write(path, `export default ctx => ctx.beforeTool(input => ({ arguments: { ...input.arguments, path: 'rewritten.txt' } }));`);
  const workspace = { root, launchCwd: root, extraRoots: [] };
  const loaded = await loadExtensions({ modules: [path], workspace, home: join(root, "home"), tools: createToolRegistry([editTool]) });
  const ui = await askSetup(root, [{ toolCalls: [editCall("rewritten")] }, { text: "done" }], { tools: loaded.tools, extensions: loaded.runtime });
  const turn = ui.controller.submit("edit"); await ui.waitFor(s => !!s.toolApproval?.diff);
  expect(ui.captureCharFrame()).toContain("rewritten.txt  +1 −1");
  expect(ui.captureCharFrame()).not.toContain("note.txt  +1 −1");
  ui.mockInput.pressEnter(); await turn;
  expect(await Bun.file(join(root, "rewritten.txt")).text()).toBe("after");
  expect(await Bun.file(join(root, "note.txt")).text()).toBe("before");
}));

test("parallel extension approvals follow source index when beforeTool completes backwards", async () => withTempDir(async root => {
  const path = join(root, "parallel.ts");
  await Bun.write(path, `export let release; export let secondReady = false;
    const gate = new Promise(resolve => { release = resolve; });
    export default ctx => {
      for (const name of ['first_tool', 'second_tool']) ctx.registerTool({ name, description: 'Parallel extension', execution: 'parallel', inputSchema: { type: 'object' }, execute: async () => ({ content: 'ran' }) });
      ctx.beforeTool(async input => { if (input.id === 'first') await gate; else secondReady = true; });
    };`);
  const workspace = { root, launchCwd: root, extraRoots: [] };
  const loaded = await loadExtensions({ modules: [path], workspace, home: join(root, "home"), tools: createToolRegistry() });
  const extension = await import(pathToFileURL(path).href);
  const ui = await askSetup(root, [{ toolCalls: [{ id: "first", name: "first_tool", arguments: { change: "one" } }, { id: "second", name: "second_tool", arguments: { change: "two" } }] }, { text: "done" }], { tools: loaded.tools, extensions: loaded.runtime });
  const turn = ui.controller.submit("run extensions");
  await ui.waitFor(() => extension.secondReady);
  expect(ui.controller.snapshot().toolApproval).toBeUndefined();
  extension.release(); await ui.waitFor(s => s.toolApproval?.request.toolCallId === "first");
  expect(ui.captureCharFrame()).toContain("Allow first_tool? · ask mode");
  expect(ui.captureCharFrame()).toContain('"change": "one"');
  ui.mockInput.pressEscape(); await ui.waitFor(s => s.toolApproval?.request.toolCallId === "second");
  expect(ui.captureCharFrame()).toContain("Allow second_tool? · ask mode");
  ui.mockInput.pressEnter(); await turn;
}));


test("write approval numbers every new line and scrolls the full untruncated preview with masked secrets", async () => withTempDir(async root => {
  const secret = 'private"key';
  const path = "a/very/long/nested/path/to/the/new-file.txt";
  const content = Array.from({ length: 60 }, (_, index) => index === 0 ? secret : `source line ${index + 1}`).join("\n") + "\n";
  const ui = await askSetup(root, [{ toolCalls: [{ id: "new-write", name: "write", arguments: { path, content } }] }, { text: "done" }], { secrets: [secret] });
  const turn = ui.controller.submit("write"); await ui.waitFor(s => !!s.toolApproval?.diff);
  ui.resize(50, 28); await ui.settle();
  const diff = ui.controller.snapshot().toolApproval?.diff;
  expect(diff?.rows).toHaveLength(60);
  expect(diff?.added).toBe(60); expect(diff?.removed).toBe(0);
  expect(ui.captureCharFrame()).toContain("+60 −0");
  expect(ui.captureCharFrame()).toContain("1 │+***");
  expect(ui.captureCharFrame()).not.toContain(secret);
  expect(ui.captureCharFrame()).not.toContain("source line 60");
  for (let page = 0; page < 8; page++) await ui.mockInput.pressKeys(["\x1b[6~"]);
  await ui.settle(); expect(ui.captureCharFrame()).toContain("60 │+source line 60");
  expect(ui.captureCharFrame()).toContain("Allow write for this session");
  for (let page = 0; page < 8; page++) await ui.mockInput.pressKeys(["\x1b[5~"]);
  await ui.settle(); expect(ui.captureCharFrame()).toContain("1 │+***");
  ui.mockInput.pressEscape(); await turn;
  expect(await Bun.file(join(root, path)).exists()).toBe(false);
}));

for (const invalid of ["missing", "unmatched"] as const) test(`edit ${invalid} preview still asks with its path and no diff`, async () => withTempDir(async root => {
  if (invalid === "unmatched") await Bun.write(join(root, "note.txt"), "different");
  const ui = await askSetup(root, [{ toolCalls: [editCall("invalid")] }, { text: "done" }]);
  const turn = ui.controller.submit("edit"); await ui.waitFor(s => s.toolApproval?.path === "note.txt");
  expect(ui.controller.snapshot().toolApproval?.diff).toBeUndefined();
  expect(ui.captureCharFrame()).toContain("Allow edit? · ask mode");
  expect(ui.captureCharFrame()).toContain("note.txt");
  ui.mockInput.pressEscape(); await turn;
}));

test("write preview compares the current content and command preview wraps every argument without clipping", async () => withTempDir(async root => {
  await Bun.write(join(root, "note.txt"), "keep\nbefore\n");
  const command = "printf '" + "long argument ".repeat(20) + "FINAL-MARKER'";
  const ui = await askSetup(root, [
    { toolCalls: [{ id: "write", name: "write", arguments: { path: "note.txt", content: "keep\nafter\n" } }] },
    { toolCalls: [{ id: "bash", name: "bash", arguments: { command } }] }, { text: "done" },
  ]);
  const turn = ui.controller.submit("write and run"); await ui.waitFor(s => !!s.toolApproval?.diff);
  expect(ui.controller.snapshot().toolApproval?.diff).toEqual({ added: 1, removed: 1, rows: [{ line: 2, sign: "-", text: "before" }, { line: 2, sign: "+", text: "after" }] });
  ui.mockInput.pressEscape(); await ui.waitFor(s => s.toolApproval?.content === command);
  ui.resize(50, 28); await ui.settle();
  expect((ui.renderer.root.findDescendantById("tool-approval-text") as TextRenderable).plainText).toBe(command);
  expect(ui.captureCharFrame()).toContain("FINAL-MARKER");
  ui.mockInput.pressEscape(); await turn;
}));

for (const panel of ["inspection", "tree"] as const) test(`${panel} preserves a waiting request until closed`, async () => withTempDir(async root => {
  await Bun.write(join(root, "note.txt"), "before");
  const ui = await askSetup(root, [{ toolCalls: [{ id: "read", name: "read", arguments: { path: "note.txt" } }] }, { text: "done" }, { toolCalls: [editCall("pending")] }, { text: "done" }]);
  await ui.controller.submit("read"); await ui.settle();
  if (panel === "inspection") ui.mockInput.pressKey("i", { meta: true });
  else { await ui.mockInput.typeText("/branch tree"); ui.mockInput.pressEnter(); }
  await ui.settle();
  const turn = ui.controller.submit("edit"); await ui.waitFor(s => !!s.toolApproval?.diff);
  expect(ui.captureCharFrame()).not.toContain("Allow edit? · ask mode");
  expect((ui.renderer.root.findDescendantById("hints") as TextRenderable).plainText).toBe("Esc close to review request");
  ui.mockInput.pressEscape(); await ui.settle();
  expect(ui.captureCharFrame()).toContain("Allow edit? · ask mode");
  ui.mockInput.pressEscape(); await turn;
}));

test("unknown tool arguments mask escaped secrets using controller secrets", async () => withTempDir(async root => {
  const secret = 'private"key';
  const path = join(root, "tool.ts");
  await Bun.write(path, `export default ctx => ctx.registerTool({ name: 'extension_tool', description: 'Extension tool', execution: 'parallel', inputSchema: { type: 'object' }, execute: async () => ({ content: 'ran' }) });`);
  const workspace = { root, launchCwd: root, extraRoots: [] };
  const loaded = await loadExtensions({ modules: [path], workspace, home: root, tools: createToolRegistry() });
  const ui = await askSetup(root, [{ toolCalls: [{ id: "custom", name: "extension_tool", arguments: { value: secret, nested: [secret] } }] }, { text: "done" }], { tools: loaded.tools, extensions: loaded.runtime, secrets: [secret] });
  const turn = ui.controller.submit("extension"); await ui.waitFor(s => !!s.toolApproval && !s.toolApproval.loading);
  const preview = (ui.renderer.root.findDescendantById("tool-approval-text") as TextRenderable).plainText;
  expect(preview).toContain('"value": "***"');
  expect(preview).not.toContain("private");
  ui.mockInput.pressEscape(); await turn;
}));
