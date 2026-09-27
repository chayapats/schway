import type { TuiTranscriptEntry } from "./controller.ts";

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
