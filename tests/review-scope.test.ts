import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { ScrollBoxRenderable, TextareaRenderable, type TextRenderable } from "@opentui/core";
import { join } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConversationView } from "../src/tui/view.ts";
import { TuiController, type TuiControllerOptions } from "../src/tui/controller.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { bashTool } from "../src/tools/bash.ts";
import { editTool } from "../src/tools/edit.ts";
import { writeTool } from "../src/tools/write.ts";
import { currentDiffLabel, emptyFilesLabel, fitPathStart, gitFileState, reviewDetailsLabel, reviewFileBadge, reviewFilesLabel, reviewScopeDetails, turnFileBadge, workspaceReviewDetails } from "../src/tui/review-scope.ts";
import { withTempDir } from "./helpers.ts";
import { createScriptedModel, type ScriptedTurn } from "./helpers/scripted-model.ts";

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
async function git(dir: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe", env });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(err);
  return out.trim();
}
async function repo(dir: string, files: Record<string, string> = { "two.txt": "line one\nline two\n" }) {
  await git(dir, "init", "-q");
  for (const [path, content] of Object.entries(files)) await writeFile(join(dir, path), content);
  await git(dir, "add", ".");
  await git(dir, "commit", "-qm", "baseline");
}
const edit = (id: string, path: string, oldText: string, newText: string) => ({ toolCalls: [{ id, name: "edit", arguments: { path, edits: [{ oldText, newText }] } }] });
const write = (id: string, path: string, content: string) => ({ toolCalls: [{ id, name: "write", arguments: { path, content } }] });
const shell = (id: string, command: string) => ({ toolCalls: [{ id, name: "bash", arguments: { command } }] });

function controller(dir: string, responses: ScriptedTurn[], overrides: Partial<TuiControllerOptions> = {}) {
  const workspace = overrides.workspace ?? { root: dir, launchCwd: dir, extraRoots: [] };
  return new TuiController({ session: createSession(), workspace, sessionId: "review-scope", provider: "scripted", modelId: "scripted",
    model: createScriptedModel({ responses }), contextManager: createContextManager(workspace), tools: createToolRegistry([writeTool, editTool, bashTool]),
    changeTracking: "on-demand", ...overrides });
}
async function select(c: TuiController, path: string) {
  const review = c.snapshot().changeReview!;
  const index = review.files.findIndex(file => file.path === path);
  expect(index).toBeGreaterThanOrEqual(0);
  await c.selectReviewFile(index - review.selected);
  return c.snapshot().changeReview!;
}
const headings = (rows: { comparison?: string; text: string }[]) => rows.filter(row => row.comparison).map(row => row.text);

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
async function view(c: TuiController, root: string, width = 100, height = 28, kittyKeyboard = false) {
  const terminal = await createTestRenderer({ width, height, kittyKeyboard, exitOnCtrlC: false });
  const ui = createConversationView(terminal.renderer, { controller: c, workspaceRoot: root, home: "/home/test", env: {}, secrets: [], motion: "off", submit: async () => {}, quit: () => {} });
  cleanups.push(() => { ui.destroy(); c.dispose(); terminal.renderer.destroy(); });
  const settle = async () => { ui.refresh(); await terminal.flush(); };
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!predicate() && Date.now() < deadline) { await Bun.sleep(5); await settle(); }
    expect(predicate(), "Expected review state before deadline").toBe(true);
    await settle();
  };
  const input = async (bytes: string) => { terminal.renderer.stdin.emit("data", Buffer.from(bytes)); await Bun.sleep(1); await settle(); };
  await settle();
  return { ...terminal, settle, waitFor, input, editor: terminal.renderer.root.findDescendantById("prompt") as TextareaRenderable };
}
const idle = (c: TuiController) => () => !!c.snapshot().changeReview && !c.snapshot().changeReview!.loading;

/** Hold Git diff reads for one literal path until released, leaving every other command untouched. */
function gateDiffs(path: string) {
  const realSpawn = Bun.spawn;
  const gate = Promise.withResolvers<void>();
  let held = 0;
  Bun.spawn = ((command: string[], options: Parameters<typeof Bun.spawn>[1]) => {
    const child = realSpawn(command, options);
    if (command[0] !== "git" || !command.includes("diff") || !command.includes(path)) return child;
    held++;
    return { pid: child.pid, stdout: child.stdout, stderr: child.stderr, kill: child.kill.bind(child), exited: gate.promise.then(() => child.exited) };
  }) as typeof Bun.spawn;
  return { release: () => gate.resolve(), held: () => held, restore: () => { Bun.spawn = realSpawn; } };
}

