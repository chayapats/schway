import { validateImageContent } from "../conversation/images.ts";
import { appendFileSync, writeFileSync, renameSync, unlinkSync, openSync, readSync, closeSync, readFileSync, lstatSync, fsyncSync, writeSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { openDraftStore } from "../drafts/store.ts";
import { deleteUndoSession } from "../undo/store.ts";
import { deleteHistorySession } from "../history/store.ts";
import { basename, dirname, join } from "node:path";
import type {
  AssistantContent,
  AssistantTelemetry,
  CompactionRecord,
  ConversationItem,
  SessionRecord,
  ToolTelemetry,
  UserContent,
} from "../conversation/types.ts";
import type { Workspace } from "../workspace/workspace.ts";
import { createSession, type Session } from "./session.ts";
import { applyBranchOperation, emptyBranchState, branchAncestry, pendingCalls, type BranchOperation, type BranchState, type SessionEntry } from "./branches.ts";

/** Current session format, storing atomic branch operations separately from session-wide metadata. */
export const SESSION_FORMAT_VERSION = 4;

/** Versioned first JSONL record identifying the session and the workspace restored when it is resumed. */
export interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  createdAt: string;
  workspaceRoot: string;
  launchCwd: string;
  extraRoots: string[];
}

/** Session with a persisted header whose appends synchronously write JSONL before updating in-memory history. */
export interface JsonlSession extends Session {
  readonly header: SessionHeader;
  /** Reject an altered managed artifact or lost ownership before another request or write. */
  assertCurrent(): void;
  /** Materialize a deferred header for a completed draft checkpoint without adding conversation. */
  ensurePersisted(): void;
  /** Whether a resume target exists on disk. */
  readonly persisted: boolean;
  /** Capture an unmaterialized header for an isolated exit checkpoint writer. */
  deferredCheckpoint(): { path: string; header: SessionHeader } | undefined;
}

/** Managed persistence fences external changes and flushes accepted records before publication. */
export interface ManagedSessionStorage { assertOwnership(): void }

/** An external writer changed a managed artifact; reopen under exclusive ownership before continuing. */
export class SessionConflictError extends Error {
  constructor() { super("Session writer changed"); this.name = "SessionConflictError"; }
}

/** Create a workspace-bound session, optionally deferring its JSONL header until the first durable mutation. */
export async function createJsonlSession(options: {
  directory: string;
  workspace: Workspace;
  /** Preallocated managed identity whose writer lease is already held. */
  id?: string;
  /** Keep an untouched interactive conversation in memory until its first durable mutation. */
  deferred?: boolean;
  managed?: ManagedSessionStorage;
}): Promise<JsonlSession> {
  const header: SessionHeader = {
    type: "session",
    version: SESSION_FORMAT_VERSION,
    id: options.id ?? crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    workspaceRoot: options.workspace.root,
    launchCwd: options.workspace.launchCwd,
    extraRoots: [...options.workspace.extraRoots],
  };
  await mkdir(options.directory, { recursive: true });
  const path = sessionFilePath(options.directory, header.id);
  if (!options.deferred && !options.managed) await writeFile(path, `${JSON.stringify(header)}\n`, "utf8");
  else if (!options.deferred) {
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(`${JSON.stringify(header)}\n`, "utf8"); if (options.managed) await file.sync(); }
    finally { await file.close(); }
    if (options.managed) { const dir = openSync(options.directory, "r"); try { fsyncSync(dir); } finally { closeSync(dir); } }
  }
  return openPersisted(path, header, emptyBranchState(header.id), header.extraRoots, header.version, options.deferred, options.managed);
}

/** Join the supplied home directory with `.schway/sessions` without accessing the filesystem. */
export function sessionsDirectory(home: string): string {
  return join(home, ".schway", "sessions");
}

/** Session identity, creation timestamp, and workspace root shown by session pickers. */
export interface SessionSummary {
  id: string;
  createdAt: string;
  workspaceRoot: string;
}

/**
 * List persisted sessions newest-first by header timestamp.
 * Missing directories yield an empty list; unreadable files and invalid or oversized headers are skipped.
 * Other directory-read errors propagate, and conversation records are not inspected.
 */
