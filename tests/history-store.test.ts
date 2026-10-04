import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { openDraftStore } from "../src/drafts/store.ts";
import { openUndoStore } from "../src/undo/store.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSession, deleteJsonlSession, sessionsDirectory } from "../src/session/jsonl.ts";
import { historyDirectory, historyFilePath, openHistoryStore, HISTORY_STORE_BUSY } from "../src/history/store.ts";
import { MAX_HISTORY_RECORD_BYTES, parseHistoryLine, serializeHistoryFinalize, serializeHistoryRecord, type HistoryFile, type HistoryTurnFinalize, type HistoryTurnStart } from "../src/history/records.ts";
import { historyCommandSummary, historyExcerpt, historyPath } from "../src/history/sanitize.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function temp() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "schway-history-store-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function savedSession(home: string) {
  const root = join(home, "work"); await mkdir(root, { recursive: true });
  return createJsonlSession({ directory: sessionsDirectory(home), workspace: { root, launchCwd: root, extraRoots: [] } });
}
const start = (overrides: Partial<HistoryTurnStart> = {}): HistoryTurnStart => ({ type: "turn_start", version: 1, turnId: "user-1", attemptId: "attempt-1", ordinal: 1,
  branchId: "main", parentId: "root", workspaceRoot: "/work", mode: "tui", startedAt: "2026-01-15T09:30:00.000Z", task: "Fix it", ...overrides });
const finalize = (overrides: Partial<HistoryTurnFinalize> = {}): HistoryTurnFinalize => ({ type: "turn_finalize", version: 1, turnId: "user-1", attemptId: "attempt-1", revision: 1,
  outcome: "completed", finishedAt: "2026-01-15T09:31:00.000Z", activeMs: 1000, toolResults: 0, failedTools: 0,
  commands: { total: 0, exitZero: 0, nonzero: 0, unknown: 0, truncated: false, items: [] }, files: { total: 0, truncated: false, items: [] }, git: { status: "captured" }, ...overrides });

test("a private sidecar starts with a versioned header and appends start and finalize lines", async () => {
  const home = await temp();
  const session = await savedSession(home);
  const store = openHistoryStore({ home });
  await store.start(session.header.id, start());
  await store.finalize(session.header.id, finalize());
  const path = historyFilePath(home, session.header.id);
  expect((await stat(historyDirectory(home))).mode & 0o777).toBe(0o700);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  const lines = (await readFile(path, "utf8")).split("\n");
  expect(lines.at(-1)).toBe("");
  expect(JSON.parse(lines[0]!)).toMatchObject({ type: "history", version: 1, sessionId: session.header.id });
  expect(lines.slice(1, -1).map(line => JSON.parse(line).type)).toEqual(["turn_start", "turn_finalize"]);
  const read = await store.read(session.header.id);
  expect(read).toMatchObject({ status: "ok", rejected: 0, tornTail: false });
  expect(read.starts[0]?.attemptId).toBe("attempt-1");
  expect(read.finalizes[0]?.outcome).toBe("completed");
});

test("evidence is never created for an absent session, and finalization needs a recorded start", async () => {
  const home = await temp();
  const store = openHistoryStore({ home });
  await expect(store.start("missing-session", start())).rejects.toMatchObject({ code: "HISTORY_SESSION_MISSING" });
  const session = await savedSession(home);
  await expect(store.finalize(session.header.id, finalize())).rejects.toThrow("History start was not recorded");
  expect(await Bun.file(historyFilePath(home, session.header.id)).exists()).toBe(false);
  await expect(store.start("../escape", start())).rejects.toThrow("Invalid history session id");
});

test("invalid identities are rejected rather than truncated", () => {
  expect(() => serializeHistoryRecord(start({ turnId: "x".repeat(257) }))).toThrow("Invalid history identity");
  expect(() => serializeHistoryRecord(start({ attemptId: "a\u001bb" }))).toThrow("Invalid history identity");
  expect(() => serializeHistoryRecord(start({ workspaceRoot: "relative/root" }))).toThrow("Invalid history identity");
  expect(() => serializeHistoryRecord(start({ ordinal: 0 }))).toThrow("Invalid history identity");
  expect(() => serializeHistoryFinalize(finalize({ attemptId: "" }))).toThrow("Invalid history identity");
});

