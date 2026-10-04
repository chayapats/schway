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

/** Recovery keys that move a failed turn forward, in the order the recovery offers them; empty when only editing remains. */
export function recoveryHint(recovery: Pick<TuiRecovery, "actions">): string {
  const labels: Partial<Record<TuiRecovery["actions"][number], string>> = {
    connect: "Alt+L connect", "retry-credentials": "Ctrl+R retry", "choose-model": "Alt+M choose model", continue: "Ctrl+R continue", details: "F2 details",
  };
  return recovery.actions.flatMap(action => labels[action] ?? []).join(" · ");
}
