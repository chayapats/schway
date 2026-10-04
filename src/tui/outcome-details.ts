import { formatCount } from "../text/format.ts";
import type { TurnOutcome } from "./controller-types.ts";
import { outcomeLabel } from "./presentation.ts";

/** Build read-only outcome details: label, then any failure cause, then the tool/command summary, then caveats; never renders tool-call identifiers. */
export function buildOutcomeDetails(outcome: TurnOutcome, context: { shellUnavailable?: string; comparison?: string; recovery?: string } = {}): string {
  return [
    outcomeLabel(outcome),
    // The cause leads so it is visible in the first viewport when F2 scrolls to the notice's first row.
    ...(context.recovery ? [`Failure details: ${context.recovery}`] : []),
    ...outcomeSummary(outcome),
    "",
    "Current working-tree content is unattributed; external edits may be included.",
    "Snapshots show changes observed during the turn, not exclusive Schway authorship. Current diffs may include later edits.",
    "Review is read-only. Files remain changed after failure/cancellation; conversation branching does not restore files.",
    ...(context.shellUnavailable ? [`Shell-change detection unavailable: ${context.shellUnavailable}`] : []),
    ...(context.comparison ? ["", context.comparison] : []),
  ].join("\n");
}

function outcomeSummary(outcome: TurnOutcome): string[] {
  const counts = outcome.commandCounts;
  // A started tool that never finished does not count as a result, so the empty case avoids claiming no tools ran.
  if (!outcome.toolResults && !outcome.failedTools && !counts.exitZero && !counts.nonzero && !counts.unknown && !outcome.commands.length) {
    return ["No tool results or commands."];
  }
  return [
    `${formatCount(outcome.toolResults, "tool result")}; ${formatCount(outcome.failedTools, "failed tool")}.`,
    `Commands: ${counts.exitZero} exit 0 / ${counts.nonzero} nonzero / ${counts.unknown} unknown (entire turn).`,
    "Command results (latest 50; exit codes, not a test-suite guarantee):",
    outcome.commands.map(command => `${command.command} → ${command.exitCode === null ? "no exit observed" : `exit ${command.exitCode}`}`).join("\n") || "No command exit evidence.",
  ];
}
