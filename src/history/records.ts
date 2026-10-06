import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

/** Current sidecar format version written in the header and every turn record. */
export const HISTORY_FORMAT_VERSION = 1;
/** Turns revealed per page in the timeline. */
export const HISTORY_PAGE_SIZE = 50;
/** Command summaries retained per record; totals still count every observed command. */
export const MAX_HISTORY_COMMANDS = 50;
/** Code points kept per command summary, cut at a grapheme boundary. */
export const MAX_HISTORY_COMMAND_CHARS = 200;
/** Observed file rows retained per record; totals still count every observed path. */
export const MAX_HISTORY_FILES = 200;
/** Graphemes kept in a task excerpt; a cluster longer than 32 code points keeps only its base character. */
export const MAX_HISTORY_EXCERPT_GRAPHEMES = 160;
/** UTF-8 bytes allowed for one serialized JSONL record, including its trailing LF. */
export const MAX_HISTORY_RECORD_BYTES = 128 * 1024;
/** UTF-8 bytes allowed for one optional path; longer paths are omitted with a truncation flag. */
export const MAX_HISTORY_PATH_BYTES = 4096;
/** Characters allowed in an identity field; identities are validated, never shortened. */
export const MAX_HISTORY_ID_CHARS = 256;
/** Characters allowed in a bounded Git unavailability detail. */
export const MAX_HISTORY_DETAIL_CHARS = 300;

/** Versioned first line naming the session root whose accepted turns the sidecar describes. */
export interface HistoryHeader { type: "history"; version: 1; sessionId: string; createdAt: string }

/** Where an attempt ran; both modes share the same collector and record format. */
export type HistoryMode = "tui" | "headless";

/** Durable start of one execution attempt of an accepted user turn, written before the attempt is treated as tracked. */
export interface HistoryTurnStart {
  type: "turn_start";
  version: 1;
  /** Accepted user record ID; unique across every branch of the session graph. */
  turnId: string;
  /** Fresh identity of this execution attempt; a continuation of the same turn gets a new one. */
  attemptId: string;
  /** One-based position of the user record on the ancestry the attempt ran on. */
  ordinal: number;
  branchId: string;
  /** Parent entry of the accepted user record, fixing its place in the session graph. */
  parentId: string;
  /** Primary workspace root of this attempt's execution context. */
  workspaceRoot: string;
  mode: HistoryMode;
  startedAt: string;
  /** Sanitized task excerpt; absent when the task is hidden or empty. */
  task?: string;
  taskTruncated?: true;
  /** The task looked like a command or credential, so no excerpt was stored. */
  taskHidden?: true;
}

/** Terminal outcome of one attempt as observed by the runtime. */
export type HistoryOutcome = "completed" | "failed" | "stopped" | "limit";

/** Bounded shell command summary with its observed exit evidence. */
export interface HistoryCommand {
  /** Opaque digest of the tool-call ID used only to deduplicate duplicate deliveries. */
  id: string;
  command: string;
  commandTruncated?: true;
  /** Structured exit code from the tool result; null when none was observed. */
  exitCode: number | null;
  /** How the command ended: an exit, a stop without exit, a timeout or unknown evidence. */
  ended: "exit" | "stopped" | "timed-out" | "unknown";
  status: "success" | "error" | "cancelled";
  /** Milliseconds from scheduler start to settlement, including any approval wait; absent when not measured. */
  durationMs?: number;
  /** Part of `durationMs` spent waiting for approval; absent when the call did not wait. */
  approvalWaitMs?: number;
}

/** Sum of one token dimension over the model calls that reported it; fewer reporting calls than `modelCalls` makes it a lower bound. */
export interface HistoryTokenTotal { total: number; reportedCalls: number }

/** Model-call and tool timing plus provider-reported token totals for one attempt, in whole milliseconds. */
export interface HistoryTelemetry {
  /** Turn model attempts observed, including failed and cancelled ones; compaction calls are excluded. */
  modelCalls: number;
  /** Sum of attempt durations, including failed and cancelled attempts. */
  modelMs: number;
  /** Range of time to first text or thinking output over the calls that produced any; null when none did. */
  firstDelta: { minMs: number; maxMs: number; calls: number } | null;
  /** Transient retries and the backoff waited before them. */
  retries: number;
  retryWaitMs: number;
  /** Tool calls with a measured duration. */
  toolCalls: number;
  /** Wall time during which at least one tool call was running, approval waits included; parallel calls count once. */
  toolMs: number;
  /** Summed approval waits of the tool calls; part of their durations. */
  approvalWaitMs: number;
  /** Provider-reported token totals; cached input is part of input and reasoning is part of output. */
  tokens: { input: HistoryTokenTotal; cachedInput: HistoryTokenTotal; output: HistoryTokenTotal; reasoning: HistoryTokenTotal };
}

