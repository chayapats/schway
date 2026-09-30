import { formatCount } from "../text/format.ts";
import type { TurnOutcome } from "./controller-types.ts";
import { outcomeLabel } from "./presentation.ts";

/** Build the shared read-only evidence and recovery details without rendering tool-call identifiers. */
export function buildOutcomeDetails(outcome: TurnOutcome, context: { shellUnavailable?: string; comparison?: string; recovery?: string } = {}): string {
  const counts = outcome.commandCounts;
  return [
    outcomeLabel(outcome),
    `${formatCount(outcome.toolResults, "tool result")}; ${formatCount(outcome.failedTools, "failed tool")}.`,
    `Commands: ${counts.exitZero} exit 0 / ${counts.nonzero} nonzero / ${counts.unknown} unknown (entire turn).`,
    "Command results (latest 50; exit codes, not a test-suite guarantee):",
    outcome.commands.map(command => `${command.command} → ${command.exitCode === null ? "no exit observed" : `exit ${command.exitCode}`}`).join("\n") || "No command exit evidence.",
    "",
    "Current working-tree content is unattributed; external edits may be included.",
    "Snapshots show changes observed during the turn, not exclusive Schway authorship. Current diffs may include later edits.",
    "Review is read-only. Files remain changed after failure/cancellation; conversation branching does not restore files.",
    ...(context.shellUnavailable ? [`Shell-change detection unavailable: ${context.shellUnavailable}`] : []),
    ...(context.comparison ? ["", context.comparison] : []),
    ...(context.recovery ? ["", `Failure details: ${context.recovery}`] : []),
  ].join("\n");
}
