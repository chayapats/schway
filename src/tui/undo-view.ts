import type { GitDiffRow } from "../text/diff.ts";
import type { UndoPreview } from "./controller-types.ts";

/** Panel heading naming the target or read-only state; Enter undo appears only when an undo applies. */
export function undoHeading(undo: UndoPreview): string {
  if (undo.result) return `Undo turn ${undo.turnNumber} · Esc close`;
  if (undo.readOnlyStatus) return `${undo.readOnlyStatus} · Alt+R review · Esc close`;
  return `Undo ${undo.older ? "older " : ""}turn ${undo.turnNumber} · Enter undo · Esc cancel`;
}

/** Widest undo hint that fits, dropping scroll help before the review action and never dropping Esc. */
export function undoHint(undo: UndoPreview | undefined, width: number): string {
  const choices = undo && !undo.result
    ? ["↑↓ select · PgUp/PgDn scroll · Alt+R review · Esc close", "↑↓ select · Alt+R review · Esc close", "Alt+R review · Esc close"]
    : ["↑↓ select · PgUp/PgDn scroll · Esc close", "↑↓ select · Esc close"];
  return choices.find(choice => Bun.stringWidth(choice) <= width) ?? choices.at(-1)!;
}

/** Explanation lines, then the selected file's header and diff or read-only explanation. */
export function undoRows(undo: UndoPreview): GitDiffRow[] {
  const selected = undo.files[undo.selected];
  return [...(undo.notes ?? []).map(text => ({ sign: " " as const, text })),
    ...(undo.shellUnavailable ? [{ sign: " " as const, text: "Shell changes can't be detected here" }] : []),
    { sign: " ", text: `─ ${selected?.path ?? ""} ─` }, ...(selected?.rows ?? [])];
}
