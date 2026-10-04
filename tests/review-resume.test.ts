import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { join } from "node:path";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createConversationView } from "../src/tui/view.ts";
import { TuiController, type TuiControllerOptions } from "../src/tui/controller.ts";
import { dispatchEditorInput } from "../src/tui/commands.ts";
import { handleSlashCommand } from "../src/tui/app.ts";
import { ConfigEditor } from "../src/config/editing.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { createJsonlSession, loadJsonlSession, sessionsDirectory, type JsonlSession } from "../src/session/jsonl.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { editTool } from "../src/tools/edit.ts";
import { writeTool } from "../src/tools/write.ts";
import { restoreWorkspace, type Workspace } from "../src/workspace/workspace.ts";
import { createScriptedModel, type ScriptedTurn } from "./helpers/scripted-model.ts";

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
async function git(dir: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe", env });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(err);
  return out.trim();
}
async function repo(dir: string, files: Record<string, string> = { "tracked.txt": "line one\nline two\n" }) {
  await mkdir(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  for (const [path, content] of Object.entries(files)) await writeFile(join(dir, path), content);
  await git(dir, "add", ".");
  await git(dir, "commit", "-qm", "baseline");
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function temp() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "schway-review-resume-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Scripted model that records every stream request so review can prove it never calls the model. */
function countingModel(responses: ScriptedTurn[] = []) {
  const model = createScriptedModel({ responses });
  const stream = model.stream.bind(model);
  let calls = 0;
  model.stream = request => { calls++; return stream(request); };
  return { model, calls: () => calls };
}
const workspaceOf = (root: string): Workspace => ({ root, launchCwd: root, extraRoots: [] });
function controller(session: TuiControllerOptions["session"], workspace: Workspace, sessionId: string, overrides: Partial<TuiControllerOptions> = {}) {
  const c = new TuiController({ session, workspace, sessionId, provider: "scripted", modelId: "scripted", model: countingModel().model,
    contextManager: createContextManager(workspace), tools: createToolRegistry([writeTool, editTool]), changeTracking: "on-demand", ...overrides });
  cleanups.push(() => c.dispose());
  return c;
}

/** Run one real scripted edit turn in a durable JSONL session, then dispose that process's controller. */
async function savedEditSession(home: string, root: string, turns: ScriptedTurn[]) {
  const session = await createJsonlSession({ directory: sessionsDirectory(home), workspace: workspaceOf(root) });
  const first = new TuiController({ session, workspace: workspaceOf(root), sessionId: session.header.id, provider: "scripted", modelId: "scripted",
    model: createScriptedModel({ responses: turns }), contextManager: createContextManager(workspaceOf(root)), tools: createToolRegistry([writeTool, editTool]), changeTracking: "on-demand" });
  expect(await first.submit("change the files")).toBe(true);
  expect(first.snapshot().outcome?.files.length).toBeGreaterThan(0);
  first.dispose();
  await first.waitForIdle();
  return session.header.id;
}

/** Load a saved session as a new process would: JSONL from disk, restored workspace, fresh controller. */
async function resume(home: string, id: string, overrides: Partial<TuiControllerOptions> = {}) {
  const loaded = await loadJsonlSession({ directory: sessionsDirectory(home), id });
  const restored = await restoreWorkspace({ root: loaded.header.workspaceRoot, launchCwd: loaded.header.launchCwd, extraRoots: [...loaded.metadata.extraRoots] });
  const counted = countingModel();
  const c = controller(loaded, restored.workspace, id, { model: counted.model, ...overrides });
  return { c, loaded, workspace: restored.workspace, calls: counted.calls, file: join(sessionsDirectory(home), `${id}.jsonl`) };
}

/** Record every Git process the controller starts, optionally holding `status` reads until released. */
function spyGit(holdStatus = false) {
  const realSpawn = Bun.spawn;
  const gate = Promise.withResolvers<void>();
  const commands: string[][] = [];
  Bun.spawn = ((command: string[], options: Parameters<typeof Bun.spawn>[1]) => {
    const child = realSpawn(command, options);
    if (command[0] !== "git") return child;
    commands.push(command);
    if (!holdStatus || !command.includes("status")) return child;
    return { pid: child.pid, stdout: child.stdout, stderr: child.stderr, kill: child.kill.bind(child), exited: gate.promise.then(() => child.exited) };
  }) as typeof Bun.spawn;
  const restore = () => { Bun.spawn = realSpawn; };
  cleanups.push(restore);
  return { commands, release: () => gate.resolve(), restore };
}

async function view(c: TuiController, root: string, width = 100, height = 28) {
  const terminal = await createTestRenderer({ width, height, kittyKeyboard: true, exitOnCtrlC: false });
  const ui = createConversationView(terminal.renderer, { controller: c, workspaceRoot: root, home: "/home/test", env: {}, secrets: [], motion: "off", quit: () => {},
    submit: (value, accepted) => dispatchEditorInput(value, c, command => command.name === "changes" ? c.changesCommand(command.args) : Promise.resolve(false), accepted) });
  cleanups.push(() => { ui.destroy(); terminal.renderer.destroy(); });
  const settle = async () => { ui.refresh(); await terminal.flush(); };
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!predicate() && Date.now() < deadline) { await Bun.sleep(5); await settle(); }
    expect(predicate(), "Expected review state before deadline").toBe(true);
    await settle();
  };
  const press = async (bytes: string) => { terminal.renderer.stdin.emit("data", Buffer.from(bytes)); await Bun.sleep(1); await settle(); };
  await settle();
  return { ...terminal, settle, waitFor, f2: () => press("\x1bOQ"), editor: terminal.renderer.root.findDescendantById("prompt") as TextareaRenderable,
    transcript: terminal.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable };
}
const idle = (c: TuiController) => () => c.snapshot().changeReview?.loading === false;
const states = (c: TuiController) => Object.fromEntries(c.snapshot().changeReview!.files.map(file => [file.path, "state" in file ? file.state : file.source]));
async function selectPath(c: TuiController, path: string) {
  const review = c.snapshot().changeReview!;
  const index = review.files.findIndex(file => file.path === path);
  expect(index).toBeGreaterThanOrEqual(0);
  await c.selectReviewFile(index - review.selected);
  return c.snapshot().changeReview!;
}
/** Workspace bytes, Git index and refs that review must never change. */
async function fingerprint(root: string) {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if (path.includes(`${join(root, ".git")}/objects`) || path.includes(`${join(root, ".git")}/logs`)) continue;
    files[path] = (await readFile(path)).toString("base64");
  }
  return files;
}

