import { appendFileSync, writeFileSync, renameSync, unlinkSync, openSync, readSync, closeSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  AssistantContent,
  CompactionRecord,
  ConversationItem,
  SessionRecord,
  UserContent,
} from "../conversation/types.ts";
import type { Workspace } from "../workspace/workspace.ts";
import { createSession, type Session } from "./session.ts";
import { applyBranchOperation, emptyBranchState, branchAncestry, pendingCalls, type BranchOperation, type BranchState, type SessionEntry } from "./branches.ts";

/** Current session format, storing atomic branch operations separately from session-wide metadata. */
export const SESSION_FORMAT_VERSION = 3;

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
}

/** Create a workspace-bound session, optionally deferring its JSONL header until the first durable mutation. */
export async function createJsonlSession(options: {
  directory: string;
  workspace: Workspace;
  /** Keep an untouched interactive conversation in memory until its first durable mutation. */
  deferred?: boolean;
}): Promise<JsonlSession> {
  const header: SessionHeader = {
    type: "session",
    version: SESSION_FORMAT_VERSION,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    workspaceRoot: options.workspace.root,
    launchCwd: options.workspace.launchCwd,
    extraRoots: [...options.workspace.extraRoots],
  };
  await mkdir(options.directory, { recursive: true });
  const path = sessionFilePath(options.directory, header.id);
  if (!options.deferred) await writeFile(path, `${JSON.stringify(header)}\n`, "utf8");
  return openPersisted(path, header, emptyBranchState(header.id), header.extraRoots, header.version, options.deferred);
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

/** Restore selected ancestry, rejecting semantic corruption and repairing torn tails and selected interrupted calls without tool replay. */
export async function loadJsonlSession(options: {
  directory: string;
  id: string;
  branchId?: string;
}): Promise<JsonlSession> {
  const path = sessionFilePath(options.directory, options.id);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(`Session not found: ${options.id}`);
    }
    throw error;
  }
  const loaded = loadRecords(text);
  if (loaded.header.id !== options.id) throw new Error("Session header ID does not match the requested session");
  // Validate selection and settlement before repairing bytes or writing any durable operation.
  const staged: BranchOperation[] = [];
  const candidate = createSession([], loaded.extraRoots, { state: loaded.state, writeOperation: operation => staged.push(operation) });
  candidate.selectBranch(options.branchId ?? candidate.activeBranchId);
  if (loaded.text !== text) await replaceFile(path, loaded.text);
  const session = openPersisted(path, loaded.header, loaded.state, loaded.extraRoots, loaded.version);
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

/** Bind atomic branch operations and separate workspace metadata to append-only version upgrades. */
function openPersisted(path: string, header: SessionHeader, state: BranchState, extraRoots: readonly string[], version: number, deferred = false): JsonlSession {
  let failed = false;
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
      if (deferred) { writeFileSync(path, `${JSON.stringify(header)}\n${text}`, { encoding: "utf8", flag: "wx", mode: 0o600 }); deferred = false; }
      else appendFileSync(path, text, "utf8");
    } catch (error) { failed = true; throw error; }
  };
  const session = createSession([], extraRoots, {
    state,
    writeOperation(operation) {
      const prefix = version < 3 ? JSON.stringify({ type: "session_format", version: 3 }) + "\n" : "";
      const committedAt = operation.type === "branch_append" && operation.entries.some(entry => entry.item.type !== "compaction") ? new Date().toISOString() : undefined;
      const line = JSON.stringify({ ...operation, ...(committedAt ? { committedAt } : {}) });
      write(prefix + line + "\n");
      version = 3;
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
  return Object.assign(session, { header });
}

/** Replay version-specific records without normalizing valid bytes or repairing semantic corruption. */
function loadRecords(text: string): { header: SessionHeader; state: BranchState; extraRoots: string[]; version: number; text: string } {
  const lines = [...text.matchAll(/([^\n]*)(\n|$)/g)].filter(match => match[0].length > 0);
  let first: unknown;
  try { first = JSON.parse(lines[0]?.[1] ?? ""); } catch { throw new Error("Session file is missing a versioned header"); }
  if (!isSessionHeader(first)) throw new Error("Session file is missing a versioned header");
  if (![1, 2, 3].includes(first.version)) throw new Error(`Unsupported session format version ${first.version}. This Schway build reads versions 1, 2 and 3.`);
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
      if (![2, 3].includes(record.version as number) || (record.version as number) <= version || "id" in record || "parentId" in record) throw new Error("Unsupported or invalid session format transition");
      version = record.version as number;
    } else if (record.type === "workspace_roots") {
      if (record.version !== 1) throw new Error("Unsupported workspace metadata version");
      if (version < 2) throw new Error("Workspace metadata requires session format 2 or 3");
      if (!isRootList(record.extraRoots) || "id" in record || "parentId" in record) throw malformedRecord();
      extraRoots = [...record.extraRoots];
    } else state = version === 3 ? replayBranchRecord(state, record) : replayLegacyRecord(state, record);
  }
  const prefix = text.slice(0, validLength);
  return { header: first, state, extraRoots, version, text: prefix.endsWith("\n") ? prefix : prefix + "\n" };
}