/** One observed path: a successful file-tool edit or a path found by Git snapshots. */
export interface HistoryFile {
  /** Workspace-relative path with `/` separators, or an absolute path outside the workspace. */
  path: string;
  source: "tool" | "shell";
  added?: number;
  removed?: number;
}

/** Why observational Git evidence is missing; tool-result evidence is retained regardless. */
export type HistoryGitReason = "off" | "no-workspace" | "non-git" | "failed" | "not-captured" | "headless";

/** Observational Git evidence state for an attempt, never gathered solely for history. */
export type HistoryGitEvidence =
  | { status: "captured" }
  | { status: "unavailable"; reason: HistoryGitReason; detail?: string };

/** Bounded list with its true total and whether entries were omitted. */
export interface HistoryCollection<T> { total: number; truncated: boolean; items: T[] }

/** Revisioned outcome of one attempt; the highest revision for an attempt is authoritative. */
export interface HistoryTurnFinalize {
  type: "turn_finalize";
  version: 1;
  turnId: string;
  attemptId: string;
  revision: number;
  outcome: HistoryOutcome;
  finishedAt: string;
  /** Monotonic active time of this attempt; null when it could not be measured. */
  activeMs: number | null;
  toolResults: number;
  failedTools: number;
  commands: HistoryCollection<HistoryCommand> & { exitZero: number; nonzero: number; unknown: number };
  files: HistoryCollection<HistoryFile>;
  git: HistoryGitEvidence;
  /** Optional entries omitted because a single path or command was too large to store. */
  oversized?: number;
  /** Model and tool timing with token totals; absent on records written before it was recorded, whose timings are unknown. */
  telemetry?: HistoryTelemetry;
}

/** Any validated sidecar line. */
export type HistoryRecord = HistoryHeader | HistoryTurnStart | HistoryTurnFinalize;

const CONTROL = /(?![\u200c\u200d])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const ISO = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
const COUNT = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** True for a nonempty printable identity of at most 256 characters. */
export function isHistoryId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_HISTORY_ID_CHARS && !CONTROL.test(value) && value.isWellFormed();
}

/** True for a session identity that is also safe as one file-name component. */
export function isHistorySessionId(value: unknown): value is string {
  return isHistoryId(value) && value !== "." && value !== ".." && !/[\\/]/.test(value);
}

/** True for an absolute, printable workspace root within the path byte limit. */
export function isHistoryRoot(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && Buffer.byteLength(value) <= MAX_HISTORY_PATH_BYTES && !CONTROL.test(value) && value.isWellFormed();
}

/** Opaque, stable digest of a tool-call ID, so stored records never repeat provider call identifiers. */
export function historyCallDigest(callId: string): string {
  return createHash("sha256").update(callId).digest("hex").slice(0, 16);
}

/** Byte length of one serialized record line including its trailing LF. */
export function historyLineBytes(record: HistoryRecord): number {
  return Buffer.byteLength(JSON.stringify(record)) + 1;
}

/** Serialize a header or start record whose fields are already bounded, rejecting invalid identities instead of truncating them. */
export function serializeHistoryRecord(record: HistoryHeader | HistoryTurnStart): string {
  if (!validRecord(record)) throw new Error("Invalid history identity or record");
  const line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line) > MAX_HISTORY_RECORD_BYTES) throw new Error("History record exceeds 128 KiB");
  return line;
}

/**
 * Serialize a finalize record within 128 KiB: apply item counts first, then omit whole trailing
 * command and file entries until the escaped JSON fits, marking each affected collection truncated
 * while keeping its total. Identity fields are validated, never shortened.
 */
