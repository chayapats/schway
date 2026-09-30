import { expect, test } from "bun:test";
import { formatDiffRows, formatNumberedEditDiff, summarizeResumedToolResult, summarizeToolResult } from "../src/tui/transcript-format.ts";

test("read summaries distinguish complete, empty, partial and truncated reads", () => {
  for (const lineCount of [0, 1, 3]) {
    expect(summarizeToolResult("read", "success", { lineCount, startLine: 1, endLine: lineCount, truncated: false }))
      .toBe(`${lineCount} ${lineCount === 1 ? "line" : "lines"}`);
  }
  expect(summarizeToolResult("read", "success", { lineCount: 300, startLine: 10, endLine: 50, truncated: false })).toBe("lines 10–50 of 300");
  expect(summarizeToolResult("read", "success", { lineCount: 300, startLine: 1, endLine: 50, truncated: false })).toBe("lines 1–50 of 300");
  expect(summarizeToolResult("read", "success", { lineCount: 3, startLine: 2, endLine: 3, truncated: false })).toBe("lines 2–3 of 3");
  expect(summarizeToolResult("read", "success", { lineCount: 3, startLine: 1, endLine: 3, truncated: true })).toBe("lines 1–3 of 3");
});

test("grep and find report matches with singular, plural and truncation", () => {
  for (const [name, field] of [["grep", "matchCount"], ["find", "fileCount"]]) {
    expect(summarizeToolResult(name!, "success", { [field!]: 0, truncated: false })).toBe("0 matches");
    expect(summarizeToolResult(name!, "success", { [field!]: 1, truncated: false })).toBe("1 match");
    expect(summarizeToolResult(name!, "success", { [field!]: 3, truncated: false })).toBe("3 matches");
    expect(summarizeToolResult(name!, "success", { [field!]: 50, truncated: true })).toBe("50+ matches · truncated");
  }
});

test("ls reports entries with an irregular plural and truncation", () => {
  expect(summarizeToolResult("ls", "success", { entryCount: 0, truncated: false })).toBe("0 entries");
  expect(summarizeToolResult("ls", "success", { entryCount: 1, truncated: false })).toBe("1 entry");
  expect(summarizeToolResult("ls", "success", { entryCount: 3, truncated: false })).toBe("3 entries");
  expect(summarizeToolResult("ls", "success", { entryCount: 50, truncated: true })).toBe("50+ entries · truncated");
});

test("bash uses measured duration and treats a missing exit code as stopped", () => {
  expect(summarizeToolResult("bash", "success", { exitCode: 0 }, 1200)).toBe("exit 0 · 1.2s");
  expect(summarizeToolResult("bash", "success", { exitCode: 1 }, 300)).toBe("exit 1 · 0.3s");
  expect(summarizeToolResult("bash", "success", { exitCode: 0 }, 9960)).toBe("exit 0 · 10s");
  expect(summarizeToolResult("bash", "success", { exitCode: 0 }, 65000)).toBe("exit 0 · 1m 5s");
  expect(summarizeToolResult("bash", "success", { exitCode: null }, 1200)).toBe("stopped · no exit code");
  expect(summarizeToolResult("bash", "success", { exitCode: null })).toBe("stopped · no exit code");
});

test("write distinguishes creation and replacement with actual written line counts", () => {
  expect(summarizeToolResult("write", "success", { created: true, lineCount: 42 })).toBe("new · 42 lines");
  expect(summarizeToolResult("write", "success", { created: true, lineCount: 1 })).toBe("new · 1 line");
  expect(summarizeToolResult("write", "success", { created: false, lineCount: 0 })).toBe("overwritten · 0 lines");
  expect(summarizeToolResult("write", "success", { created: false, lineCount: 3 })).toBe("overwritten · 3 lines");
});