export async function listSessions(directory: string): Promise<SessionSummary[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }
  const summaries: SessionSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) {
      continue;
    }
    let firstLine: string | undefined;
    try {
      firstLine = await readFirstLine(join(directory, entry));
    } catch {
      continue;
    }
    if (firstLine === undefined) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(firstLine);
    } catch {
      continue;
    }
    if (!isSessionHeader(parsed)) {
      continue;
    }
    summaries.push({
      id: parsed.id,
      createdAt: parsed.createdAt,
      workspaceRoot: parsed.workspaceRoot,
    });
  }
  summaries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return summaries;
}

/** Read only the first line of a session file; headers stay small while transcripts grow. */
async function readFirstLine(path: string): Promise<string | undefined> {
  const handle = await open(path, "r");
  try {
    // Session headers are a few hundred bytes; one small read covers them.
    // A first line longer than the window is treated as invalid so one
    // corrupt or oversized file cannot force a full read during discovery.
    const chunk = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, 0);
    const text = chunk.subarray(0, bytesRead).toString("utf8");
    const newline = text.indexOf("\n");
    if (newline !== -1) {
      const line = text.slice(0, newline);
      return line.length > 0 ? line : undefined;
    }
    if (bytesRead < chunk.length) {
      return text.length > 0 ? text : undefined;
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

/** Why `loadJsonlSession` refused a session before reading its records, or after validating them; the message is unchanged. */
export type SessionLoadFailure = "not-found" | "invalid-id" | "repair-failed";

/** A `loadJsonlSession` failure with a known `reason`; other load errors are file-read errors or invalid contents. */
export class SessionLoadError extends Error {
  constructor(readonly reason: SessionLoadFailure, message: string, options?: { cause?: unknown }) { super(message, options); this.name = "SessionLoadError"; }
}

/** Restore selected ancestry, rejecting semantic corruption and repairing torn tails and selected interrupted calls without tool replay. */
export async function loadJsonlSession(options: {
  directory: string;
  id: string;
  branchId?: string;
  /** Validate managed identity before any torn-tail repair or interrupted-call settlement writes. */
  validateIdentity?: (workspaceRoot: string, extraRoots: readonly string[]) => void;
  managed?: ManagedSessionStorage;
}): Promise<JsonlSession> {
  let path: string;
  try { path = sessionFilePath(options.directory, options.id); }
  catch (error) { throw new SessionLoadError("invalid-id", error instanceof Error ? error.message : String(error)); }
  let text: string;
  try {
    if (options.managed) { options.managed.assertOwnership(); managedFileIdentity(path); }
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      throw new SessionLoadError("not-found", `Session not found: ${options.id}`);
    }
    throw error;
  }
  options.managed?.assertOwnership();
  const loaded = loadRecords(text);
  if (loaded.header.id !== options.id) throw new Error("Session header ID does not match the requested session");
  options.validateIdentity?.(loaded.header.workspaceRoot, loaded.extraRoots);
  // Validate selection and settlement before repairing bytes or writing any durable operation.
  const staged: BranchOperation[] = [];
  const candidate = createSession([], loaded.extraRoots, { state: loaded.state, writeOperation: operation => staged.push(operation) });
  candidate.selectBranch(options.branchId ?? candidate.activeBranchId);
  if (loaded.text !== text) {
    try { await replaceFile(path, loaded.text, options.managed); }
    catch (error) { throw new SessionLoadError("repair-failed", error instanceof Error ? error.message : String(error), { cause: error }); }
  }
  const session = openPersisted(path, loaded.header, loaded.state, loaded.extraRoots, loaded.version, false, options.managed, loaded.text);
  session.assertCurrent();
  // Recompute fresh settlement IDs only after validation and any safe trailing repair succeed.
  if (staged.length) session.selectBranch(options.branchId ?? session.activeBranchId);
  return session;
}

/** Resolve `<id>.jsonl` under `directory`. Rejects ids that escape the directory. */
function sessionFilePath(directory: string, id: string): string {
  if (id.length === 0 || id !== basename(id) || id === "." || id === "..") {
    throw new Error(`Invalid session id: ${id}`);
  }
  return join(directory, `${id}.jsonl`);
}

/** Refuse file aliases so separate managed stores cannot lease the same underlying conversation. */
function managedFileIdentity(path: string) {
  const info = lstatSync(path);
  if (!info.isFile() || info.nlink !== 1) throw new SessionConflictError();
  return info;
}

/** Bind atomic branch operations and separate workspace metadata to append-only version upgrades. */
function openPersisted(path: string, header: SessionHeader, state: BranchState, extraRoots: readonly string[], version: number, deferred = false, managed?: ManagedSessionStorage, expectedText?: string): JsonlSession {
  let failed = false;
  let failure: unknown;
  let expected = managed && !deferred ? expectedText === undefined ? readFileSync(path) : Buffer.from(expectedText) : undefined;
  let identity = managed && !deferred ? managedFileIdentity(path) : undefined;
  const assertCurrent = () => {
    if (!managed) return;
    if (failed) throw failure;
    managed.assertOwnership();
    if (expected) {
      const current = readFileSync(path), info = managedFileIdentity(path);
      if (identity!.dev !== info.dev || identity!.ino !== info.ino || !expected.equals(current)) throw new SessionConflictError();
    }
  };
  let discovery: { activityAt?: string; title?: string } = {};
  try {
    const fd = openSync(`${path}.meta`, "r");
    try {
      const buffer = Buffer.alloc(2048);
      const count = readSync(fd, buffer, 0, buffer.length, 0);
      const cached = JSON.parse(buffer.subarray(0, count).toString("utf8"));
      if (isPlainObject(cached)) discovery = {
        ...(typeof cached.activityAt === "string" ? { activityAt: cached.activityAt } : {}),
        ...(typeof cached.title === "string" ? { title: safeTaskText(cached.title) } : {}),
      };
    } finally { closeSync(fd); }
  } catch { /* Optional bounded discovery cache. */ }
  /** Fence this handle after uncertain I/O so retries cannot append behind a partial durable write. */
  const write = (text: string): void => {
    if (failed) throw new Error("Session storage previously failed; reload the session before writing again");
    try {
      assertCurrent();
      if (deferred) {
        writeFileSync(path, `${JSON.stringify(header)}\n${text}`, { encoding: "utf8", flag: "wx", mode: 0o600 });
        if (managed) {
          const fd = openSync(path, "r+");
          try { fsyncSync(fd); } finally { closeSync(fd); }
          const directory = openSync(dirname(path), "r");
          try { fsyncSync(directory); } finally { closeSync(directory); }
        }
        deferred = false;
      }
      else if (managed) {
        const fd = openSync(path, "a");
        try {
          const bytes = Buffer.from(text);
          let offset = 0;
          while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
          fsyncSync(fd);
        } finally { closeSync(fd); }
      } else appendFileSync(path, text, "utf8");
      if (managed) {
        expected = expected ? Buffer.concat([expected, Buffer.from(text)]) : Buffer.from(`${JSON.stringify(header)}\n${text}`);
        identity ??= managedFileIdentity(path);
        assertCurrent();
      }
    } catch (error) { failed = true; failure = error; throw error; }
  };
  const session = createSession([], extraRoots, {
    state,
    writeOperation(operation) {
      if (operation.type === "branch_append") for (const entry of operation.entries) {
        if (entry.item.type === "user") for (const part of entry.item.content) {
          if (part.type === "image") validateImageContent(part);
        }
      }
      const hasUndo = operation.type === "branch_append" && operation.entries.some(entry => entry.item.type === "turn_undo");
      const nextVersion = hasUndo ? 4 : Math.max(version, 3);
      const prefix = version < nextVersion ? JSON.stringify({ type: "session_format", version: nextVersion }) + "\n" : "";
      const committedAt = operation.type === "branch_append" && operation.entries.some(entry => entry.item.type !== "compaction") ? new Date().toISOString() : undefined;
      const line = JSON.stringify({ ...operation, ...(committedAt ? { committedAt } : {}) });
      write(prefix + line + "\n");
      version = nextVersion;
      if (committedAt && operation.type === "branch_append") {
        // All advisory work is fenced after the authoritative append succeeded.
        let temp: string | undefined;
        try {
          discovery.activityAt = committedAt;
          for (const entry of operation.entries) {
            const title = taskTitle(entry.item);
            if (title) discovery.title = title;
          }
          temp = `${path}.meta.${crypto.randomUUID()}.tmp`;
          writeFileSync(temp, JSON.stringify(discovery), { mode: 0o600 });
          renameSync(temp, `${path}.meta`);
        } catch {
          if (temp) { try { unlinkSync(temp); } catch {} }
          try { unlinkSync(`${path}.meta`); } catch {}
        }
      }
    },
    writeRoots(roots) {
      if (JSON.stringify(roots) === JSON.stringify(session.metadata.extraRoots)) return;
      const prefix = version === 1 ? JSON.stringify({ type: "session_format", version: 2 }) + "\n" : "";
      write(prefix + JSON.stringify({ type: "workspace_roots", version: 1, extraRoots: [...roots] }) + "\n");
      if (version === 1) version = 2;
    },
  });
  return Object.defineProperties(Object.assign(session, { header, assertCurrent, deferredCheckpoint() { return deferred ? { path, header } : undefined; }, ensurePersisted() { if (deferred) write(""); } }), { persisted: { get: () => !deferred } }) as JsonlSession;
}

/** Replay version-specific records without normalizing valid bytes or repairing semantic corruption. */
function loadRecords(text: string): { header: SessionHeader; state: BranchState; extraRoots: string[]; version: number; text: string } {
  const lines = [...text.matchAll(/([^\n]*)(\n|$)/g)].filter(match => match[0].length > 0);
  let first: unknown;
  try { first = JSON.parse(lines[0]?.[1] ?? ""); } catch { throw new Error("Session file is missing a versioned header"); }
  if (!isSessionHeader(first)) throw new Error("Session file is missing a versioned header");
  if (![1, 2, 3, 4].includes(first.version)) throw new Error(`Unsupported session format version ${first.version}. This Schway build reads versions 1, 2, 3 and 4.`);
  let state = emptyBranchState(first.id);
  let version = first.version;
  let extraRoots = [...first.extraRoots];
  let validLength = text.length;
  const lastNonempty = lines.findLastIndex(match => match[1]!.trim().length > 0);
  for (let i = 1; i < lines.length; i++) {
    const match = lines[i]!;
    if (!match[1]!.trim()) continue;
    let record: unknown;
    try { record = JSON.parse(match[1]!); } catch {
      if (i !== lastNonempty) throw new Error("Session file contains malformed interior JSON");
      validLength = match.index!;
      break;
    }
    if (!isPlainObject(record)) throw malformedRecord();
    if (record.type === "session_format") {
      if (![2, 3, 4].includes(record.version as number) || (record.version as number) <= version || "id" in record || "parentId" in record) throw new Error("Unsupported or invalid session format transition");
      version = record.version as number;
    } else if (record.type === "workspace_roots") {
      if (record.version !== 1) throw new Error("Unsupported workspace metadata version");
      if (version < 2) throw new Error("Workspace metadata requires session format 2, 3 or 4");
      if (!isRootList(record.extraRoots) || "id" in record || "parentId" in record) throw malformedRecord();
      extraRoots = [...record.extraRoots];
    } else state = version >= 3 ? replayBranchRecord(state, record, version) : replayLegacyRecord(state, record);
  }
  const prefix = text.slice(0, validLength);
  return { header: first, state, extraRoots, version, text: prefix.endsWith("\n") ? prefix : prefix + "\n" };
}

/** Validate legacy linear parents before importing their entries into the single default branch. */
function replayLegacyRecord(state: BranchState, record: Record<string, unknown>): BranchState {
  if (typeof record.parentId !== "string") throw new Error("Legacy session record is missing its parent ID");
  return applyBranchOperation(state, { type: "branch_append", version: 1, branchId: "main", entries: [{ parentId: record.parentId, item: toSessionRecord(record) }] });
}

/** Validate each branch-capable semantic operation before staging its graph and active head changes. */
function replayBranchRecord(state: BranchState, record: Record<string, unknown>, formatVersion: number): BranchState {
  if (record.version !== 1 || typeof record.branchId !== "string" || !record.branchId || "id" in record || "parentId" in record) throw new Error("Invalid branch operation version or identity");
  const branchId = record.branchId;
  if (record.type === "branch_fork") {
    if (typeof record.headId !== "string" || (record.name !== undefined && typeof record.name !== "string")) throw new Error("Invalid branch fork head or label");
    return applyBranchOperation(state, { type: "branch_fork", version: 1, branchId, headId: record.headId, ...(record.name === undefined ? {} : { name: record.name as string }) });
  }
  if (record.type === "branch_append") return applyBranchOperation(state, { type: "branch_append", version: 1, branchId, entries: parseEntries(record.entries, formatVersion) });
  if (record.type === "branch_select") return applyBranchOperation(state, { type: "branch_select", version: 1, branchId, settlements: parseEntries(record.settlements, formatVersion) });
  throw new Error(`Session format ${formatVersion} requires a valid branch operation`);
}

/** Decode entry payloads without accepting malformed IDs, parents, or conversation shapes. */
function parseEntries(value: unknown, formatVersion: number): SessionEntry[] {
  if (!Array.isArray(value)) throw new Error("Branch operation entries must be an array");
  return value.map(entry => {
    if (!isPlainObject(entry) || typeof entry.parentId !== "string") throw new Error("Branch entry is missing a valid parent ID");
    return { parentId: entry.parentId, item: toSessionRecord(entry.item, formatVersion) };
  });
}

/** Accept only nonempty string identities in saved attachment lists. */
function isRootList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(root => typeof root === "string" && root.length > 0);
}

