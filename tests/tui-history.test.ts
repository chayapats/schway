import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { TextareaRenderable } from "@opentui/core";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContextManager } from "../src/context/manager.ts";
import { loadExtensions } from "../src/extensions/loader.ts";
import { HISTORY_PAGE_SIZE } from "../src/history/records.ts";
import { historyFilePath } from "../src/history/store.ts";
import { createJsonlSession, loadJsonlSession, sessionsDirectory, type JsonlSession } from "../src/session/jsonl.ts";
import { createSession } from "../src/session/session.ts";
import { bashTool } from "../src/tools/bash.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { writeTool } from "../src/tools/write.ts";
import { dispatchEditorInput, helpText, parseSkillInvocation, parseSlashCommand } from "../src/tui/commands.ts";
import { commandCatalog } from "../src/tui/command-catalog.ts";
import { handleSlashCommand } from "../src/tui/app.ts";
import { TuiController, type TuiControllerOptions } from "../src/tui/controller.ts";
import { historyCommandLine, historyDurationLabel, historyOutcomeLabel, historyUndoLine } from "../src/tui/controller-history.ts";
import { createConversationView } from "../src/tui/view.ts";
import type { Workspace } from "../src/workspace/workspace.ts";
import { RESERVED_SKILL_NAMES } from "../src/skills/skills.ts";
import { createScriptedModel, type ScriptedTurn } from "./helpers/scripted-model.ts";

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
async function git(dir: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe", env: gitEnv });
  const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(err);
}
async function repo(dir: string) {
  await mkdir(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "README.md"), "fixture\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-qm", "baseline");
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function temp() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "schway-tui-history-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const workspaceOf = (root: string): Workspace => ({ root, launchCwd: root, extraRoots: [] });

/** Scripted model that counts stream calls so opening history can prove it never calls the model. */
function countingModel(responses: ScriptedTurn[] = []) {
  const model = createScriptedModel({ responses });
  const stream = model.stream.bind(model);
  let calls = 0;
  model.stream = request => { calls++; return stream(request); };
  return { model, calls: () => calls };
}
function controller(session: TuiControllerOptions["session"], root: string, home: string, overrides: Partial<TuiControllerOptions> = {}) {
  const c = new TuiController({ session, workspace: workspaceOf(root), home, sessionId: "rootId" in session ? (session as JsonlSession).header?.id ?? session.rootId : "memory",
    provider: "scripted", modelId: "scripted", model: countingModel().model, contextManager: createContextManager(workspaceOf(root)),
    tools: createToolRegistry([writeTool, bashTool]), changeTracking: "on-demand", activityClock: () => 0, ...overrides });
  cleanups.push(() => c.dispose());
  return c;
}

/** Record every Git process started while the spy is installed. */
function spyGit() {
  const realSpawn = Bun.spawn;
  const commands: string[][] = [];
  Bun.spawn = ((command: string[], options: Parameters<typeof Bun.spawn>[1]) => {
    if (command[0] === "git") commands.push(command);
    return realSpawn(command, options);
  }) as typeof Bun.spawn;
  const restore = () => { Bun.spawn = realSpawn; };
  cleanups.push(restore);
  return { commands, restore };
}

async function view(c: TuiController, root: string, home: string, width = 100, height = 30) {
  const terminal = await createTestRenderer({ width, height, kittyKeyboard: true, exitOnCtrlC: false });
  const ui = createConversationView(terminal.renderer, { controller: c, workspaceRoot: root, home, env: {}, secrets: [], motion: "off", quit: () => {},
    submit: (value, accepted) => dispatchEditorInput(value, c, command => command.name === "history" ? c.historyCommand(command.args)
      : command.name === "undo" ? c.undoCommand(command.args) : Promise.resolve(false), accepted) });
  cleanups.push(() => { ui.destroy(); terminal.renderer.destroy(); });
  const settle = async () => { ui.refresh(); await terminal.flush(); };
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!predicate() && Date.now() < deadline) { await Bun.sleep(5); await settle(); }
    expect(predicate(), "Expected state before deadline").toBe(true);
    await settle();
  };
  const keys = { return: "RETURN", escape: "ESCAPE", up: "ARROW_UP", down: "ARROW_DOWN", f2: "F2", pagedown: "\u001b[6~" } as const;
  const press = async (key: keyof typeof keys) => { terminal.mockInput.pressKey(keys[key]); await Bun.sleep(1); await settle(); };
  const type = async (text: string) => { await terminal.mockInput.typeText(text); await settle(); };
  await settle();
  return { ...terminal, settle, waitFor, press, type, editor: terminal.renderer.root.findDescendantById("prompt") as TextareaRenderable,
    frame: () => terminal.captureCharFrame() };
}