test("session deletion removes evidence under the history lock and blocks recreation", async () => {
  const home = await temp();
  const session = await savedSession(home);
  const store = openHistoryStore({ home });
  await store.start(session.header.id, start());
  const lock = new Database(join(home, ".schway", "history.lock"));
  lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  try {
    await expect(deleteJsonlSession({ directory: sessionsDirectory(home), home, id: session.header.id })).rejects.toMatchObject({ code: HISTORY_STORE_BUSY });
    // A busy history lock leaves both the session and its evidence intact.
    expect(await Bun.file(join(sessionsDirectory(home), `${session.header.id}.jsonl`)).exists()).toBe(true);
    expect(await Bun.file(historyFilePath(home, session.header.id)).exists()).toBe(true);
  } finally { lock.close(); }
  await deleteJsonlSession({ directory: sessionsDirectory(home), home, id: session.header.id });
  expect(await Bun.file(join(sessionsDirectory(home), `${session.header.id}.jsonl`)).exists()).toBe(false);
  expect(await Bun.file(historyFilePath(home, session.header.id)).exists()).toBe(false);
  await expect(store.start(session.header.id, start({ attemptId: "late" }))).rejects.toMatchObject({ code: "HISTORY_SESSION_MISSING" });
  expect(await Bun.file(historyFilePath(home, session.header.id)).exists()).toBe(false);
});

test("deletion always takes the history lock, even before any history exists, and waits for a writer", async () => {
  const home = await temp();
  const session = await savedSession(home);
  // A first writer holds the lock before the history directory exists.
  const lock = new Database(join(home, ".schway", "history.lock"), { create: true });
  lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  const sessionPath = join(sessionsDirectory(home), `${session.header.id}.jsonl`);
  let settled = false;
  const deletion = deleteJsonlSession({ directory: sessionsDirectory(home), home, id: session.header.id }).finally(() => { settled = true; });
  await Bun.sleep(100);
  // Nothing irreversible happens while the writer owns the lock.
  expect(settled).toBe(false);
  expect(await Bun.file(sessionPath).exists()).toBe(true);
  // The writer publishes its first evidence while it still holds the lock, then releases it.
  await mkdir(historyDirectory(home), { recursive: true });
  await writeFile(historyFilePath(home, session.header.id), `${JSON.stringify({ type: "history", version: 1, sessionId: session.header.id, createdAt: "2026-01-15T09:30:00.000Z" })}\n`);
  lock.close();
  await deletion;
  expect(await Bun.file(sessionPath).exists()).toBe(false);
  expect(await Bun.file(historyFilePath(home, session.header.id)).exists()).toBe(false);
  await expect(openHistoryStore({ home }).start(session.header.id, start())).rejects.toMatchObject({ code: "HISTORY_SESSION_MISSING" });
  expect(await Bun.file(historyFilePath(home, session.header.id)).exists()).toBe(false);
});

test("a busy history lock stops deletion before the draft, undo data or session change", async () => {
  const home = await temp();
  const session = await savedSession(home);
  const draft = openDraftStore({ home, workspaceRoot: session.header.workspaceRoot, sessionId: session.header.id });
  expect(draft.save("keep this draft", 1)).toBe(true);
  await openUndoStore({ home }).recordShell({ sessionId: session.header.id, turnId: "t", turnNumber: 1 }, { detection: "unavailable" });
  const lock = new Database(join(home, ".schway", "history.lock"), { create: true });
  lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  try {
    await expect(deleteJsonlSession({ directory: sessionsDirectory(home), home, id: session.header.id })).rejects.toMatchObject({ code: HISTORY_STORE_BUSY });
  } finally { lock.close(); }
  expect(openDraftStore({ home, workspaceRoot: session.header.workspaceRoot, sessionId: session.header.id }).checkpoint?.text).toBe("keep this draft");
  expect((await openUndoStore({ home }).list(session.header.id)).map(manifest => manifest.turnId)).toEqual(["t"]);
  expect(await Bun.file(join(sessionsDirectory(home), `${session.header.id}.jsonl`)).exists()).toBe(true);
});