/** Validate legacy linear parents before importing their entries into the single default branch. */
function replayLegacyRecord(state: BranchState, record: Record<string, unknown>): BranchState {
  if (typeof record.parentId !== "string") throw new Error("Legacy session record is missing its parent ID");
  return applyBranchOperation(state, { type: "branch_append", version: 1, branchId: "main", entries: [{ parentId: record.parentId, item: toSessionRecord(record) }] });
}

/** Validate each v3 semantic operation before staging its graph and active head changes. */
function replayBranchRecord(state: BranchState, record: Record<string, unknown>): BranchState {
  if (record.version !== 1 || typeof record.branchId !== "string" || !record.branchId || "id" in record || "parentId" in record) throw new Error("Invalid branch operation version or identity");
  const branchId = record.branchId;
  if (record.type === "branch_fork") {
    if (typeof record.headId !== "string" || (record.name !== undefined && typeof record.name !== "string")) throw new Error("Invalid branch fork head or label");
    return applyBranchOperation(state, { type: "branch_fork", version: 1, branchId, headId: record.headId, ...(record.name === undefined ? {} : { name: record.name as string }) });
  }
  if (record.type === "branch_append") return applyBranchOperation(state, { type: "branch_append", version: 1, branchId, entries: parseEntries(record.entries) });
  if (record.type === "branch_select") return applyBranchOperation(state, { type: "branch_select", version: 1, branchId, settlements: parseEntries(record.settlements) });
  throw new Error("Session format 3 requires a valid branch operation");
}

/** Decode entry payloads without accepting malformed IDs, parents, or conversation shapes. */
function parseEntries(value: unknown): SessionEntry[] {
  if (!Array.isArray(value)) throw new Error("Branch operation entries must be an array");
  return value.map(entry => {
    if (!isPlainObject(entry) || typeof entry.parentId !== "string") throw new Error("Branch entry is missing a valid parent ID");
    return { parentId: entry.parentId, item: toSessionRecord(entry.item) };
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

function toSessionRecord(value: unknown): SessionRecord {
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
    return {
      type: "tool_result",
      id: value.id,
      toolCallId: value.toolCallId,
      content: value.content,
      isError: value.isError,
    };
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

function isUserContent(value: unknown): value is UserContent {
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
async function replaceFile(path: string, text: string): Promise<void> {
  const tempPath = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, text, "utf8");
    await rename(tempPath, path);
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
  /** The read window ended before complete history validation; unknown work must remain recoverable. */
  previewIncomplete?: boolean;
  activityAt?: string;
  state: string;
}

/** Read one batch of at most 100 histories with 64 KiB transcript windows, retaining every file for explicit recovery. */
export async function discoverSessions(directory: string, offset = 0): Promise<SessionDiscovery[]> {
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
      if (![1, 2, 3].includes(header.version)) { row.state = "Unsupported history · use a compatible Schway build"; continue; }
      try {
        const metadata: unknown = JSON.parse(await readWindow(join(directory, `${name}.meta`), 2048));
        if (!isPlainObject(metadata)) throw new Error("Invalid discovery metadata");
        if (typeof metadata.activityAt === "string" && Number.isFinite(Date.parse(metadata.activityAt))) { row.activityAt = metadata.activityAt; row.hasWork = true; }
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
        row.title = items.map(taskTitle).filter(Boolean).at(-1) || row.title;
        const times = text.split("\n").flatMap(line => {
          try { const value = JSON.parse(line); return value.type === "branch_append" && typeof value.committedAt === "string" && Number.isFinite(Date.parse(value.committedAt)) ? [value.committedAt as string] : []; } catch { return []; }
        });
        row.activityAt = times.at(-1) ?? row.activityAt;
        row.state = loaded.text !== (text.endsWith("\n") ? text : text + "\n") || pendingCalls(items).length ? "Interrupted · Enter recovers without replaying tools" : !items.length ? "Empty history" : header.version < 3 ? "Legacy history · supported" : "Ready";
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
  return safeTaskText(item.content.map(block => block.text).join(" "));
}

function safeTaskText(text: string): string {
  if (/(^|\s)\/(?:login|auth|logout|connect|config|model|callback)\b|(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|oauth|https?:\/\/[^\s]*[?&](?:code|token)=)/i.test(text) || text.trimStart().startsWith("/")) return "";
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}
