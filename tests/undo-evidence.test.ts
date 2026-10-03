import { expect, test } from "bun:test";
import { lstat, mkdir, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { collectUndoEvidence } from "../src/undo/evidence.ts";
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
