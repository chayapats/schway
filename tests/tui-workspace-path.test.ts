import { expect, test } from "bun:test";
import { shortenWorkspacePath } from "../src/tui/presentation.ts";

test("workspace paths keep home and the longest whole trailing segments", () => {
  const path = "/home/test/Projects/deep/schway";
  for (const [columns, expected] of [[80, "~/Projects/deep/schway"], [20, "~/…/deep/schway"], [13, "~/…/schway"], [9, "…/schway"], [8, "…/schway"], [7, "schway"], [6, "schway"], [5, "…/sc…"]] as const) {
    expect(shortenWorkspacePath(path, "/home/test", columns)).toBe(expected);
  }
  expect(shortenWorkspacePath("/home/test", "/home/test", 10)).toBe("~");
  expect(shortenWorkspacePath("/home/test-other/schway", "/home/test", 80)).toBe("/home/test-other/schway");
  expect(shortenWorkspacePath("/tmp/claude-1000/a/scratchpad/ws", "/home/test", 20)).toBe("/tmp/…/scratchpad/ws");
  expect(shortenWorkspacePath("/tmp/claude-1000/a/scratchpad/ws", "/home/test", 10)).toBe("/tmp/…/ws");
  expect(shortenWorkspacePath("/tmp/claude-1000/a/scratchpad/ws", "/home/test", 8)).toBe("…/ws");
});

test("every width preserves the final folder when it fits and never splits Thai or emoji graphemes", () => {
  for (const final of ["schway", "ทดสอบ", "資料庫", "👩🏽‍💻-งาน"]) {
    const path = `/home/test/Projects/very-long-directory-name/${final}`;
    for (let width = 1; width <= 90; width++) {
      const shown = shortenWorkspacePath(path, "/home/test", width);
      expect(Bun.stringWidth(shown)).toBeLessThanOrEqual(width);
      if (width >= Bun.stringWidth(final)) expect(shown.endsWith(final)).toBe(true);
      for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(shown)) {
        expect(segment).not.toBe("\u200d");
      }
    }
  }
  expect(shortenWorkspacePath("/home/test/Projects/👩🏽‍💻งานไทย", "/home/test", 5)).toBe("…/👩🏽‍💻…");
  expect(shortenWorkspacePath("/home/test/Projects/ก้ข้คงจ", "/home/test", 4)).toBe("…/ก้…");
  expect(shortenWorkspacePath("/", "/home/test", 1)).toBe("/");
  expect(shortenWorkspacePath("/repo", "/home/test", 5)).toBe("/repo");
  expect(shortenWorkspacePath("/repo", "/home/test", 0)).toBe("");
});
