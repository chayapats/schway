import { Database } from "bun:sqlite";
import { closeSync, constants, openSync } from "node:fs";
import { chmod, link, lstat, mkdir, open, rm, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { HISTORY_FORMAT_VERSION, MAX_HISTORY_RECORD_BYTES, isHistorySessionId, parseHistoryLine, serializeHistoryFinalize, serializeHistoryRecord,
  type HistoryHeader, type HistoryTurnFinalize, type HistoryTurnStart } from "./records.ts";

/** Result of one bounded sidecar read; nothing is repaired or rewritten. */
export interface HistoryRead {
  /** missing: no sidecar; unsupported: written by a newer format; unreadable: header or file could not be validated. */
  status: "ok" | "missing" | "unsupported" | "unreadable";
  starts: HistoryTurnStart[];
  finalizes: HistoryTurnFinalize[];
  /** Complete lines rejected as malformed, oversized, mismatched or of an unknown kind. */
  rejected: number;
  /** A final line without LF, left by an interrupted append, was ignored. */
  tornTail: boolean;
}

/** Append-only private evidence store for accepted turns, separate from canonical session records. */
export interface HistoryStore {
  /** Persist one attempt start, creating the private sidecar and its header only while the saved session exists. */
  start(sessionId: string, record: HistoryTurnStart): Promise<void>;
  /** Append one bounded, revisioned attempt outcome to an existing sidecar. */
  finalize(sessionId: string, record: HistoryTurnFinalize): Promise<void>;
  /** Read and validate every complete line with a bounded line reader, never writing. */
  read(sessionId: string): Promise<HistoryRead>;
}

/** Error thrown when the sidecar's saved session no longer exists, so evidence is never recreated after deletion. */
export const HISTORY_SESSION_MISSING = "HISTORY_SESSION_MISSING";
/** Error code for lock contention that outlasted the bounded wait. */
export const HISTORY_STORE_BUSY = "HISTORY_STORE_BUSY";

/** Join `<home>/.schway/history` without touching the filesystem. */
export function historyDirectory(home: string): string {
  return join(home, ".schway", "history");
}

/** Resolve `<home>/.schway/history/<session-id>.jsonl`, rejecting identities that are not one safe file-name component. */
export function historyFilePath(home: string, sessionId: string): string {
  if (!isHistorySessionId(sessionId)) throw new Error(`Invalid history session id: ${sessionId}`);
  return join(historyDirectory(home), `${sessionId}.jsonl`);
}

/** Open the sidecar store under `home`; nothing is created until a turn start is recorded. */
export function openHistoryStore({ home, lockWaitMs = 1000 }: { home: string; lockWaitMs?: number }): HistoryStore {
  const sessionFile = (id: string) => join(home, ".schway", "sessions", `${id}.jsonl`);
  /** Append complete lines, starting a fresh line if an earlier append was torn. */
  const append = async (sessionId: string, line: string, create: boolean) => {
    const path = historyFilePath(home, sessionId);
    await withHistoryLock(home, lockWaitMs, async () => {
      const existing = await lstat(path).catch(error => { if (isErrno(error, "ENOENT")) return undefined; throw error; });
      if (!existing) {
        if (!create) throw Object.assign(new Error("History start was not recorded"), { code: "ENOENT" });
        // Evidence follows the saved-session lifecycle: never create it for an absent or deleted session.
        await stat(sessionFile(sessionId)).catch(error => {
          if (isErrno(error, "ENOENT")) throw Object.assign(new Error("Saved session not found"), { code: HISTORY_SESSION_MISSING });
          throw error;
        });
        await mkdir(historyDirectory(home), { recursive: true, mode: 0o700 });
        await chmod(historyDirectory(home), 0o700);
        const header: HistoryHeader = { type: "history", version: HISTORY_FORMAT_VERSION, sessionId, createdAt: new Date().toISOString() };
        // Publish the header and first record atomically: a crash or full disk leaves at most a temporary file, never a torn sidecar.
        const temp = join(historyDirectory(home), `.${sessionId}.${crypto.randomUUID()}.tmp`);
        try {
          const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { await writeAll(file, serializeHistoryRecord(header) + line); await file.sync(); } finally { await file.close(); }
          // A hard link never replaces an existing sidecar, unlike rename.
          await link(temp, path);
        } finally { await unlink(temp).catch(() => {}); }
        return;
      }
      if (!existing.isFile()) throw new Error("History sidecar is not a regular file");
      const file = await open(path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        const head = Buffer.alloc(Math.min(info.size, 4096));
        await file.read(head, 0, head.length, 0);
        const first = head.toString("utf8").split("\n", 1)[0] ?? "";
        const header = parseHistoryLine(first);
        if (header?.type !== "history" || header.sessionId !== sessionId || !head.includes(10)) throw new Error("History sidecar header does not match its session");
        const last = Buffer.alloc(1);
        if (info.size > 0) await file.read(last, 0, 1, info.size - 1);
        await writeAll(file, info.size > 0 && last[0] !== 10 ? `\n${line}` : line);
        await file.sync();
      } finally { await file.close(); }
    });
  };
  return {
    async start(sessionId, record) { await append(sessionId, serializeHistoryRecord(record), true); },
    async finalize(sessionId, record) { await append(sessionId, serializeHistoryFinalize(record), false); },
    read: sessionId => readHistory(home, sessionId),
  };
}

/** Write every byte, retrying short writes; a write that makes no progress fails so a torn append is never reported as saved. */
async function writeAll(file: FileHandle, text: string): Promise<void> {
  const bytes = Buffer.from(text, "utf8");
  for (let offset = 0; offset < bytes.length;) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
    if (bytesWritten <= 0) throw Object.assign(new Error("History write made no progress"), { code: "EIO" });
    offset += bytesWritten;
  }
}

