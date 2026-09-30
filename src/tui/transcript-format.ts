import { toolTarget } from "./presentation.ts";
import type { SessionRecord } from "../conversation/types.ts";
import type { TuiTranscriptEntry } from "./controller-types.ts";
import { buildEditDiff, buildEditDiffHunks, type DiffRow } from "../text/diff.ts";
import { formatCount, formatDuration } from "../text/format.ts";

/** Bound on displayed tool-result characters; session data stays complete. */
export const MAX_TOOL_DISPLAY_CHARS = 2000;

/** Summarize successful built-in results from validated summary fields, leaving other states and malformed details without a summary. */
export function summarizeToolResult(
  name: string,
  status: TuiTranscriptEntry["toolStatus"],
  details: unknown,
  durationMs?: number,
): string | undefined {
  if (status !== "success" || typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
  const record = details as Record<string, unknown>;
  if (name === "read") {
    const { lineCount, startLine, endLine, truncated } = record;
    if (!isCount(lineCount) || !isCount(startLine) || startLine < 1 || !isCount(endLine) || typeof truncated !== "boolean") return undefined;
    if (lineCount === 0) {
      if (startLine !== 1 || endLine !== 0) return undefined;
    } else if (endLine < startLine || endLine > lineCount) return undefined;
    return startLine > 1 || endLine < lineCount || truncated
      ? `lines ${startLine}–${endLine} of ${lineCount}`
      : formatCount(lineCount, "line");
  }
  if (name === "grep" || name === "find" || name === "ls") {
    const count = record[name === "grep" ? "matchCount" : name === "find" ? "fileCount" : "entryCount"];
    if (!isCount(count) || typeof record.truncated !== "boolean") return undefined;
    const singular = name === "ls" ? "entry" : "match";
    const plural = name === "ls" ? "entries" : "matches";
    return record.truncated
      ? `${count}+ ${plural} · truncated`
      : formatCount(count, singular, plural);
  }
  if (name === "bash") {
    if (record.exitCode === null) return "stopped · no exit code";
    if (!isCount(record.exitCode) || typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
    return `exit ${record.exitCode} · ${formatDuration(durationMs)}`;
  }
  if (name === "write") {
    if (!isCount(record.lineCount) || typeof record.created !== "boolean") return undefined;
    return `${record.created ? "new" : "overwritten"} · ${formatCount(record.lineCount, "line")}`;
  }
  if (name === "edit") {
    const edit = asEditDetails(details);
    if (!edit?.hunks || edit.hunks.some(hunk => !isCount(hunk.startLine) || hunk.startLine < 1)) return undefined;
    const diff = buildEditDiff(edit.hunks);
    return `+${diff.added} −${diff.removed}`;
  }
  return undefined;
}

/** Summarize successful persisted edit arguments without inferring result data or claiming persisted line positions. */
export function summarizeResumedToolResult(
  name: string,
  status: TuiTranscriptEntry["toolStatus"],
  args: unknown,
): string | undefined {
  if (name !== "edit" || status !== "success" || typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  if (typeof record.path !== "string" || !Array.isArray(record.edits) || record.edits.length === 0) return undefined;
  const hunks: EditHunkDisplay[] = [];
  for (const edit of record.edits) {
    if (typeof edit !== "object" || edit === null || Array.isArray(edit)) return undefined;
    const entry = edit as Record<string, unknown>;
    if (typeof entry.oldText !== "string" || entry.oldText.length === 0 || typeof entry.newText !== "string") return undefined;
    hunks.push({ startLine: 1, oldText: entry.oldText, newText: entry.newText });
  }
  const diff = buildEditDiff(hunks);
  return `+${diff.added} −${diff.removed}`;
}

/** Align original deletion and edited addition line numbers without clipping, redacting, or sanitizing recorded text. */
export function formatDiffRows(rows: readonly DiffRow[]): string {
  let width = 1;
  for (const row of rows) width = Math.max(width, String(row.line).length);
  return rows.map(row => `${String(row.line).padStart(width)} │${row.sign}${row.text}`).join("\n");
}

/** Format numbered changes from eight sorted hunks, capped at twelve changed rows per side and three hundred characters per row. */
export function formatNumberedEditDiff(hunks: readonly EditHunkDisplay[], summary = ""): string {
  const shown = [...hunks].sort((a, b) => a.startLine - b.startLine).slice(0, 8);
  const rows: DiffRow[] = [];
  for (const hunk of buildEditDiffHunks(shown)) {
    const count = { "+": 0, "-": 0 };
    for (const row of hunk.rows) {
      if (count[row.sign]++ < 12) rows.push(row);
    }
  }
  const lines = summary ? [summary] : [];
  if (rows.length > 0) lines.push(...formatDiffRows(rows).split("\n").map(line => line.slice(0, 300)));
  if (hunks.length > shown.length) {
    lines.push(`… ${formatCount(hunks.length - shown.length, "more replacement")}. Full diff is in the session file.`);
  }
  return lines.join("\n");
}

/** Accept finite nonnegative integers for result counts and original line positions. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Rebuild bounded display history without replaying tools, pairing results chronologically within each accepted call group. */
export function buildTranscriptFromSession(items: readonly SessionRecord[]): TuiTranscriptEntry[] {
  const transcript: TuiTranscriptEntry[] = [];
  const pending = new Map<string, TuiTranscriptEntry>();
  let counter = 0;
  const nextId = (prefix: string): string => {
    counter += 1;
    return `hist-${prefix}-${counter}`;
  };
  for (const item of items) {
    if (item.type === "user") {
      const text = item.content.map((block) => block.text).join("");
      if (text.length > 0) {
        transcript.push({ id: nextId("user"), sessionRecordId: item.id, kind: "user", text });
      }
    } else if (item.type === "assistant") {
      const textParts: string[] = [];
      for (const block of item.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "thinking") {
          // Thinking is runtime context, not resumed display history.
        } else if (block.type === "tool_call") {
          const entry: TuiTranscriptEntry = {
            id: nextId("tool"),
            kind: "tool",
            text: "Tool call interrupted before a result was persisted",
            toolName: block.name,
            toolCallId: block.id,
            toolStatus: "cancelled",
            toolSummary: toolTarget(block.name, block.arguments),
          };
          pending.set(block.id, entry);
          transcript.push(entry);
        }
      }
      const text = textParts.join("");
      if (text.length > 0) {
        transcript.push({ id: nextId("asst"), kind: "assistant", text });
      }
    } else if (item.type === "tool_result") {
      const entry = pending.get(item.toolCallId);
      if (entry) {
        entry.text = boundDisplay(item.content);
        entry.toolStatus = item.isError ? "error" : "success";
        pending.delete(item.toolCallId);
      }
    } else if (item.type === "compaction") {
      transcript.push({
        id: nextId("sys"),
        kind: "system",
        text: `Context compacted (saved summary; original history retained): ${boundDisplay(item.summary, 500)}`,
      });
    }
  }
  return transcript;
}

/** Bound displayed tool output so one result cannot flood the terminal. */
export function boundDisplay(text: string, limit: number = MAX_TOOL_DISPLAY_CHARS): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n… truncated. Full output is in the session file.`;
}

/** Remove userinfo, query, and fragment from a displayed URL, or return `configured` if parsing fails. */
export function sanitizeBaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "configured";
  }
}

/** One structured replacement from a successful edit, kept out of model content. */
export interface EditHunkDisplay {
  startLine: number;
  oldText: string;
  newText: string;
}

/** Structured edit extras attached to tool.finished runtime events. */
export interface EditDetailsDisplay {
  path: string;
  hunks?: EditHunkDisplay[];
}

/** Render tool completion from structured details while model content stays bounded. */
export function formatToolFinishedText(
  name: string,
  content: string,
  details: unknown,
  status: "success" | "error" | "cancelled",
): string {
  if (status === "cancelled") {
    return boundDisplay(content);
  }
  if (name === "edit") {
    const edit = asEditDetails(details);
    if (edit && status === "success" && edit.hunks && edit.hunks.length > 0) {
      return boundDisplay(formatEditDiff(edit.path, edit.hunks, content));
    }
    if (edit && status === "error") {
      return boundDisplay(`Edit failed for ${edit.path}: ${content}`);
    }
    if (status === "error") {
      return boundDisplay(`Edit failed: ${content}`);
    }
  }
  return boundDisplay(content);
}

/** Format applied edit hunks as a bounded unified-style diff for the transcript. */
export function formatEditDiff(path: string, hunks: readonly EditHunkDisplay[], summary: string): string {
  const lines = [summary];
  const shown = hunks.slice(0, 8);
  for (const hunk of shown) {
    lines.push(`--- ${path}:${hunk.startLine}`);
    for (const line of hunk.oldText.split("\n").slice(0, 12)) {
      lines.push(`- ${line}`.slice(0, 300));
    }
    for (const line of hunk.newText.split("\n").slice(0, 12)) {
      lines.push(`+ ${line}`.slice(0, 300));
    }
  }
  if (hunks.length > shown.length) {
    lines.push(`… ${hunks.length - shown.length} more replacements. Full diff is in the session file.`);
  }
  return lines.join("\n");
}

/** Narrow unknown tool details to the edit shape without coupling to tool internals. */
export function asEditDetails(details: unknown): EditDetailsDisplay | undefined {
  if (typeof details !== "object" || details === null || Array.isArray(details)) {
    return undefined;
  }
  const record = details as Record<string, unknown>;
  if (typeof record.path !== "string") {
    return undefined;
  }
  if (record.hunks === undefined) {
    return { path: record.path };
  }
  if (!Array.isArray(record.hunks)) {
    return undefined;
  }
  const hunks: EditHunkDisplay[] = [];
  for (const hunk of record.hunks) {
    if (typeof hunk !== "object" || hunk === null || Array.isArray(hunk)) {
      return undefined;
    }
    const entry = hunk as Record<string, unknown>;
    if (
      typeof entry.startLine !== "number" ||
      typeof entry.oldText !== "string" ||
      typeof entry.newText !== "string"
    ) {
      return undefined;
    }
    hunks.push({ startLine: entry.startLine, oldText: entry.oldText, newText: entry.newText });
  }
  return { path: record.path, hunks };
}
