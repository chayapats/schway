import { expect, test } from "bun:test";
import { formatCount, formatDuration } from "../src/text/format.ts";

test("counts use singular only for one and accept irregular plurals", () => {
  expect(formatCount(1, "line")).toBe("1 line");
  expect(formatCount(0, "line")).toBe("0 lines");
  expect(formatCount(3, "entry", "entries")).toBe("3 entries");
  expect(formatCount(1, "entry", "entries")).toBe("1 entry");
});

test.each([
  [0, "0.0s"],
  [49, "0.0s"],
  [50, "0.1s"],
  [1200, "1.2s"],
  [1249, "1.2s"],
  [1250, "1.3s"],
  [14000, "14s"],
  [65000, "1m 5s"],
  [9949, "9.9s"],
  [9950, "10s"],
  [9960, "10s"],
  [10000, "10s"],
  [14499, "14s"],
  [14500, "15s"],
  [59499, "59s"],
  [59500, "1m 0s"],
  [60000, "1m 0s"],
  [119500, "2m 0s"],
])("duration %d milliseconds formats as %s", (ms, expected) => {
  expect(formatDuration(ms as number)).toBe(expected);
});