test("after process restart Alt+R and /changes review open current changes without a model call or new turn", async () => {
  const dir = await temp();
  const home = join(dir, "home"), root = join(dir, "project");
  await repo(root);
  const id = await savedEditSession(home, root, [
    { toolCalls: [{ id: "edit", name: "edit", arguments: { path: "tracked.txt", edits: [{ oldText: "line two", newText: "line TWO" }] } }] },
    { toolCalls: [{ id: "write", name: "write", arguments: { path: "notes.md", content: "Saved note\n" } }] },
    { text: "Changed both files." },
  ]);
  const { c, loaded, calls, file } = await resume(home, id);
  const items = loaded.items.length, sessionBytes = await readFile(file, "utf8"), workspaceBytes = await fingerprint(root);
  expect(c.snapshot().outcome).toBeUndefined();

  const ui = await view(c, root);
  ui.mockInput.pressKey("r", { meta: true });
  await ui.waitFor(idle(c));
  let review = c.snapshot().changeReview!;
  expect(review.heading).toBe("Review · current changes");
  expect(review.scope).toEqual({ kind: "workspace" });
  expect(states(c)).toEqual({ "notes.md": "untracked", "tracked.txt": "unstaged" });
  expect(review.currentPath).toBe("notes.md");
  let frame = ui.captureCharFrame();
  expect(frame).toContain("Review · current changes");
  expect(frame).toContain("Current working tree");
  expect(frame).toContain("Current diff · notes.md");
  expect(frame).toContain("untracked");
  expect(frame).not.toContain("turn 1");
  expect(frame).not.toContain("No turn to review yet");
  expect(frame).toContain("F2 details");

  review = await selectPath(c, "tracked.txt");
  expect(review.detail).toContain("2 - line two");
  expect(review.detail).toContain("2 + line TWO");

  // Details explain the missing turn record and never rebuild historical evidence.
  await ui.f2();
  review = c.snapshot().changeReview!;
  expect(review.showingDetails).toBe(true);
  expect(review.details).toStartWith("Previous turn details unavailable");
  expect(review.details).toContain(`Workspace: ${root}`);
  expect(review.details).toContain("Branch: main");
  expect(review.details).toContain("never the exact patch of a resumed turn");
  for (const historical of [/\+\d+ −\d+/, /exit \d/i, /exit-zero/i, /\b\d+ commands?\b/, /\b\d+(\.\d+)?m?s\b/, /\b[0-9a-f]{7,}\b/, /Files from turn/, /Turn \d/]) expect(review.details).not.toMatch(historical);
  frame = ui.captureCharFrame();
  expect(frame).toContain("Current changes details");
  expect(frame).toContain("Previous turn details unavailable");
  await ui.f2();
  expect(c.snapshot().changeReview!.showingDetails).toBe(false);
  ui.mockInput.pressEscape(); await ui.settle();
  expect(c.snapshot().changeReview).toBeUndefined();

  expect(await dispatchEditorInput("/changes review", c, command => command.name === "changes" ? c.changesCommand(command.args) : Promise.resolve(false))).toBe(true);
  expect(c.snapshot().changeReview!.heading).toBe("Review · current changes");
  expect(c.snapshot().changeReview!.files.map(entry => entry.path)).toEqual(["notes.md", "tracked.txt"]);

  expect(calls()).toBe(0);
  expect(loaded.items).toHaveLength(items);
  expect(loaded.items.filter(item => item.type === "user")).toHaveLength(1);
  expect(await readFile(file, "utf8")).toBe(sessionBytes);
  expect(await fingerprint(root)).toEqual(workspaceBytes);
});