test("scope helpers keep turn counts with turn evidence and never invent unknown counts", () => {
  expect(reviewFilesLabel({ kind: "turn", turn: 2 })).toBe("Files from turn 2");
  expect(currentDiffLabel()).toBe("Current diff");
  expect(reviewDetailsLabel({ kind: "turn", turn: 2 })).toBe("Turn 2 details");
  expect(currentDiffLabel("ชื่อ 😀.txt")).toBe("Current diff · ชื่อ 😀.txt");
  expect(turnFileBadge({ path: "a", source: "tool", added: 3, removed: 1 })).toBe("+3 −1");
  expect(turnFileBadge({ path: "a", source: "tool", added: 2 })).toBe("+2 −?");
  expect(turnFileBadge({ path: "a", source: "tool" })).toBe("");
  expect(turnFileBadge({ path: "a", source: "shell" })).toBe("detected");
  const details = reviewScopeDetails({ kind: "turn", turn: 4 });
  expect(details).toContain("Files from turn 4: paths observed during that turn");
  expect(details).toContain("not a record of exclusive authorship");
  expect(details).toContain("repeated edits can exceed the net current diff");
  expect(details).toContain("does not identify which command or process changed them");
  expect(details).toContain("does not update live");
});

test("workspace scope labels name the current working tree and its details never claim turn evidence", () => {
  const scope = { kind: "workspace" } as const;
  expect(reviewFilesLabel(scope)).toBe("Current working tree");
  expect(reviewDetailsLabel(scope)).toBe("Current changes details");
  expect(emptyFilesLabel(scope)).toBe("None listed");
  expect(emptyFilesLabel({ kind: "turn", turn: 1 })).toBe("None observed");
  expect(reviewFileBadge({ path: "a", source: "git", state: "staged" })).toBe("staged");
  expect(reviewFileBadge({ path: "a", source: "shell" })).toBe("detected");
  const change = (staged: string, unstaged: string, untracked = false) => gitFileState({ path: "a", staged, unstaged, untracked, binary: false });
  expect([change("?", "?", true), change("M", "."), change(".", "M"), change("M", "M"), change("D", "."), change(".", "D"), change("R", "."), change("U", "U"), change("A", "A")])
    .toEqual(["untracked", "staged", "unstaged", "partly staged", "deleted", "deleted", "renamed", "conflict", "conflict"]);
  const details = workspaceReviewDetails({ root: "/work/ไทย", branch: "feature/ไทย", shown: 50, total: 51 });
  expect(details.split("\n")[0]).toBe("Previous turn details unavailable");
  expect(details).toContain("Workspace: /work/ไทย");
  expect(details).toContain("Branch: feature/ไทย");
  expect(details).toContain("Showing the first 50 of 51 changed paths.");
  expect(details).toContain("never the exact patch of a resumed turn");
  expect(details).not.toContain("Files from turn");
  expect(workspaceReviewDetails({ root: "/w", detached: true })).toContain("Branch: detached HEAD");
  expect(reviewScopeDetails(scope)).not.toContain("detected");
});

test("left-truncated paths keep distinct Thai and emoji file names within their cell budget", () => {
  const dir = "src/" + "ส่วนประกอบ-ยาวมาก/".repeat(3);
  const a = fitPathStart(`${dir}ไฟล์-ก-😀.ts`, 16), b = fitPathStart(`${dir}ไฟล์-ข-😀.ts`, 16);
  expect(a).toStartWith("…");
  expect(a).toEndWith("ไฟล์-ก-😀.ts");
  expect(b).toEndWith("ไฟล์-ข-😀.ts");
  expect(a).not.toBe(b);
  for (const value of [a, b]) expect(Bun.stringWidth(value)).toBeLessThanOrEqual(16);
  expect(fitPathStart("short.ts", 16)).toBe("short.ts");
  expect(fitPathStart("anything", 0)).toBe("");
});