test("edit summaries use shared trimmed changed-line counts and a Unicode minus", () => {
  expect(summarizeToolResult("edit", "success", { path: "file.ts", hunks: [{ startLine: 2, oldText: "old", newText: "new" }] })).toBe("+1 −1");
  expect(summarizeToolResult("edit", "success", { path: "file.ts", hunks: [{ startLine: 1, oldText: "before\nold\nafter\n", newText: "before\nnew\nafter\n" }] })).toBe("+1 −1");
  expect(summarizeToolResult("edit", "success", { path: "file.ts", hunks: [{ startLine: 2, oldText: "", newText: "added\n" }] })).toBe("+1 −0");
  expect(summarizeToolResult("edit", "success", { path: "file.ts", hunks: [
    { startLine: 10, oldText: "late", newText: "later" },
    { startLine: 2, oldText: "early\n", newText: "one\ntwo\n" },
  ] })).toBe("+3 −2");
  expect(summarizeToolResult("edit", "success", { path: "file.ts", hunks: [] })).toBe("+0 −0");
});

test("non-success rows and extension tools have no result summaries", () => {
  const results = [
    ["read", { lineCount: 3, startLine: 1, endLine: 3, truncated: false }],
    ["grep", { matchCount: 3, truncated: false }],
    ["find", { fileCount: 3, truncated: false }],
    ["ls", { entryCount: 3, truncated: false }],
    ["bash", { exitCode: 0 }],
    ["write", { created: true, lineCount: 3 }],
    ["edit", { path: "file.ts", hunks: [] }],
  ] as const;
  for (const [name, details] of results) {
    for (const status of ["running", "error", "cancelled", undefined] as const) {
      expect(summarizeToolResult(name, status, details, 1200)).toBeUndefined();
    }
  }
  expect(summarizeToolResult("extension-tool", "success", { lineCount: 3, created: true }, 1200)).toBeUndefined();
});

test("absent, scalar and array details are rejected for every built-in tool", () => {
  for (const name of ["read", "grep", "find", "ls", "bash", "write", "edit"]) {
    for (const details of [undefined, null, [], "result", 3, true, {}]) {
      expect(summarizeToolResult(name, "success", details, 1200)).toBeUndefined();
    }
  }
});

test("invalid count and truncation fields never produce a summary", () => {
  for (const invalid of [-1, 1.5, "3", NaN, Infinity, undefined, null]) {
    expect(summarizeToolResult("read", "success", { lineCount: invalid, startLine: 1, endLine: 3, truncated: false })).toBeUndefined();
    expect(summarizeToolResult("grep", "success", { matchCount: invalid, truncated: false })).toBeUndefined();
    expect(summarizeToolResult("find", "success", { fileCount: invalid, truncated: false })).toBeUndefined();
    expect(summarizeToolResult("ls", "success", { entryCount: invalid, truncated: false })).toBeUndefined();
    expect(summarizeToolResult("write", "success", { lineCount: invalid, created: true })).toBeUndefined();
  }
  for (const truncated of [undefined, null, "true", 1]) {
    expect(summarizeToolResult("read", "success", { lineCount: 3, startLine: 1, endLine: 3, truncated })).toBeUndefined();
    expect(summarizeToolResult("grep", "success", { matchCount: 3, truncated })).toBeUndefined();
    expect(summarizeToolResult("find", "success", { fileCount: 3, truncated })).toBeUndefined();
    expect(summarizeToolResult("ls", "success", { entryCount: 3, truncated })).toBeUndefined();
  }
});