/** Run a store operation in a child process with `node:fs/promises` partly replaced. */
async function withFaultyFs(home: string, sessionId: string, patch: string) {
  const script = `
    import { mock } from "bun:test";
    const fs = await import("node:fs/promises");
    ${patch}
    const { openHistoryStore } = await import(${JSON.stringify(join(import.meta.dir, "../src/history/store.ts"))});
    const store = openHistoryStore({ home: ${JSON.stringify(home)} });
    try { await store.start(${JSON.stringify(sessionId)}, ${JSON.stringify(start())}); console.log("saved"); }
    catch (error) { console.log(error.code ?? error.message); }
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, errors).toBe(0);
  return output.trim();
}

test("a failed sidecar creation never leaves a torn header that blocks later history", async () => {
  const home = await temp();
  const session = await savedSession(home);
  // Publication fails after the temporary header was written, as a crash or full disk would.
  expect(await withFaultyFs(home, session.header.id, `mock.module("node:fs/promises", () => ({ ...fs, link: async () => { throw Object.assign(new Error("full"), { code: "ENOSPC" }); } }));`)).toBe("ENOSPC");
  expect(await Bun.file(historyFilePath(home, session.header.id)).exists()).toBe(false);
  expect((await readdir(historyDirectory(home))).filter(name => name.endsWith(".tmp"))).toEqual([]);
  // The next attempt creates a valid sidecar.
  await openHistoryStore({ home }).start(session.header.id, start());
  expect((await openHistoryStore({ home }).read(session.header.id)).starts).toHaveLength(1);
});

test("short writes are completed and a stalled write is reported instead of a torn append", async () => {
  const home = await temp();
  const session = await savedSession(home);
  const shortWrites = `const realOpen = fs.open;
    mock.module("node:fs/promises", () => ({ ...fs, open: async (...args) => {
      const handle = await realOpen(...args);
      const write = handle.write.bind(handle);
      handle.write = (buffer, offset, length) => write(buffer, offset, Math.min(length, 7));
      return handle;
    } }));`;
  expect(await withFaultyFs(home, session.header.id, shortWrites)).toBe("saved");
  const read = await openHistoryStore({ home }).read(session.header.id);
  expect(read).toMatchObject({ status: "ok", rejected: 0, tornTail: false });
  expect(read.starts).toHaveLength(1);
  const stalled = `const realOpen = fs.open;
    mock.module("node:fs/promises", () => ({ ...fs, open: async (...args) => {
      const handle = await realOpen(...args);
      handle.write = async () => ({ bytesWritten: 0 });
      return handle;
    } }));`;
  expect(await withFaultyFs(home, session.header.id, stalled)).toBe("EIO");
});

test("the bounded reader rejects malformed, oversized and mismatched lines and ignores a torn tail without writing", async () => {
  const home = await temp();
  const session = await savedSession(home);
  const store = openHistoryStore({ home });
  await store.start(session.header.id, start());
  const path = historyFilePath(home, session.header.id);
  const oversized = JSON.stringify(finalize({ files: { total: 1, truncated: false, items: [{ path: "x".repeat(10 * 1024 * 1024), source: "tool" }] } }));
  await appendFile(path, `{not json\n${JSON.stringify({ type: "turn_start", version: 2 })}\n${oversized}\n${JSON.stringify(finalize())}\n{"type":"turn_fin`);
  const before = await readFile(path), info = await stat(path);
  const read = await store.read(session.header.id);
  expect(read.status).toBe("ok");
  expect(read.rejected).toBe(3);
  expect(read.tornTail).toBe(true);
  expect(read.finalizes).toHaveLength(1);
  expect((await readFile(path)).equals(before)).toBe(true);
  expect((await stat(path)).mtimeMs).toBe(info.mtimeMs);
  // The next append starts a fresh line, leaving the torn fragment as one rejected record.
  await store.finalize(session.header.id, finalize({ revision: 2 }));
  const after = await store.read(session.header.id);
  expect(after.tornTail).toBe(false);
  expect(after.rejected).toBe(4);
  expect(after.finalizes.map(record => record.revision)).toEqual([1, 2]);
});

test("a newer header is unsupported, a foreign or oversized header is unreadable, and readers stay offline", async () => {
  const home = await temp();
  await mkdir(historyDirectory(home), { recursive: true });
  await writeFile(historyFilePath(home, "future"), `${JSON.stringify({ type: "history", version: 2, sessionId: "future", createdAt: "2026-01-15T09:30:00.000Z" })}\n`);
  await writeFile(historyFilePath(home, "foreign"), `${JSON.stringify({ type: "history", version: 1, sessionId: "other", createdAt: "2026-01-15T09:30:00.000Z" })}\n`);
  await writeFile(historyFilePath(home, "huge"), `${"x".repeat(200 * 1024)}\n`);
  const store = openHistoryStore({ home });
  expect((await store.read("future")).status).toBe("unsupported");
  expect((await store.read("foreign")).status).toBe("unreadable");
  expect((await store.read("huge")).status).toBe("unreadable");
  expect((await store.read("absent")).status).toBe("missing");
  expect(await Bun.file(join(home, ".schway", "history.lock")).exists()).toBe(false);
});

/** A path of `count` repeated units, kept under the per-path byte limit. */
const pathOf = (unit: string, index: number) => `${index}/${unit.repeat(Math.floor(3800 / Buffer.byteLength(unit)))}`;

test.each([
  ["worst-case JSON escaping", "\"\\"],
  ["multibyte Thai with combining marks", "ก้"],
  ["emoji ZWJ sequences", "👩‍💻"],
  ["decomposed accents", "é"],
])("finalize records fit 128 KiB with %s by omitting whole trailing entries", (_name, unit) => {
  const items: HistoryFile[] = Array.from({ length: 200 }, (_, index) => ({ path: pathOf(unit, index), source: "tool", added: 1, removed: 0 }));
  const line = serializeHistoryFinalize(finalize({ files: { total: 213, truncated: false, items } }));
  expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_HISTORY_RECORD_BYTES);
  expect(line.endsWith("\n")).toBe(true);
  const parsed = parseHistoryLine(line.slice(0, -1));
  expect(parsed?.type).toBe("turn_finalize");
  const record = parsed as HistoryTurnFinalize;
  expect(record.files.truncated).toBe(true);
  expect(record.files.total).toBe(213);
  expect(record.files.items.length).toBeGreaterThan(0);
  expect(record.files.items.length).toBeLessThan(200);
  // Kept entries are an unaltered prefix, never byte-sliced.
  expect(record.files.items).toEqual(items.slice(0, record.files.items.length));
  // One more entry would not have fit.
  const next = Buffer.byteLength(JSON.stringify(items[record.files.items.length])) + 1;
  expect(Buffer.byteLength(line) + next).toBeGreaterThan(MAX_HISTORY_RECORD_BYTES);
});