test("empty turn evidence and a read-only turn in a dirty repository show distinct empty states", async () => {
  await withTempDir(async dir => {
    await repo(dir);
    await writeFile(join(dir, "two.txt"), "pre-existing dirt\n");
    const c = controller(dir, [{ text: "read-only answer" }]);
    await c.submit("explain");
    const ui = await view(c, dir);
    ui.mockInput.pressKey("r", { meta: true });
    await ui.waitFor(idle(c));
    expect(c.snapshot().changeReview!.files).toEqual([]);
    expect(c.snapshot().changeReview!.detail).toBe("No file changes observed · /changes status");
    const frame = ui.captureCharFrame();
    expect(frame).toContain("Files from turn 1");
    expect(frame).toContain("None observed");
    expect(frame).toContain("No file changes observed · /changes status");
    expect(frame).not.toContain("two.txt");
    expect(frame).not.toContain("› None observed");
  });
});

test("two turns and a later external edit show turn evidence beside the cumulative current diff", async () => {
  await withTempDir(async dir => {
    await repo(dir);
    const c = controller(dir, [edit("first", "two.txt", "line one", "line ONE"), { text: "first" }, edit("second", "two.txt", "line two", "line TWO"), { text: "second" }]);
    await c.submit("edit line one");
    await c.submit("edit line two");
    // An edit outside Schway after the turn settles is current content, not turn evidence.
    await writeFile(join(dir, "two.txt"), "line ONE\nline TWO\nexternal line\n");
    await writeFile(join(dir, "elsewhere.txt"), "external file\n");
    const ui = await view(c, dir);
    ui.mockInput.pressKey("r", { meta: true });
    await ui.waitFor(idle(c));
    const review = c.snapshot().changeReview!;
    expect(review.scope).toEqual({ kind: "turn", turn: 2 });
    expect(review.files).toEqual([{ path: "two.txt", source: "tool", added: 1, removed: 1 }]);
    expect(review.currentPath).toBe("two.txt");
    expect(headings(review.rows)).toEqual(["Unstaged · index → worktree"]);
    for (const row of ["1 - line one", "1 + line ONE", "2 - line two", "2 + line TWO", "3 + external line"]) expect(review.detail).toContain(row);
    const frame = ui.captureCharFrame();
    expect(frame).toContain("Files from turn 2");
    expect(frame).toContain("Current diff · two.txt");
    expect(frame).toContain("Unstaged · index → worktree");
    expect(frame).not.toContain("elsewhere.txt");
    // The count sits on the turn file row, left of the divider, not on the current-diff title.
    const countRow = frame.split("\n").find(line => line.includes("+1 −1"))!;
    expect(countRow).toContain("› two.txt");
    expect(countRow.indexOf("+1 −1")).toBeLessThan(countRow.indexOf("│"));
    expect(frame.split("\n").find(line => line.includes("Current diff"))).not.toContain("+1 −1");
    const files = ui.renderer.root.findDescendantById("change-review-files")!;
    const diff = ui.renderer.root.findDescendantById("change-review-diff")!;
    expect(files.y).toBe(diff.y);
    const heading = (ui.renderer.root.findDescendantById("change-review-text") as TextRenderable).chunks.find(chunk => chunk.text.includes("Unstaged"));
    expect(heading?.attributes).toBeTruthy();
    expect(frame).not.toContain("unattributed");
    expect(frame).not.toContain("diff --git");
  });
});

test("staged, unstaged, untracked, binary and pre-existing dirt keep their own scope", async () => {
  await withTempDir(async dir => {
    await repo(dir, { "code.ts": "one\ntwo\n", "dirty.txt": "committed\n" });
    await writeFile(join(dir, "dirty.txt"), "pre-existing dirt\n");
    const c = controller(dir, [
      edit("code", "code.ts", "one", "ONE"),
      write("new", "notes ไทย 😀.md", "fresh note\n"),
      shell("binary", "printf '\\000\\001' > blob.bin"),
      { text: "done" },
    ]);
    await c.submit("change files");
    await git(dir, "add", "code.ts");
    await writeFile(join(dir, "code.ts"), "ONE\ntwo\nlater unstaged\n");
    await c.openChangeReview();
    let review = c.snapshot().changeReview!;
    expect(review.files.map(file => file.path).sort()).toEqual(["blob.bin", "code.ts", "notes ไทย 😀.md"]);
    review = await select(c, "code.ts");
    expect(headings(review.rows)).toEqual(["Unstaged · index → worktree", "Staged · HEAD → index"]);
    const [unstaged, staged] = review.detail.split("Staged · HEAD → index");
    expect(unstaged).toContain("3 + later unstaged");
    expect(unstaged).not.toContain("1 - one");
    expect(staged).toContain("1 - one");
    expect(staged).toContain("1 + ONE");
    review = await select(c, "notes ไทย 😀.md");
    expect(headings(review.rows)).toEqual(["Untracked · current file"]);
    expect(review.detail).toContain("1 + fresh note");
    review = await select(c, "blob.bin");
    expect(review.rows[0]!.text).toBe("Found by Git snapshot · not undoable");
    expect(headings(review.rows)).toEqual(["Untracked · current file"]);
    expect(review.detail).toContain("Binary file · content not shown");
    expect(review.files.find(file => file.path === "blob.bin")!.source).toBe("shell");
    c.dispose();
  });
});