async function savedSession(home: string, root: string) {
  return createJsonlSession({ directory: sessionsDirectory(home), workspace: workspaceOf(root) });
}

test("three turns, an undo and a restart keep identities and outcomes; current content is labelled current", async () => {
  const dir = await temp();
  const home = join(dir, "home"), root = join(dir, "work");
  await repo(root);
  const session = await savedSession(home, root);
  const first = controller(session, root, home, { model: countingModel([
    { toolCalls: [{ id: "w1", name: "write", arguments: { path: "notes.md", content: "one\ntwo\n" } }] }, { text: "Wrote notes." },
    { toolCalls: [{ id: "b1", name: "bash", arguments: { command: "printf 'checking\\n'; exit 3" } }] }, { text: "The check exited 3." },
    { chunks: ["Working"], waitForAbort: true },
  ]).model });
  expect(await first.submit("Write the notes")).toBe(true);
  expect(await first.submit("Run the check")).toBe(true);
  const stopping = first.submit("Take a long time");
  const deadline = Date.now() + 5000;
  while (!first.snapshot().transcript.some(entry => entry.kind === "assistant" && entry.text.includes("Working")) && Date.now() < deadline) await Bun.sleep(5);
  first.cancel();
  await stopping;
  expect(first.snapshot().outcome?.reason).toBe("cancelled");
  expect(await first.undoCommand("")).toBe(true);
  expect(first.snapshot().undoPreview?.turnNumber).toBe(1);
  await first.applyUndo();
  expect(session.items.at(-1)?.type).toBe("turn_undo");
  first.dispose();
  const users = session.items.filter(item => item.type === "user").map(item => item.id);

  // Restart: a new process loads the saved session and opens /history from the composer.
  const loaded = await loadJsonlSession({ directory: sessionsDirectory(home), id: session.header.id });
  const counted = countingModel();
  const c = controller(loaded, root, home, { model: counted.model, sessionId: loaded.header.id });
  const ui = await view(c, root, home, 120, 32);
  await ui.type("/history");
  await ui.press("return");
  await ui.waitFor(() => c.snapshot().history?.loading === false);
  const history = c.snapshot().history!;
  expect(history.turns.map(turn => [turn.ordinal, turn.turnId, turn.outcome])).toEqual([[3, users[2], "stopped"], [2, users[1], "completed"], [1, users[0], "completed"]]);
  let frame = ui.frame();
  expect(frame).toContain("History · 3 turns");
  expect(frame).toContain("− Stopped");
  expect(frame).toContain("Take a long time");
  // Up/Down select and Enter opens saved evidence for turn 2.
  await ui.press("down");
  await ui.press("return");
  expect(c.snapshot().history?.view).toBe("detail");
  frame = ui.frame();
  expect(frame).toContain("Turn 2 · ✓ Done");
  expect(frame).toContain("printf 'checking\\n'; exit 3 · Exit 3");
  expect(frame).toContain("No file edits to undo");
  // Esc returns to the same list row.
  await ui.press("escape");
  expect(c.snapshot().history).toMatchObject({ view: "list", selected: 1 });
  await ui.press("down");
  await ui.press("return");
  frame = ui.frame();
  expect(frame).toContain("Turn 1 · ✓ Done");
  expect(frame).toContain("notes.md");
  expect(frame).toContain("+2 −0");
  expect(frame).toContain("Undone · 1 file reverted");
  // The explicit current-content action reads Git now and says so; the undone file no longer exists.
  await ui.press("return");
  await ui.waitFor(() => c.snapshot().history?.current?.loading === false);
  frame = ui.frame();
  expect(frame).toContain("Current diff · notes.md");
  expect(frame).toContain("Current content · not turn 1's patch");
  expect(frame).toContain("File not found · nothing to compare");
  expect(frame).not.toContain("+two");
  await ui.press("escape");
  expect(c.snapshot().history?.view).toBe("detail");
  await ui.press("escape");
  await ui.press("escape");
  expect(c.snapshot().history).toBeUndefined();
  expect(ui.editor.visible).toBe(true);
  expect(counted.calls()).toBe(0);
});

