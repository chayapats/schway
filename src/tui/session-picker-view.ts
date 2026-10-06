import { formatCount } from "../text/format.ts";
import type { TuiSnapshot } from "./controller-types.ts";
import { displayText, fitLine, shortenWorkspacePath } from "./presentation.ts";

/** Session picker state as the view receives it in a snapshot. */
export type SessionPickerState = NonNullable<TuiSnapshot["sessionPicker"]>;

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
/** Short status shown for any discovery failure; the raw error stays behind F2 details. */
export const SESSION_DISCOVERY_FAILED = "Cannot load sessions";
/** Short status when loading another batch fails; the rows already loaded stay usable. */
export const SESSION_LOAD_MORE_FAILED = "Cannot load more sessions";
/** Short status for a picker resume whose cause has no more specific label. */
export const SESSION_RESUME_FAILED = "Resume failed";

/** Epoch milliseconds of a parseable timestamp, or undefined for a missing or unparseable value. */
function parseTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Exact minute of a parseable timestamp as `YYYY-MM-DD HH:MM UTC`, the `/history` format; undefined when it cannot be parsed. */
export function utcMinuteLabel(value: string | undefined): string | undefined {
  const ms = parseTime(value);
  return ms === undefined ? undefined : `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Whole elapsed days as `N day(s) ago`, with the noun matching the count. */
export function daysAgoLabel(days: number): string {
  return `${formatCount(days, "day")} ago`;
}

/**
 * Activity by elapsed time before the wall-clock `now` (epoch ms), so older activity never reads newer: `just now`
 * under a minute, `N min ago` under an hour, `N h ago` under 24 hours, `yesterday` under 48 hours, `N days ago` under
 * seven days, then the UTC date. Missing or unparseable values read `activity unknown`; a future time shows its UTC
 * date, never a negative age.
 */
export function relativeActivityLabel(value: string | undefined, now: number): string {
  const at = parseTime(value);
  if (at === undefined) return "activity unknown";
  const age = now - at;
  if (age < 0 || age >= 7 * DAY) return new Date(at).toISOString().slice(0, 10);
  if (age < MINUTE) return "just now";
  if (age < HOUR) return `${Math.floor(age / MINUTE)} min ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)} h ago`;
  if (age < 2 * DAY) return "yesterday";
  return daysAgoLabel(Math.floor(age / DAY));
}

/** One hint-row action in display order; the highest `priority` number drops first, after trying its `short` form. */
export interface SessionHintAction { text: string; priority: number; short?: string }
/** The picker's single hint row: an optional short status, then paired key actions. */
export interface SessionPickerHint { status?: string; tone: "error" | "muted"; actions: SessionHintAction[] }

const ESC_BACK: SessionHintAction = { text: "Esc back", priority: 1 };

/**
 * Status and actions for the one picker hint row. Failures, loading, resuming and empty states lead with a short
 * status; a selected row offers `Enter resume`, `Esc back`, `↑↓ select`, `Ctrl+W scope`, `PgUp/PgDn page`,
 * `Ctrl+L load more` (only while more can load) and its position, in that priority. A load-more failure keeps those
 * forward actions and adds `F2 details`; the panel names the failure.
 */
export function sessionPickerHint(picker: SessionPickerState): SessionPickerHint {
  const many = picker.total > 1;
  if (picker.resuming) return { status: "Resuming session…", tone: "muted", actions: [ESC_BACK] };
  if (picker.error && picker.details) return { status: picker.error, tone: "error", actions: [ESC_BACK] };
  const more = picker.errorKind === "more" && picker.errorDetails ? [{ text: "F2 details", priority: 2.5 }] : [];
  if (picker.error && picker.errorKind !== "more") return { status: picker.error, tone: "error", actions: [
    ...(picker.errorKind === "resume" && many ? [{ text: "↑↓ choose another", priority: 3 }] : []),
    ...(picker.errorDetails ? [{ text: "F2 details", priority: 2 }] : []),
    ESC_BACK,
  ] };
  if (picker.loading) return { status: "Loading sessions…", tone: "muted", actions: [ESC_BACK] };
  if (!picker.total) {
    if (picker.query.trim()) return { status: "No matching sessions", tone: "muted", actions: [
      picker.allWorkspaces ? { text: "Edit search", priority: 3 } : { text: "Edit search or Ctrl+W scope", priority: 3, short: "Ctrl+W scope" }, ...more, ESC_BACK] };
    return picker.allWorkspaces
      ? { status: "No saved sessions yet", tone: "muted", actions: [...more, ESC_BACK] }
      : { status: "No saved sessions here yet", tone: "muted", actions: [{ text: "Ctrl+W other workspaces", priority: 3, short: "Ctrl+W scope" }, ...more, ESC_BACK] };
  }
  return { tone: "muted", actions: [
    ...(many ? [{ text: "↑↓ select", priority: 3 }] : []),
    { text: "Enter resume", priority: 1 },
    ...(picker.total > 8 ? [{ text: "PgUp/PgDn page", priority: 5 }] : []),
    { text: "Ctrl+W scope", priority: 4 },
    ...(picker.hasMore ? [{ text: "Ctrl+L load more", priority: 6 }] : []),
    ...more,
    { ...ESC_BACK, priority: 2 },
    { text: `${picker.offset + picker.selectedIndex + 1}/${picker.total}`, priority: 7 },
  ] };
}

/**
 * Fit the hint row into `columns`: shorten actions, then drop the lowest-priority action, keeping at least one;
 * the status is clipped only when the last action and status still do not fit. Pass `omitEsc` when the status bar
 * already names Esc. Returns the status and the fitted action text separately so the view can color them.
 */
export function fitSessionPickerHint(hint: SessionPickerHint, columns: number, omitEsc = false): { status: string; actions: string } {
  const actions = hint.actions.filter(action => !omitEsc || action.text !== ESC_BACK.text).map(action => ({ ...action }));
  const actionText = () => actions.map(action => action.text).join(" · ");
  const width = () => Bun.stringWidth([hint.status ?? "", actionText()].filter(Boolean).join(" · "));
  for (const action of [...actions].sort((a, b) => b.priority - a.priority)) if (width() > columns && action.short) action.text = action.short;
  while (width() > columns && actions.length > 1) actions.splice(actions.indexOf(actions.reduce((low, action) => action.priority > low.priority ? action : low)), 1);
  const rest = actionText();
  if (!hint.status) return { status: "", actions: fitLine(rest, columns) };
  if (width() <= columns) return { status: hint.status, actions: rest };
  const room = columns - Bun.stringWidth(rest) - 3;
  return room >= 4 && rest ? { status: fitLine(hint.status, room), actions: rest } : { status: fitLine(hint.status, columns), actions: "" };
}

/** One rendered picker panel row with its semantic tone; `selected` rows get the selection tint. */
export interface SessionPanelLine { text: string; tone: "accent" | "text" | "muted" | "error"; selected?: boolean }

/** Wrap text into at most `rows` rows of `columns` cells at spaces, clipping the last row. */
function wrapRows(text: string, columns: number, rows: number): string[] {
  const words = displayText(text).replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (Bun.stringWidth(next) <= columns || !line) { line = next; continue; }
    lines.push(line); line = word;
  }
  if (line) lines.push(line);
  const shown = lines.slice(0, rows);
  if (lines.length > rows) shown[rows - 1] = fitLine(`${shown[rows - 1]} ${lines[rows]}`, columns);
  return shown.map(row => fitLine(row, columns));
}

/**
 * Panel rows above the composer: the scope heading, session rows with relative activity, then either the selected
 * row's exact UTC minute, workspace and state or, while F2 details are open, only the selected row and the full
 * failure text in the space the other rows used. Rows carry no
 * key hints; the hint row is rendered separately (or appended via `hint` when the footer hint row is hidden).
 */
export function sessionPanelLines(picker: SessionPickerState, options: {
  columns: number; height: number; visibleRows: number; home: string; now: number; currentSessionId?: string; hint?: SessionPanelLine;
}): SessionPanelLine[] {
  const { columns, height } = options;
  const lines: SessionPanelLine[] = [];
  if (height >= 12) lines.push({ text: fitLine(`Recent sessions · ${picker.allWorkspaces ? "All workspaces + recovery" : "Current workspace"}`, columns), tone: "accent" });
  // Open details keep only the row they describe, so the full failure text gets the other rows' space.
  const details = !!picker.details && !!picker.errorDetails;
  const visibleRows = details ? 1 : options.visibleRows;
  const start = Math.max(0, picker.selectedIndex - visibleRows + 1);
  picker.entries.slice(start, start + visibleRows).forEach((entry, index) => {
    const selected = start + index === picker.selectedIndex;
    const prefix = `${selected ? "›" : " "} ${entry.id === options.currentSessionId ? "● current · " : ""}`;
    const suffix = ` · ${relativeActivityLabel(entry.activityAt, options.now)}`;
    const room = columns - Bun.stringWidth(prefix) - Bun.stringWidth(suffix);
    // Keep the activity visible by clipping the title first; very narrow rows fall back to clipping the whole line.
    const text = room >= 6 ? `${prefix}${fitLine(entry.title, room)}${suffix}` : fitLine(`${prefix}${entry.title}${suffix}`, columns);
    lines.push({ text, tone: selected ? "accent" : "text", selected });
  });
  const selected = picker.entries[picker.selectedIndex];
  // A load-more failure is named here because the hint row keeps the forward actions for the rows already loaded.
  // While a Ctrl+L retry loads, the hint row says so and the earlier failure line is hidden.
  if (picker.errorKind === "more" && !details && !picker.loading) lines.push({ text: fitLine(picker.error ?? SESSION_LOAD_MORE_FAILED, columns), tone: "error" });
  if (details) {
    const rows = options.visibleRows - (selected ? 1 : 0) + 1 + (height >= 14 ? 1 : 0) + (height >= 10 ? 1 : 0);
    for (const row of wrapRows(picker.errorDetails!, columns, Math.max(1, rows))) lines.push({ text: row, tone: "error" });
  } else if (selected) {
    const exact = utcMinuteLabel(selected.activityAt);
    lines.push({ text: fitLine(exact ? `Last activity: ${exact}` : "Activity unknown", columns), tone: "muted" });
    if (height >= 14) {
      const id = ` · ${selected.id}`;
      const path = selected.workspaceRoot ? shortenWorkspacePath(selected.workspaceRoot, options.home, Math.max(8, columns - Bun.stringWidth(id))) : "Unknown workspace";
      lines.push({ text: fitLine(`${path}${id}`, columns), tone: "muted" });
    }
    if (height >= 10) lines.push({ text: fitLine(selected.state, columns), tone: "muted" });
  }
  if (options.hint) lines.push(options.hint);
  return lines;
}
