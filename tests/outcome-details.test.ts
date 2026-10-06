import { expect, test } from "bun:test";
import { buildOutcomeDetails } from "../src/tui/outcome-details.ts";
import { formatOutcomeLine } from "../src/tui/presentation.ts";
import type { TurnOutcome } from "../src/tui/controller-types.ts";

const outcome = (overrides: Partial<TurnOutcome> = {}): TurnOutcome => ({
  reason: "completed", files: [], elapsedMs: 14000, commands: [],
  commandCounts: { exitZero: 0, nonzero: 0, unknown: 0 }, toolResults: 0, failedTools: 0, ...overrides,
});
const caveats = [
  "Current working-tree content is unattributed; external edits may be included.",
  "Snapshots show changes observed during the turn, not exclusive Schway authorship. Current diffs may include later edits.",
  "Review is read-only. Files remain changed after failure/cancellation; conversation branching does not restore files.",
];

test("a failed turn's details lead with the label and then the failure cause", () => {
  const lines = buildOutcomeDetails(outcome({ reason: "failed" }), { recovery: "Provider request failed after 3 transient attempts: Service unavailable" }).split("\n");
  expect(lines[0]).toBe("✗ Failed");
  expect(lines[1]).toStartWith("Failure details: ");
  expect(lines[1]).toBe("Failure details: Provider request failed after 3 transient attempts: Service unavailable");
  expect(lines[2]).toBe("No tool results or commands.");
});

test("an all-zero outcome compacts the tool and command summary into one line", () => {
  const text = buildOutcomeDetails(outcome());
  expect(text.split("\n").slice(0, 3)).toEqual(["✓ Done", "No tool results or commands.", ""]);
  for (const absent of ["0 tool results", "Commands: 0 exit 0", "Command results (", "No command exit evidence.", "No tools ran."]) expect(text).not.toContain(absent);
});

test("retained commands keep the tallies and every exit row", () => {
  const text = buildOutcomeDetails(outcome({
    toolResults: 2, commandCounts: { exitZero: 1, nonzero: 0, unknown: 1 },
    commands: [{ callId: "a", command: "bun test", exitCode: 0, status: "success" }, { callId: "b", command: "sleep 9", exitCode: null, status: "error" }],
  }));
  expect(text).toContain("2 tool results; 0 failed tools.");
  expect(text).toContain("Commands: 1 exit 0 / 0 nonzero / 1 unknown (entire turn).");
  expect(text).toContain("bun test → exit 0");
  expect(text).toContain("sleep 9 → no exit observed");
  expect(text).not.toContain("No tool results or commands.");
});

test("any nonzero count keeps the existing summary wording without commands", () => {
  for (const overrides of [{ toolResults: 1 }, { failedTools: 1 }, { commandCounts: { exitZero: 0, nonzero: 0, unknown: 1 } }] satisfies Partial<TurnOutcome>[]) {
    const text = buildOutcomeDetails(outcome(overrides));
    expect(text).toContain("tool result");
    expect(text).toContain("Commands: ");
    expect(text).toContain("Command results (latest 50; exit codes, not a test-suite guarantee):");
    expect(text).toContain("No command exit evidence.");
    expect(text).not.toContain("No tool results or commands.");
  }
});

test("caveats, the shell note and the comparison follow the cause and summary in their prior order", () => {
  const text = buildOutcomeDetails(outcome({ reason: "failed", toolResults: 1 }), { recovery: "cause", shellUnavailable: "no workspace is active.", comparison: "Comparison fixture" });
  const order = ["✗ Failed", "Failure details: cause", "1 tool result; 0 failed tools.", "No command exit evidence.", ...caveats, "Shell-change detection unavailable: no workspace is active.", "Comparison fixture"]
    .map(line => text.indexOf(line));
  expect(order.every(index => index >= 0)).toBe(true);
  expect(order).toEqual(order.toSorted((a, b) => a - b));
  // A blank line separates the summary from the caveats and the caveats from the comparison.
  expect(text).toContain("No command exit evidence.\n\nCurrent working-tree");
  expect(text).toContain("is active.\n\nComparison fixture");
  expect(text).not.toContain("\n\nFailure details:");
});

test("without diagnostics no cause line is emitted", () => {
  for (const reason of ["completed", "cancelled", "limit", "failed"] as const) {
    const text = buildOutcomeDetails(outcome({ reason }));
    expect(text).not.toContain("Failure details:");
    for (const caveat of caveats) expect(text).toContain(caveat);
  }
});

test("the outcome strip omits F2 details while details are open and keeps Alt+R review", () => {
  const failed = outcome({ reason: "failed" });
  expect(formatOutcomeLine(failed, 120)).toBe("✗ Failed · 14s · Alt+R review · F2 details");
  expect(formatOutcomeLine(failed, 120, true, true)).toBe("✗ Failed · 14s · Alt+R review");
  expect(formatOutcomeLine(failed, 40, true, true)).toBe("✗ Failed · 14s · Alt+R review");
  expect(formatOutcomeLine(failed, 120, false, true)).toBe("✗ Failed · 14s");
  expect(formatOutcomeLine(outcome(), 120, true, true)).toBe("✓ Done · 14s · Alt+R review");
});
