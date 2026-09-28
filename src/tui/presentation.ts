import type { TuiActivity, TuiTranscriptEntry } from "./controller.ts";

/** Render an operation's event-backed phase with elapsed time and cancellation control. */
export function activityStatus(activity: TuiActivity, compact = false, tiny = false): string {
  const elapsed = Math.floor(activity.elapsedMs / 1000);
  const duration = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;
  if (tiny) {
    if (activity.phase === "stopping") return activity.cancellation === "requested" ? "◌ Cancel sent" : "◌ Stopping";
    if (activity.phase === "retry" && activity.retry) return `◌ Retry ${activity.retry.failedAttempt + 1}/${activity.retry.maxAttempts} · Esc`;
    return `● ${{ preparing: "Prep", waiting: "Wait", streaming: "Stream", tools: `Tools ${activity.activeTools}`, retry: "Retry", compacting: "Compact" }[activity.phase]} · Esc`;
  }
  if (activity.phase === "stopping") return activity.cancellation === "requested" ? "◌ Cancel requested" : `◌ Stopping ${duration}`;
  if (activity.phase === "retry" && activity.retry) {
    if (compact) return `◌ Retry ${activity.retry.failedAttempt + 1}/${activity.retry.maxAttempts} ${Math.ceil(activity.retry.remainingMs / 1000)}s · Esc stops`;
    return `◌ Retry ${activity.retry.failedAttempt + 1}/${activity.retry.maxAttempts} in ${Math.ceil(activity.retry.remainingMs / 1000)}s · ${duration} · Esc stops`;
  }
  if (activity.phase === "retry") return `◌ Retrying ${duration} · Esc stops`;
  const phase = activity.phase === "tools" ? `Tools ${activity.activeTools}` : {
    preparing: "Preparing", waiting: "Waiting for model", streaming: "Streaming", compacting: "Compacting",
  }[activity.phase];
  return `● ${compact && activity.phase === "waiting" ? "Waiting" : phase} ${duration} · Esc stops`;
}

/** Summarize current work without implying that a quiet provider or tool has stalled. */
export function activityDetail(activity: TuiActivity): string {
  const detail = currentWorkDetail(activity);
  return activity.compactionOutcome && activity.phase !== "stopping"
    ? `Compaction ${activity.compactionOutcome === "noop" ? "no-op" : activity.compactionOutcome} · ${detail}`
    : detail;
}

/** Describe the current phase independently of the prior compaction result. */
function currentWorkDetail(activity: TuiActivity): string {
  if (activity.phase === "stopping") return activity.cancellation === "requested" ? "Cancellation requested · stop signal sent" : "Stopping · waiting for active work to settle";
  if (activity.phase === "compacting") return `${activity.compactionReason === "overflow" ? "Context overflow" : activity.compactionReason === "pressure" ? "Context pressure" : "Manual compaction"} · summarizing older turns; history retained`;
  if (activity.phase === "tools") {
    const names = [...new Set(activity.toolNames)];
    return names.length ? `Running ${activity.activeTools} tool${activity.activeTools === 1 ? "" : "s"}: ${names.slice(0, 2).join(", ")}${names.length > 2 ? ` +${names.length - 2}` : ""}` : `Running ${activity.activeTools} tools`;
  }
  if (activity.phase === "retry" && activity.retry) return `Provider retry ${activity.retry.failedAttempt + 1}/${activity.retry.maxAttempts} after the requested delay`;
  if (activity.phase === "retry") return "Retrying provider request…";
  return { preparing: "Preparing request…", waiting: "Waiting for provider response…", streaming: "Receiving response…" }[activity.phase];
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
export function toolPresentation(entry: TuiTranscriptEntry, expanded: boolean): { marker: string; target: string; state: string; detail: string; tone: "accent" | "success" | "warning" | "error" } {
  const state = entry.toolStatus ?? "error";
  const marker = { running: "●", success: "✓", cancelled: "−", error: "!" }[state];
  const tone = { running: "accent", success: "success", cancelled: "warning", error: "error" }[state] as "accent" | "success" | "warning" | "error";
  const lines = displayText(entry.text).split("\n");
  const target = entry.toolSummary || lines.find(line => line.trim()) || "";
  const summary = { marker, target, state: state === "success" ? "done" : state, tone };
  if (expanded) return { ...summary, detail: lines.join("\n") };
  if (state === "success") return { ...summary, detail: "" };
  const preview = state === "running" ? lines.slice(-3) : lines.slice(0, 6);
  if (lines.length > preview.length) preview.push("… Ctrl+O to expand output");
  return { ...summary, detail: preview.join("\n").trim() };
}