test("malformed read ranges, write creation flags and bash timing are rejected", () => {
  for (const [startLine, endLine] of [[0, 3], [1.5, 3], [1, 3.5], ["1", 3], [1, "3"], [undefined, 3], [1, undefined], [4, 3], [1, 4]]) {
    expect(summarizeToolResult("read", "success", { lineCount: 3, startLine, endLine, truncated: false })).toBeUndefined();
  }
  expect(summarizeToolResult("read", "success", { lineCount: 0, startLine: 2, endLine: 0, truncated: false })).toBeUndefined();
  for (const created of [undefined, null, "true", 1]) {
    expect(summarizeToolResult("write", "success", { lineCount: 3, created })).toBeUndefined();
  }
  for (const exitCode of [undefined, "0", NaN, Infinity, 1.5, -1]) {
    expect(summarizeToolResult("bash", "success", { exitCode }, 1200)).toBeUndefined();
  }
  for (const duration of [undefined, NaN, Infinity, -1]) {
    expect(summarizeToolResult("bash", "success", { exitCode: 0 }, duration)).toBeUndefined();
  }
});

test("edit details require a path and valid complete hunk records", () => {
  for (const details of [
    { hunks: [] }, { path: 3, hunks: [] }, { path: "file.ts" }, { path: "file.ts", hunks: {} },
    ...[null, [], {}, { startLine: 1, oldText: "old" }, { startLine: 1, oldText: 3, newText: "new" }, { startLine: 1, oldText: "old", newText: 3 },
      ...[0, -1, NaN, Infinity, 1.5, "1"].map(startLine => ({ startLine, oldText: "old", newText: "new" })),
    ].map(hunk => ({ path: "file.ts", hunks: [hunk] })),
  ]) {
    expect(summarizeToolResult("edit", "success", details)).toBeUndefined();
  }
});

test("numbered diff formatting aligns lines and preserves recorded signs and fragments", () => {
  expect(formatDiffRows([
    { sign: "-", line: 9, text: "  old\r" },
    { sign: "+", line: 10, text: "  new\r" },
  ])).toBe(" 9 │-  old\r\n10 │+  new\r");
  expect(formatDiffRows([])).toBe("");
  expect(formatNumberedEditDiff([{ startLine: 2, oldText: "before\nold\nafter\n", newText: "before\nnew\nafter\n" }], "Edited file.ts"))
    .toBe("Edited file.ts\n3 │-old\n3 │+new");
  expect(formatNumberedEditDiff([])).toBe("");
  expect(formatNumberedEditDiff([], "Edited file.ts")).toBe("Edited file.ts");
});

test("bounded numbered diffs sort first and preserve full shifts after hidden rows", () => {
  const hunks = [
    { startLine: 40, oldText: "later-old\n", newText: "later-new\n" },
    { startLine: 2, oldText: Array.from({ length: 13 }, (_, i) => `old-${i}\n`).join(""), newText: Array.from({ length: 17 }, (_, i) => `new-${i}\n`).join("") },
  ];
  const text = formatNumberedEditDiff(hunks);
  const rows = text.split("\n");
  expect(rows).toHaveLength(26);
  expect(rows[0]).toBe(" 2 │-old-0");
  expect(rows[11]).toBe("13 │-old-11");
  expect(rows[12]).toBe(" 2 │+new-0");
  expect(rows[23]).toBe("13 │+new-11");
  expect(rows[24]).toBe("40 │-later-old");
  expect(rows[25]).toBe("44 │+later-new");
  expect(text).not.toContain("old-12");
  expect(text).not.toContain("new-12");
  expect(text).not.toContain("--- ");
  expect(hunks.map(hunk => hunk.startLine)).toEqual([40, 2]);
});

test("bounded diff rows clip at three hundred characters without clipping the shared raw formatter", () => {
  const text = "x".repeat(400);
  expect(formatDiffRows([{ sign: "+", line: 1, text }])).toHaveLength(404);
  expect(formatNumberedEditDiff([{ startLine: 1, oldText: "", newText: text }])).toBe(`1 │+${"x".repeat(296)}`);
});

