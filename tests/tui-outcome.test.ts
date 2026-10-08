import { expect, test } from "bun:test";
import { formatOutcomeLine } from "../src/tui/presentation.ts";
import type { TurnOutcome } from "../src/tui/controller-types.ts";

const outcome = (overrides: Partial<TurnOutcome> = {}): TurnOutcome => ({
  reason: "completed", files: [], elapsedMs: 14000, commands: [],
  commandCounts: { exitZero: 0, nonzero: 0, unknown: 0 }, toolResults: 0, failedTools: 0, ...overrides,
});

test("outcome words and glyphs keep failed-only details and omit zero counts", () => {
  for (const [reason, word] of [["completed", "✓ Done"], ["failed", "✗ Failed"], ["cancelled", "− Stopped"], ["limit", "◌ Limit"]] as const) {
    expect(formatOutcomeLine(outcome({ reason }), 120)).toBe(`${word} · 14s · Alt+R review${reason === "failed" ? " · F2 details" : ""}`);
  }
});

test("outcomes count tool and shell files and sum only observed line counts", () => {
  const tool = { path: "a.ts", added: 1, removed: 1, source: "tool" as const };
  expect(formatOutcomeLine(outcome({ files: [tool] }), 120)).toBe("✓ Done · 1 file +1 −1 · 14s · Alt+R review");
  expect(formatOutcomeLine(outcome({ files: [tool, { ...tool, path: "b.ts", added: 7, removed: 2 }] }), 120)).toBe("✓ Done · 2 files +8 −3 · 14s · Alt+R review");
  expect(formatOutcomeLine(outcome({ files: [{ path: "out.json", source: "shell" }] }), 120)).toBe("✓ Done · 1 file · 14s · Alt+R review");
});

test("all nonzero whole-turn command results appear in success failure stopped order", () => {
  expect(formatOutcomeLine(outcome({ commandCounts: { exitZero: 3, nonzero: 1, unknown: 1 } }), 140)).toBe("✓ Done · 3 commands ok · 1 command failed · 1 command stopped · 14s · Alt+R review");
});

test("narrow outcomes drop elapsed then all commands then files while preserving actions", () => {
  const value = outcome({ files: [{ path: "a", added: 1, removed: 1, source: "tool" }], commandCounts: { exitZero: 2, nonzero: 0, unknown: 0 } });
  expect(formatOutcomeLine(value, 80)).toBe("✓ Done · 1 file +1 −1 · 2 commands ok · 14s · Alt+R review");
  expect(formatOutcomeLine(value, 55)).toBe("✓ Done · 1 file +1 −1 · 2 commands ok · Alt+R review");
  expect(formatOutcomeLine(value, 50)).toBe("✓ Done · 1 file +1 −1 · Alt+R review");
  expect(formatOutcomeLine(value, 40)).toBe("✓ Done · 1 file +1 −1 · Alt+R review");
  expect(formatOutcomeLine({ ...value, reason: "failed" }, 50)).toBe("✗ Failed · Alt+R review · F2 details");
  expect(formatOutcomeLine({ ...value, reason: "failed" }, 40)).toBe("✗ Failed · Alt+R review · F2 details");
  expect(Bun.stringWidth(formatOutcomeLine({ ...value, reason: "failed" }, 20))).toBeLessThanOrEqual(20);
});

test("narrow outcomes drop whole action keys and never cut one mid-word", async () => {
  const { hintGrammarFailures } = await import("./helpers/hint-grammar.ts");
  const value = outcome({ reason: "failed", files: [{ path: "a", added: 1, removed: 1, source: "tool" }], commandCounts: { exitZero: 2, nonzero: 0, unknown: 0 } });
  for (const reason of ["failed", "completed"] as const) for (let width = 20; width <= 36; width++) {
    const line = formatOutcomeLine({ ...value, reason }, width);
    expect(Bun.stringWidth(line), `${reason} ${width}`).toBeLessThanOrEqual(width);
    expect(line, `${reason} ${width}`).not.toMatch(/(?:Alt\+R|F2) \S*…|(?:Alt\+R|F2)$/);
    const failures = hintGrammarFailures({ screen: "outcome", title: "Outcome", description: "Outcome strip.", variant: `dark-${width}`, cols: width, rows: 1,
      cursor: { x: 1, y: 1, visible: false }, text: [line], styles: [] });
    expect(failures.map(failure => failure.message), line).toEqual([]);
  }
  expect(formatOutcomeLine(value, 28)).toBe("✗ Failed · Alt+R review");
  expect(formatOutcomeLine({ ...value, reason: "completed" }, 21)).toBe("✓ Done · Alt+R review");
  expect(formatOutcomeLine({ ...value, reason: "completed" }, 20)).toBe("✓ Done");
});

test("an outcome shown under a panel keeps its summary but names no Alt+R or F2 action", () => {
  expect(formatOutcomeLine(outcome({ reason: "failed", files: [{ path: "a.ts", added: 1, removed: 1, source: "tool" }] }), 120, { review: false, details: false })).toBe("✗ Failed · 1 file +1 −1 · 14s");
  expect(formatOutcomeLine(outcome(), 120, { review: false, details: false })).toBe("✓ Done · 14s");
});
