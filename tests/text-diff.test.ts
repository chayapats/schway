import { expect, test } from "bun:test";
import { buildEditDiff, buildEditDiffHunks, countLines, parseGitDiff, type GitDiffSection } from "../src/text/diff.ts";

test("comparison labels use structured scope and leave legacy parsing opt-in", () => {
  const sections: GitDiffSection[] = [
    { comparison: "index-to-worktree", diff: "Staged:\n@@ -1 +1 @@\n-index text\n+worktree text", truncated: false, binaryFiles: [] },
    { comparison: "head-to-index", diff: "Unstaged:\n@@ -1 +1 @@\n-HEAD text\n+index text", truncated: false, binaryFiles: [] },
  ];
  const preview = { diff: "@@ -1 +1 @@\n-legacy old\n+legacy new", truncated: false, binaryFiles: [], sections };
  expect(parseGitDiff(preview)).toEqual([
    { sign: "-", line: 1, text: "legacy old" }, { sign: "+", line: 1, text: "legacy new" },
  ]);
  expect(parseGitDiff(preview, { includeComparisons: true, includeSections: true })).toEqual([
    { sign: " ", text: "Unstaged · index → worktree" },
    { sign: "-", line: 1, text: "index text" }, { sign: "+", line: 1, text: "worktree text" },
    { sign: " ", text: "Staged · HEAD → index" },
    { sign: "-", line: 1, text: "HEAD text" }, { sign: "+", line: 1, text: "index text" },
  ]);
  // A legacy preview has no trusted provenance from which to invent a comparison label.
  expect(parseGitDiff({ ...preview, sections: undefined }, { includeComparisons: true })).toEqual(parseGitDiff(preview));
});

test("structured comparisons retain literal Unicode source and per-section unavailable content", () => {
  const sections: GitDiffSection[] = [
    { comparison: "untracked", diff: "Staged:\nnot source", untrackedContent: "Staged:\n@@ -1 +1 @@\nสวัสดี 😀\n", truncated: false, binaryFiles: [] },
    { comparison: "index-to-worktree", diff: "", truncated: false, binaryFiles: ["blob.bin"] },
    { comparison: "head-to-index", diff: "", truncated: true, binaryFiles: [] },
  ];
  expect(parseGitDiff({ diff: "ignored", truncated: true, binaryFiles: [], sections }, { includeComparisons: true })).toEqual([
    { sign: " ", text: "Untracked · current file" },
    { sign: "+", line: 1, text: "Staged:" },
    { sign: "+", line: 2, text: "@@ -1 +1 @@" },
    { sign: "+", line: 3, text: "สวัสดี 😀" },
    { sign: " ", text: "Unstaged · index → worktree" },
    { sign: " ", text: "Binary file · content not shown" },
    { sign: " ", text: "Staged · HEAD → index" },
    { sign: " ", text: "Preview truncated · use git diff for full content" },
  ]);
});

test("comparison parsing preserves raw source for the existing caller redaction boundary", () => {
  const source = "\u001b[31msecret-fixture\u001b[0m ไทย";
  const section: GitDiffSection = { comparison: "untracked", diff: "", untrackedContent: source, truncated: false, binaryFiles: [] };
  const rows = parseGitDiff({ ...section, sections: [section] }, { includeComparisons: true });
  expect(rows[1]).toEqual({ sign: "+", line: 1, text: source });
  expect(rows[0]).toEqual({ sign: " ", text: "Untracked · current file" });
});

test("Git review drops metadata and stats and numbers each hunk using old removals and new context", () => {
  expect(parseGitDiff({ diff: "Unstaged:\n a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\ndiff --git a/a.ts b/a.ts\nindex 1111111..2222222 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -2,3 +4,4 @@ title\n context\n-old\n+new\n+extra\n tail\n@@ -10 +13 @@\n-late\n+later\n", truncated: false, binaryFiles: [] })).toEqual([
    { sign: " ", line: 4, text: "context" },
    { sign: "-", line: 3, text: "old" },
    { sign: "+", line: 5, text: "new" },
    { sign: "+", line: 6, text: "extra" },
    { sign: " ", line: 7, text: "tail" },
    { sign: "-", line: 10, text: "late" },
    { sign: "+", line: 13, text: "later" },
  ]);
});

test("Git review keeps plain explanations for binary deleted renamed truncated and untracked files", () => {
  expect(parseGitDiff({ diff: "Untracked:\nhello\n\nworld\n", untrackedContent: "hello\n\nworld\n", truncated: false, binaryFiles: [] })).toEqual([
    { sign: "+", line: 1, text: "hello" }, { sign: "+", line: 2, text: "" }, { sign: "+", line: 3, text: "world" },
  ]);
  expect(parseGitDiff({ diff: "diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new", truncated: false, binaryFiles: [] })).toEqual([{ sign: " ", text: "Renamed from old to new" }]);
  expect(parseGitDiff({ diff: "diff --git a/a b/a\ndeleted file mode 100644\n--- a/a\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone", truncated: false, binaryFiles: [] })).toEqual([{ sign: " ", text: "File deleted" }, { sign: "-", line: 1, text: "gone" }]);
  expect(parseGitDiff({ diff: "Untracked binary file blob. Content summarized, not shown.", truncated: false, binaryFiles: ["blob"] })).toEqual([{ sign: " ", text: "Binary file · content not shown" }]);
  expect(parseGitDiff({ diff: "Untracked:\nhello\n… truncated at 5 chars.", untrackedContent: "hello", truncated: true, binaryFiles: [] })).toEqual([{ sign: "+", line: 1, text: "hello" }, { sign: " ", text: "Preview truncated · use git diff for full content" }]);
  expect(parseGitDiff({ diff: "No textual diff. Staged, untracked, or binary-only changes may still be listed by /changes status.", truncated: false, binaryFiles: [] })).toEqual([{ sign: " ", text: "No textual diff" }]);
});

