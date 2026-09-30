import { expect, test } from "bun:test";
import { fuzzyRank } from "../src/tui/fuzzy.ts";

test("fuzzy ranks exact, prefix, hyphen word start, substring, then other subsequences", () => {
  const candidates = ["separate-events-soon", "obsession", "delete-session", "sessions", "ses"];
  expect(candidates.map(candidate => fuzzyRank("ses", candidate))).toEqual([4, 3, 2, 1, 0]);
  expect(candidates.toSorted((left, right) => fuzzyRank("ses", left)! - fuzzyRank("ses", right)!))
    .toEqual(["ses", "sessions", "delete-session", "obsession", "separate-events-soon"]);
});

test("fuzzy matching is case insensitive and rejects missing, reordered and repeated characters", () => {
  expect(fuzzyRank("SeS", "SES")).toBe(0);
  expect(fuzzyRank("SeS", "DELETE-SESSION")).toBe(2);
  expect(fuzzyRank("thk", "Thinking")).toBe(4);
  for (const [query, candidate] of [["xyz", "session"], ["sse", "ses"], ["sssss", "sessions"]]) {
    expect(fuzzyRank(query!, candidate!)).toBeUndefined();
  }
  expect(fuzzyRank("", "sessions")).toBe(0);
  expect(fuzzyRank("ses", "")).toBeUndefined();
});

test("a hyphen word start outranks an earlier substring and Unicode subsequences remain searchable", () => {
  expect(fuzzyRank("ses", "obsession-session")).toBe(2);
  expect(fuzzyRank("🪴🌱", "🪴 growing 🌱")).toBe(4);
  expect(fuzzyRank("กค", "กขค")).toBe(4);
});
