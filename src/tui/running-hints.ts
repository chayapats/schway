import type { TuiRecovery } from "./controller-types.ts";

/** Composer placeholder while a turn runs: text typed now is an unsent draft, never queued work. */
export function runningPlaceholder(columns: number): string {
  return columns >= 30 ? "Draft your next task…" : "Draft next task…";
}

/** Hint-row guidance while a turn runs; Enter sends only after the turn ends, and stopping stays available. */
export const RUNNING_DRAFT_HINT = "Wait, then Enter sends · Esc stop";

/** Short hint-row form for widths that cannot fit the draft guidance; run state and stop come first. */
export const RUNNING_NARROW_HINT = "Working · Esc stop";

/** Notice for plain text submitted while work is active; the draft stays and nothing is queued. The activity row keeps the stop key. */
export function runningSubmitNotice(stopping: boolean): string {
  return stopping ? "Stopping · Wait, then Enter sends" : "Still working · Wait, then Enter sends";
}

/** Error-row label for each recovery action; the hint row reuses these so both surfaces name the same keys. */
export const RECOVERY_ACTION_LABELS: Readonly<Record<TuiRecovery["actions"][number], string>> = {
  connect: "Alt+L connect", "retry-credentials": "Ctrl+R retry credential access", "choose-model": "Alt+M choose model",
  continue: "Ctrl+R continue", details: "F2 details", "keep-editing": "Esc keep editing",
};

/** Hint-row lead when this session cannot save another turn; another session must open before Enter can send. */
export const SESSION_BLOCKED_HINT = "/new start fresh · /sessions browse";

/** Recovery keys from the error row, in offered order and including F2 details; omits Esc keep editing and is empty when nothing else remains. */
export function recoveryHint(recovery: Pick<TuiRecovery, "actions">): string {
  return recovery.actions.filter(action => action !== "keep-editing").map(action => RECOVERY_ACTION_LABELS[action]).join(" · ");
}

/** Keys that lead the idle hint row instead of Enter send, or "" when Enter can genuinely send. */
export function blockedSubmitHint(snapshot: { status: string; recovery?: Pick<TuiRecovery, "actions">; sessionWriteBlocked?: true }): string {
  const failed = snapshot.status === "error" && !!snapshot.recovery;
  if (!failed && !snapshot.sessionWriteBlocked) return "";
  const keys = [snapshot.sessionWriteBlocked ? SESSION_BLOCKED_HINT : "", failed ? recoveryHint(snapshot.recovery!) : ""].filter(Boolean).join(" · ");
  return keys || RECOVERY_ACTION_LABELS["keep-editing"];
}