test("Esc steps back through current content, details and the list, then restores the draft", async () => {
  const dir = await temp();
  const home = join(dir, "home"), root = join(dir, "work");
  await repo(root);
  const session = await savedSession(home, root);
  const c = controller(session, root, home, { model: countingModel([{ toolCalls: [{ id: "w1", name: "write", arguments: { path: "a.txt", content: "a\n" } }] }, { text: "ok" }]).model });
  expect(await c.submit("Add a file")).toBe(true);
  const ui = await view(c, root, home, 80, 24);
  await ui.type("draft in progress");
  expect(await c.historyCommand("")).toBe(true);
  await ui.settle();
  expect(ui.editor.visible).toBe(false);
  await ui.press("return");
  await ui.press("f2");
  expect(c.snapshot().history?.showingDetails).toBe(true);
  expect(ui.frame()).toContain("Turn 1 details");
  expect(c.snapshot().history?.details).toContain("do not identify exclusive authorship");
  await ui.press("escape");
  expect(c.snapshot().history).toMatchObject({ view: "detail", showingDetails: false });
  await ui.press("escape");
  await ui.press("escape");
  expect(c.snapshot().history).toBeUndefined();
  expect(ui.editor.visible).toBe(true);
  expect(ui.editor.plainText).toBe("draft in progress");
});

test("more than one page reveals older turns on request and absent evidence stays explicit", async () => {
  const dir = await temp();
  const home = join(dir, "home"), root = join(dir, "work");
  await mkdir(root, { recursive: true });
  const session = await savedSession(home, root);
  for (let index = 0; index < HISTORY_PAGE_SIZE + 7; index++) {
    session.append({ type: "user", id: `u${index}`, content: [{ type: "text", text: `Legacy task ${index + 1}` }] }, { type: "assistant", id: `a${index}`, content: [{ type: "text", text: "ok" }] });
  }
  const c = controller(session, root, home);
  const ui = await view(c, root, home, 100, 30);
  expect(await c.historyCommand("")).toBe(true);
  await ui.settle();
  let history = c.snapshot().history!;
  expect(history.total).toBe(HISTORY_PAGE_SIZE + 7);
  expect(history.turns).toHaveLength(HISTORY_PAGE_SIZE);
  expect(history.turns.every(turn => turn.evidence === "missing")).toBe(true);
  expect(ui.frame()).toContain("○ Details unavailable");
  for (let index = 0; index < HISTORY_PAGE_SIZE - 1; index++) c.moveHistory(1);
  expect(c.snapshot().history!.turns).toHaveLength(HISTORY_PAGE_SIZE);
  await ui.settle();
  expect(ui.frame()).toContain("7 older turns · ↓ show more");
  await ui.press("down");
  history = c.snapshot().history!;
  expect(history.turns).toHaveLength(HISTORY_PAGE_SIZE + 7);
  expect(history.selected).toBe(HISTORY_PAGE_SIZE);
  await ui.press("return");
  expect(ui.frame()).toContain("Details unavailable · F2 details");
  expect(await Bun.file(historyFilePath(home, session.header.id)).exists()).toBe(false);
});