/** Stream complete LF-terminated lines, discarding any line over 128 KiB without buffering it whole. */
async function readHistory(home: string, sessionId: string): Promise<HistoryRead> {
  const result: HistoryRead = { status: "ok", starts: [], finalizes: [], rejected: 0, tornTail: false };
  let file;
  try { file = await open(historyFilePath(home, sessionId), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { return { ...result, status: isErrno(error, "ENOENT") ? "missing" : "unreadable" }; }
  try {
    if (!(await file.stat()).isFile()) return { ...result, status: "unreadable" };
    const chunk = Buffer.alloc(64 * 1024);
    let pending: Buffer[] = [], pendingBytes = 0, oversized = false, first = true;
    const accept = (line: Buffer): boolean => {
      const record = parseHistoryLine(line.toString("utf8"));
      if (first) {
        first = false;
        if (record?.type === "history" && record.sessionId === sessionId) return true;
        const raw = (() => { try { return JSON.parse(line.toString("utf8")) as Record<string, unknown>; } catch { return undefined; } })();
        result.status = raw?.type === "history" && typeof raw.version === "number" && raw.version > HISTORY_FORMAT_VERSION ? "unsupported" : "unreadable";
        return false;
      }
      if (record?.type === "turn_start") result.starts.push(record);
      else if (record?.type === "turn_finalize") result.finalizes.push(record);
      else result.rejected++;
      return true;
    };
    for (let position = 0; ;) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      let start = 0;
      for (let index = chunk.indexOf(10, 0); index !== -1 && index < bytesRead; index = chunk.indexOf(10, start)) {
        const piece = chunk.subarray(start, index);
        start = index + 1;
        if (oversized || pendingBytes + piece.length + 1 > MAX_HISTORY_RECORD_BYTES) {
          if (first) { result.status = "unreadable"; return result; }
          result.rejected++;
        } else if (!accept(Buffer.concat([...pending, piece]))) return result;
        pending = []; pendingBytes = 0; oversized = false;
      }
      if (start < bytesRead && !oversized) {
        const rest = chunk.subarray(start, bytesRead);
        // Stop buffering once a line can no longer fit; skip to its LF without allocating it.
        if (pendingBytes + rest.length + 1 > MAX_HISTORY_RECORD_BYTES) { oversized = true; pending = []; pendingBytes = 0; }
        else { pending.push(Buffer.from(rest)); pendingBytes += rest.length; }
      }
    }
    if (pendingBytes > 0 || oversized) result.tornTail = true;
    if (first) result.status = "unreadable";
    return result;
  } catch { return { ...result, status: "unreadable" }; }
  finally { await file.close(); }
}

/**
 * Run a session deletion while holding the history lock, then remove its evidence, so a concurrent first
 * writer can neither create nor append evidence for the deleted session. The lock is always taken, even
 * before any history exists, and is acquired before `remove` runs, so a busy lock changes nothing.
 */
export async function deleteHistorySession({ home, sessionId, lockWaitMs = 1000 }: { home: string; sessionId: string; lockWaitMs?: number }, remove: () => Promise<void> = async () => {}): Promise<void> {
  return withHistoryLock(home, lockWaitMs, async () => {
    await remove();
    // An identity the store could never write has no evidence to remove.
    if (isHistorySessionId(sessionId)) await rm(historyFilePath(home, sessionId), { force: true });
  });
}

/** Exclude sidecar publication and deletion across processes with an OS-released SQLite lock and a bounded asynchronous wait. */
async function withHistoryLock<T>(home: string, waitMs: number, operation: () => Promise<T>): Promise<T> {
  const directory = join(home, ".schway");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Like the undo lock, this inode is never removed, and only SQLite opens it once created.
  const path = join(directory, "history.lock");
  try { closeSync(openSync(path, "wx", 0o600)); }
  catch (error) { if (!isErrno(error, "EEXIST")) throw error; }
  const lock = new Database(path);
  try {
    const deadline = Date.now() + waitMs;
    for (;;) {
      try { lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE"); break; }
      catch (error) {
        if (!isErrno(error, "SQLITE_BUSY") && !isErrno(error, "SQLITE_LOCKED")) throw error;
        if (Date.now() >= deadline) throw Object.assign(new Error("History store busy"), { code: HISTORY_STORE_BUSY });
        await Bun.sleep(20);
      }
    }
    return await operation();
  } finally { lock.close(); }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === code;
}