test("a record exactly at the 128 KiB boundary keeps every entry and one more byte truncates", () => {
  const head: HistoryFile[] = [];
  const build = (length: number) => {
    const all: HistoryFile[] = [...head, { path: "z".repeat(length), source: "tool" }];
    return { all, line: serializeHistoryFinalize(finalize({ files: { total: 199, truncated: true, items: all } })) };
  };
  // Grow combining-mark entries until less than one path's worth of bytes remains.
  while (Buffer.byteLength(build(1).line) < MAX_HISTORY_RECORD_BYTES - 3000) head.push({ path: `${head.length}/${"ก้".repeat(400)}`, source: "shell" });
  const probe = build(1);
  expect((parseHistoryLine(probe.line.slice(0, -1)) as HistoryTurnFinalize).files.items).toHaveLength(head.length + 1);
  const exact = build(1 + MAX_HISTORY_RECORD_BYTES - Buffer.byteLength(probe.line));
  expect(Buffer.byteLength(exact.line)).toBe(MAX_HISTORY_RECORD_BYTES);
  expect((parseHistoryLine(exact.line.slice(0, -1)) as HistoryTurnFinalize).files.items).toEqual(exact.all);
  const over = build(2 + MAX_HISTORY_RECORD_BYTES - Buffer.byteLength(probe.line));
  expect(Buffer.byteLength(over.line)).toBeLessThan(MAX_HISTORY_RECORD_BYTES);
  expect((parseHistoryLine(over.line.slice(0, -1)) as HistoryTurnFinalize).files.items).toEqual(head);
});

