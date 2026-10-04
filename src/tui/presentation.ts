import type { TuiActivity, TuiTranscriptEntry } from "./controller.ts";
import { formatCount, formatDuration } from "../text/format.ts";
import type { TurnOutcome } from "./controller-types.ts";

/** Return the visible completion word and glyph without implying verification. */
export function outcomeLabel(outcome: TurnOutcome): string {
  return { completed: "✓ Done", failed: "✗ Failed", cancelled: "− Stopped", limit: "◌ Limit" }[outcome.reason];
}

/** Fit a turn summary by dropping elapsed, commands, then files before clipping; actions appear only when `actionable`. */
export function formatOutcomeLine(outcome: TurnOutcome, columns: number, actionable = true): string {
  let elapsed = formatDuration(outcome.elapsedMs);
  // Panels own Alt+R and F2, so the strip names its actions only where they work.
  const actions = actionable ? `Alt+R review${outcome.reason === "failed" ? " · F2 details" : ""}` : "";
  const counts = outcome.commandCounts;
  let commands = [[counts.exitZero, "ok"], [counts.nonzero, "failed"], [counts.unknown, "stopped"]]
    .filter(([count]) => Number(count) > 0).map(([count, word]) => `${formatCount(Number(count), "command")} ${word}`).join(" · ");
  const counted = outcome.files.filter(file => file.added !== undefined || file.removed !== undefined);
  let files = outcome.files.length ? formatCount(outcome.files.length, "file") : "";
  if (counted.length) files += ` +${counted.reduce((sum, file) => sum + (file.added ?? 0), 0)} −${counted.reduce((sum, file) => sum + (file.removed ?? 0), 0)}`;
  const line = () => [outcomeLabel(outcome), files, commands, elapsed, actions].filter(Boolean).join(" · ");
  if (Bun.stringWidth(line()) > columns) elapsed = "";
  if (Bun.stringWidth(line()) > columns) commands = "";
  if (Bun.stringWidth(line()) > columns) files = "";
  return fitLine(line(), columns);
}

/** Pair connection and operation states with semantic status-pill colors. */
export type StatusTone = "ready" | "neutral" | "active" | "stopping" | "attention";

/** Describe the current state in sentence case; spinning labels receive an animated glyph. */
export function statusPill(state: { readiness: string; status: string; activity?: TuiActivity; toolApproval?: unknown }, tiny = false): { label: string; tone: StatusTone; spinning: boolean } {
  if (state.toolApproval) return { label: "APPROVAL", tone: "stopping", spinning: false };
  const activity = state.activity;
  if (state.readiness === "loading") return { label: "Checking", tone: "active", spinning: true };
  if (!activity) {
    if (state.status === "running") return { label: "Working", tone: "active", spinning: true };
    if (state.status === "error") return { label: "Attention", tone: "attention", spinning: false };
    if (state.readiness === "not-connected") return { label: "Not connected", tone: "neutral", spinning: false };
    return { label: "Ready", tone: "ready", spinning: false };
  }
  const duration = tiny ? "" : ` ${formatDuration(activity.elapsedMs)}`;
  if (activity.phase === "stopping") return { label: activity.cancellation === "requested" ? "Stop requested" : `Stopping${duration}`, tone: "stopping", spinning: false };
  if (activity.phase === "retry") {
    const label = activity.retry
      ? `Retry ${activity.retry.failedAttempt + 1}/${activity.retry.maxAttempts}${tiny ? "" : ` · ${formatDuration(activity.retry.remainingMs)}`}`
      : `Retrying${duration}`;
    return { label, tone: "stopping", spinning: true };
  }
  const phase = activity.phase === "tools" ? formatCount(activity.activeTools, "tool") : { preparing: "Preparing", waiting: "Waiting", streaming: "Receiving", compacting: "Compacting" }[activity.phase];
  return { label: `${phase}${duration}`, tone: "active", spinning: true };
}

/** Summarize current work without implying that a quiet provider or tool has stalled. */
export function activityDetail(activity: TuiActivity): string {
  if (activity.compactionOutcome && activity.phase !== "stopping") return {
    completed: "Context compacted · Esc stop", cancelled: "Compaction cancelled · Esc stop",
    failed: "Compaction failed · Esc stop", noop: "Context unchanged · Esc stop",
  }[activity.compactionOutcome];
  return currentWorkDetail(activity);
}

/** Describe the current phase independently of the prior compaction result. */
function currentWorkDetail(activity: TuiActivity): string {
  if (activity.phase === "stopping") return activity.cancellation === "requested" ? "Stop requested · Waiting for cleanup" : "Stopping · Waiting for cleanup";
  if (activity.phase === "compacting") return "Compacting context · Esc stop";
  if (activity.phase === "tools") {
    return `Running ${formatCount(activity.activeTools, "tool")}`;
  }
  if (activity.phase === "retry" && activity.retry) return `Retry ${activity.retry.failedAttempt + 1}/${activity.retry.maxAttempts} · Esc stop`;
  if (activity.phase === "retry") return "Retrying connection · Esc stop";
  return { preparing: "Preparing request · Esc stop", waiting: "Waiting for response · Esc stop", streaming: "Receiving response · Esc stop" }[activity.phase];
}

