import { formatUndoResult } from "../undo/record.ts";
import { toolTarget } from "./presentation.ts";
import { credentialValues, displayUrl, maskCredentialsInText, UNDISPLAYABLE_URL } from "../tools/web-fetch-display.ts";
import type { SessionRecord } from "../conversation/types.ts";
import type { TuiShellOutcome, TuiTranscriptEntry } from "./controller-types.ts";
import { buildEditDiff, buildEditDiffHunks, type DiffRow } from "../text/diff.ts";
import { formatCount, formatDuration } from "../text/format.ts";
import { hostedSearchCount } from "../model/hosted-tools.ts";

/** Bound on displayed tool-result characters; session data stays complete. */
export const MAX_TOOL_DISPLAY_CHARS = 2000;

/** Read shell evidence only from valid structured exit and timeout fields, never from result prose. */
export function asShellOutcome(details: unknown): TuiShellOutcome | undefined {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
  const record = details as Record<string, unknown>;
  if (record.timedOut !== undefined && typeof record.timedOut !== "boolean") return undefined;
  if (record.timedOut === true) return { kind: "timed-out" };
  if (record.exitCode === null) return { kind: "stopped" };
  if (typeof record.exitCode === "number" && Number.isSafeInteger(record.exitCode) && record.exitCode >= 0) return { kind: "exit", code: record.exitCode };
  return undefined;
}