test("opening history is offline and read-only", async () => {
  const dir = await temp();
  const home = join(dir, "home"), root = join(dir, "work");
  await repo(root);
  const session = await savedSession(home, root);
  const counted = countingModel([{ toolCalls: [{ id: "w1", name: "write", arguments: { path: "r.txt", content: "r\n" } }] }, { text: "ok" }]);
  const c = controller(session, root, home, { model: counted.model });
  expect(await c.submit("Write r")).toBe(true);
  const calls = counted.calls();
  const sidecar = historyFilePath(home, session.header.id);
  const before = { bytes: await readFile(sidecar), mtime: (await stat(sidecar)).mtimeMs, files: (await readdir(join(home, ".schway"), { recursive: true })).sort() };
  const spy = spyGit();
  const fetchCalls: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: unknown[]) => { fetchCalls.push(args); throw new Error("offline"); }) as unknown as typeof fetch;
  cleanups.push(() => { globalThis.fetch = realFetch; });
  expect(await c.historyCommand("")).toBe(true);
  expect(c.openHistoryDetail()).toBe(true);
  c.toggleHistoryDetails();
  c.historyBack(); c.historyBack(); c.historyBack();
  expect(spy.commands).toEqual([]);
  expect(fetchCalls).toEqual([]);
  expect(counted.calls()).toBe(calls);
  expect((await readFile(sidecar)).equals(before.bytes)).toBe(true);
  expect((await stat(sidecar)).mtimeMs).toBe(before.mtime);
  expect((await readdir(join(home, ".schway"), { recursive: true })).sort()).toEqual(before.files);
});

test.each([["tracking off", "off"], ["non-Git workspace", "non-git"], ["failed capture", "failed"]] as const)("TUI %s keeps tool evidence, marks Git evidence unavailable and adds no Git process", async (_name, kind) => {
  const dir = await temp();
  const home = join(dir, "home"), root = join(dir, "work");
  if (kind === "non-git") await mkdir(root, { recursive: true }); else await repo(root);
  if (kind === "failed") await writeFile(join(root, ".git", "index"), "not an index");
  const responses = (): ScriptedTurn[] => [{ toolCalls: [{ id: "w1", name: "write", arguments: { path: "t.txt", content: "t\n" } }] }, { text: "ok" }];
  const mode = kind === "off" ? "off" as const : "on-demand" as const;
  // The same turn without history (an in-memory session) sets the Git baseline.
  const baseline = spyGit();
  const plain = controller(createSession(), root, home, { model: countingModel(responses()).model, changeTracking: mode });
  expect(await plain.submit("Write t")).toBe(true);
  baseline.restore();
  const without = baseline.commands.length;
  await rm(join(root, "t.txt"), { force: true });
  const session = await savedSession(home, root);
  const spy = spyGit();
  const c = controller(session, root, home, { model: countingModel(responses()).model, changeTracking: mode, sessionId: session.header.id });
  expect(await c.submit("Write t")).toBe(true);
  expect(spy.commands.length).toBe(without);
  if (kind === "off") expect(spy.commands).toEqual([]);
  const turnCommands = spy.commands.length;
  expect(await c.historyCommand("")).toBe(true);
  expect(spy.commands.length).toBe(turnCommands);
  const turn = c.snapshot().history!.turns[0]!;
  expect(turn.files.items).toEqual([{ path: "t.txt", source: "tool", added: 1, removed: 0 }]);
  expect(turn.attempts[0]!.git).toMatchObject({ status: "unavailable", reason: kind });
  expect(c.openHistoryDetail()).toBe(true);
  expect(c.snapshot().history!.details).toContain({ off: "change tracking is off", "non-git": "not a Git workspace", failed: "the snapshot failed" }[kind]);
  const ui = await view(c, root, home, 80, 24);
  expect(ui.frame()).toContain("Shell changes not tracked · F2 details");
  // Current content on request still honors tracking off by reading nothing.
  await ui.press("return");
  await ui.waitFor(() => c.snapshot().history?.current?.loading === false);
  if (kind === "off") {
    expect(spy.commands.length).toBe(turnCommands);
    expect(ui.frame()).toContain("Change tracking is off");
  }
});

test("a live history storage failure is reported without claiming the turn was saved", async () => {
  const dir = await temp();
  const home = join(dir, "home"), root = join(dir, "work");
  await mkdir(root, { recursive: true });
  const session = await savedSession(home, root);
  await writeFile(join(home, ".schway", "history"), "blocked");
  const c = controller(session, root, home, { model: countingModel([{ text: "Done." }]).model, changeTracking: "off" });
  expect(await c.submit("Answer briefly")).toBe(true);
  expect(c.snapshot().transcript.at(-1)?.text).toBe("History not saved · /history shows gaps · F2 details");
  expect(session.items.map(item => item.type)).toEqual(["user", "assistant"]);
  expect(await c.historyCommand("")).toBe(true);
  const ui = await view(c, root, home, 80, 24);
  expect(ui.frame()).toContain("! Not saved");
  await ui.press("return");
  expect(ui.frame()).toContain("History not saved · F2 details");
  expect(c.snapshot().history?.details).toContain("History was not saved for this turn");
});