test("item counts apply before byte trimming and keep totals", () => {
  const commands = Array.from({ length: 70 }, (_, index) => ({ id: index.toString(16).padStart(16, "0"), command: `echo ${index}`, exitCode: 0, ended: "exit" as const, status: "success" as const }));
  const record = parseHistoryLine(serializeHistoryFinalize(finalize({ commands: { total: 70, exitZero: 70, nonzero: 0, unknown: 0, truncated: false, items: commands } })).trim()) as HistoryTurnFinalize;
  expect(record.commands.items).toHaveLength(50);
  expect(record.commands.items.at(-1)?.command).toBe("echo 49");
  expect(record.commands).toMatchObject({ total: 70, truncated: true });
});

test("excerpts keep at most 160 graphemes, cutting only at grapheme boundaries", () => {
  const thai = historyExcerpt("ก้".repeat(200), []);
  expect(thai.truncated).toBe(true);
  expect(thai.text).toBe("ก้".repeat(160));
  const emoji = historyExcerpt("👩‍💻".repeat(200), []);
  expect([...new Intl.Segmenter().segment(emoji.text!)].length).toBe(160);
  expect(emoji.text!.endsWith("👩‍💻")).toBe(true);
  expect(historyExcerpt("x".repeat(160), [])).toEqual({ text: "x".repeat(160), truncated: false, hidden: false });
});

test("heavy combining marks shorten an excerpt but never empty it", () => {
  const zalgo = historyExcerpt(`a${"\u0301".repeat(500)} rest`, []);
  expect(zalgo).toEqual({ text: "a rest", truncated: true, hidden: false });
  const stacked = historyExcerpt(`${"e\u0301\u0302".repeat(10)}${"z\u0300".repeat(200)}`, []);
  expect(stacked.text!.startsWith("e\u0301\u0302")).toBe(true);
  expect([...new Intl.Segmenter().segment(stacked.text!)].length).toBe(160);
  // A record built from the worst case stays well within the line limit.
  const line = serializeHistoryRecord(start({ task: historyExcerpt(`${"q".concat("\u0301".repeat(31))}`.repeat(400), []).text }));
  expect(Buffer.byteLength(line)).toBeLessThan(MAX_HISTORY_RECORD_BYTES);
  expect(historyCommandSummary(`b${"\u0301".repeat(400)}`, []).text).toBe("b");
});

test("sanitizing strips terminal controls and redacts secrets before bounding", () => {
  const secret = "hunter2-known-value";
  const excerpt = historyExcerpt(`Deploy \u001b]8;;https://evil\u0007with\u001b[31m ${secret}\u001b[0m now‮`, [secret]);
  expect(excerpt.text).toBe("Deploy with *** now");
  expect(historyExcerpt("/login openai", [])).toMatchObject({ hidden: true });
  expect(historyExcerpt("my api_key=abc", [])).toMatchObject({ hidden: true });
  const command = historyCommandSummary(`curl -H 'Authorization: Bearer abc.def' https://x.test/?token=zzz\u001b[2J; echo ${secret}\n${"y".repeat(400)}`, [secret]);
  expect(command.truncated).toBe(true);
  expect([...command.text].length).toBeLessThanOrEqual(200);
  expect(command.text).not.toContain(secret);
  expect(command.text).not.toContain("abc.def");
  expect(command.text).not.toContain("zzz");
  expect(command.text).not.toContain("\u001b");
  expect(historyPath(`src/\u001b[31mred\u0007.ts`, [])).toBe("src/red�.ts");
  expect(historyPath("a".repeat(5000), [])).toBeUndefined();
});
