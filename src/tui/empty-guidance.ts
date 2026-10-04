import type { TuiSnapshot } from "./controller-types.ts";

/** Heading above the static task examples in a ready, empty conversation. */
export const TASK_EXAMPLES_HEADING = "Try a task";

/** Static English examples; showing them never inspects the project, runs a command or calls a model. */
export const TASK_EXAMPLES: readonly string[] = ["Explain how this project starts.", "Find a bug and suggest a fix.", "Add a test for an edge case."];

const INDENT = "  ";

/** View-local facts that compete with task examples for the empty conversation surface. */
export interface TaskExampleSurface {
  /** Current ordinary composer text; any character, including whitespace, counts as typing. */
  draft: string;
  /** A panel, search, inspection, details return or credential surface owns input or the conversation area. */
  owned: boolean;
  /** A saved-draft restoration or failure notice is visible. */
  draftNotice: boolean;
}

/** Whether a snapshot is a ready, idle, empty conversation whose ordinary composer is empty and unowned. */
export function taskExamplesEligible(snapshot: TuiSnapshot, surface: TaskExampleSurface): boolean {
  return snapshot.readiness === "ready" && snapshot.status === "idle" && snapshot.transcript.length === 0
    && !snapshot.activity && !snapshot.toolApproval && !snapshot.recovery && !snapshot.outcome
    && !snapshot.recentSession && !snapshot.restored
    && !surface.owned && !surface.draftNotice && surface.draft.length === 0;
}

/**
 * Lay out whole examples within `width` columns and `rows` rows, counting one blank separator and the heading.
 * Examples are dropped, never truncated; no lines are returned when the heading and one example cannot fit.
 */
export function taskExampleLines(width: number, rows: number): string[] {
  const fitting = TASK_EXAMPLES.filter(example => Bun.stringWidth(`${INDENT}${example}`) <= width);
  const count = Math.min(fitting.length, rows - 2);
  if (count < 1 || Bun.stringWidth(TASK_EXAMPLES_HEADING) > width) return [];
  return [TASK_EXAMPLES_HEADING, ...fitting.slice(0, count).map(example => `${INDENT}${example}`)];
}