test("a history skill or extension follows normal collision behavior and never shadows the built-in", async () => {
  expect(RESERVED_SKILL_NAMES).toContain("history");
  expect(parseSlashCommand("/history")).toMatchObject({ name: "history", args: "" });
  expect(parseSkillInvocation("/history")).toBeNull();
  // Help and completion list the built-in from the shared catalogue.
  expect(commandCatalog([]).find(entry => entry.name === "history")).toMatchObject({ insertion: "/history ", description: "Browse turn history", source: "built-in", available: true });
  expect(helpText()).toContain("/history - browse recorded turn outcomes");
  const dir = await temp();
  const home = join(dir, "home"), root = join(dir, "work");
  await mkdir(join(root, ".agents/skills/history"), { recursive: true });
  await writeFile(join(root, ".agents/skills/history/SKILL.md"), "---\nname: history\ndescription: Shadow history\n---\nNever run.");
  const session = await savedSession(home, root);
  const counted = countingModel();
  const c = controller(session, root, home, { model: counted.model });
  let opened = 0;
  const executed = await dispatchEditorInput("/history", c, async command => { opened++; return c.historyCommand(command.args); });
  expect(executed).toBe(false);
  expect(opened).toBe(0);
  expect(c.snapshot().history).toBeUndefined();
  expect(c.snapshot().transcript.at(-1)?.text).toContain("Command conflicts with skill");
  // The colliding skill is shown as an unavailable choice; the built-in is never silently redirected to it.
  expect(c.commandChoices("/history").filter(entry => entry.name === "history").every(entry => !entry.available)).toBe(true);
  expect(counted.calls()).toBe(0);
  // Extensions cannot register the built-in name at all.
  await writeFile(join(root, "history-extension.ts"), "export default ctx => ctx.registerCommand({ name: 'history', description: 'Shadow', execute() {} });");
  await expect(loadExtensions({ modules: [join(root, "history-extension.ts")], workspace: workspaceOf(root), tools: createToolRegistry(), home })).rejects.toThrow("conflicts with Schway built-in /history");
  // Without a collision the shared dispatcher opens the built-in.
  await rm(join(root, ".agents"), { recursive: true });
  const ctx = { controller: c, home, workspaceRoot: root, skillScope: { workspaceRoot: root }, sessionsDir: sessionsDirectory(home), settings: () => ({}) as never, env: {}, secrets: [], finishQuit() {}, stderr: { write() {} } };
  expect(await dispatchEditorInput("/history", c, command => handleSlashCommand(command.name, command.args, ctx as never))).toBe(true);
  expect(c.snapshot().history).toBeDefined();
  expect(await dispatchEditorInput("/history extra", c, command => { c.closeHistory(); return handleSlashCommand(command.name, command.args, ctx as never); })).toBe(false);
  expect(c.snapshot().transcript.at(-1)?.text).toBe("Usage: /history");
});

test("history snapshots redact known secrets in tasks, commands and paths", async () => {
  const dir = await temp();
  const home = join(dir, "home"), root = join(dir, "work");
  await mkdir(root, { recursive: true });
  const secret = "hunter2-session-secret";
  const session = await savedSession(home, root);
  const c = controller(session, root, home, { secrets: [secret], changeTracking: "off", model: countingModel([
    { toolCalls: [{ id: "b1", name: "bash", arguments: { command: `echo ${secret}` } }, { id: "w1", name: "write", arguments: { path: `${secret}.txt`, content: "x\n" } }] }, { text: "ok" }]).model });
  expect(await c.submit(`Use ${secret} carefully`)).toBe(true);
  const raw = await readFile(historyFilePath(home, session.header.id), "utf8");
  expect(raw).not.toContain(secret);
  expect(await c.historyCommand("")).toBe(true);
  expect(JSON.stringify(c.snapshot().history)).not.toContain(secret);
  expect(c.snapshot().history!.turns[0]!.task).toBe("Use *** carefully");
});