export function serializeHistoryFinalize(record: HistoryTurnFinalize): string {
  const commands = record.commands.items.slice(0, MAX_HISTORY_COMMANDS);
  const files = record.files.items.slice(0, MAX_HISTORY_FILES);
  const bounded: HistoryTurnFinalize = {
    ...record,
    commands: { ...record.commands, truncated: record.commands.truncated || commands.length < record.commands.items.length || record.commands.total > commands.length, items: [] },
    files: { ...record.files, truncated: record.files.truncated || files.length < record.files.items.length || record.files.total > files.length, items: [] },
  };
  // Measure each entry as it will be escaped, plus its separating comma, then fit greedily.
  const sizeOf = (entry: unknown) => Buffer.byteLength(JSON.stringify(entry)) + 1;
  const commandSizes = commands.map(sizeOf), fileSizes = files.map(sizeOf);
  // Assume both collections may become truncated so flipping a flag can never push the line past the limit.
  const base = historyLineBytes({ ...bounded, commands: { ...bounded.commands, truncated: true }, files: { ...bounded.files, truncated: true } });
  let budget = MAX_HISTORY_RECORD_BYTES - base;
  let keptCommands = 0, keptFiles = 0, commandsOpen = commands.length > 0, filesOpen = files.length > 0;
  // Alternate so neither collection starves the other; each keeps a prefix in observation order,
  // and the first entry that no longer fits closes its collection so only trailing entries are omitted.
  while (commandsOpen || filesOpen) {
    const takeCommand = commandsOpen && (!filesOpen || keptCommands <= keptFiles);
    const size = takeCommand ? commandSizes[keptCommands]! : fileSizes[keptFiles]!;
    if (size > budget) { if (takeCommand) commandsOpen = false; else filesOpen = false; continue; }
    budget -= size;
    if (takeCommand) commandsOpen = ++keptCommands < commands.length;
    else filesOpen = ++keptFiles < files.length;
  }
  bounded.commands.items = commands.slice(0, keptCommands);
  bounded.files.items = files.slice(0, keptFiles);
  if (keptCommands < commands.length) bounded.commands.truncated = true;
  if (keptFiles < files.length) bounded.files.truncated = true;
  if (!validRecord(bounded)) throw new Error("Invalid history identity or record");
  let line = `${JSON.stringify(bounded)}\n`;
  // The arithmetic is exact, but never emit an oversized line if an estimate were ever wrong.
  while (Buffer.byteLength(line) > MAX_HISTORY_RECORD_BYTES) {
    if (bounded.files.items.length) { bounded.files.items.pop(); bounded.files.truncated = true; }
    else if (bounded.commands.items.length) { bounded.commands.items.pop(); bounded.commands.truncated = true; }
    else throw new Error("History record exceeds 128 KiB");
    line = `${JSON.stringify(bounded)}\n`;
  }
  return line;
}

/** Parse one complete line, returning undefined for malformed, unknown, future or out-of-bounds records. */
export function parseHistoryLine(line: string): HistoryRecord | undefined {
  if (Buffer.byteLength(line) + 1 > MAX_HISTORY_RECORD_BYTES) return undefined;
  let value: unknown;
  try { value = JSON.parse(line); } catch { return undefined; }
  return validRecord(value) ? value : undefined;
}

/** Strictly validate a record's shape, identities and per-field bounds. */
function validRecord(value: unknown): value is HistoryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== HISTORY_FORMAT_VERSION) return false;
  if (record.type === "history") return isHistorySessionId(record.sessionId) && ISO(record.createdAt);
  if (record.type === "turn_start") {
    return isHistoryId(record.turnId) && isHistoryId(record.attemptId) && COUNT(record.ordinal) && (record.ordinal as number) >= 1
      && isHistoryId(record.branchId) && isHistoryId(record.parentId) && isHistoryRoot(record.workspaceRoot)
      && (record.mode === "tui" || record.mode === "headless") && ISO(record.startedAt)
      && (record.task === undefined || (typeof record.task === "string" && boundedText(record.task, MAX_HISTORY_EXCERPT_GRAPHEMES * 32) && graphemes(record.task) <= MAX_HISTORY_EXCERPT_GRAPHEMES))
      && (record.taskTruncated === undefined || record.taskTruncated === true) && (record.taskHidden === undefined || record.taskHidden === true);
  }
  if (record.type !== "turn_finalize") return false;
  const commands = record.commands as Record<string, unknown> | undefined, files = record.files as Record<string, unknown> | undefined;
  const git = record.git as Record<string, unknown> | undefined;
  return isHistoryId(record.turnId) && isHistoryId(record.attemptId) && COUNT(record.revision) && (record.revision as number) >= 1
    && ["completed", "failed", "stopped", "limit"].includes(record.outcome as string) && ISO(record.finishedAt)
    && (record.activeMs === null || COUNT(record.activeMs)) && COUNT(record.toolResults) && COUNT(record.failedTools)
    && collection(commands, MAX_HISTORY_COMMANDS, validCommand) && COUNT(commands!.exitZero) && COUNT(commands!.nonzero) && COUNT(commands!.unknown)
    && collection(files, MAX_HISTORY_FILES, validFile)
    && !!git && typeof git === "object" && (git.status === "captured" ? Object.keys(git).length === 1
      : git.status === "unavailable" && ["off", "no-workspace", "non-git", "failed", "not-captured", "headless"].includes(git.reason as string)
        && (git.detail === undefined || (typeof git.detail === "string" && boundedText(git.detail, MAX_HISTORY_DETAIL_CHARS))))
    && (record.oversized === undefined || COUNT(record.oversized))
    && (record.telemetry === undefined || validTelemetry(record.telemetry));
}