test("unborn repositories name the empty-tree staged comparison", async () => {
  await withTempDir(async dir => {
    await git(dir, "init", "-q");
    const c = controller(dir, [write("first", "first.txt", "first\n"), { text: "done" }]);
    await c.submit("create");
    await git(dir, "add", "first.txt");
    await writeFile(join(dir, "first.txt"), "first\nsecond\n");
    await c.openChangeReview();
    expect(headings(c.snapshot().changeReview!.rows)).toEqual(["Unstaged · index → worktree", "Staged · empty tree → index"]);
    c.dispose();
  });
});

test("repeated edits keep accumulated turn counts while the current diff shows the net change", async () => {
  await withTempDir(async dir => {
    await repo(dir);
    const c = controller(dir, [edit("a", "two.txt", "line one", "draft"), edit("b", "two.txt", "draft", "line one"), edit("c", "two.txt", "line two", "final"),
      write("overwrite", "two-copy.txt", "copy\n"), { text: "done" }]);
    await writeFile(join(dir, "two-copy.txt"), "existing\n");
    await git(dir, "add", "two-copy.txt"); await git(dir, "commit", "-qm", "copy");
    await c.submit("edit repeatedly");
    await c.openChangeReview();
    const review = c.snapshot().changeReview!;
    expect(review.files.find(file => file.path === "two.txt")).toEqual({ path: "two.txt", source: "tool", added: 3, removed: 3 });
    expect(review.detail).toContain("2 - line two");
    expect(review.detail).toContain("2 + final");
    expect(review.detail).not.toContain("draft");
    expect(review.detail).not.toContain("1 - line one");
    const copy = review.files.find(file => file.path === "two-copy.txt")!;
    expect(reviewFileBadge(copy)).toBe("");
    const ui = await view(c, dir);
    await ui.settle();
    const copyRow = ui.captureCharFrame().split("\n").find(line => line.includes("two-copy.txt"))!;
    expect(copyRow).not.toMatch(/\+\d/);
    expect(c.snapshot().changeReview!.details).toContain("repeated edits can exceed the net current diff");
  });
});

test("historical files that are now clean, missing, renamed, ignored or outside Git keep the turn record with a truthful state", async () => {
  await withTempDir(async base => {
    const dir = join(base, "repo"), outside = join(base, "attached");
    await mkdir(dir); await mkdir(outside);
    await repo(dir, { "two.txt": "line one\nline two\n", "move.txt": "move me\n" });
    const workspace = { root: dir, launchCwd: dir, extraRoots: [outside] };
    const c = controller(dir, [
      edit("clean", "two.txt", "line one", "line ONE"), write("gone", "gone.txt", "temporary\n"), write("ignored", "ignored.log", "log\n"),
      edit("move", "move.txt", "move me", "moved"), write("outside", join(outside, "attached.txt"), "outside\n"), { text: "done" },
    ], { workspace });
    await c.submit("touch files");
    await git(dir, "commit", "-qam", "accept two.txt and move.txt");
    await rm(join(dir, "gone.txt"));
    await writeFile(join(dir, ".gitignore"), "ignored.log\n");
    await git(dir, "mv", "move.txt", "renamed.txt");
    await c.openChangeReview();
    const recorded = c.snapshot().changeReview!.files.map(file => file.path);
    expect(recorded).toContain("gone.txt");
    expect(recorded).toContain("move.txt");
    expect(recorded).not.toContain("renamed.txt");
    expect(recorded).not.toContain(".gitignore");
    expect((await select(c, "two.txt")).detail).toBe("No current changes · file matches HEAD");
    expect((await select(c, "gone.txt")).detail).toBe("File not found · nothing to compare");
    expect((await select(c, "ignored.log")).detail).toBe("Ignored by Git · content not shown");
    expect((await select(c, "move.txt")).detail).toContain("Renamed from move.txt to renamed.txt");
    const attached = c.snapshot().changeReview!.files.find(file => file.path.endsWith("attached.txt"))!;
    expect((await select(c, attached.path)).detail).toBe("Outside the Git repository · no diff");
    c.dispose();
  });
});