/** Validate the initial workspace identity before interpreting any versioned records. */
function isSessionHeader(value: unknown): value is SessionHeader {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<SessionHeader>;
  return (
    record.type === "session" &&
    typeof record.version === "number" &&
    typeof record.id === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.workspaceRoot === "string" &&
    typeof record.launchCwd === "string" &&
    isRootList(record.extraRoots)
  );
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  );
}

/** Decode validated session items while rejecting record types unavailable in the active format version. */
function toSessionRecord(value: unknown, formatVersion = 1): SessionRecord {
  if (!isPlainObject(value) || typeof value.id !== "string" || value.id.length === 0) {
    throw malformedRecord();
  }
  if (value.type === "user") {
    if (!Array.isArray(value.content) || !value.content.every(isUserContent)) {
      throw malformedRecord();
    }
    return {
      type: "user",
      id: value.id,
      content: value.content,
    };
  }
  if (value.type === "assistant") {
    if (
      !Array.isArray(value.content) ||
      !value.content.every(isAssistantContent)
    ) {
      throw malformedRecord();
    }
    const item: ConversationItem = {
      type: "assistant",
      id: value.id,
      content: value.content,
    };
    if (value.providerMetadata !== undefined) {
      if (!isPlainObject(value.providerMetadata)) {
        throw malformedRecord();
      }
      item.providerMetadata = value.providerMetadata;
    }
    // Telemetry is optional evidence: a malformed value is dropped and never fails the conversation record.
    const telemetry = assistantTelemetry(value.telemetry);
    if (telemetry) item.telemetry = telemetry;
    return item;
  }
  if (value.type === "tool_result") {
    if (
      typeof value.toolCallId !== "string" ||
      typeof value.content !== "string" ||
      typeof value.isError !== "boolean"
    ) {
      throw malformedRecord();
    }
    const telemetry = toolTelemetry(value.telemetry);
    return {
      type: "tool_result",
      id: value.id,
      toolCallId: value.toolCallId,
      content: value.content,
      isError: value.isError,
      ...(telemetry ? { telemetry } : {}),
    };
  }
  if (value.type === "turn_undo") {
    if (formatVersion < 4 || typeof value.turnId !== "string" || !value.turnId || !Number.isInteger(value.turnNumber) || (value.turnNumber as number) < 1 || typeof value.note !== "string"
      || !Array.isArray(value.reverted) || !value.reverted.every(entry => isPlainObject(entry) && typeof entry.path === "string" && (entry.action === "restored" || entry.action === "deleted"))
      || !Array.isArray(value.skipped) || !value.skipped.every(entry => isPlainObject(entry) && typeof entry.path === "string" && (entry.reason === "changed" || entry.reason === "failed"))) throw malformedRecord();
    return { type: "turn_undo", id: value.id, turnId: value.turnId, turnNumber: value.turnNumber as number,
      reverted: value.reverted, skipped: value.skipped, note: value.note };
  }
  if (value.type === "compaction") {
    if (
      typeof value.summary !== "string" ||
      typeof value.firstKeptId !== "string" ||
      value.firstKeptId.length === 0 ||
      (value.parentCompactionId !== undefined &&
        (typeof value.parentCompactionId !== "string" || !value.parentCompactionId))
    ) {
      throw malformedRecord();
    }
    const record: CompactionRecord = {
      type: "compaction",
      id: value.id,
      summary: value.summary,
      firstKeptId: value.firstKeptId,
    };
    if (typeof value.tokensBefore === "number") {
      record.tokensBefore = value.tokensBefore;
    }
    if (
      typeof value.parentCompactionId === "string" &&
      value.parentCompactionId.length > 0
    ) {
      record.parentCompactionId = value.parentCompactionId;
    }
    return record;
  }
  throw malformedRecord();
}