/** Summarize successful built-in results; shell timing is optional and independent of observed exit evidence. */
export function summarizeToolResult(
  name: string,
  status: TuiTranscriptEntry["toolStatus"],
  details: unknown,
  durationMs?: number,
): string | undefined {
  if (name === "bash") return status === "success" && typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
    ? formatDuration(durationMs) : undefined;
  if (status !== "success" || typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
  const record = details as Record<string, unknown>;
  if (name === "web_fetch") {
    const { status: httpStatus, rawBytes, truncated } = record;
    if (!isCount(httpStatus) || !isCount(rawBytes) || typeof truncated !== "boolean") return undefined;
    const elapsed = typeof record.durationMs === "number" && Number.isFinite(record.durationMs) && record.durationMs >= 0 ? record.durationMs
      : typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : undefined;
    return [`HTTP ${httpStatus}`, formatByteSize(rawBytes), ...(elapsed === undefined ? [] : [formatDuration(elapsed)]), ...(truncated ? ["truncated"] : [])].join(" · ");
  }
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

/** Format eight sorted hunks with twelve changed rows per side, transforming changed text before the three-hundred-character row cap. */
export function formatNumberedEditDiff(hunks: readonly EditHunkDisplay[], summary = "", transformText: (text: string) => string = text => text): string {
  const shown = [...hunks].sort((a, b) => a.startLine - b.startLine).slice(0, 8);
  const rows: DiffRow[] = [];
  for (const hunk of buildEditDiffHunks(shown)) {
    const count = { "+": 0, "-": 0 };
    for (const row of hunk.rows) {
      if (count[row.sign]++ < 12) rows.push({ ...row, text: transformText(row.text) });
    }
  }
  const lines = summary ? [summary] : [];
  if (rows.length > 0) lines.push(...formatDiffRows(rows).split("\n").map(line => line.slice(0, 300)));
  if (hunks.length > shown.length) {
    lines.push(`… ${formatCount(hunks.length - shown.length, "more replacement")}. Full diff is in the session file.`);
  }
  return lines.join("\n");
}

/** Identify successful runtime diffs that fit the effective inline limit and cannot be toggled. */
export function hasInlineDiff(entry: TuiTranscriptEntry, limit: number): boolean {
  return entry.toolStatus === "success" && (entry.toolName === "edit" || entry.toolName === "write")
    && !!entry.diffRows?.length && entry.diffRows.length <= limit;
}

/** Format a byte count as B, KB or MB using 1024-byte units. */
function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const [value, unit] = bytes < 1024 * 1024 ? [bytes / 1024, "KB"] : [bytes / (1024 * 1024), "MB"];
  return `${value < 9.95 ? value.toFixed(1) : Math.round(value)} ${unit}`;
}

/** Accept finite nonnegative integers for result counts and original line positions. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** One compact transcript line for an assistant message whose response ran hosted web searches; undefined when it ran none. */
export function hostedSearchEntryText(message: Parameters<typeof hostedSearchCount>[0]): string | undefined {
  const count = hostedSearchCount(message);
  return count === 0 ? undefined : count === 1 ? "Searched the web" : `Searched the web (${count})`;
}

/** Rebuild bounded display history without replaying tools, pairing results chronologically within each accepted call group. */
export function buildTranscriptFromSession(items: readonly SessionRecord[]): TuiTranscriptEntry[] {
  const transcript: TuiTranscriptEntry[] = [];
  const pending = new Map<string, TuiTranscriptEntry>();
  const argumentsByCall = new Map<string, unknown>();
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
          argumentsByCall.set(block.id, block.arguments);
          transcript.push(entry);
        }
      }
      const text = textParts.join("");
      if (text.length > 0) {
        transcript.push({ id: nextId("asst"), kind: "assistant", text });
      }
      // The search line follows its answer, so it reads as part of that answer rather than the next one.
      const searched = hostedSearchEntryText(item);
      if (searched) transcript.push({ id: nextId("sys"), kind: "system", text: searched });
    } else if (item.type === "tool_result") {
      const entry = pending.get(item.toolCallId);
      if (entry) {
        const args = argumentsByCall.get(item.toolCallId);
        const url = typeof args === "object" && args !== null && typeof (args as { url?: unknown }).url === "string" ? (args as { url: string }).url : undefined;
        entry.text = entry.toolName === "web_fetch" ? webFetchDisplayText(item.content, undefined, url) : boundDisplay(item.content);
        entry.toolStatus = item.isError ? "error" : "success";
        entry.resultSummary = summarizeResumedToolResult(entry.toolName ?? "", entry.toolStatus, argumentsByCall.get(item.toolCallId));
        pending.delete(item.toolCallId);
        argumentsByCall.delete(item.toolCallId);
      }
    } else if (item.type === "turn_undo") {
      transcript.push({ id: nextId("sys"), sessionRecordId: item.id, kind: "system", text: formatUndoResult(item) });
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

/**
 * Display a web_fetch result without re-showing the tool's own URL echo: the first line becomes the structured
 * `details.statusLine`, or, without details, a status rebuilt from known fields and the requested URL's display form.
 * The server text gets best-effort masking plus every exact credential value from the requested and echoed URLs.
 */
export function webFetchDisplayText(content: string, details: unknown, requestedUrl?: string): string {
  return webFetchMasked(content, details, requestedUrl, webFetchSecrets(content, requestedUrl));
}

/** Mask one web_fetch result with precomputed exact credential values. */
function webFetchMasked(content: string, details: unknown, requestedUrl: string | undefined, secrets: readonly string[]): string {
  const statusLine = typeof details === "object" && details !== null && typeof (details as { statusLine?: unknown }).statusLine === "string"
    ? (details as { statusLine: string }).statusLine : undefined;
  const newline = content.indexOf("\n");
  const first = newline < 0 ? content : content.slice(0, newline);
  const rest = newline < 0 ? "" : content.slice(newline);
  const line = statusLine ?? rebuiltStatusLine(first, requestedUrl);
  return boundDisplay(line === undefined ? maskCredentialsInText(content, secrets) : `${line}${maskCredentialsInText(rest, secrets)}`);
}

/** Longest first line read for the tool's own status line; the tool bounds that line well below this. */
const MAX_FIRST_LINE = 64 * 1024;

/** Exact credential values from the requested URL and from the URL the tool's own first line carries; never persisted. */
function webFetchSecrets(content: string, requestedUrl: string | undefined): string[] {
  const newline = content.slice(0, MAX_FIRST_LINE + 1).indexOf("\n");
  const fields = (newline < 0 ? content.slice(0, MAX_FIRST_LINE) : content.slice(0, newline)).split(" · ");
  const known = fields[0] === "No response" || fields[0] === "No request sent" || /^HTTP \d{3}/.test(fields[0] ?? "");
  const echoed = known && fields.length > 1 ? (/^after \d+ redirects?$/.test(fields.at(-1)!) ? fields.at(-2)! : fields.at(-1)!) : "";
  return [...new Set([...(requestedUrl ? credentialValues(requestedUrl) : []), ...(echoed ? credentialValues(echoed) : [])])];
}

/**
 * One-line-ready preview of a web_fetch result that masks only a bounded prefix: the first line plus about two
 * preview lengths, cut at ASCII whitespace when one is near. The cut moves before any exact credential value it
 * would split, and when it is not at whitespace a sentinel `@` closes an open userinfo span so it is masked to the cut.
 */
export function webFetchPreviewText(content: string, requestedUrl: string | undefined, bound: number): string {
  const secrets = webFetchSecrets(content, requestedUrl);
  const newline = content.slice(0, MAX_FIRST_LINE + 1).indexOf("\n");
  const head = newline >= 0 ? newline : 0;
  let cut = head + bound * 2;
  if (cut >= content.length) return webFetchMasked(content, undefined, requestedUrl, secrets);
  for (let index = cut; index < Math.min(content.length, cut + bound * 2); index++) {
    if (content.charCodeAt(index) <= 32) { cut = index; break; }
  }
  for (let moved = true; moved;) {
    moved = false;
    for (const secret of secrets) {
      const from = Math.max(head, cut - secret.length + 1);
      const found = content.slice(from, cut + secret.length - 1).indexOf(secret);
      if (found >= 0 && from + found < cut) { cut = from + found; moved = true; }
    }
  }
  // At ASCII whitespace no masked span is open; elsewhere the sentinel closes an open userinfo span.
  if (content.charCodeAt(cut) <= 32) return webFetchMasked(content.slice(0, cut), undefined, requestedUrl, secrets);
  const shown = webFetchMasked(`${content.slice(0, cut)}@`, undefined, requestedUrl, secrets);
  return shown.endsWith("@") ? shown.slice(0, -1) : shown;
}

/** The `url` argument of the web_fetch call with this ID, from the latest assistant message that holds it. */
export function webFetchCallUrl(items: readonly SessionRecord[], toolCallId: string): string | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (item.type !== "assistant") continue;
    const call = item.content.find(block => block.type === "tool_call" && block.id === toolCallId);
    if (call?.type !== "tool_call") continue;
    const url = (call.arguments as { url?: unknown } | null)?.url;
    return typeof url === "string" ? url : undefined;
  }
  return undefined;
}