test("a path changed outside the file tools is marked detected and never counted as tool authorship", async () => {
  const dir = await temp();
  const home = join(dir, "home"), root = join(dir, "work");
  await repo(root);
  const session = await savedSession(home, root);
  const c = controller(session, root, home, { sessionId: session.header.id, model: countingModel([
    { toolCalls: [{ id: "w1", name: "write", arguments: { path: "tool.txt", content: "tool\n" } }, { id: "b1", name: "bash", arguments: { command: "printf 'external\\n' > external.txt" } }] }, { text: "ok" }]).model });
  expect(await c.submit("Change two files")).toBe(true);
  expect(await c.historyCommand("")).toBe(true);
  const turn = c.snapshot().history!.turns[0]!;
  expect(turn.files.items).toEqual([{ path: "tool.txt", source: "tool", added: 1, removed: 0 }, { path: "external.txt", source: "shell" }]);
  expect(turn.attempts[0]!.git).toEqual({ status: "captured" });
  expect(c.openHistoryDetail()).toBe(true);
  const ui = await view(c, root, home, 80, 24);
  expect(ui.frame()).toMatch(/external\.txt\s+detected/);
  expect(c.snapshot().history!.details).toContain("They do not identify exclusive authorship; concurrent external edits can appear.");
});

test("history labels distinguish outcomes, unknown time and every undo state", () => {
  const base = { turnId: "t", evidence: "recorded" as const, undo: [], files: { total: 1, truncated: false, items: [{ path: "a", source: "tool" as const }] } };
  expect(["completed", "failed", "stopped", "limit", "incomplete"].map(outcome => historyOutcomeLabel({ evidence: "recorded", outcome: outcome as never })))
    .toEqual(["✓ Done", "✗ Failed", "− Stopped", "◌ Limit reached", "! Incomplete"]);
  expect(historyOutcomeLabel({ evidence: "missing" })).toBe("○ Details unavailable");
  expect(historyOutcomeLabel({ evidence: "missing" }, true)).toBe("! Not saved");
  const attempt = { attemptId: "a", mode: "tui" as const, workspaceRoot: "/w", startedAt: "2026-01-15T09:30:00.000Z", activeMs: null };
  expect(historyDurationLabel({ evidence: "recorded", activeMs: 1500, unknownDurations: 1, attempts: [attempt, { ...attempt, activeMs: 1500 }] })).toBe("1.5s + unknown");
  expect(historyDurationLabel({ evidence: "recorded", activeMs: 0, unknownDurations: 1, attempts: [attempt] })).toBe("Time unknown");
  const undo = { known: true, preImages: ["t", "u"], targetTurnId: "u", targetOrdinal: 4 };
  expect(historyUndoLine({ ...base, undo: [{ reverted: [{ path: "a", action: "restored" }], skipped: [{ path: "b", reason: "changed" }] }] }, undo)).toBe("Undone · 1 file reverted · 1 skipped");
  expect(historyUndoLine(base, { ...undo, targetTurnId: "t" })).toBe("Undo available · /undo previews this turn");
  expect(historyUndoLine(base, undo)).toBe("Not the undo target · /undo previews turn 4");
  expect(historyUndoLine(base, { known: true, preImages: [] })).toBe("Undo unavailable · pre-images not kept");
  expect(historyUndoLine(base, { known: false, preImages: [] })).toBe("Undo status unknown · /undo preview");
  expect(historyUndoLine({ ...base, files: { total: 1, truncated: false, items: [{ path: "a", source: "shell" }] } }, undo)).toBe("No file edits to undo");
  expect(historyCommandLine({ id: "0".repeat(16), command: "bun test", exitCode: 1, ended: "exit", status: "success" }).text).toBe("bun test · Exit 1");
  expect(historyCommandLine({ id: "0".repeat(16), command: "sleep 9", exitCode: null, ended: "timed-out", status: "error" }).text).toBe("sleep 9 · Timed out");
});