test("bounded diff side limits apply after large common prefix and suffix contexts are trimmed", () => {
  const prefix = Array.from({ length: 100 }, (_, index) => `prefix-${index}\n`).join("");
  const suffix = Array.from({ length: 100 }, (_, index) => `suffix-${index}\n`).join("");
  const oldText = prefix + Array.from({ length: 14 }, (_, index) => `old-${index}\n`).join("") + suffix;
  const newText = prefix + Array.from({ length: 14 }, (_, index) => `new-${index}\n`).join("") + suffix;
  const text = formatNumberedEditDiff([{ startLine: 1, oldText, newText }]);
  expect(text.split("\n")).toHaveLength(24);
  expect(text).toStartWith("101 │-old-0");
  expect(text).toEndWith("112 │+new-11");
  expect(text).not.toContain("prefix");
  expect(text).not.toContain("suffix");
});

test("numbered diff hunks on the same original line remain in input order", () => {
  expect(formatNumberedEditDiff([
    { startLine: 2, oldText: "first", newText: "FIRST\n" },
    { startLine: 2, oldText: "second", newText: "SECOND" },
  ])).toBe("2 │-first\n2 │+FIRST\n2 │-second\n3 │+SECOND");
});

test("bounded diffs show the first eight sorted hunks and count remaining replacements", () => {
  const hunks = Array.from({ length: 10 }, (_, index) => ({ startLine: index + 1, oldText: `old-${index}`, newText: `new-${index}` })).reverse();
  const text = formatNumberedEditDiff(hunks);
  expect(text.split("\n")).toHaveLength(17);
  expect(text).toStartWith("1 │-old-0\n1 │+new-0");
  expect(text).toContain("8 │+new-7");
  expect(text).not.toContain("old-8");
  expect(text).toEndWith("… 2 more replacements. Full diff is in the session file.");
  expect(formatNumberedEditDiff(hunks.slice(1))).toEndWith("… 1 more replacement. Full diff is in the session file.");
});

test("resumed edit summaries trim persisted arguments without line positions", () => {
  expect(summarizeResumedToolResult("edit", "success", { path: "file.ts", edits: [{ oldText: "old", newText: "new" }] })).toBe("+1 −1");
  expect(summarizeResumedToolResult("edit", "success", { path: "file.ts", edits: [{ oldText: "before\nold\nafter\n", newText: "before\nnew\nafter\n" }] })).toBe("+1 −1");
  expect(summarizeResumedToolResult("edit", "success", { path: "file.ts", edits: [
    { oldText: "before\nafter\n", newText: "before\ninserted\nafter\n" },
    { oldText: "deleted\n", newText: "" },
  ] })).toBe("+1 −1");
  expect(summarizeResumedToolResult("edit", "success", { path: "file.ts", edits: [{ oldText: "same", newText: "same" }] })).toBe("+0 −0");
});

test("resumed summaries never infer result data for other tools or unsuccessful edits", () => {
  const args = { path: "file.ts", edits: [{ oldText: "old", newText: "new" }], created: true, lineCount: 3, exitCode: 0, matchCount: 1 };
  for (const name of ["read", "write", "bash", "grep", "find", "ls", "extension-tool"]) {
    expect(summarizeResumedToolResult(name, "success", args)).toBeUndefined();
  }
  for (const status of ["running", "error", "cancelled", undefined] as const) {
    expect(summarizeResumedToolResult("edit", status, args)).toBeUndefined();
  }
});

test("resumed summaries reject malformed edit arguments instead of parsing text", () => {
  for (const args of [undefined, null, [], "Edited file.ts (+1 -1)", {},
    { edits: [{ oldText: "old", newText: "new" }] },
    { path: 3, edits: [{ oldText: "old", newText: "new" }] },
    { path: "file.ts", edits: [] }, { path: "file.ts", edits: {} },
    ...[null, [], {}, { oldText: "old" }, { oldText: 3, newText: "new" }, { oldText: "old", newText: 3 }, { oldText: "", newText: "new" }]
      .map(edit => ({ path: "file.ts", edits: [edit] })),
  ]) {
    expect(summarizeResumedToolResult("edit", "success", args)).toBeUndefined();
  }
});
