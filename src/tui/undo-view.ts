import type { GitDiffRow } from "../text/diff.ts";
import type { UndoPreview } from "./controller-types.ts";

/** Panel heading naming the target or read-only state; Enter undo appears only when an undo applies. */
export function undoHeading(undo: UndoPreview): string {
  if (undo.result) return `Undo turn ${undo.turnNumber} · Esc back`;
  if (undo.readOnlyStatus) return `${undo.readOnlyStatus} · Alt+R review · Esc back`;
  return `Undo ${undo.older ? "older " : ""}turn ${undo.turnNumber} · Enter undo · Esc cancel`;
}

/** Esc phrase for the undo panel: cancel while an undo is offered, back once a result or read-only list shows. */
export function undoEscape(undo: UndoPreview | undefined): string {
  return undo && !undo.result && !undo.readOnlyStatus ? "Esc cancel" : "Esc back";
}

/**
 * Widest undo hint that fits, dropping scroll help before the review action. Esc alone is the last choice, so no
 * segment is ever clipped; when the status bar already names Esc (`escInStatusBar`), the row keeps its review action
 * instead and the caller's fitting drops Esc.
 */
export function undoHint(undo: UndoPreview | undefined, width: number, escInStatusBar = false): string {
  const escape = undoEscape(undo);
  const choices = undo && !undo.result
    ? [`↑↓ select · PgUp/PgDn scroll · Alt+R review · ${escape}`, `↑↓ select · Alt+R review · ${escape}`, `Alt+R review · ${escape}`]
    : [`↑↓ select · PgUp/PgDn scroll · ${escape}`, `↑↓ select · ${escape}`];
  return choices.find(choice => Bun.stringWidth(choice) <= width) ?? (escInStatusBar ? choices.at(-1)! : escape);
}

/** Explanation lines, then the selected file's header and diff or read-only explanation. */
export function undoRows(undo: UndoPreview): GitDiffRow[] {
  const selected = undo.files[undo.selected];
  return [...(undo.notes ?? []).map(text => ({ sign: " " as const, text })),
    ...(undo.shellUnavailable ? [{ sign: " " as const, text: "Shell changes can't be detected here" }] : []),
    { sign: " ", text: `─ ${selected?.path ?? ""} ─` }, ...(selected?.rows ?? [])];
}

/** File-list title for a review opened from the undo panel, naming where its paths came from. */
export const UNDO_REVIEW_FILES = "Files from undo panel";

/** File-list placeholder when none of the undo panel's paths are inside the workspace. */
export const UNDO_REVIEW_NO_FILES = "No workspace files";

/** Current-diff row for that empty case; the panel's paths exist but are outside the workspace. */
export const UNDO_REVIEW_OUTSIDE = "Paths in the undo panel are outside the workspace.";

/** Content title while Details replaces the current diff in a review opened from the undo panel. */
export const UNDO_REVIEW_DETAILS = "Review details";