test("metadata-looking untracked content remains literal numbered source text", () => {
  expect(parseGitDiff({ diff: "Untracked:\ndiff --git literal\nBinary files are ordinary text\n+++ source\n@@ source\n", untrackedContent: "diff --git literal\nBinary files are ordinary text\n+++ source\n@@ source\n", truncated: false, binaryFiles: [] })).toEqual([
    { sign: "+", line: 1, text: "diff --git literal" },
    { sign: "+", line: 2, text: "Binary files are ordinary text" },
    { sign: "+", line: 3, text: "+++ source" },
    { sign: "+", line: 4, text: "@@ source" },
  ]);
});

test("structured untracked previews preserve literal markers regardless of multiline footer prose", () => {
  expect(parseGitDiff({ diff: "Untracked:\nhello\n… truncated at SOURCE CONTENT\n… truncated at 5 chars. Another literal source line\nmore source\n… truncated at 8000 chars. Use git diff --no-index /dev/null -- multi\nline.txt in /project\nroot for the full content.", untrackedContent: "hello\n… truncated at SOURCE CONTENT\n… truncated at 5 chars. Another literal source line\nmore source", truncated: true, binaryFiles: [] })).toEqual([
    { sign: "+", line: 1, text: "hello" },
    { sign: "+", line: 2, text: "… truncated at SOURCE CONTENT" },
    { sign: "+", line: 3, text: "… truncated at 5 chars. Another literal source line" },
    { sign: "+", line: 4, text: "more source" },
    { sign: " ", text: "Preview truncated · use git diff for full content" },
  ]);
});

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

import { diffLines } from "../src/text/diff.ts";
test("line diffs describe identical, replaced, created, deleted and unterminated text", () => {
  expect(diffLines("same\n", "same\n")).toEqual({ rows: [], added: 0, removed: 0 });
  expect(diffLines("keep\nold\n", "keep\nnew\n")).toEqual({ rows: [{ sign: "-", line: 2, text: "old" }, { sign: "+", line: 2, text: "new" }], added: 1, removed: 1 });
  expect(diffLines("", "a\nb\n")).toEqual({ rows: [{ sign: "+", line: 1, text: "a" }, { sign: "+", line: 2, text: "b" }], added: 2, removed: 0 });
  expect(diffLines("a\nb\n", "")).toEqual({ rows: [{ sign: "-", line: 1, text: "a" }, { sign: "-", line: 2, text: "b" }], added: 0, removed: 2 });
  expect(diffLines("old", "new")).toEqual({ rows: [{ sign: "-", line: 1, text: "old" }, { sign: "+", line: 1, text: "new" }], added: 1, removed: 1 });
});


test("whole-file diffs retain final-newline identity", () => {
  expect(diffLines("same\n", "same")).toEqual({ rows: [
    { sign: "-", line: 1, text: "same" }, { sign: "+", line: 1, text: "same" },
  ], added: 1, removed: 1 });
  expect(diffLines("same", "same\n")).toEqual({ rows: [
    { sign: "-", line: 1, text: "same" }, { sign: "+", line: 1, text: "same" },
  ], added: 1, removed: 1 });
});

test("whole-file diffs omit unchanged lines between separate edits", () => {
  expect(diffLines("old\nkeep\nold2\n", "new\nkeep\nnew2\n")).toEqual({ rows: [
    { sign: "-", line: 1, text: "old" }, { sign: "+", line: 1, text: "new" },
    { sign: "-", line: 3, text: "old2" }, { sign: "+", line: 3, text: "new2" },
  ], added: 2, removed: 2 });
});

test("whole-file diffs number separated insertions and deletions on their own sides", () => {
  expect(diffLines("a\nremove\nb\nc\n", "a\nb\ninsert\nc\n")).toEqual({ rows: [
    { sign: "-", line: 2, text: "remove" }, { sign: "+", line: 3, text: "insert" },
  ], added: 1, removed: 1 });
});

test("large file diffs preserve sparse common lines and handle unrelated content", () => {
  const lines = Array.from({ length: 30_000 }, (_, index) => `line ${index}\n`);
  const changed = [...lines]; changed[1] = "first replacement\n"; changed[29_998] = "last replacement\n";
  const sparse = diffLines(lines.join(""), changed.join(""));
  expect(sparse.rows).toHaveLength(4);
  expect(sparse).toEqual({ rows: [
    { sign: "-", line: 2, text: "line 1" }, { sign: "+", line: 2, text: "first replacement" },
    { sign: "-", line: 29_999, text: "line 29998" }, { sign: "+", line: 29_999, text: "last replacement" },
  ], added: 2, removed: 2 });
  const unrelated = diffLines("old\n".repeat(15_000), "new\n".repeat(15_000));
  expect(unrelated.added).toBe(15_000); expect(unrelated.removed).toBe(15_000);
  expect(unrelated.rows).toHaveLength(30_000);
});