/** Remove terminal control sequences while retaining ordinary Unicode, tabs, and newlines. */
export function displayText(text: string): string {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

/** Fit one line to terminal columns without splitting a Unicode grapheme. */
export function fitLine(text: string, columns: number): string {
  const line = displayText(text).replace(/\s+/g, " ");
  if (columns <= 0) return "";
  if (Bun.stringWidth(line) <= columns) return line;
  let result = "";
  let width = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line)) {
    const next = Bun.stringWidth(segment);
    if (width + next > columns - 1) break;
    result += segment;
    width += next;
  }
  return `${result}…`;
}

/** Fit a workspace path by dropping middle segments before clipping its final grapheme-safe folder name. */
export function shortenWorkspacePath(path: string, home: string, columns: number): string {
  const normalizedHome = home.replace(/\/+$/, "") || "/";
  const underHome = path === normalizedHome || path.startsWith(normalizedHome === "/" ? "/" : `${normalizedHome}/`);
  const line = displayText(underHome ? `~${normalizedHome === "/" && path !== "/" ? path : path.slice(normalizedHome.length)}` : path).replace(/\s+/g, " ");
  if (columns <= 0) return "";
  if (Bun.stringWidth(line) <= columns) return line;
  const segments = line.split("/").filter(Boolean);
  const last = segments.at(-1) ?? line;
  const first = line.startsWith("/") ? `/${segments[0]}` : segments[0];
  for (let start = 1; start < segments.length; start++) {
    const candidate = `${first}/…/${segments.slice(start).join("/")}`;
    if (Bun.stringWidth(candidate) <= columns) return candidate;
  }
  const tail = `…/${last}`;
  if (Bun.stringWidth(tail) <= columns) return tail;
  if (Bun.stringWidth(last) <= columns) return last;
  return columns > 2 ? `…/${fitLine(last, columns - 2)}` : fitLine(last, columns);
}

/** Select a built-in tool target; callers redact it before clipping it for display. */
export function toolTarget(name: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const values = args as Record<string, unknown>;
  const candidate = name === "bash" ? values.command
    : name === "grep" || name === "find" ? values.pattern
    : ["read", "write", "edit", "ls"].includes(name) ? values.path : undefined;
  return typeof candidate === "string" ? candidate : undefined;
}

/** Return a short tool summary and bounded preview, keeping errors visible without expanding. */
export function toolPresentation(entry: TuiTranscriptEntry, expanded: boolean): { marker: string; target: string; state: string; detail: string; tone: "accent" | "success" | "warning" | "error" | "muted" } {
  const state = entry.toolStatus ?? "error";
  const marker = { running: "●", success: "✓", cancelled: "−", error: "!" }[state];
  const tone = ({ running: "accent", success: "success", cancelled: "muted", error: "error" } as const)[state];
  const lines = displayText(entry.text).split("\n");
  const target = entry.toolSummary || lines.find(line => line.trim()) || "";
  const summary = { marker, target, state: state === "success" ? "done" : state === "cancelled" ? "Stopped" : state, tone, ...(entry.toolName === "bash" ? shellPresentation(entry) : {}) };
  if (expanded) return { ...summary, detail: lines.join("\n") };
  if (state === "success") return { ...summary, detail: "" };
  const preview = state === "running" ? lines.slice(-3) : lines.slice(0, 6);
  if (lines.length > preview.length) preview.push("… Ctrl+O to expand output");
  return { ...summary, detail: preview.join("\n").trim() };
}

/** Derive every shell status cue from execution state and validated evidence, with errors taking precedence over exits. */
function shellPresentation(entry: TuiTranscriptEntry): Pick<ReturnType<typeof toolPresentation>, "marker" | "state" | "tone"> {
  if (entry.toolStatus === "running") return { marker: "●", state: "running", tone: "accent" };
  if (entry.toolStatus === "cancelled") return { marker: "−", state: "Stopped", tone: "muted" };
  if (entry.shellOutcome?.kind === "timed-out") return { marker: "!", state: "Timed out", tone: "error" };
  if (entry.toolStatus !== "success") return { marker: "!", state: "Tool error", tone: "error" };
  if (entry.shellOutcome?.kind === "exit") return entry.shellOutcome.code === 0
    ? { marker: "✓", state: "Exit 0", tone: "success" }
    : { marker: "!", state: `Exit ${entry.shellOutcome.code}`, tone: "warning" };
  return { marker: "−", state: entry.shellOutcome?.kind === "stopped" ? "Stopped" : "No exit observed", tone: "muted" };
}
