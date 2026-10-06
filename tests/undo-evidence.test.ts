import { expect, test } from "bun:test";
import { lstat, mkdir, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import type { TextareaRenderable } from "@opentui/core";
import { collectUndoEvidence, describeUndoLimits } from "../src/undo/evidence.ts";
import { bashTool } from "../src/tools/bash.ts";
import { editTool } from "../src/tools/edit.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { dispatchEditorInput } from "../src/tui/commands.ts";
import { createConversationView } from "../src/tui/view.ts";
import type { ScriptedTurn } from "./helpers/scripted-model.ts";
import { hashUndoBytes, openUndoStore, pruneUndoStore, type UndoFile, type UndoStore, type UndoTurn } from "../src/undo/store.ts";
import { createJsonlSession, loadJsonlSession } from "../src/session/jsonl.ts";
import type { Session } from "../src/session/session.ts";
import { createContextManager } from "../src/context/manager.ts";
import { TuiController } from "../src/tui/controller.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { withTempDir } from "./helpers.ts";

/** Read an exact file/type/mode inventory without following links or comparing access times. */
async function inventory(root: string): Promise<unknown[]> {
  const entries: unknown[] = [];
  const visit = async (path: string) => {
    const info = await lstat(path), name = relative(root, path), mode = info.mode & 0o777;
    if (info.isDirectory()) {
      entries.push({ name, mode, directory: true });
      for (const entry of (await readdir(path)).sort()) await visit(join(path, entry));
    } else entries.push({ name, mode, ...(info.isSymbolicLink() ? { link: await readlink(path) } : { bytes: (await readFile(path)).toString("hex") }) });
  };
  await visit(root);
  return entries;
}

/** Create durable session and undo storage separately from the active workspace. */
async function fixture(root: string) {
  const home = join(root, "home"), work = join(root, "work"), directory = join(home, "sessions");
  await mkdir(work);
  const workspace = { root: work, launchCwd: work, extraRoots: [] };
  const session = await createJsonlSession({ directory, workspace });
  const store = openUndoStore({ home });
  const addTurn = (id: string): UndoTurn => {
    session.append({ type: "user", id, content: [{ type: "text", text: id }] },
      { type: "assistant", id: `${id}-answer`, content: [{ type: "text", text: "Done." }] });
    return { sessionId: session.rootId, turnId: id, turnNumber: session.items.filter(item => item.type === "user").length };
  };
  const controller = (active: Session = session) => new TuiController({ session: active, sessionId: active.rootId, workspace, home,
    contextManager: createContextManager(workspace, { home }), provider: "scripted", modelId: "test", model: createScriptedModel(), changeTracking: "off" });
  return { home, work, directory, workspace, session, store, addTurn, controller };
}

/** Record a real pre-image and settled post-image, including absence and unchanged files. */
async function change(store: UndoStore, turn: UndoTurn, path: string, before: string | null, after: string | null) {
  if (before === null) await rm(path, { force: true }); else await writeFile(path, before);
  const { created } = await store.capture(turn, path);
  if (after === null) await rm(path, { force: true }); else await writeFile(path, after);
  await store.settle(turn, path, created);
}

/** Capture active accepted IDs and already-undone IDs across every branch before reading evidence. */
function context(session: Session) {
  return { turns: session.items.filter(item => item.type === "user").map(item => item.id),
    undone: new Set(session.entries.flatMap(entry => entry.item.type === "turn_undo" ? [entry.item.turnId] : [])) };
}

test("empty ancestry differs from missing saved data and collection leaves its inputs untouched", () => {
  expect(collectUndoEvidence([], [], new Set())).toEqual({ target: undefined, turns: [] });
  const turns = Object.freeze(["missing"]), undone = new Set(["missing"]);
  const first = collectUndoEvidence([], turns, undone);
  expect(first).toEqual({ target: undefined, turns: [{ turnId: "missing", ordinal: 1, alreadyUndone: true, kind: "missing" }] });
  expect(collectUndoEvidence([], turns, undone)).toEqual(first);
  expect(turns).toEqual(["missing"]);
  expect([...undone]).toEqual(["missing"]);
});

test("durable reload keeps older file-tool selection separate from newer observed and empty turns", async () => {
  await withTempDir(async root => {
    const f = await fixture(root);
    const first = f.addTurn("first");
    await change(f.store, first, join(f.work, "edited.txt"), "before", "after");
    const observed = join(f.work, "รายงาน [literal]*.txt");
    await writeFile(observed, "observed change");
    await f.store.recordShell(first, { detection: "git", paths: [observed] });
    const second = f.addTurn("second");
    await f.store.recordShell(second, { detection: "git", paths: [observed, join(f.work, "untracked.txt")] });
    const third = f.addTurn("third");
    await f.store.recordShell(third, { detection: "git", paths: [] });
    const resumed = await loadJsonlSession({ directory: f.directory, id: f.session.rootId });
    const { turns, undone } = context(resumed), manifests = await openUndoStore({ home: f.home }).list(resumed.rootId);
    const evidence = collectUndoEvidence(manifests, turns, undone);
    expect(evidence.target?.turnId).toBe(first.turnId);
    expect(evidence.turns.map(turn => [turn.turnId, turn.ordinal, turn.kind, turn.alreadyUndone])).toEqual([
      ["first", 1, "retained", false], ["second", 2, "retained", false], ["third", 3, "retained", false],
    ]);
    expect(evidence.turns.map(turn => turn.kind === "retained" ? turn.observedPaths : undefined)).toEqual([
      [observed], [observed, join(f.work, "untracked.txt")], [],
    ]);
    expect(evidence.turns[1]?.kind === "retained" && evidence.turns[1].manifest.files).toEqual([]);
    const c = f.controller(resumed);
    try {
      expect(await c.undoCommand("")).toBe(true);
      expect(c.snapshot().undoPreview?.turnId).toBe(first.turnId);
      await c.applyUndo();
      expect(await readFile(join(f.work, "edited.txt"), "utf8")).toBe("before");
      expect(await readFile(observed, "utf8")).toBe("observed change");
      expect(resumed.items.at(-1)).toMatchObject({ type: "turn_undo", turnId: first.turnId, reverted: [{ path: "edited.txt", action: "restored" }] });
    } finally { c.dispose(); await c.waitForIdle(); }
  });
});

test("active ancestry excludes sibling evidence while a global undo still excludes the original target", async () => {
  await withTempDir(async root => {
    const f = await fixture(root), first = f.addTurn("original"), originalBranch = f.session.activeBranchId;
    await change(f.store, first, join(f.work, "original.txt"), "before", "after");
    await f.store.recordShell(first, { detection: "git", paths: [join(f.work, "observed.txt")] });
    const head = f.session.items.at(-1)!.id;
    f.session.forkBranch(head, "sibling");
    const sibling = f.addTurn("sibling");
    await change(f.store, sibling, join(f.work, "sibling.txt"), null, "sibling");
    await f.store.recordShell(sibling, { detection: "git", paths: [join(f.work, "sibling-observed.txt")] });
    f.session.append({ type: "turn_undo", id: "already-undone", turnId: first.turnId, turnNumber: first.turnNumber,
      reverted: [{ path: "original.txt", action: "restored" }], skipped: [], note: "The original turn was undone on another branch." });
    f.session.selectBranch(originalBranch);
    const resumed = await loadJsonlSession({ directory: f.directory, id: f.session.rootId });
    expect(resumed.items.some(item => item.type === "turn_undo")).toBe(false);
    const { turns, undone } = context(resumed), manifests = await f.store.list(resumed.rootId);
    const evidence = collectUndoEvidence(manifests, turns, undone);
    expect(evidence.target).toBeUndefined();
    expect(evidence.turns).toHaveLength(1);
    expect(evidence.turns[0]).toMatchObject({ turnId: first.turnId, ordinal: 1, alreadyUndone: true, kind: "retained", observedPaths: [join(f.work, "observed.txt")] });
    expect(JSON.stringify(evidence)).not.toContain("sibling-observed");
    const c = f.controller(resumed);
    try {
      expect(await c.undoCommand("")).toBe(true);
      expect(c.snapshot().undoPreview).toBeUndefined();
      expect(c.snapshot().transcript.at(-1)?.text).toBe("Nothing to undo");
    } finally { c.dispose(); await c.waitForIdle(); }
  });
});

test("missing, pruned, retained empty and unavailable detection remain different facts without expiry inference", async () => {
  await withTempDir(async root => {
    const f = await fixture(root);
    const removed = f.addTurn("pruned");
    await change(f.store, removed, join(f.work, "old.txt"), "before", "after");
    const old = (await f.store.list(f.session.rootId))[0]!;
    old.createdAt = "2000-01-01T00:00:00Z";
    await writeFile(join(f.home, ".schway/undo", f.session.rootId, "turns/pruned.json"), JSON.stringify(old));
    await pruneUndoStore({ home: f.home, maxAgeDays: 30, maxSizeBytes: 1_000_000 });
    f.addTurn("never-captured");
    const empty = f.addTurn("empty");
    await f.store.recordShell(empty, { detection: "git", paths: [] });
    const unknown = f.addTurn("unknown");
    await f.store.recordShell(unknown, { detection: "unavailable" });
    const legacy = f.addTurn("legacy");
    await f.store.recordShell(legacy, { detection: "unavailable" });
    const legacyPath = join(f.home, ".schway/undo", f.session.rootId, "turns/legacy.json");
    const legacyJson = JSON.parse(await readFile(legacyPath, "utf8")); delete legacyJson.shell;
    await writeFile(legacyPath, JSON.stringify(legacyJson));
    const before = await inventory(root), { turns, undone } = context(f.session);
    const evidence = collectUndoEvidence(await openUndoStore({ home: f.home }).list(f.session.rootId), turns, undone);
    expect(evidence.target).toBeUndefined();
    expect(evidence.turns.map(turn => turn.kind)).toEqual(["missing", "missing", "retained", "retained", "retained"]);
    expect(evidence.turns[2]).toMatchObject({ kind: "retained", observedPaths: [] });
    for (const turn of evidence.turns.slice(3)) expect(turn.kind === "retained" && turn.observedPaths).toBeUndefined();
    expect(JSON.stringify(evidence)).not.toContain("expired");
    expect(await inventory(root)).toEqual(before);
  });
});

const beforeHash = hashUndoBytes(Buffer.from("before")), afterHash = hashUndoBytes(Buffer.from("after"));
const fileCases: { name: string; file: Omit<UndoFile, "path">; eligible: boolean }[] = [
  { name: "unsettled pre-image", file: { before: beforeHash }, eligible: false },
  { name: "settled deletion", file: { before: beforeHash, after: null }, eligible: true },
  { name: "settled creation", file: { before: null, after: afterHash }, eligible: true },
  { name: "absent before and after", file: { before: null, after: null }, eligible: false },
  { name: "changed legacy content", file: { before: beforeHash, after: afterHash }, eligible: true },
  { name: "unchanged legacy content", file: { before: beforeHash, after: beforeHash }, eligible: false },
  { name: "permission-only change", file: { before: beforeHash, after: beforeHash, beforeMode: 0o755, afterMode: 0o600 }, eligible: true },
  { name: "same content and permissions", file: { before: beforeHash, after: beforeHash, beforeMode: 0o600, afterMode: 0o600 }, eligible: false },
  { name: "missing legacy before mode", file: { before: beforeHash, after: beforeHash, afterMode: 0o600 }, eligible: false },
  { name: "missing legacy after mode", file: { before: beforeHash, after: beforeHash, beforeMode: 0o755 }, eligible: false },
];

for (const sample of fileCases) test(`retained ${sample.name} preserves target eligibility`, async () => {
  await withTempDir(async root => {
    const f = await fixture(root), turn = f.addTurn("candidate");
    await f.store.recordShell(turn, { detection: "unavailable" });
    const manifest = (await f.store.list(turn.sessionId))[0]!;
    manifest.files = [{ path: join(f.work, "not-read.txt"), ...sample.file }];
    await writeFile(join(f.home, ".schway/undo", turn.sessionId, "turns/candidate.json"), JSON.stringify(manifest));
    const evidence = collectUndoEvidence(await f.store.list(turn.sessionId), [turn.turnId], new Set());
    expect(evidence.target?.turnId).toBe(sample.eligible ? turn.turnId : undefined);
    expect(evidence.turns[0]).toMatchObject({ kind: "retained", ordinal: 1 });
    expect(await readdir(f.work)).toEqual([]);
  });
});

test("target ordering preserves createdAt, turnNumber and stable exact ties without reordering input", async () => {
  await withTempDir(async root => {
    const f = await fixture(root);
    for (const id of ["later-ordinal", "earlier-ordinal", "equal-first", "equal-last"]) {
      const turn = f.addTurn(id);
      await change(f.store, turn, join(f.work, id), "before", "after");
    }
    const manifests = await f.store.list(f.session.rootId), byId = new Map(manifests.map(manifest => [manifest.turnId, manifest]));
    const early = byId.get("earlier-ordinal")!, late = byId.get("later-ordinal")!;
    early.createdAt = "2020-01-02T00:00:00Z"; late.createdAt = "2020-01-01T00:00:00Z";
    late.turnNumber = 99;
    expect(collectUndoEvidence([late, early], [late.turnId, early.turnId], new Set()).target).toBe(early);
    late.createdAt = early.createdAt;
    expect(collectUndoEvidence([early, late], [late.turnId, early.turnId], new Set()).target).toBe(late);
    const equalFirst = byId.get("equal-first")!, equalLast = byId.get("equal-last")!;
    for (const manifest of [equalFirst, equalLast]) { manifest.createdAt = early.createdAt; manifest.turnNumber = 4; }
    const input = Object.freeze([equalLast, equalFirst]);
    expect(collectUndoEvidence(input, [equalFirst.turnId, equalLast.turnId], new Set()).target).toBe(equalLast);
    expect(input).toEqual([equalLast, equalFirst]);
  });
});

test("current conflicts never change the selected durable target or cause evidence reads to write", async () => {
  await withTempDir(async root => {
    const f = await fixture(root), older = f.addTurn("older");
    await change(f.store, older, join(f.work, "older.txt"), "before", "after");
    const newer = f.addTurn("newer");
    await change(f.store, newer, join(f.work, "newer.txt"), "before", "after");
    await writeFile(join(f.work, "newer.txt"), "external later edit");
    const c = f.controller(), before = await inventory(root), { turns, undone } = context(f.session);
    try {
      const evidence = collectUndoEvidence(await f.store.list(f.session.rootId), turns, undone);
      expect(evidence.target?.turnId).toBe(newer.turnId);
      expect(await c.undoCommand("")).toBe(true);
      expect(c.snapshot().undoPreview).toBeUndefined();
      expect(c.snapshot().transcript.at(-1)?.text).toBe("Nothing to undo · every file changed since");
      await c.applyUndo(); c.closeUndoPreview();
      expect(f.session.items.some(item => item.type === "turn_undo")).toBe(false);
      expect(await inventory(root)).toEqual(before);
    } finally { c.dispose(); await c.waitForIdle(); }
  });
});

for (const failure of ["corrupt", "not-directory"] as const) test(`a ${failure} store list still fails through the controller instead of producing empty evidence`, async () => {
  await withTempDir(async root => {
    const f = await fixture(root), turn = f.addTurn("candidate");
    await change(f.store, turn, join(f.work, "edited.txt"), "before", "after");
    const turnsDirectory = join(f.home, ".schway/undo", turn.sessionId, "turns");
    if (failure === "corrupt") await writeFile(join(turnsDirectory, "candidate.json"), "{invalid");
    else { await rm(turnsDirectory, { recursive: true }); await writeFile(turnsDirectory, "not a directory"); }
    const before = await inventory(root), c = f.controller();
    try {
      await expect(f.store.list(turn.sessionId)).rejects.toThrow();
      expect(await c.undoCommand("")).toBe(false);
      expect(c.snapshot().undoPreview).toBeUndefined();
      expect(c.snapshot().transcript.at(-1)?.text).toBe("Undo unavailable · /undo retry");
      expect(await inventory(root)).toEqual(before);
    } finally { c.dispose(); await c.waitForIdle(); }
  });
});

test("apply re-reads selection and refuses a newly recorded undo without restoring files", async () => {
  await withTempDir(async root => {
    const f = await fixture(root), turn = f.addTurn("candidate");
    await change(f.store, turn, join(f.work, "edited.txt"), "before", "after");
    const c = f.controller();
    try {
      expect(await c.undoCommand("")).toBe(true);
      expect(c.snapshot().undoPreview?.turnId).toBe(turn.turnId);
      f.session.append({ type: "turn_undo", id: "external-undo", turnId: turn.turnId, turnNumber: turn.turnNumber,
        reverted: [{ path: "edited.txt", action: "restored" }], skipped: [], note: "An undo was already recorded." });
      const before = await inventory(root);
      await c.applyUndo();
      expect(c.snapshot().undoPreview).toBeUndefined();
      expect(c.snapshot().transcript.at(-1)?.text).toBe("Nothing to undo");
      expect(f.session.items.filter(item => item.type === "turn_undo")).toHaveLength(1);
      expect(await inventory(root)).toEqual(before);
    } finally { c.dispose(); await c.waitForIdle(); }
  });
});

test("real controller preview and apply each read the manifest list exactly once", async () => {
  await withTempDir(async root => {
    const f = await fixture(root), turn = f.addTurn("candidate"), path = join(f.work, "edited.txt");
    await change(f.store, turn, path, "before", "after");
    const directory = join(f.home, ".schway/undo", turn.sessionId, "turns");
    const script = `
      import { mock } from "bun:test";
      const fs = await import("node:fs/promises");
      const read = fs.readFile, list = fs.readdir;
      const directory = ${JSON.stringify(directory)};
      let lists = 0, manifests = 0;
      mock.module("node:fs/promises", () => ({ ...fs,
        readdir: async (...args) => { if (String(args[0]) === directory) lists++; return list(...args); },
        readFile: async (...args) => { if (String(args[0]) === directory + "/candidate.json") manifests++; return read(...args); },
      }));
      const { TuiController } = await import(${JSON.stringify(join(import.meta.dir, "../src/tui/controller.ts"))});
      const { loadJsonlSession } = await import(${JSON.stringify(join(import.meta.dir, "../src/session/jsonl.ts"))});
      const { createContextManager } = await import(${JSON.stringify(join(import.meta.dir, "../src/context/manager.ts"))});
      const { createScriptedModel } = await import(${JSON.stringify(join(import.meta.dir, "helpers/scripted-model.ts"))});
      const workspace = ${JSON.stringify(f.workspace)}, home = ${JSON.stringify(f.home)};
      const session = await loadJsonlSession({ directory: ${JSON.stringify(f.directory)}, id: ${JSON.stringify(turn.sessionId)} });
      const c = new TuiController({ session, sessionId: session.rootId, workspace, home, contextManager: createContextManager(workspace, { home }),
        provider: "scripted", modelId: "test", model: createScriptedModel(), changeTracking: "off" });
      try {
        const opened = await c.undoCommand("");
        const preview = { opened, lists, manifests, turnId: c.snapshot().undoPreview?.turnId };
        await c.applyUndo();
        console.log(JSON.stringify({ preview, applied: { lists, manifests, records: session.items.filter(item => item.type === "turn_undo").length },
          content: await read(${JSON.stringify(path)}, "utf8") }));
      } finally { c.dispose(); await c.waitForIdle(); }
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill(), 5000);
    try {
      const [exit, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(exit, error).toBe(0);
      expect(JSON.parse(out)).toEqual({ preview: { opened: true, lists: 1, manifests: 1, turnId: turn.turnId },
        applied: { lists: 2, manifests: 2, records: 1 }, content: "before" });
    } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill(); await child.exited; }
  });
}, 7000);

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.com" };
/** Run one isolated Git command in the workspace and return trimmed output. */
function git(work: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: work, env: gitEnv });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
/** Commit tracked fixtures in a fresh repository whose private home stays outside status output. */
async function gitWorkspace(work: string, files: Record<string, string>) {
  git(work, "init", "-q", "-b", "main");
  for (const [path, content] of Object.entries(files)) await writeFile(join(work, path), content);
  git(work, "add", "."); git(work, "-c", "commit.gpgsign=false", "commit", "-qm", "Fixture");
}
const bash = (id: string, command: string): ScriptedTurn => ({ toolCalls: [{ id, name: "bash", arguments: { command } }] });
const edit = (id: string, path: string): ScriptedTurn => ({ toolCalls: [{ id, name: "edit", arguments: { path, edits: [{ oldText: "before", newText: "after" }] } }] });

/** Render a scripted conversation over a separate workspace and durable home, as an interactive user sees it. */
async function rendered(root: string, turns: ScriptedTurn[], options: { tracking?: "off" | "on-demand"; session?: Session; secrets?: string[] } = {}) {
  const home = join(root, "home"), work = join(root, "work"), directory = join(home, "sessions");
  await mkdir(work, { recursive: true });
  const workspace = { root: work, launchCwd: work, extraRoots: [] };
  const session = options.session ?? await createJsonlSession({ directory, workspace });
  const secrets = options.secrets ?? [];
  const controller = new TuiController({ session, sessionId: session.rootId, workspace, home, provider: "scripted", modelId: "scripted", secrets,
    model: createScriptedModel({ responses: turns }), contextManager: createContextManager(workspace, { home }),
    tools: createToolRegistry([editTool, bashTool]), changeTracking: options.tracking ?? "on-demand" });
  const terminal = await createTestRenderer({ width: 80, height: 30, kittyKeyboard: true });
  const view = createConversationView(terminal.renderer, { controller, home, workspaceRoot: work, env: {}, secrets, quit() {},
    submit: (value, accepted) => dispatchEditorInput(value, controller, command => command.name === "undo" ? controller.undoCommand(command.args) : Promise.resolve(false), accepted) });
  const editor = terminal.renderer.root.findDescendantById("prompt") as TextareaRenderable;
  const settle = async () => { view.refresh(); await terminal.flush(); };
  const waitFor = async (ready: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!ready() && Date.now() < deadline) { await Bun.sleep(5); await settle(); }
    expect(ready()).toBe(true); await settle();
  };
  const send = async (text: string) => { await terminal.mockInput.typeText(text); terminal.mockInput.pressEnter(); await waitFor(() => editor.plainText !== text); await controller.waitForIdle(); await settle(); };
  const undo = async () => { await controller.undoCommand(""); await settle(); };
  const reviewReady = () => !!controller.snapshot().changeReview && !controller.snapshot().changeReview!.loading;
  /** Capture workspace bytes, durable session/undo data and Git's semantic state; Git's stat cache may refresh. */
  const state = async () => ({ files: (await inventory(root)).filter(entry => !String((entry as { name: string }).name).startsWith("work/.git")),
    git: await Bun.file(join(work, ".git")).exists() ? [git(work, "status", "--porcelain=v1", "-uall"), git(work, "rev-parse", "HEAD")] : [] });
  return { ...terminal, home, work, directory, session, controller, editor, settle, waitFor, send, undo, reviewReady, state,
    records: () => session.items.filter(item => item.type === "turn_undo"),
    dispose: async () => { view.destroy(); controller.dispose(); terminal.renderer.destroy(); await controller.waitForIdle(); } };
}

test("limits keep the target's observed paths first, newer turns newest first and no expiry facts", () => {
  const manifest = (turnId: string, turnNumber: number, files: UndoFile[], paths?: string[]) => ({ version: 1 as const, sessionId: "s", turnId, turnNumber,
    createdAt: `2026-01-0${turnNumber}T00:00:00Z`, files, shell: paths ? { detection: "git" as const, paths } : { detection: "unavailable" as const } });
  const changed = { path: "/w/a", before: hashUndoBytes(Buffer.from("a")), after: hashUndoBytes(Buffer.from("b")) };
  const manifests = [manifest("t1", 1, [changed], ["/w/own"]), manifest("t2", 2, [{ path: "/w/incomplete", before: null }], ["/w/later"]), manifest("t4", 4, [])];
  const limits = describeUndoLimits(collectUndoEvidence(manifests, ["t1", "t2", "t3", "t4"], new Set()));
  expect(limits).toEqual({ targetOrdinal: 1, latestOrdinal: 4, undetected: [4], missing: [3], unsaved: [
    { turnId: "t1", ordinal: 1, path: "/w/own", kind: "observed" },
    { turnId: "t2", ordinal: 2, path: "/w/incomplete", kind: "incomplete" }, { turnId: "t2", ordinal: 2, path: "/w/later", kind: "observed" },
  ] });
  const none = describeUndoLimits(collectUndoEvidence(manifests.slice(1), ["t1", "t2", "t3", "t4"], new Set(["t2"])));
  expect(none).toEqual({ targetOrdinal: undefined, latestOrdinal: 4, unsaved: [], undetected: [4], missing: [3, 1] });
  expect(JSON.stringify([limits, none])).not.toContain("expire");
});

test("a shell-only change lists its path read-only with a reachable review and leaves every store untouched", async () => {
  await withTempDir(async root => {
    await mkdir(join(root, "work"));
    await gitWorkspace(join(root, "work"), { "a.ts": "before" });
    const ui = await rendered(root, [bash("generate", "printf 'generated\\n' > generated.txt"), { text: "Generated." }]);
    try {
      await ui.send("Generate a file");
      await ui.mockInput.pasteBracketedText("Keep this draft");
      ui.editor.cursorOffset = 4;
      const before = await ui.state();
      await ui.undo();
      const frame = ui.captureCharFrame();
      expect(frame).toContain("No saved undo for these changes · Alt+R review · Esc back");
      expect(frame).toContain("generated.txt"); expect(frame).toContain("turn 1 · no saved undo");
      expect(frame).toContain("Seen during turn 1 · no saved undo");
      expect(frame).not.toContain("Enter undo"); expect(frame).not.toContain("Nothing to undo"); expect(frame).not.toContain("changed by shell");
      ui.mockInput.pressEnter(); await ui.settle();
      expect(ui.controller.snapshot().undoPreview?.readOnlyStatus).toBe("No saved undo for these changes");
      ui.mockInput.pressKey("r", { meta: true }); await ui.waitFor(ui.reviewReady);
      expect(ui.controller.snapshot().changeReview).toMatchObject({ heading: "Review · current changes", fromUndo: true, files: [{ path: "generated.txt" }] });
      expect(ui.controller.snapshot().changeReview?.scope).toBeUndefined();
      const review = ui.captureCharFrame();
      expect(review).toContain("Review · current changes"); expect(review).toContain("Files from undo panel"); expect(review).toContain("Current diff · generated.txt");
      expect(review).toContain("Ctrl+R reload");
      // An undo-panel path carries no turn attribution: no shell, detected or snapshot claims.
      for (const claim of [/\bshell\b/i, /\bdetected\b/, /Git snapshot/, /Files from turn/]) expect(review).not.toMatch(claim);
      expect(ui.controller.snapshot().changeReview?.rows.map(row => row.text).join("\n")).not.toMatch(/shell|Git snapshot/);
      expect(ui.controller.snapshot().changeReview?.rows).toContainEqual(expect.objectContaining({ sign: "+", text: "generated" }));
      // With a live turn, F2 swaps in the undo-panel review's own Details and back; Esc first leaves Details.
      expect(review).toContain("F2 details");
      ui.mockInput.pressKey("\u001bOQ"); await ui.settle();
      expect(ui.controller.snapshot().changeReview?.showingDetails).toBe(true);
      expect(ui.captureCharFrame()).toContain("Review details");
      ui.mockInput.pressEscape(); await ui.settle();
      expect(ui.controller.snapshot().changeReview).toMatchObject({ fromUndo: true, showingDetails: false });
      ui.mockInput.pressEscape(); await ui.settle();
      expect(ui.controller.snapshot().changeReview).toBeUndefined();
      expect(ui.controller.snapshot().undoPreview?.files.map(file => file.path)).toEqual(["generated.txt"]);
      ui.mockInput.pressEscape(); await ui.settle();
      expect(ui.controller.snapshot().undoPreview).toBeUndefined();
      expect(ui.editor.plainText).toBe("Keep this draft"); expect(ui.editor.cursorOffset).toBe(4);
      expect(await ui.state()).toEqual(before);
      expect(await readFile(join(ui.work, "generated.txt"), "utf8")).toBe("generated\n");
      expect(ui.records()).toEqual([]);
    } finally { await ui.dispose(); }
  });
});

test("a mixed turn separates read-only rows and applying changes only pre-image-backed files", async () => {
  await withTempDir(async root => {
    await mkdir(join(root, "work"));
    await gitWorkspace(join(root, "work"), { "a.ts": "before" });
    const ui = await rendered(root, [{ toolCalls: [...edit("edit", "a.ts").toolCalls!, ...bash("generate", "printf 'x\\n' > gen.txt").toolCalls!] }, { text: "Done." }]);
    try {
      await ui.send("Edit and generate"); await ui.undo();
      expect(ui.controller.snapshot().undoPreview).toMatchObject({ older: false, notes: ["1 change without saved undo stays"],
        files: [{ path: "a.ts", action: "restore" }, { path: "gen.txt", action: "shell", status: "no saved undo" }] });
      expect(ui.controller.snapshot().undoPreview?.readOnlyStatus).toBeUndefined();
      expect(ui.captureCharFrame()).toContain("Undo turn 1 · Enter undo · Esc cancel");
      ui.mockInput.pressEnter(); await ui.waitFor(() => !ui.controller.snapshot().undoPreview);
      expect(await readFile(join(ui.work, "a.ts"), "utf8")).toBe("before");
      expect(await readFile(join(ui.work, "gen.txt"), "utf8")).toBe("x\n");
      expect(ui.records()).toEqual([expect.objectContaining({ turnNumber: 1, reverted: [{ path: "a.ts", action: "restored" }], skipped: [] })]);
      // The undone turn's remaining path does not reappear as a fresh candidate.
      await ui.undo(); expect(ui.controller.snapshot().transcript.at(-1)?.text).toBe("Nothing to undo");
      expect(ui.controller.snapshot().undoPreview).toBeUndefined();
    } finally { await ui.dispose(); }
  });
});

test("an older target names itself and lists newer changes that remain before it can be applied", async () => {
  await withTempDir(async root => {
    await mkdir(join(root, "work"));
    await gitWorkspace(join(root, "work"), { "a.ts": "before" });
    const ui = await rendered(root, [edit("edit", "a.ts"), { text: "Edited." }, bash("generate", "printf 'x\\n' > gen.txt"), { text: "Generated." }]);
    try {
      await ui.send("Edit"); await ui.send("Generate"); await ui.undo();
      const frame = ui.captureCharFrame();
      expect(frame).toContain("Undo older turn 1 · Enter undo · Esc cancel");
      expect(frame).toContain("turn 2 · no saved undo"); expect(frame).toContain("1 change without saved undo stays");
      expect(ui.controller.snapshot().undoPreview?.files.map(file => [file.path, file.action])).toEqual([["a.ts", "restore"], ["gen.txt", "shell"]]);
      ui.mockInput.pressEnter(); await ui.waitFor(() => !ui.controller.snapshot().undoPreview);
      expect(await readFile(join(ui.work, "a.ts"), "utf8")).toBe("before");
      expect(await readFile(join(ui.work, "gen.txt"), "utf8")).toBe("x\n");
      expect(ui.records()).toEqual([expect.objectContaining({ turnNumber: 1, reverted: [{ path: "a.ts", action: "restored" }], skipped: [] })]);
    } finally { await ui.dispose(); }
  });
});

test("when every file conflicts the remaining paths and per-file reasons stay visible without an undo record", async () => {
  await withTempDir(async root => {
    await mkdir(join(root, "work"));
    await gitWorkspace(join(root, "work"), { "a.ts": "before" });
    const ui = await rendered(root, [{ toolCalls: [...edit("edit", "a.ts").toolCalls!, ...bash("generate", "printf 'x\\n' > gen.txt").toolCalls!] }, { text: "Done." }]);
    try {
      await ui.send("Edit and generate");
      await writeFile(join(ui.work, "a.ts"), "external");
      await ui.undo();
      expect(ui.controller.snapshot().undoPreview).toMatchObject({ readOnlyStatus: "Nothing to undo in turn 1",
        files: [{ path: "a.ts", status: "changed since · skip" }, { path: "gen.txt", status: "no saved undo" }] });
      expect(ui.captureCharFrame()).toContain("Nothing to undo in turn 1 · Alt+R review · Esc back");
      ui.mockInput.pressEnter(); await ui.settle(); ui.mockInput.pressEscape(); await ui.settle();
      expect(ui.records()).toEqual([]); expect(await readFile(join(ui.work, "a.ts"), "utf8")).toBe("external");
      // A conflict found only at apply time keeps the result panel and its remaining context.
      await writeFile(join(ui.work, "a.ts"), "after");
      await ui.undo(); expect(ui.controller.snapshot().undoPreview?.readOnlyStatus).toBeUndefined();
      await writeFile(join(ui.work, "a.ts"), "raced");
      ui.mockInput.pressEnter(); await ui.waitFor(() => ui.controller.snapshot().undoPreview?.result === true);
      expect(ui.controller.snapshot().undoPreview?.files.map(file => file.status)).toEqual(["changed since · skip", "no saved undo"]);
      expect(ui.controller.snapshot().transcript.at(-1)?.text).toBe("Nothing to undo · every file changed since");
      expect(ui.records()).toEqual([]); expect(await readFile(join(ui.work, "a.ts"), "utf8")).toBe("raced");
      expect(await readFile(join(ui.work, "gen.txt"), "utf8")).toBe("x\n");
    } finally { await ui.dispose(); }
  });
});

test("a missing manifest reports no saved undo data and never claims expiry", async () => {
  await withTempDir(async root => {
    await mkdir(join(root, "work"));
    await gitWorkspace(join(root, "work"), { "a.ts": "before" });
    const ui = await rendered(root, [bash("generate", "printf 'x\\n' > gen.txt"), { text: "Generated." }]);
    try {
      await ui.send("Generate");
      await rm(join(ui.home, ".schway/undo", ui.session.rootId, "turns"), { recursive: true });
      const before = await ui.state();
      await ui.undo();
      expect(ui.controller.snapshot().transcript.at(-1)?.text).toBe("No saved undo data · F2 details");
      expect(ui.controller.inspectNoticeDetails()).toBe(true);
      const details = ui.controller.snapshot().transcript.at(-1)!.text;
      expect(details).toContain("No undo data is saved for turn 1"); expect(details).not.toMatch(/expire/i);
      expect(await ui.state()).toEqual(before);
    } finally { await ui.dispose(); }
  });
});

for (const scenario of ["non-Git workspace", "tracking off"] as const) test(`a ${scenario} reports unavailable detection without asserting that nothing changed`, async () => {
  await withTempDir(async root => {
    await mkdir(join(root, "work"));
    if (scenario === "tracking off") await gitWorkspace(join(root, "work"), { "a.ts": "before" });
    const ui = await rendered(root, [bash("generate", "printf 'x\\n' > gen.txt"), { text: "Generated." }], { tracking: scenario === "tracking off" ? "off" : "on-demand" });
    try {
      await ui.send("Generate");
      const before = await ui.state();
      await ui.undo();
      expect(ui.controller.snapshot().undoPreview).toBeUndefined();
      expect(ui.controller.snapshot().transcript.at(-1)?.text).toBe("Change detection unavailable · F2 details");
      ui.mockInput.pressKey("\u001bOQ"); await ui.settle();
      expect(ui.controller.snapshot().transcript.at(-1)?.text).toStartWith("Details · Esc keep editing\n");
      const details = ui.controller.snapshot().transcript.at(-1)!.text;
      expect(details).toContain("Change detection was unavailable for turn 1"); expect(details).toContain("They may still have changed.");
      expect(details).not.toContain("Nothing to undo"); expect(details).not.toMatch(/no files changed/i);
      if (scenario === "tracking off") expect(details).toContain('/config set git {"changeTracking":"on-demand"}');
      expect(await ui.state()).toEqual(before);
      expect(await readFile(join(ui.work, "gen.txt"), "utf8")).toBe("x\n");
    } finally { await ui.dispose(); }
  });
});

test("reload from durable manifests rebuilds the read-only list and review for the current branch only", async () => {
  await withTempDir(async root => {
    await mkdir(join(root, "work"));
    await gitWorkspace(join(root, "work"), { "a.ts": "before" });
    const first = await rendered(root, [bash("generate", "printf 'x\\n' > gen.txt"), { text: "Generated." }]);
    await first.send("Generate");
    const { directory } = first, id = first.session.rootId;
    await first.dispose();
    const session = await loadJsonlSession({ directory, id });
    const ui = await rendered(root, [], { session });
    try {
      expect(ui.controller.snapshot().outcome).toBeUndefined();
      const before = await ui.state();
      await ui.undo();
      expect(ui.controller.snapshot().undoPreview).toMatchObject({ readOnlyStatus: "No saved undo for these changes", files: [{ path: "gen.txt", status: "turn 1 · no saved undo" }] });
      ui.mockInput.pressKey("r", { meta: true }); await ui.waitFor(ui.reviewReady);
      expect(ui.controller.snapshot().changeReview?.files.map(file => file.path)).toEqual(["gen.txt"]);
      expect(ui.captureCharFrame()).not.toMatch(/\bshell\b|\bdetected\b|Git snapshot/i);
      expect(ui.controller.snapshot().changeReview?.rows).toContainEqual(expect.objectContaining({ sign: "+", text: "x" }));
      ui.mockInput.pressEscape(); await ui.settle(); ui.mockInput.pressEscape(); await ui.settle();
      expect(await ui.state()).toEqual(before);
      session.forkBranch(session.rootId); ui.controller.replaceSession(session, session.rootId);
      await ui.undo();
      expect(ui.controller.snapshot().undoPreview).toBeUndefined();
      expect(ui.controller.snapshot().transcript.at(-1)?.text).toBe("Nothing to undo");
    } finally { await ui.dispose(); }
  });
});

test("Ctrl+R rereads an undo-panel review in place, and a stale read never reopens a closed review", async () => {
  await withTempDir(async root => {
    await mkdir(join(root, "work"));
    await gitWorkspace(join(root, "work"), { "a.ts": "before" });
    const ui = await rendered(root, [bash("generate", "printf 'x\\n' > gen.txt"), { text: "Generated." }]);
    try {
      await ui.send("Generate");
      await ui.undo();
      ui.mockInput.pressKey("r", { meta: true }); await ui.waitFor(ui.reviewReady);
      ui.mockInput.pressKey("down"); await ui.waitFor(ui.reviewReady);
      await writeFile(join(ui.work, "gen.txt"), "y\n");
      ui.mockInput.pressKey("r", { ctrl: true });
      await ui.waitFor(() => !!ui.controller.snapshot().changeReview?.rows.some(row => row.sign === "+" && row.text === "y"));
      expect(ui.controller.snapshot().changeReview).toMatchObject({ heading: "Review · current changes", fromUndo: true, selected: 0, currentPath: "gen.txt", files: [{ path: "gen.txt" }] });
      expect(ui.controller.snapshot().changeReview?.scope).toBeUndefined();
      // A reload still pending when review closes is discarded; Esc returns to the same undo panel.
      const pending = ui.controller.refreshChangeReview();
      ui.mockInput.pressEscape(); await ui.settle();
      expect(await pending).toBe(false);
      expect(ui.controller.snapshot().changeReview).toBeUndefined();
      expect(ui.controller.snapshot().undoPreview).toMatchObject({ readOnlyStatus: "No saved undo for these changes", files: [{ path: "gen.txt" }] });
      expect(ui.records()).toEqual([]);
    } finally { await ui.dispose(); }
  });
});

/** Hold Git reads whose arguments include `marker` until released, leaving every other command untouched. */
function gateGit(marker: string) {
  const realSpawn = Bun.spawn, gate = Promise.withResolvers<void>(), commands: string[][] = [];
  let held = 0;
  Bun.spawn = ((command: string[], options: Parameters<typeof Bun.spawn>[1]) => {
    const child = realSpawn(command, options);
    if (command[0] === "git") commands.push(command);
    if (command[0] !== "git" || !command.includes(marker)) return child;
    held++;
    return { pid: child.pid, stdout: child.stdout, stderr: child.stderr, kill: child.kill.bind(child), exited: gate.promise.then(() => child.exited) };
  }) as typeof Bun.spawn;
  return { release: () => gate.resolve(), held: () => held, commands, restore: () => { Bun.spawn = realSpawn; } };
}

test("a slow undo-review diff for one path never appears after selection moves to another", async () => {
  await withTempDir(async root => {
    await mkdir(join(root, "work"));
    await gitWorkspace(join(root, "work"), { "a.ts": "before" });
    const ui = await rendered(root, [bash("generate", "printf 'a evidence\\n' > a.txt; printf 'b evidence\\n' > b.txt"), { text: "Generated." }]);
    try {
      await ui.send("Generate");
      await ui.undo();
      expect(ui.controller.snapshot().undoPreview?.files.map(file => file.path)).toEqual(["a.txt", "b.txt"]);
      const gate = gateGit("a.txt");
      try {
        const opening = ui.controller.reviewUndoChanges();
        while (!gate.held()) await Bun.sleep(1);
        expect(ui.controller.snapshot().changeReview).toMatchObject({ currentPath: "a.txt", detail: "Loading current diff…" });
        await ui.controller.selectReviewFile(1);
        expect(ui.controller.snapshot().changeReview?.currentPath).toBe("b.txt");
        expect(ui.controller.snapshot().changeReview?.detail).toContain("b evidence");
        gate.release(); expect(await opening).toBe(true);
        const review = ui.controller.snapshot().changeReview!;
        expect(review).toMatchObject({ fromUndo: true, selected: 1, currentPath: "b.txt" });
        expect(review.detail).toContain("b evidence"); expect(review.detail).not.toContain("a evidence");
      } finally { gate.restore(); }
    } finally { await ui.dispose(); }
  });
});

test("a pending undo-review Git read is discarded when the session is replaced or the branch changes", async () => {
  for (const [marker, boundary] of [["status", "session"], ["status", "branch"], ["gen.txt", "session"], ["gen.txt", "branch"]] as const) {
    await withTempDir(async root => {
      await mkdir(join(root, "work"));
      await gitWorkspace(join(root, "work"), { "a.ts": "before" });
      const ui = await rendered(root, [bash("generate", "printf 'x\\n' > gen.txt"), { text: "Generated." }]);
      try {
        await ui.send("Generate");
        await ui.undo();
        const before = await ui.state();
        const gate = gateGit(marker);
        try {
          const opening = ui.controller.reviewUndoChanges();
          while (!gate.held()) await Bun.sleep(1);
          if (boundary === "session") ui.controller.replaceSession(ui.session, ui.session.rootId);
          else ui.session.forkBranch(ui.session.rootId);
          gate.release(); await opening;
          // A discarded status read never goes on to read a file diff for the old review.
          if (marker === "status") expect(gate.commands.some(command => command.includes("gen.txt"))).toBe(false);
          const review = ui.controller.snapshot().changeReview;
          if (boundary === "session") { expect(review).toBeUndefined(); expect(ui.controller.snapshot().undoPreview).toBeUndefined(); }
          else {
            // The branch moved under an open review: its Git read is dropped and never shown as current.
            expect(review?.rows.some(row => row.text === "x")).toBe(false);
            expect(review?.detail ?? "").not.toContain("x\n");
          }
        } finally { gate.restore(); }
        expect(ui.records()).toEqual([]);
        // Forking the branch is the test's own session write; replacing the session writes nothing.
        if (boundary === "session") expect(await ui.state()).toEqual(before);
      } finally { await ui.dispose(); }
    });
  }
});

test("an undo review whose listed paths are all outside the workspace says so instead of claiming none were seen", async () => {
  await withTempDir(async root => {
    await mkdir(join(root, "work"));
    await gitWorkspace(join(root, "work"), { "a.ts": "before" });
    const ui = await rendered(root, [{ text: "Nothing to change." }]);
    try {
      await ui.send("Look around");
      const turnId = ui.session.items.findLast(item => item.type === "user")!.id, outside = join(root, "outside.txt");
      await writeFile(outside, "outside\n");
      await openUndoStore({ home: ui.home }).recordShell({ sessionId: ui.session.rootId, turnId, turnNumber: 1 }, { detection: "git", paths: [outside] });
      await ui.undo();
      expect(ui.controller.snapshot().undoPreview).toMatchObject({ readOnlyStatus: "No saved undo for these changes", files: [{ absolutePath: outside }] });
      ui.mockInput.pressKey("r", { meta: true }); await ui.waitFor(ui.reviewReady);
      expect(ui.controller.snapshot().changeReview).toMatchObject({ fromUndo: true, files: [], detail: "Paths in the undo panel are outside the workspace." });
      const frame = ui.captureCharFrame();
      expect(frame).toContain("Files from undo panel"); expect(frame).toContain("No workspace files");
      expect(frame).not.toContain("None observed");
      ui.mockInput.pressEscape(); await ui.settle();
      expect(ui.controller.snapshot().undoPreview?.files).toHaveLength(1);
      expect(ui.records()).toEqual([]);
    } finally { await ui.dispose(); }
  });
});

test("session replacement discards a pending read and a review opened from the undo panel", async () => {
  await withTempDir(async root => {
    await mkdir(join(root, "work"));
    await gitWorkspace(join(root, "work"), { "a.ts": "before" });
    const ui = await rendered(root, [bash("generate", "printf 'x\\n' > gen.txt"), { text: "Generated." }]);
    try {
      await ui.send("Generate");
      const pending = ui.controller.undoCommand("");
      ui.controller.replaceSession(ui.session, ui.session.rootId);
      ui.session.forkBranch(ui.session.rootId);
      expect(await pending).toBe(false);
      expect(ui.controller.snapshot().undoPreview).toBeUndefined();
      ui.session.selectBranch("main"); ui.controller.replaceSession(ui.session, ui.session.rootId);
      await ui.undo(); expect(await ui.controller.reviewUndoChanges()).toBe(true);
      ui.controller.replaceSession(ui.session, ui.session.rootId);
      expect(ui.controller.snapshot().changeReview).toBeUndefined();
      expect(ui.controller.snapshot().undoPreview).toBeUndefined();
    } finally { await ui.dispose(); }
  });
});

test("secret and control-sequence paths are redacted in the read-only list and review", async () => {
  await withTempDir(async root => {
    await mkdir(join(root, "work"));
    await gitWorkspace(join(root, "work"), { "a.ts": "before" });
    const name = "token-SECRET123-\u001b[31mred.txt";
    const ui = await rendered(root, [bash("generate", `printf 'x\\n' > '${name}'`), { text: "Generated." }], { secrets: ["SECRET123"] });
    try {
      await ui.send("Generate");
      await ui.undo();
      expect(ui.controller.snapshot().undoPreview?.readOnlyStatus).toBe("No saved undo for these changes");
      let frame = ui.captureCharFrame();
      expect(frame).toContain("token-***-"); expect(frame).not.toContain("SECRET123"); expect(frame).not.toContain("\u001b");
      ui.mockInput.pressKey("r", { meta: true }); await ui.waitFor(ui.reviewReady);
      frame = ui.captureCharFrame();
      expect(frame).not.toContain("SECRET123"); expect(frame).not.toContain("\u001b");
    } finally { await ui.dispose(); }
  });
});

test("newer turns without saved undo data are named before an older undo and in the read-only list", async () => {
  await withTempDir(async root => {
    const f = await fixture(root), first = f.addTurn("first");
    await change(f.store, first, join(f.work, "edited.txt"), "before", "after");
    await f.store.recordShell(first, { detection: "git", paths: [] });
    f.addTurn("headless-shell");
    const c = f.controller();
    try {
      expect(await c.undoCommand("")).toBe(true);
      expect(c.snapshot().undoPreview).toMatchObject({ turnId: "first", older: true, notes: ["No saved undo data for turn 2"] });
      c.closeUndoPreview();
    } finally { c.dispose(); await c.waitForIdle(); }
  });
  await withTempDir(async root => {
    const f = await fixture(root), first = f.addTurn("observed");
    await f.store.recordShell(first, { detection: "git", paths: [join(f.work, "seen.txt")] });
    f.addTurn("never-saved");
    const before = await inventory(root), c = f.controller();
    try {
      expect(await c.undoCommand("")).toBe(true);
      expect(c.snapshot().undoPreview).toMatchObject({ readOnlyStatus: "No saved undo for these changes", notes: ["No saved undo data for turn 2"],
        files: [{ path: "seen.txt", status: "turn 1 · no saved undo" }] });
      c.closeUndoPreview();
      expect(await inventory(root)).toEqual(before);
    } finally { c.dispose(); await c.waitForIdle(); }
  });
});

test("an incomplete target entry is labelled incomplete and recorded without claiming it changed", async () => {
  await withTempDir(async root => {
    const f = await fixture(root), turn = f.addTurn("partial");
    await change(f.store, turn, join(f.work, "a.txt"), "before", "after");
    await writeFile(join(f.work, "b.txt"), "unsettled");
    await f.store.capture(turn, join(f.work, "b.txt"));
    const c = f.controller();
    try {
      expect(await c.undoCommand("")).toBe(true);
      const row = c.snapshot().undoPreview?.files.find(file => file.path === "b.txt");
      expect(row).toMatchObject({ action: "skip", status: "undo data incomplete · skip", rows: [{ text: "Turn 1 undo data is incomplete · undo leaves this file as it is" }] });
      await c.applyUndo();
      expect(await readFile(join(f.work, "a.txt"), "utf8")).toBe("before");
      expect(await readFile(join(f.work, "b.txt"), "utf8")).toBe("unsettled");
      const record = f.session.items.at(-1);
      expect(record).toMatchObject({ type: "turn_undo", reverted: [{ path: "a.txt", action: "restored" }], skipped: [{ path: "b.txt", reason: "failed" }] });
      expect(record?.type === "turn_undo" && record.note).toBe("The user undid your file changes from the previous turn: a.txt. b.txt could not be reverted.");
      expect(c.snapshot().undoPreview).toBeUndefined();
    } finally { c.dispose(); await c.waitForIdle(); }
  });
});

test("when nothing is reverted, an unavailable copy keeps the panel and never claims every file changed", async () => {
  await withTempDir(async root => {
    const f = await fixture(root), turn = f.addTurn("partial");
    await change(f.store, turn, join(f.work, "a.txt"), "before", "after");
    await writeFile(join(f.work, "b.txt"), "unsettled");
    await f.store.capture(turn, join(f.work, "b.txt"));
    const c = f.controller();
    try {
      expect(await c.undoCommand("")).toBe(true);
      await writeFile(join(f.work, "a.txt"), "raced");
      await c.applyUndo();
      expect(c.snapshot().transcript.at(-1)?.text).toBe("Nothing to undo in turn 1 · Esc back");
      expect(c.snapshot().undoPreview).toMatchObject({ result: true, files: [{ path: "a.txt", status: "changed since · skip" }, { path: "b.txt", status: "undo data incomplete · skip" }] });
      expect(f.session.items.some(item => item.type === "turn_undo")).toBe(false);
      expect(await readFile(join(f.work, "a.txt"), "utf8")).toBe("raced");
    } finally { c.dispose(); await c.waitForIdle(); }
  });
});
