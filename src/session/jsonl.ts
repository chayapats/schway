import { appendFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  AssistantContent,
  CompactionRecord,
  ConversationItem,
  SessionRecord,
  ToolResult,
  UserContent,
} from "../conversation/types.ts";
import type { Workspace } from "../workspace/workspace.ts";
import { createSession, type Session } from "./session.ts";

/** First persisted session format. Loaders stay version-specific. */
export const SESSION_FORMAT_VERSION = 1;

/** First JSONL record in a session file. */
export interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  createdAt: string;
  workspaceRoot: string;
  launchCwd: string;
  extraRoots: string[];
}

/** In-memory session whose appends are durable JSONL records. */
export interface JsonlSession extends Session {
  readonly header: SessionHeader;
}

/** Create a new append-oriented session file under `directory`. */
export async function createJsonlSession(options: {
  directory: string;
  workspace: Workspace;
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
  await writeFile(path, `${JSON.stringify(header)}\n`, "utf8");
  return openPersisted(path, header, [], header.id);
}

/** Canonical per-user session directory: `~/.schway/sessions`. */
export function sessionsDirectory(home: string): string {
  return join(home, ".schway", "sessions");
}

/** Lightweight header for session pickers; skips corrupt or unreadable files. */
export interface SessionSummary {
  id: string;
  createdAt: string;
  workspaceRoot: string;
}

/**
 * List persisted sessions newest-first by header timestamp.
 * Missing directories yield an empty list; corrupt files are skipped.
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
    let text: string;
    try {
      text = await readFile(join(directory, entry), "utf8");
    } catch {
      continue;
    }
    const firstLine = text.split("\n").find((line) => line.length > 0);
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

/** Load a session, settle unresolved tool calls, and drop a corrupt trailing record. */
export async function loadJsonlSession(options: {
  directory: string;
  id: string;
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
  const loaded = loadV1(text);
  if (loaded.text !== text) {
    await replaceFile(path, loaded.text);
  }
  const session = openPersisted(
    path,
    loaded.header,
    loaded.items,
    loaded.tipId,
  );
  const settlements = settlementsFor(loaded.items);
  if (settlements.length > 0) {
    session.append(...settlements);
  }
  return session;
}

/** Resolve `<id>.jsonl` under `directory`. Rejects ids that escape the directory. */
function sessionFilePath(directory: string, id: string): string {
  if (id.length === 0 || id !== basename(id) || id === "." || id === "..") {
    throw new Error(`Invalid session id: ${id}`);
  }
  return join(directory, `${id}.jsonl`);
}

function openPersisted(
  path: string,
  header: SessionHeader,
  items: readonly SessionRecord[],
  tipId: string,
): JsonlSession {
  const session = createSession(items);
  let parentId = tipId;
  return {
    header,
    get items() {
      return session.items;
    },
    append(...added) {
      for (const item of added) {
        appendFileSync(
          path,
          `${JSON.stringify({ ...item, parentId })}\n`,
          "utf8",
        );
        parentId = item.id;
        session.append(item);
      }
    },
  };
}

/** Append explicit error results for durable tool calls that never got a result. */
function settlementsFor(items: readonly SessionRecord[]): ToolResult[] {
  const resolved = new Set(
    items
      .filter((item): item is ToolResult => item.type === "tool_result")
      .map((item) => item.toolCallId),
  );
  const settlements: ToolResult[] = [];
  for (const item of items) {
    if (item.type !== "assistant") {
      continue;
    }
    for (const block of item.content) {
      if (block.type === "tool_call" && !resolved.has(block.id)) {
        settlements.push({
          type: "tool_result",
          id: crypto.randomUUID(),
          toolCallId: block.id,
          content: "Tool call interrupted before a result was persisted",
          isError: true,
        });
        resolved.add(block.id);
      }
    }
  }
  return settlements;
}

/** Parse a version 1 session file into header, items, and the latest entry id. */
function loadV1(text: string): {
  header: SessionHeader;
  items: SessionRecord[];
  tipId: string;
  text: string;
} {
  const lines = text.split("\n").filter((line) => line.length > 0);
  const firstLine = lines[0];
  if (firstLine === undefined) {
    throw new Error("Session file is missing a versioned header");
  }
  let first: unknown;
  try {
    first = JSON.parse(firstLine);
  } catch {
    throw new Error("Session file is missing a versioned header");
  }
  if (!isSessionHeader(first)) {
    throw new Error("Session file is missing a versioned header");
  }
  if (first.version !== SESSION_FORMAT_VERSION) {
    throw new Error(
      `Unsupported session format version ${first.version}. This Schway build reads version ${SESSION_FORMAT_VERSION}.`,
    );
  }
  const kept = [firstLine];
  const items: SessionRecord[] = [];
  let tipId = first.id;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const trailing = i === lines.length - 1;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch (error) {
      if (trailing) {
        break;
      }
      throw error;
    }
    try {
      const item = toSessionRecord(record);
      items.push(item);
      tipId = item.id;
      kept.push(line);
    } catch (error) {
      if (trailing) {
        break;
      }
      throw error;
    }
  }
  return {
    header: first,
    items,
    tipId,
    text: `${kept.join("\n")}\n`,
  };
}

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
    Array.isArray(record.extraRoots)
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
      value.firstKeptId.length === 0
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