const isMs = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isIsoTime = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
const isTokenCount = (value: unknown): value is number | null | undefined => value === undefined || value === null || isMs(value);

/** Rebuild valid assistant telemetry field by field; anything malformed yields undefined. */
function assistantTelemetry(value: unknown): AssistantTelemetry | undefined {
  if (!isPlainObject(value) || !isIsoTime(value.startedAt) || !(value.firstDeltaMs === null || isMs(value.firstDeltaMs)) || !isMs(value.attemptMs)
    || !isMs(value.totalMs) || !isMs(value.attempts) || value.attempts < 1 || !isMs(value.retryWaitMs) || !isPlainObject(value.usage)) return undefined;
  const usage = value.usage;
  if (!(usage.inputTokens === null || isMs(usage.inputTokens)) || !(usage.outputTokens === null || isMs(usage.outputTokens))
    || !isTokenCount(usage.cachedInputTokens) || !isTokenCount(usage.reasoningTokens)) return undefined;
  return {
    startedAt: value.startedAt, firstDeltaMs: value.firstDeltaMs, attemptMs: value.attemptMs, totalMs: value.totalMs, attempts: value.attempts, retryWaitMs: value.retryWaitMs,
    usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
      ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
      // Hosted-search counts are optional evidence; an invalid count is dropped without discarding the rest.
      ...(isMs(usage.hostedSearchCalls) ? { hostedSearchCalls: usage.hostedSearchCalls } : {}),
      ...(isMs(usage.reportedHostedSearchCalls) ? { reportedHostedSearchCalls: usage.reportedHostedSearchCalls } : {}) },
  };
}