test("tracking off and non-Git workspaces keep the turn list without reading current Git state", async () => {
  await withTempDir(async dir => {
    const realSpawn = Bun.spawn;
    let gitCalls = 0;
    Bun.spawn = ((command: string[], options: Parameters<typeof Bun.spawn>[1]) => { if (command[0] === "git") gitCalls++; return realSpawn(command, options); }) as typeof Bun.spawn;
    try {
      await repo(dir);
      const off = controller(dir, [write("w", "made.txt", "made\n"), { text: "done" }], { changeTracking: "off" });
      await off.submit("write");
      gitCalls = 0;
      await off.openChangeReview();
      expect(gitCalls).toBe(0);
      expect(off.snapshot().changeReview!.files).toEqual([{ path: "made.txt", source: "tool", added: 1, removed: 0 }]);
      expect(off.snapshot().changeReview!.detail).toBe("Change tracking off. No Git state read.");
      expect(await off.refreshChangeReview()).toBe(true);
      expect(gitCalls).toBe(0);
      off.dispose();
    } finally { Bun.spawn = realSpawn; }
    await rm(join(dir, ".git"), { recursive: true });
    const plain = controller(dir, [write("w", "plain.txt", "plain\n"), { text: "done" }]);
    await plain.submit("write");
    await plain.openChangeReview();
    expect(plain.snapshot().changeReview!.files.map(file => file.path)).toEqual(["plain.txt"]);
    expect(plain.snapshot().changeReview!.detail).toContain("Non-Git workspace");
    plain.dispose();
  });
});

test("a late diff for one file never appears under another, a closed review or a replaced session", async () => {
  await withTempDir(async dir => {
    await repo(dir, { "a.txt": "a\n", "b.txt": "b\n" });
    const c = controller(dir, [write("a", "a.txt", "a evidence\n"), write("b", "b.txt", "b evidence\n"), { text: "done" }]);
    await c.submit("write both");
    const gate = gateDiffs("a.txt");
    try {
      const opening = c.openChangeReview();
      while (!gate.held()) await Bun.sleep(1);
      expect(c.snapshot().changeReview!.currentPath).toBe("a.txt");
      expect(c.snapshot().changeReview!.detail).toBe("Loading current diff…");
      await c.selectReviewFile(1);
      expect(c.snapshot().changeReview!.currentPath).toBe("b.txt");
      expect(c.snapshot().changeReview!.detail).toContain("b evidence");
      gate.release(); await opening;
      expect(c.snapshot().changeReview!.currentPath).toBe("b.txt");
      expect(c.snapshot().changeReview!.detail).toContain("b evidence");
      expect(c.snapshot().changeReview!.detail).not.toContain("a evidence");
    } finally { gate.restore(); }

    for (const boundary of ["close", "reopen", "session"] as const) {
      const held = gateDiffs("a.txt");
      try {
        c.closeChangeReview();
        const pending = c.openChangeReview();
        while (!held.held()) await Bun.sleep(1);
        if (boundary === "close") c.closeChangeReview();
        if (boundary === "reopen") { c.closeChangeReview(); held.restore(); await c.openChangeReview(); await c.selectReviewFile(1); }
        if (boundary === "session") c.replaceSession(createSession(), "review-scope");
        held.release(); await pending;
        const review = c.snapshot().changeReview;
        if (boundary === "reopen") { expect(review!.currentPath).toBe("b.txt"); expect(review!.detail).not.toContain("a evidence"); }
        else expect(review).toBeUndefined();
      } finally { held.restore(); }
    }
    c.dispose();
  });
});