/** Strictly validate optional telemetry: whole nonnegative numbers, coverage within the call count and an ordered first-output range. */
function validTelemetry(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const telemetry = value as Record<string, unknown>;
  const calls = telemetry.modelCalls, tokens = telemetry.tokens as Record<string, unknown> | undefined, first = telemetry.firstDelta as Record<string, unknown> | null | undefined;
  const total = (entry: unknown) => !!entry && typeof entry === "object" && COUNT((entry as Record<string, unknown>).total)
    && COUNT((entry as Record<string, unknown>).reportedCalls) && ((entry as Record<string, unknown>).reportedCalls as number) <= (calls as number);
  return COUNT(calls) && COUNT(telemetry.modelMs) && COUNT(telemetry.retries) && COUNT(telemetry.retryWaitMs) && COUNT(telemetry.toolCalls)
    && COUNT(telemetry.toolMs) && COUNT(telemetry.approvalWaitMs)
    && (first === null || (!!first && typeof first === "object" && COUNT(first.minMs) && COUNT(first.maxMs) && (first.minMs as number) <= (first.maxMs as number)
      && COUNT(first.calls) && (first.calls as number) >= 1 && (first.calls as number) <= (calls as number)))
    && !!tokens && typeof tokens === "object" && total(tokens.input) && total(tokens.cachedInput) && total(tokens.output) && total(tokens.reasoning);
}

function collection(value: Record<string, unknown> | undefined, max: number, item: (entry: unknown) => boolean): boolean {
  return !!value && typeof value === "object" && COUNT(value.total) && typeof value.truncated === "boolean" && Array.isArray(value.items)
    && value.items.length <= max && value.items.length <= (value.total as number) && value.items.every(item);
}

function validCommand(value: unknown): boolean {
  const entry = value as Record<string, unknown>;
  return !!entry && typeof entry === "object" && typeof entry.id === "string" && /^[0-9a-f]{16}$/.test(entry.id)
    && typeof entry.command === "string" && boundedText(entry.command, MAX_HISTORY_COMMAND_CHARS)
    && (entry.commandTruncated === undefined || entry.commandTruncated === true)
    && (entry.exitCode === null || COUNT(entry.exitCode))
    && ["exit", "stopped", "timed-out", "unknown"].includes(entry.ended as string) && ["success", "error", "cancelled"].includes(entry.status as string)
    && (entry.durationMs === undefined || COUNT(entry.durationMs))
    && (entry.approvalWaitMs === undefined || (COUNT(entry.approvalWaitMs) && COUNT(entry.durationMs) && entry.approvalWaitMs <= entry.durationMs));
}

function validFile(value: unknown): boolean {
  const entry = value as Record<string, unknown>;
  return !!entry && typeof entry === "object" && typeof entry.path === "string" && entry.path.length > 0 && Buffer.byteLength(entry.path) <= MAX_HISTORY_PATH_BYTES
    && !CONTROL.test(entry.path) && entry.path.isWellFormed() && (entry.source === "tool" || entry.source === "shell")
    && (entry.added === undefined || COUNT(entry.added)) && (entry.removed === undefined || COUNT(entry.removed));
}

/** Printable, well-formed text of at most `max` code points. */
function boundedText(value: string, max: number): boolean {
  if (CONTROL.test(value) || !value.isWellFormed()) return false;
  let count = 0;
  for (const _ of value) if (++count > max) return false;
  return true;
}

/** Count grapheme clusters, the unit excerpts are bounded in. */
function graphemes(value: string): number {
  let count = 0;
  for (const _ of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)) count++;
  return count;
}
