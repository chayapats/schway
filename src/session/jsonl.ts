import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ConversationItem, ToolResult } from "../conversation/types.ts";
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

/** Load a previously saved session by identity. */
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

function sessionFilePath(directory: string, id: string): string {
  if (id.length === 0 || id !== basename(id) || id === "." || id === "..") {
    throw new Error(`Invalid session id: ${id}`);
  }
  return join(directory, `${id}.jsonl`);
}

function openPersisted(
  path: string,
  header: SessionHeader,
  items: readonly ConversationItem[],
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
function settlementsFor(items: readonly ConversationItem[]): ToolResult[] {
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
  items: ConversationItem[];
  tipId: string;
} {
  const lines = text.split("\n").filter((line) => line.length > 0);
  const records: unknown[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      records.push(JSON.parse(lines[i]!));
    } catch (error) {
      if (i === lines.length - 1) {
        break;
      }
      throw error;
    }
  }
  const first = records[0];
  if (!isSessionHeader(first)) {
    throw new Error("Session file is missing a versioned header");
  }
  if (first.version !== SESSION_FORMAT_VERSION) {
    throw new Error(
      `Unsupported session format version ${first.version}. This Schway build reads version ${SESSION_FORMAT_VERSION}.`,
    );
  }
  const items: ConversationItem[] = [];
  let tipId = first.id;
  const entries = records.slice(1);
  for (let i = 0; i < entries.length; i++) {
    try {
      const item = toConversationItem(entries[i]);
      items.push(item);
      tipId = item.id;
    } catch (error) {
      if (i === entries.length - 1) {
        break;
      }
      throw error;
    }
  }
  return { header: first, items, tipId };
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

function toConversationItem(value: unknown): ConversationItem {
  if (value === null || typeof value !== "object") {
    throw new Error("Session file contains a malformed record");
  }
  const { parentId: _parentId, ...item } = value as {
    parentId?: string;
  } & ConversationItem;
  if (
    item.type !== "user" &&
    item.type !== "assistant" &&
    item.type !== "tool_result"
  ) {
    throw new Error("Session file contains a malformed record");
  }
  return item;
}