test("Ctrl+R reloads newer current content without changing turn evidence, and Esc restores the draft", async () => {
  await withTempDir(async dir => {
    await repo(dir);
    const path = "ชื่อ/" + "very-long-directory-name/".repeat(3) + "ไฟล์ 😀.txt";
    const c = controller(dir, [write("w", path, "first\n"), edit("e", "two.txt", "line one", "line ONE"), { text: "done" }]);
    await c.submit("write");
    const ui = await view(c, dir, 50, 24, true);
    ui.editor.setText("ร่างไทย 🧪"); ui.editor.cursorOffset = 4; await ui.settle();
    const reloads: Promise<boolean>[] = [];
    const refresh = c.refreshChangeReview.bind(c);
    c.refreshChangeReview = () => { const pending = refresh(); reloads.push(pending); return pending; };
    ui.mockInput.pressKey("r", { meta: true });
    await ui.waitFor(() => idle(c)() && c.snapshot().changeReview!.detail.includes("first"));
    let frame = ui.captureCharFrame();
    expect(frame).toContain("Files from turn 1");
    expect(frame).toMatch(/Current diff · …\S*ไฟล์ 😀\.txt/);
    expect(frame).toContain("Ctrl+R reload");
    expect(frame).toContain("Esc back");
    const before = structuredClone(c.snapshot().changeReview!.files);
    await writeFile(join(dir, path), "first\nnewer external\n");
    expect(c.snapshot().changeReview!.detail).not.toContain("newer external");
    // Kitty press plus release must reload once.
    await ui.input("\x1b[114;5u\x1b[114;5:3u");
    expect(reloads).toHaveLength(1);
    await reloads[0];
    await ui.waitFor(() => idle(c)() && c.snapshot().changeReview!.detail.includes("newer external"));
    expect(c.snapshot().changeReview!.files).toEqual(before);
    expect(c.snapshot().changeReview!.currentPath).toBe(c.snapshot().changeReview!.files[0]!.path);
    frame = ui.captureCharFrame();
    expect(frame).toContain("2 + newer external");
    ui.mockInput.pressArrow("down");
    await ui.waitFor(() => idle(c)() && c.snapshot().changeReview!.currentPath === "two.txt");
    expect(ui.captureCharFrame()).toContain("Current diff · two.txt");
    await ui.input("\x1bOQ");
    expect(c.snapshot().changeReview!.showingDetails).toBe(true);
    expect(ui.captureCharFrame()).not.toContain("Ctrl+R reload");
    expect(ui.captureCharFrame()).toContain("Turn 1 details");
    expect(ui.captureCharFrame()).not.toContain("Current diff");
    await ui.input("\x12");
    expect(reloads).toHaveLength(1);
    ui.mockInput.pressEscape(); await ui.settle();
    ui.mockInput.pressEscape(); await ui.settle();
    expect(c.snapshot().changeReview).toBeUndefined();
    expect(ui.editor.plainText).toBe("ร่างไทย 🧪");
    expect(ui.editor.cursorOffset).toBe(4);
    expect(await readFile(join(dir, path), "utf8")).toBe("first\nnewer external\n");
  });
});

test("scope labels stay visible in the stacked narrow layout with long Unicode paths", async () => {
  await withTempDir(async dir => {
    await repo(dir);
    const path = "src/" + "ส่วนประกอบ-ยาวมาก/".repeat(4) + "ไฟล์-😀.ts";
    for (const [width, height] of [[40, 20], [50, 24]] as const) {
      const sibling = path.replace("ไฟล์-😀", "ไฟล์-อื่น");
      const c = controller(dir, [write("w", path, "export const value = 1;\n"), write("s", sibling, "export const other = 2;\n"), { text: "done" }]);
      await c.submit("write");
      const ui = await view(c, dir, width, height);
      ui.mockInput.pressKey("r", { meta: true });
      await ui.waitFor(idle(c));
      const frame = ui.captureCharFrame();
      expect(frame).toContain("Files from turn 1");
      expect(frame).toContain("Current diff");
      expect(frame).toContain("Untracked · current file");
      // Both titles and list rows keep the distinct file names of siblings under one long directory.
      expect(frame).toMatch(/Current diff · …\S*ไฟล์-😀\.ts/);
      expect(frame).toContain("ไฟล์-อื่น.ts");
      ui.mockInput.pressArrow("down");
      await ui.waitFor(() => idle(c)() && c.snapshot().changeReview!.currentPath === sibling);
      expect(ui.captureCharFrame()).toMatch(/Current diff · …\S*ไฟล์-อื่น\.ts/);
      expect(frame).toContain("Esc back");
      for (const line of frame.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
      const files = ui.renderer.root.findDescendantById("change-review-files")!;
      const diff = ui.renderer.root.findDescendantById("change-review-diff") as ScrollBoxRenderable;
      expect(diff.y).toBeGreaterThan(files.y);
      ui.mockInput.pressEscape(); await ui.settle();
      cleanups.pop()!();
    }
  });
});