/**
 * Rebuild a stored first line from recognized fields only, never re-emitting its URL: `HTTP NNN` keeps a plain reason
 * phrase, type and size when they match, then adds the requested URL's display form. Other lines return undefined.
 */
function rebuiltStatusLine(first: string, requestedUrl: string | undefined): string | undefined {
  const fields = first.split(" · ");
  const url = requestedUrl === undefined ? UNDISPLAYABLE_URL : displayUrl(requestedUrl);
  if (fields[0] === "No response" || fields[0] === "No request sent") return `${fields[0]} · ${url}`;
  const code = /^HTTP (\d{3})(?![\d])/.exec(fields[0] ?? "");
  if (!code) return undefined;
  const kept = [/^HTTP \d{3}( [A-Za-z][A-Za-z '-]{0,40})?$/.test(fields[0]!) ? fields[0]! : `HTTP ${code[1]}`];
  if (/^(no content type|[a-z0-9.+-]+\/[a-z0-9.+-]+)$/.test(fields[1] ?? "")) {
    kept.push(fields[1]!);
    if (/^([\d,]+ bytes?( read| \(read limit\))?|\d+ MiB( read| \(read limit\))?|size unknown)$/.test(fields[2] ?? "")) kept.push(fields[2]!);
  }
  return `${kept.join(" · ")} · ${url}`;
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
  transformText: (text: string) => string = text => text,
  requestedUrl?: string,
): string {
  if (name === "web_fetch") return webFetchDisplayText(content, details, requestedUrl);
  if (status === "cancelled") {
    return boundDisplay(content);
  }
  if (name === "edit") {
    const edit = asEditDetails(details);
    if (edit && status === "success" && edit.hunks && edit.hunks.length > 0) {
      return boundDisplay(formatEditDiff(edit.path, edit.hunks, content, transformText));
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

/** Format applied edit hunks as bounded numbered changes beneath the supplied completion text. */
export function formatEditDiff(_path: string, hunks: readonly EditHunkDisplay[], summary: string, transformText: (text: string) => string = text => text): string {
  return formatNumberedEditDiff(hunks, summary, transformText);
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
