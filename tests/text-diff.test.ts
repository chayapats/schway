import { expect, test } from "bun:test";
import { buildEditDiff, buildEditDiffHunks, countLines } from "../src/text/diff.ts";

test("a single-line replacement keeps its original and edited line numbers", () => {
  expect(buildEditDiff([{ startLine: 2, oldText: "old", newText: "new" }])).toEqual({
    rows: [
      { sign: "-", line: 2, text: "old" },
      { sign: "+", line: 2, text: "new" },
    ],
    added: 1,
    removed: 1,
  });
});

test("common leading and trailing context contributes no changed rows", () => {
  expect(buildEditDiff([{ startLine: 4, oldText: "before\nold\nafter\n", newText: "before\nnew\nafter\n" }])).toEqual({
    rows: [
      { sign: "-", line: 5, text: "old" },
      { sign: "+", line: 5, text: "new" },
    ],
    added: 1,
    removed: 1,
  });
  expect(buildEditDiff([{ startLine: 1, oldText: "same\n", newText: "same\n" }])).toEqual({ rows: [], added: 0, removed: 0 });
});

test("out-of-order hunks are sorted without mutation and later additions shift by prior changes", () => {
  const hunks = [
    { startLine: 10, oldText: "late", newText: "later" },
    { startLine: 3, oldText: "early\n", newText: "first\nsecond\nthird\n" },
    { startLine: 7, oldText: "remove\n", newText: "" },
  ];
  expect(buildEditDiff(hunks)).toEqual({
    rows: [
      { sign: "-", line: 3, text: "early" },
      { sign: "+", line: 3, text: "first" },
      { sign: "+", line: 4, text: "second" },
      { sign: "+", line: 5, text: "third" },
      { sign: "-", line: 7, text: "remove" },
      { sign: "-", line: 10, text: "late" },
      { sign: "+", line: 11, text: "later" },
    ],
    added: 4,
    removed: 3,
  });
  expect(hunks.map(hunk => hunk.startLine)).toEqual([10, 3, 7]);
});

test("hunks starting on the same line retain their input order", () => {
  expect(buildEditDiff([
    { startLine: 2, oldText: "first", newText: "FIRST" },
    { startLine: 2, oldText: "second", newText: "SECOND" },
  ]).rows.map(row => row.text)).toEqual(["first", "FIRST", "second", "SECOND"]);
});

test("empty sides, insertion and deletion do not invent empty rows", () => {
  expect(buildEditDiff([])).toEqual({ rows: [], added: 0, removed: 0 });
  expect(buildEditDiff([{ startLine: 1, oldText: "", newText: "" }])).toEqual({ rows: [], added: 0, removed: 0 });
  expect(buildEditDiff([{ startLine: 2, oldText: "", newText: "inserted\n" }])).toEqual({
    rows: [{ sign: "+", line: 2, text: "inserted" }], added: 1, removed: 0,
  });
  expect(buildEditDiff([{ startLine: 2, oldText: "deleted\n", newText: "" }])).toEqual({
    rows: [{ sign: "-", line: 2, text: "deleted" }], added: 0, removed: 1,
  });
});

test("insertion and deletion within common context trim both sides independently", () => {
  expect(buildEditDiff([{ startLine: 1, oldText: "a\nc\n", newText: "a\nb\nc\n" }])).toEqual({
    rows: [{ sign: "+", line: 2, text: "b" }], added: 1, removed: 0,
  });
  expect(buildEditDiff([{ startLine: 1, oldText: "a\nb\nc\n", newText: "a\nc\n" }])).toEqual({
    rows: [{ sign: "-", line: 2, text: "b" }], added: 0, removed: 1,
  });
});

test("mid-line fragments remain exact and newline changes shift later additions", () => {
  expect(buildEditDiff([
    { startLine: 2, oldText: "  old\r", newText: "  new\r\n" },
    { startLine: 6, oldText: "tail", newText: "next" },
  ])).toEqual({
    rows: [
      { sign: "-", line: 2, text: "  old\r" },
      { sign: "+", line: 2, text: "  new\r" },
      { sign: "-", line: 6, text: "tail" },
      { sign: "+", line: 7, text: "next" },
    ],
    added: 2,
    removed: 2,
  });
  expect(buildEditDiff([
    { startLine: 1, oldText: "same", newText: "same\n" },
    { startLine: 3, oldText: "old", newText: "new" },
  ]).rows).toEqual([
    { sign: "-", line: 3, text: "old" },
    { sign: "+", line: 4, text: "new" },
  ]);
});

test("blank lines count while the final newline contributes no empty segment", () => {
  for (const [text, expected] of [["", 0], ["one", 1], ["one\n", 1], ["one\ntwo\nthree\n", 3], ["\n", 1], ["\n\n", 2], ["one\n\n", 2]] as const) {
    expect(countLines(text)).toBe(expected);
    const diff = buildEditDiff([{ startLine: 1, oldText: "", newText: text }]);
    expect(diff.added).toBe(expected);
    expect(diff.rows).toHaveLength(expected);
  }
});

test("newline-only edits and changes to blank lines retain actual blank rows", () => {
  expect(buildEditDiff([{ startLine: 2, oldText: "\n", newText: "" }])).toEqual({
    rows: [{ sign: "-", line: 2, text: "" }], added: 0, removed: 1,
  });
  expect(buildEditDiff([{ startLine: 2, oldText: "\n", newText: "filled\n" }])).toEqual({
    rows: [
      { sign: "-", line: 2, text: "" },
      { sign: "+", line: 2, text: "filled" },
    ], added: 1, removed: 1,
  });
  expect(buildEditDiff([{ startLine: 2, oldText: "line\n", newText: "line\n\n" }])).toEqual({
    rows: [{ sign: "+", line: 3, text: "" }], added: 1, removed: 0,
  });
});

test("the pure helper leaves row and text bounds to callers", () => {
  const text = Array.from({ length: 30 }, (_, index) => `${index} ${"x".repeat(400)}`).join("\n");
  const diff = buildEditDiff([{ startLine: 1, oldText: "", newText: text }]);
  expect(diff.added).toBe(30);
  expect(diff.rows[29]).toEqual({ sign: "+", line: 30, text: `29 ${"x".repeat(400)}` });
});

test("grouped diffs retain sorted hunk boundaries and full prior line shifts", () => {
  const hunks = [
    { startLine: 10, oldText: "late", newText: "later" },
    { startLine: 2, oldText: "before\nold\nafter\n", newText: "before\none\ntwo\nafter\n" },
    { startLine: 6, oldText: "same", newText: "same" },
  ];
  const groups = buildEditDiffHunks(hunks);
  expect(groups).toEqual([
    { rows: [
      { sign: "-", line: 3, text: "old" },
      { sign: "+", line: 3, text: "one" },
      { sign: "+", line: 4, text: "two" },
    ], added: 2, removed: 1 },
    { rows: [], added: 0, removed: 0 },
    { rows: [
      { sign: "-", line: 10, text: "late" },
      { sign: "+", line: 11, text: "later" },
    ], added: 1, removed: 1 },
  ]);
  expect(groups.flatMap(group => group.rows)).toEqual(buildEditDiff(hunks).rows);
  expect(hunks.map(hunk => hunk.startLine)).toEqual([10, 2, 6]);
  expect(buildEditDiffHunks([])).toEqual([]);
});
