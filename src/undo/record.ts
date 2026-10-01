import type { TurnUndoRecord } from "../conversation/types.ts";
import { formatCount } from "../text/format.ts";

/** Build the exact model-visible note from reverted paths and each skipped reason. */
export function buildUndoNote(reverted: TurnUndoRecord["reverted"], skipped: TurnUndoRecord["skipped"], turnNumber: number, latestTurn: boolean): string {
  let note = `The user undid your file changes from ${latestTurn ? "the previous turn" : `turn ${turnNumber}`}: ${reverted.map(file => file.path).join(", ")}.`;
  const changed = skipped.filter(file => file.reason === "changed").map(file => file.path);
  const failed = skipped.filter(file => file.reason === "failed").map(file => file.path);
  if (changed.length) note += ` ${changed.join(", ")} ${changed.length === 1 ? "was not reverted because it changed" : "were not reverted because they changed"} afterwards.`;
  if (failed.length) note += ` ${failed.join(", ")} could not be reverted.`;
  return note;
}

/** Format the durable undo outcome for both live notices and resumed transcript rows. */
export function formatUndoResult(record: Pick<TurnUndoRecord, "turnNumber" | "reverted" | "skipped">): string {
  return `✓ Undid turn ${record.turnNumber} · ${formatCount(record.reverted.length, "file")}${record.skipped.length ? ` · ${record.skipped.length} skipped` : ""}`;
}