test("a fresh session without a turn lists staged, unstaged, partly staged, deleted, renamed and untracked paths", async () => {
  const dir = await temp(), root = join(dir, "project");
  await repo(root, { "staged.txt": "one\n", "unstaged.txt": "one\n", "mixed.txt": "one\n", "gone.txt": "one\n", "old-name.txt": "same content\n" });
  await writeFile(join(root, "staged.txt"), "two\n"); await git(root, "add", "staged.txt");
  await writeFile(join(root, "unstaged.txt"), "two\n");
  await writeFile(join(root, "mixed.txt"), "two\n"); await git(root, "add", "mixed.txt"); await writeFile(join(root, "mixed.txt"), "three\n");
  await rm(join(root, "gone.txt"));
  await git(root, "mv", "old-name.txt", "new-name.txt");
  await writeFile(join(root, "ไฟล์ใหม่ 🧪.txt"), "new\n");
  const before = await fingerprint(root);
  const c = controller(createSession(), workspaceOf(root), "fresh");
  expect(await c.openChangeReview()).toBe(true);
  expect(c.snapshot().changeReview!.heading).toBe("Review · current changes");
  expect(states(c)).toEqual({ "gone.txt": "deleted", "mixed.txt": "partly staged", "new-name.txt": "renamed", "staged.txt": "staged", "unstaged.txt": "unstaged", "ไฟล์ใหม่ 🧪.txt": "untracked" });
  const mixed = await selectPath(c, "mixed.txt");
  expect(mixed.rows.filter(row => row.comparison).map(row => row.text)).toEqual(["Unstaged · index → worktree", "Staged · HEAD → index"]);
  expect((await selectPath(c, "ไฟล์ใหม่ 🧪.txt")).rows.some(row => row.comparison && row.text === "Untracked · current file")).toBe(true);
  expect(await fingerprint(root)).toEqual(before);
});