/** Rebuild valid tool telemetry field by field; anything malformed yields undefined. */
function toolTelemetry(value: unknown): ToolTelemetry | undefined {
  if (!isPlainObject(value) || !isIsoTime(value.startedAt) || !isMs(value.durationMs)
    || !(value.approvalWaitMs === undefined || (isMs(value.approvalWaitMs) && value.approvalWaitMs <= value.durationMs))) return undefined;
  return { startedAt: value.startedAt, durationMs: value.durationMs, ...(value.approvalWaitMs !== undefined ? { approvalWaitMs: value.approvalWaitMs } : {}) };
}

function isUserContent(value: unknown): value is UserContent {
  if (isPlainObject(value) && value.type === "image") {
    try { validateImageContent(value); return true; } catch { return false; }
  }
  return (
    isPlainObject(value) && value.type === "text" && typeof value.text === "string"
  );
}

function isAssistantContent(value: unknown): value is AssistantContent {
  if (!isPlainObject(value)) {
    return false;
  }
  if (value.type === "text") {
    return typeof value.text === "string";
  }
  if (value.type === "thinking") {
    return (
      typeof value.text === "string" &&
      (value.providerMetadata === undefined ||
        isPlainObject(value.providerMetadata))
    );
  }
  if (value.type === "tool_call") {
    return typeof value.id === "string" && typeof value.name === "string";
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformedRecord(): Error {
  return new Error("Session file contains a malformed record");
}

/** Replace `path` via a same-directory temp file so a crash cannot wipe valid history. */
async function replaceFile(path: string, text: string, managed?: ManagedSessionStorage): Promise<void> {
  const tempPath = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    if (managed) {
      const file = await open(tempPath, "wx", 0o600);
      try { await file.writeFile(text, "utf8"); await file.sync(); }
      finally { await file.close(); }
      managed.assertOwnership();
    } else await writeFile(tempPath, text, "utf8");
    await rename(tempPath, path);
    if (managed) { const directory = openSync(dirname(path), "r"); try { fsyncSync(directory); } finally { closeSync(directory); } }
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

/** Bounded, read-only discovery row; unknown activity is never inferred from filesystem modification time. */
export interface SessionDiscovery extends SessionSummary {
  title: string;
  /** Whether bounded inspection found saved conversation work, independent of its redacted title. */
  hasWork?: boolean;
  hasDraft?: boolean;
  /** The read window ended before complete history validation; unknown work must remain recoverable. */
  previewIncomplete?: boolean;
  activityAt?: string;
  state: string;
}

/** Machine state observed without resuming, repairing, or replaying saved work. */
export type SessionInventoryState = "ready" | "legacy" | "interrupted" | "empty" | "draft" | "partial" | "unsupported" | "corrupt" | "unreadable";

/** Bounded transcript evidence; a missing header never acquires the caller's workspace identity. */
export interface TranscriptInspection {
  header?: SessionHeader;
  state: SessionInventoryState;
  previewIncomplete: boolean;
  activityAt?: string;
  task?: string;
}

/** Validate only the supplied transcript window using the durable record validators, without resume side effects. */
export function inspectSessionTranscript(text: string, id: string, incomplete: boolean, preview = false): TranscriptInspection {
  const result: TranscriptInspection = { state: "corrupt", previewIncomplete: incomplete };
  const lines = text.split("\n");
  let header: unknown;
  try { header = JSON.parse(lines[0] ?? ""); }
  catch { return incomplete && lines.length === 1 ? { state: "partial", previewIncomplete: true } : result; }
  if (!isSessionHeader(header) || header.id !== id || !header.id || !header.workspaceRoot || !Number.isSafeInteger(header.version) || header.version < 1) return result;
  result.header = header;
  if (header.version > SESSION_FORMAT_VERSION) return { ...result, state: "unsupported" };
  let state = emptyBranchState(header.id);
  let version = header.version;
  let torn = false;
  // Only a complete final line can be interpreted when a read window cuts the file.
  const last = incomplete ? lines.length - 1 : lines.length;
  for (let index = 1; index < last; index++) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    let record: unknown;
    try { record = JSON.parse(line); }
    catch {
      if (!incomplete && index === lines.length - 1 && !text.endsWith("\n")) { torn = true; break; }
      return result;
    }
    if (!isPlainObject(record)) return result;
    try {
      if (record.type === "session_format") {
        if (!Number.isSafeInteger(record.version) || (record.version as number) <= version || "id" in record || "parentId" in record) return result;
        if ((record.version as number) > SESSION_FORMAT_VERSION) return { ...result, state: "unsupported" };
        version = record.version as number;
      } else if (record.type === "workspace_roots") {
        if (record.version !== 1 || version < 2 || !isRootList(record.extraRoots) || "id" in record || "parentId" in record) return result;
      } else {
        state = version >= 3 ? replayBranchRecord(state, record, version) : replayLegacyRecord(state, record);
        if (record.type === "branch_append" && typeof record.committedAt === "string" && Number.isFinite(Date.parse(record.committedAt))) result.activityAt = record.committedAt;
      }
    } catch { return result; }
  }
  const items = branchAncestry(state, state.branches.get(state.activeBranchId)!.headId).map(entry => entry.item);
  if (preview) {
    const latestTask = items.findLast(item => item.type === "user");
    if (latestTask?.type === "user") result.task = latestTask.content.filter(block => block.type === "text").map(block => block.text).join(" ");
  }
  result.state = incomplete ? "partial" : torn || pendingCalls(items).length > 0 ? "interrupted" : !items.length ? "empty" : version < SESSION_FORMAT_VERSION ? "legacy" : "ready";
  return result;
}

/** Read one batch of at most 100 histories with 64 KiB transcript windows, retaining every file for explicit recovery. */
export async function discoverSessions(directory: string, offset = 0, home?: string): Promise<SessionDiscovery[]> {
  let names: string[];
  try { names = await readdir(directory); } catch (error) { if (isNotFound(error)) return []; throw error; }
  const rows: SessionDiscovery[] = [];
  for (const name of names.filter(name => name.endsWith(".jsonl")).sort().slice(offset, offset + 100)) {
    const row: SessionDiscovery = { id: name.slice(0, -6), createdAt: "", workspaceRoot: "", title: "No task preview", state: "Corrupt/unreadable header · recover file manually" };
    rows.push(row);
    try {
      const text = await readWindow(join(directory, name), 65536);
      const header = JSON.parse(text.split("\n", 1)[0]!);
      if (!isSessionHeader(header) || header.id !== row.id) continue;
      row.createdAt = header.createdAt;
      row.workspaceRoot = header.workspaceRoot;
      if (home) {
        try { row.hasDraft = !!openDraftStore({ home, workspaceRoot: header.workspaceRoot, sessionId: header.id }).checkpoint; }
        catch { /* Draft recovery errors remain visible when explicitly reopened. */ }
      }
      if (![1, 2, 3, 4].includes(header.version)) { row.state = "Unsupported history · use a compatible Schway build"; continue; }
      try {
        const metadata: unknown = JSON.parse(await readWindow(join(directory, `${name}.meta`), 2048));
        if (!isPlainObject(metadata)) throw new Error("Invalid discovery metadata");
        if (typeof metadata.activityAt === "string" && Number.isFinite(Date.parse(metadata.activityAt))) row.activityAt = metadata.activityAt;
        if (typeof metadata.title === "string") row.title = safeTaskText(metadata.title) || row.title;
      } catch { /* Older histories do not have a discovery cache. */ }
      if (Buffer.byteLength(text) >= 65536) {
        row.state = "Partial preview · large history validated only on resume";
        row.previewIncomplete = true;
        for (const line of text.split("\n").slice(1, -1)) {
          try {
            const record = JSON.parse(line);
            const items = record.type === "branch_append" ? record.entries.map((entry: SessionEntry) => entry.item) : [record];
            for (const item of items) if (item.type === "user" && Array.isArray(item.content) && item.content.every(isUserContent)) {
              row.hasWork = true;
              row.title = taskTitle(item) || row.title;
            }
          } catch { /* The bounded preview is advisory; only explicit resume validates the file. */ }
        }
      }
      else {
        const loaded = loadRecords(text);
        const items = branchAncestry(loaded.state, loaded.state.branches.get(loaded.state.activeBranchId)!.headId).map(entry => entry.item);
        row.hasWork = items.some(item => item.type === "user");
        row.title = items.map(taskTitle).filter(Boolean).at(-1) || (row.hasDraft ? "Unsent draft" : row.title);
        const times = text.split("\n").flatMap(line => {
          try { const value = JSON.parse(line); return value.type === "branch_append" && typeof value.committedAt === "string" && Number.isFinite(Date.parse(value.committedAt)) ? [value.committedAt as string] : []; } catch { return []; }
        });
        row.activityAt = times.at(-1) ?? row.activityAt;
        row.state = loaded.text !== (text.endsWith("\n") ? text : text + "\n") || pendingCalls(items).length ? "Interrupted · Enter recovers without replaying tools" : !items.length ? (row.hasDraft ? "Unsent draft · Enter restores without sending" : "Empty history") : header.version < 3 ? "Legacy history · supported" : "Ready";
      }
    } catch { row.state = "Corrupt/unreadable history · recover file manually"; }
  }
  return rows.sort((a, b) => (b.activityAt ?? b.createdAt).localeCompare(a.activityAt ?? a.createdAt) || a.id.localeCompare(b.id));
}

async function readWindow(path: string, limit: number): Promise<string> {
  const file = await open(path, "r");
  try { const buffer = Buffer.alloc(limit); const { bytesRead } = await file.read(buffer, 0, limit, 0); return buffer.subarray(0, bytesRead).toString("utf8"); }
  finally { await file.close(); }
}

function taskTitle(item: SessionRecord): string {
  if (item.type !== "user") return "";
  // Credential entry never becomes a user record; additionally exclude saved command/callback payloads.
  return safeTaskText(item.content.filter(block => block.type === "text").map(block => block.text).join(" "));
}

function safeTaskText(text: string): string {
  if (/(^|\s)\/(?:login|auth|logout|connect|config|model|callback)\b|(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|oauth|https?:\/\/[^\s]*[?&](?:code|token)=)/i.test(text) || text.trimStart().startsWith("/")) return "";
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}

/** Delete a selected saved session after clearing its draft and undo data, removing history evidence under the history lock. */
export async function deleteJsonlSession(options: { directory: string; id: string; home: string; beforeDelete?: () => Promise<void> }): Promise<void> {
  const path = sessionFilePath(options.directory, options.id);
  const firstLine = await readFirstLine(path);
  const header: unknown = JSON.parse(firstLine ?? "null");
  if (!isSessionHeader(header) || header.id !== options.id) throw new Error("Cannot delete an invalid session header");
  // The history lock is taken first, so history contention leaves the draft, undo data, session and evidence intact.
  // Failures inside the lock (for example undo contention after the draft clear) can leave partial
  // sidecars behind; the caller reports those as partial or blocked for retry.
  await deleteHistorySession({ home: options.home, sessionId: header.id }, async () => {
    openDraftStore({ home: options.home, workspaceRoot: header.workspaceRoot, sessionId: header.id }).clear(Number.MAX_SAFE_INTEGER);
    await deleteUndoSession({ home: options.home, sessionId: header.id });
    // Host retirement is durable before the last discoverable native identity can disappear.
    await options.beforeDelete?.();
    await unlink(path);
    try { await unlink(`${path}.meta`); } catch (error) { if (!isNotFound(error)) throw error; }
  });
}
