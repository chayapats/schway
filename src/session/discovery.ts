import { constants } from "node:fs";
import { access, open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { redactSecrets } from "../auth/secrets.ts";
import { inspectDraftCheckpoint } from "../drafts/inspection.ts";
import { inspectSessionTranscript, sessionsDirectory, type SessionInventoryState } from "./jsonl.ts";

/** Public saved-work evidence, with optional excerpts only after explicit opt-in. */
export interface SessionInventoryRow {
  id: string;
  createdAt?: string;
  activityAt?: string;
  workspaceRoot?: string;
  state: SessionInventoryState;
  previewIncomplete: boolean;
  preview?: string;
}

/** Versioned observational inventory; pagination applies after global ordering and workspace filtering. */
export interface SessionInventory {
  schemaVersion: 1;
  scope: { workspace?: string; all: boolean };
  limit: number;
  offset: number;
  hasMore: boolean;
  status: "complete" | "partial" | "error";
  sessions: SessionInventoryRow[];
  warnings: string[];
}

/** Canonical scope and bounded page options, independent of configuration and credential stores. */
export interface SessionInventoryOptions {
  home: string;
  workspace?: string;
  all: boolean;
  limit: number;
  offset: number;
  preview?: boolean;
  secrets?: readonly string[];
  signal?: AbortSignal;
}

const CONTROL_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const CREDENTIAL_TEXT = /(?:\b(?:sk-[\w-]{8,}|xai-[\w-]{8,}|Bearer\s+\S+|eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+)|(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|authorization|password|secret)\s*[=:]|https?:\/\/[^\s]*[?&#](?:code|token|access_token|refresh_token|id_token)=|https?:\/\/[^\s/]+:[^\s/]+@)/i;

function knownSecretVariants(secrets: readonly string[]): string[] {
  return [...new Set(secrets.flatMap(secret => [secret, secret.trim()]).filter(Boolean))].sort((a, b) => b.length - a.length);
}

/** Reject control-bearing or recognized sensitive identifiers instead of fabricating copyable replacements. */
export function isSafeSessionIdentity(value: string, secrets: readonly string[] = []): boolean {
  return !CONTROL_TEXT.test(value) && !CREDENTIAL_TEXT.test(value) && !knownSecretVariants(secrets).some(secret => value.includes(secret));
}

/** Produce a short Unicode task excerpt, suppressing sensitive commands and masking explicitly known secrets. */
export function sessionTaskPreview(value: string, secrets: readonly string[] = []): string | undefined {
  // Formatting can split a credential label; retain whitespace that separates it from its value.
  const recognizable = Bun.stripANSI(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, character => /\p{White_Space}/u.test(character) ? " " : "");
  if (CREDENTIAL_TEXT.test(recognizable) || /(?:^|\s)\/(?:login|logout|auth|key|apikey|connect|config|model|callback)\b|\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|oauth|bearer)\b/i.test(`${value} ${recognizable}`) || recognizable.trimStart().startsWith("/")) return undefined;
  const variants = knownSecretVariants(secrets);
  const normalized = Bun.stripANSI(redactSecrets(value, variants)).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim();
  // ANSI removal and whitespace folding can reconstruct an otherwise split known credential.
  const clean = redactSecrets(normalized, variants);
  return clean ? Array.from(clean).slice(0, 160).join("") : undefined;
}

/** Capture candidate names once, inspect each bounded row once, and never invoke recovery or a resume loader. */
export async function inventorySessions(options: SessionInventoryOptions): Promise<SessionInventory> {
  const secrets = options.secrets ?? [];
  const result: SessionInventory = {
    schemaVersion: 1,
    scope: { all: options.all, ...(options.workspace && isSafeSessionIdentity(options.workspace, secrets) ? { workspace: options.workspace } : {}) },
    limit: options.limit, offset: options.offset, hasMore: false, status: "complete", sessions: [], warnings: [],
  };
  const warn = (message: string) => {
    result.status = "partial";
    if (!result.warnings.includes(message)) result.warnings.push(message);
  };
  if (options.workspace && !isSafeSessionIdentity(options.workspace, secrets)) warn("Workspace hidden · Remove sensitive text from its path to display it");
  const directory = sessionsDirectory(options.home);
  let names: string[];
  try {
    options.signal?.throwIfAborted();
    if (!(await stat(options.home)).isDirectory()) throw new Error("Invalid home");
    await access(options.home, constants.R_OK | constants.X_OK);
  } catch {
    return { ...result, status: "error", warnings: [options.signal?.aborted ? "Listing cancelled · Retry sessions list" : "HOME unavailable · Choose an accessible user directory"] };
  }
  try {
    names = [...new Set((await readdir(directory)).filter(name => name.endsWith(".jsonl")))];
  } catch (error) {
    if (!options.signal?.aborted && (error as NodeJS.ErrnoException).code === "ENOENT") return result;
    return { ...result, status: "error", warnings: [options.signal?.aborted ? "Listing cancelled · Retry sessions list" : "Storage unavailable · Check HOME and session directory permissions"] };
  }
  const captured: SessionInventoryRow[] = [];
  for (const name of names) {
    if (options.signal?.aborted) { warn("Listing cancelled · Retry sessions list"); break; }
    const id = name.slice(0, -6);
    const row: SessionInventoryRow = { id, state: "unreadable", previewIncomplete: false };
    let workspace: string | undefined;
    try {
      const window = await readWindow(join(directory, name), 65536);
      const inspected = inspectSessionTranscript(window.text, id, window.incomplete, options.preview);
      row.state = inspected.state;
      row.previewIncomplete = inspected.previewIncomplete;
      if (inspected.header) {
        workspace = inspected.header.workspaceRoot;
        row.createdAt = timestamp(inspected.header.createdAt);
        if (isSafeSessionIdentity(workspace, secrets)) row.workspaceRoot = workspace;
        else warn("Workspace hidden · Remove sensitive text from its path to display it");
        const checkpoint = inspectDraftCheckpoint({ home: options.home, workspaceRoot: workspace, sessionId: id });
        if (checkpoint.status === "unverifiable") warn("Draft unavailable · Check checkpoint permissions and format");
        if (row.state === "empty" && checkpoint.status === "valid" && checkpoint.present) row.state = "draft";
      }
      row.activityAt = timestamp(inspected.activityAt);
      if (options.preview && inspected.task !== undefined) {
        const preview = sessionTaskPreview(inspected.task, secrets);
        if (preview !== undefined) row.preview = preview;
      }
      if (window.changed) warn("History changed · Retry for a fresh listing");
    } catch { warn("Session unavailable · Check session storage permissions and retry"); }
    // Metadata is advisory, read once even for damaged or unsupported histories.
    try {
      const metadata = await readWindow(join(directory, `${name}.meta`), 2048);
      if (metadata.incomplete) throw new Error("Oversized metadata");
      const value: unknown = JSON.parse(metadata.text);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid metadata");
      const activity = timestamp((value as { activityAt?: unknown }).activityAt);
      if (activity && (!row.activityAt || Date.parse(activity) > Date.parse(row.activityAt))) row.activityAt = activity;
      if (metadata.changed) warn("History changed · Retry for a fresh listing");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") warn("Metadata unavailable · Check session metadata and retry");
    }
    if (options.all || workspace === options.workspace) captured.push(row);
  }
  if (options.signal?.aborted) warn("Listing cancelled · Retry sessions list");
  captured.sort((a, b) => {
    const left = Date.parse(a.activityAt ?? a.createdAt ?? ""), right = Date.parse(b.activityAt ?? b.createdAt ?? "");
    return (Number.isFinite(right) ? right : -Infinity) - (Number.isFinite(left) ? left : -Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  const visible = captured.filter(row => {
    if (isSafeSessionIdentity(row.id, secrets)) return true;
    warn("Session hidden · Inspect sensitive identifiers privately");
    return false;
  });
  result.hasMore = visible.length > options.offset + options.limit;
  result.sessions = visible.slice(options.offset, options.offset + options.limit);
  return result;
}

function timestamp(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}

async function readWindow(path: string, limit: number): Promise<{ text: string; incomplete: boolean; changed: boolean }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error("Not a regular file");
    const buffer = Buffer.alloc(Math.min(limit, before.size));
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await file.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const after = await file.stat();
    return { text: buffer.subarray(0, count).toString("utf8"), incomplete: before.size > count,
      changed: before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || count !== buffer.length };
  } finally { await file.close(); }
}