test("opening loads only the selected file's diff and Ctrl+R keeps the selected path", async () => {
  const dir = await temp(), root = join(dir, "project");
  await repo(root, { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
  for (const name of ["a", "b", "c"]) await writeFile(join(root, `${name}.txt`), `${name} changed\n`);
  const c = controller(createSession(), workspaceOf(root), "on-demand");
  const spy = spyGit();
  await c.openChangeReview();
  const diffed = (path: string) => spy.commands.filter(command => command.includes("diff") && command.at(-1) === path).length;
  expect(diffed("a.txt")).toBeGreaterThan(0);
  expect(diffed("b.txt") + diffed("c.txt")).toBe(0);
  await selectPath(c, "c.txt");
  expect(diffed("c.txt")).toBeGreaterThan(0);
  expect(diffed("b.txt")).toBe(0);
  spy.restore();
  // An external change between reads is picked up on reload while the selection follows its path.
  await git(root, "checkout", "--", "a.txt");
  expect(await c.refreshChangeReview()).toBe(true);
  const review = c.snapshot().changeReview!;
  expect(review.files.map(file => file.path)).toEqual(["b.txt", "c.txt"]);
  expect(review.currentPath).toBe("c.txt");
  expect(review.selected).toBe(1);
});

test("a clean tree after the change was committed shows an actionable empty state", async () => {
  const dir = await temp();
  const home = join(dir, "home"), root = join(dir, "project");
  await repo(root);
  const id = await savedEditSession(home, root, [{ toolCalls: [{ id: "edit", name: "edit", arguments: { path: "tracked.txt", edits: [{ oldText: "line one", newText: "line ONE" }] } }] }, { text: "Done." }]);
  await git(root, "commit", "-qam", "commit the change");
  const { c } = await resume(home, id);
  const ui = await view(c, root, 80, 24);
  ui.mockInput.pressKey("r", { meta: true });
  await ui.waitFor(idle(c));
  const review = c.snapshot().changeReview!;
  expect(review.files).toEqual([]);
  expect(review.rows.map(row => row.text)).toEqual(["No current changes · Esc back", "The working tree matches HEAD. Earlier turns may have changed files that were since committed or reverted."]);
  const frame = ui.captureCharFrame();
  expect(frame).toContain("None listed");
  expect(frame).toContain("No current changes · Esc back");
  expect(frame).not.toContain("None observed");
  await ui.f2();
  expect(ui.captureCharFrame()).toContain("Previous turn details unavailable");
  ui.mockInput.pressEscape(); await ui.settle();
  ui.mockInput.pressEscape(); await ui.settle();
  expect(c.snapshot().changeReview).toBeUndefined();
});

test("change tracking off opens the fallback without starting Git or reading the workspace", async () => {
  const dir = await temp();
  const home = join(dir, "home"), root = join(dir, "project");
  await repo(root);
  const id = await savedEditSession(home, root, [{ toolCalls: [{ id: "edit", name: "edit", arguments: { path: "tracked.txt", edits: [{ oldText: "line one", newText: "line ONE" }] } }] }, { text: "Done." }]);
  const spy = spyGit();
  const { c } = await resume(home, id, { changeTracking: "off" });
  expect(await c.changesCommand("review")).toBe(true);
  const review = c.snapshot().changeReview!;
  expect(review.heading).toBe("Review · current changes");
  expect(review.rows.map(row => row.text)).toEqual(["Change tracking is off · /config set git {\"changeTracking\":\"on-demand\"} enable", "No Git state was read. Esc back"]);
  expect(await c.refreshChangeReview()).toBe(true);
  expect(c.toggleReviewDetails()).toBe(true);
  expect(c.snapshot().changeReview!.details).toStartWith("Previous turn details unavailable");
  expect(spy.commands).toEqual([]);
});

test("non-Git, missing, unreadable and failed workspaces each get a distinct state and next action", async () => {
  const dir = await temp();
  const plain = join(dir, "plain");
  await mkdir(plain); await writeFile(join(plain, "file.txt"), "x\n");
  const nonGit = controller(createSession(), workspaceOf(plain), "plain");
  await nonGit.openChangeReview();
  expect(nonGit.snapshot().changeReview!.rows.map(row => row.text)).toEqual(["Not a Git workspace · Esc back", "Current changes need Git. Coding and undo still work."]);

  const none = controller(createSession(), undefined as unknown as Workspace, "none", { workspace: undefined, contextManager: createContextManager(workspaceOf(plain)) });
  await none.openChangeReview();
  expect(none.snapshot().changeReview!.rows[0]!.text).toBe("No workspace active · Esc back");

  // A resumed workspace removed after resume is unavailable, and reload recovers once it returns.
  const moved = join(dir, "moved"), root = join(dir, "project");
  await repo(root); await writeFile(join(root, "tracked.txt"), "dirty\n");
  const missing = controller(createSession(), workspaceOf(root), "missing");
  await rename(root, moved);
  await missing.openChangeReview();
  expect(missing.snapshot().changeReview!.rows.map(row => row.text)).toEqual(["Workspace unavailable · Ctrl+R reload", `Restore ${root}, then reload.`]);
  await rename(moved, root);
  await missing.refreshChangeReview();
  expect(missing.snapshot().changeReview!.files.map(file => file.path)).toEqual(["tracked.txt"]);

  // A corrupt index makes Git status fail after the repository is found.
  await writeFile(join(root, ".git", "index"), "not an index");
  const failed = controller(createSession(), workspaceOf(root), "failed");
  await failed.openChangeReview();
  const rows = failed.snapshot().changeReview!.rows.map(row => row.text);
  expect(rows[0]).toBe("Current changes unavailable · Ctrl+R reload");
  expect(rows[1]).toStartWith("Git status failed:");
  expect(failed.snapshot().changeReview!.files).toEqual([]);
});

test("resume reads the resumed workspace, not the launch checkout", async () => {
  const dir = await temp();
  const home = join(dir, "home"), launch = join(dir, "launch"), saved = join(dir, "saved");
  await repo(launch, { "launch-only.txt": "launch\n" }); await writeFile(join(launch, "launch-only.txt"), "launch dirty\n");
  await repo(saved, { "saved-only.txt": "saved\n" });
  const id = await savedEditSession(home, saved, [{ toolCalls: [{ id: "edit", name: "edit", arguments: { path: "saved-only.txt", edits: [{ oldText: "saved", newText: "saved dirty" }] } }] }, { text: "Done." }]);
  const counted = countingModel();
  const c = controller(createSession(), workspaceOf(launch), "launch", { model: counted.model });
  const ctx = { controller: c, home, workspaceRoot: launch, skillScope: { workspaceRoot: launch }, sessionsDir: sessionsDirectory(home),
    settings: () => new ConfigEditor({}, { user: join(home, "config.json"), project: join(launch, "config.json") }).settings, env: {}, secrets: [], finishQuit() {}, stderr: { write() {} } };
  await c.openChangeReview();
  expect(c.snapshot().changeReview!.files.map(file => file.path)).toEqual(["launch-only.txt"]);
  c.closeChangeReview();
  expect(await handleSlashCommand("resume", id, ctx)).toBe(true);
  expect(await handleSlashCommand("changes", "review", ctx)).toBe(true);
  const review = c.snapshot().changeReview!;
  expect(review.heading).toBe("Review · current changes");
  expect(review.files.map(file => file.path)).toEqual(["saved-only.txt"]);
  expect(review.details).toContain(`Workspace: ${saved}`);
  expect(review.details).not.toContain(launch);
  expect(counted.calls()).toBe(0);
});

test("interrupted saved history opens current changes without rerunning tools or rewriting the session", async () => {
  const dir = await temp();
  const home = join(dir, "home"), root = join(dir, "project");
  await repo(root);
  const session = await createJsonlSession({ directory: sessionsDirectory(home), workspace: workspaceOf(root) });
  session.append({ type: "user", id: "u1", content: [{ type: "text", text: "write it" }] });
  session.append({ type: "assistant", id: "a1", content: [{ type: "tool_call", id: "call-write", name: "write", arguments: { path: "never.txt", content: "never\n" } }] });
  await writeFile(join(root, "tracked.txt"), "changed before the interruption\n");
  // Loading settles the unresolved call once; review must not add anything after that.
  const first = await resume(home, session.header.id);
  first.c.dispose();
  const { c, loaded, calls, file } = await resume(home, session.header.id);
  const bytes = await readFile(file, "utf8"), items = loaded.items.length;
  await c.openChangeReview();
  expect(c.snapshot().changeReview!.files.map(entry => entry.path)).toEqual(["tracked.txt"]);
  expect(await Bun.file(join(root, "never.txt")).exists()).toBe(false);
  expect(await readFile(file, "utf8")).toBe(bytes);
  expect(loaded.items).toHaveLength(items);
  expect(calls()).toBe(0);
});

test("a retained live turn keeps its observed file list instead of the workspace fallback", async () => {
  const dir = await temp(), root = join(dir, "project");
  await repo(root, { "tracked.txt": "one\n", "other.txt": "other\n" });
  await writeFile(join(root, "other.txt"), "pre-existing dirt\n");
  const c = controller(createSession(), workspaceOf(root), "live", { model: createScriptedModel({ responses: [{ toolCalls: [{ id: "edit", name: "edit", arguments: { path: "tracked.txt", edits: [{ oldText: "one", newText: "ONE" }] } }] }, { text: "Done." }] }) });
  await c.submit("edit");
  await c.openChangeReview();
  const review = c.snapshot().changeReview!;
  expect(review.scope).toEqual({ kind: "turn", turn: 1 });
  expect(review.files.map(file => file.path)).toEqual(["tracked.txt"]);
});

test("pending workspace reads are discarded after close, resume, branch switch and dispose", async () => {
  const dir = await temp();
  const first = join(dir, "first"), second = join(dir, "second");
  await repo(first, { "first.txt": "a\n" }); await writeFile(join(first, "first.txt"), "first dirty\n");
  await repo(second, { "second.txt": "b\n" }); await writeFile(join(second, "second.txt"), "second dirty\n");
  for (const boundary of ["close", "resume", "branch", "dispose"] as const) {
    const session = createSession();
    session.append({ type: "user", id: "u1", content: [{ type: "text", text: "earlier" }] }, { type: "assistant", id: "a1", content: [{ type: "text", text: "done" }] });
    const c = controller(session, workspaceOf(first), `stale-${boundary}`);
    const spy = spyGit(true);
    const pending = c.openChangeReview();
    while (!spy.commands.some(command => command.includes("status"))) await Bun.sleep(1);
    expect(c.snapshot().changeReview!.rows[0]!.text).toBe("Loading current changes…");
    if (boundary === "close") c.closeChangeReview();
    if (boundary === "resume") c.replaceSession(createSession(), "other-session", { workspace: workspaceOf(second), contextManager: createContextManager(workspaceOf(second)) });
    if (boundary === "branch") expect(c.branchCommand(`fork ${session.rootId}`)).toBe(true);
    if (boundary === "dispose") c.dispose();
    spy.release();
    expect(await pending).toBe(false);
    spy.restore();
    expect(c.snapshot().changeReview).toBeUndefined();
    if (boundary === "resume") {
      await c.openChangeReview();
      expect(c.snapshot().changeReview!.files.map(file => file.path)).toEqual(["second.txt"]);
    }
  }
});

test("a pending reload never presents the earlier list as live and its result is fenced to the same review", async () => {
  const dir = await temp(), root = join(dir, "project");
  await repo(root, { "a.txt": "a\n" }); await writeFile(join(root, "a.txt"), "dirty\n");
  const c = controller(createSession(), workspaceOf(root), "reload");
  await c.openChangeReview();
  const spy = spyGit(true);
  const reloading = c.refreshChangeReview();
  while (!spy.commands.some(command => command.includes("status"))) await Bun.sleep(1);
  const loading = c.snapshot().changeReview!;
  expect(loading.loading).toBe(true);
  expect(loading.rows.map(row => row.text)).toEqual(["Loading current changes…"]);
  await c.selectReviewFile(1);
  c.closeChangeReview();
  spy.release();
  expect(await reloading).toBe(false);
  expect(c.snapshot().changeReview).toBeUndefined();
});

test("Alt+R and Esc keep the Thai draft, cursor, selection and transcript position", async () => {
  const dir = await temp();
  const home = join(dir, "home"), root = join(dir, "project");
  await repo(root);
  const id = await savedEditSession(home, root, [{ toolCalls: [{ id: "edit", name: "edit", arguments: { path: "tracked.txt", edits: [{ oldText: "line one", newText: "line ONE" }] } }] }, { text: "Done." }]);
  const { c, loaded } = await resume(home, id);
  for (let i = 0; i < 30; i++) c.notice(`Earlier note ${i}`);
  const ui = await view(c, root, 80, 20);
  ui.editor.setText("ร่างไทย 🧪 ยังไม่ส่ง"); ui.editor.cursorOffset = 6; ui.editor.setSelection(2, 6);
  ui.transcript.scrollTo(3); await ui.settle();
  const draft = { text: ui.editor.plainText, cursor: ui.editor.cursorOffset, selection: ui.editor.getSelectedText(), scroll: ui.transcript.scrollTop };
  ui.mockInput.pressKey("r", { meta: true });
  await ui.waitFor(idle(c));
  expect(c.snapshot().changeReview!.files.map(file => file.path)).toEqual(["tracked.txt"]);
  await ui.f2();
  await ui.f2();
  ui.mockInput.pressEscape(); await ui.settle();
  expect(c.snapshot().changeReview).toBeUndefined();
  expect({ text: ui.editor.plainText, cursor: ui.editor.cursorOffset, selection: ui.editor.getSelectedText(), scroll: ui.transcript.scrollTop }).toEqual(draft);
  expect(loaded.items.filter(item => item.type === "user")).toHaveLength(1);
});

const fixtureRoot = join(import.meta.dir, "fixtures/sessions");
for (const version of (await readdir(fixtureRoot)).sort()) test(`published ${version} session opens current changes without rewriting bytes`, async () => {
  const dir = await temp();
  const home = join(dir, "home"), root = join(dir, "project");
  await repo(root); await writeFile(join(root, "tracked.txt"), "dirty\n");
  const expected = JSON.parse(await readFile(join(fixtureRoot, version, "expect.json"), "utf8")) as { sessionId: string };
  const directory = sessionsDirectory(home);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${expected.sessionId}.jsonl`);
  await writeFile(path, (await readFile(join(fixtureRoot, version, `${expected.sessionId}.jsonl`), "utf8")).replaceAll("__SCHWAY_FIXTURE_WORKSPACE__", JSON.stringify(root).slice(1, -1)));
  const loaded: JsonlSession = await loadJsonlSession({ directory, id: expected.sessionId });
  const bytes = await readFile(path, "utf8");
  const counted = countingModel();
  const c = controller(loaded, workspaceOf(root), expected.sessionId, { model: counted.model });
  await c.openChangeReview();
  expect(c.snapshot().changeReview!.scope).toEqual({ kind: "workspace" });
  expect(c.snapshot().changeReview!.files.map(file => file.path)).toEqual(["tracked.txt"]);
  expect(c.toggleReviewDetails()).toBe(true);
  expect(await readFile(path, "utf8")).toBe(bytes);
  expect(counted.calls()).toBe(0);
});
