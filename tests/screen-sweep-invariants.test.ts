import { expect, test } from "bun:test";
import type { ScreenGolden } from "./screen-catalog/format.ts";
import {
  applySweepExemptions, escExitFailures, formatSweepFailure, sweepFrameFailures,
  type SweepExemption, type SweepFrame, type SweepFrameState,
} from "./helpers/screen-invariants.ts";
import { diffGutter, wrapDiffLine } from "../src/tui/diff-wrap.ts";
import { SWEEP_SMOKE, sweepWidths } from "./helpers/screen-sweep.ts";
import { LAYOUT_BREAKPOINTS } from "../src/tui/layout.ts";

/** A synthetic sweep frame: the given rows at `width` columns, with the status bar and hint row last unless the state says otherwise. */
function frame(text: string[], state: Partial<SweepFrameState> = {}, options: { width?: number; variant?: string; screen?: string } = {}): SweepFrame {
  const width = options.width ?? 40;
  const golden: ScreenGolden = { screen: options.screen ?? "synthetic", title: "Synthetic", description: "A synthetic frame.", variant: options.variant ?? `sweep-${width}`,
    cols: width, rows: text.length, text, styles: [], cursor: { x: 1, y: 1, visible: false } };
  return { golden, width, state: { wrapped: [], ...state } };
}
const invariants = (sweep: SweepFrame) => sweepFrameFailures(sweep).map(failure => failure.invariant);
const status = " ◆ Auto  ● Ready   scripted…    ctx ~337";

test("S1 fails a hint row that cuts a segment mid-word or with …", () => {
  const hint = { text: "Alt+R review · Esc cancel", top: 1, rows: 1 };
  const clipped = sweepFrameFailures(frame([" Auto · Esc cancel", " Alt+R review · Esc clo"], { hint, status: 0 }, { width: 24 }));
  expect(clipped.map(failure => [failure.invariant, failure.row])).toEqual([["S1", 1]]);
  expect(formatSweepFailure(clipped[0]!)).toBe('synthetic 24 columns S1: hint segment "Esc clo" is not a whole segment of "Alt+R review · Esc cancel" (row 1: " Alt+R review · Esc clo")');
  expect(invariants(frame([status, " Alt+R review · Esc canc…"], { hint, status: 0 }))).toEqual(["S1"]);
});

test("S1 passes whole segments, dropped segments and a wrapped review hint read as one row", () => {
  const hint = { text: "↑↓ select · PgUp/PgDn scroll · Alt+R review · Esc cancel", top: 1, rows: 1 };
  expect(invariants(frame([status, " ↑↓ select · Alt+R review · Esc cancel"], { hint, status: 0 }))).toEqual([]);
  const review = { text: "↑↓ files · PgUp/PgDn scroll · Ctrl+R reload · F2 details · Esc back", top: 1, rows: 4 };
  expect(invariants(frame([" Auto · Esc back", " ↑↓ files", " PgUp/PgDn scroll", " Ctrl+R reload", " F2 details · Esc back"], { hint: review, status: 0 }, { width: 24 }))).toEqual([]);
  // A segment wider than its row may wrap inside itself.
  const wide = { text: "Enter current diff · Esc back", top: 1, rows: 3 };
  expect(invariants(frame([" Auto · Esc back", " Enter current", " diff", " Esc back"], { hint: wide, status: 0 }, { width: 16 }))).toEqual([]);
});

test("S2 fails a wrapped row that ends with a key or a separator", () => {
  // The undo heading split between Esc and its action, and a heading that ends with a dangling separator.
  const heading = frame([" Undo older turn 1 · Enter undo · Esc", " cancel", "", status], { wrapped: [{ top: 0, rows: 2 }], status: 3 }, { width: 39 });
  expect(sweepFrameFailures(heading).map(failure => [failure.invariant, failure.row, failure.message])).toEqual([["S2", 0, "a wrapped row ends with Esc and its action starts the next row"]]);
  const dangling = frame([" No saved undo for these changes · Alt+R review ·", " Esc close", "", status], { wrapped: [{ top: 0, rows: 2 }], status: 3 }, { width: 50 });
  expect(sweepFrameFailures(dangling).map(failure => failure.message)).toEqual(["a wrapped row ends with a dangling ` ·`"]);
  // A next row that starts with the separator, and a hint row split between PgUp/PgDn and scroll.
  expect(invariants(frame([" Undo turn 1 · Enter undo", " · Esc cancel", status], { wrapped: [{ top: 0, rows: 2 }], status: 2 }, { width: 29 }))).toEqual(["S2"]);
  const hint = { text: "↑↓ files · PgUp/PgDn scroll", top: 1, rows: 2 };
  expect(invariants(frame([" Auto · Esc back", " ↑↓ files · PgUp/PgDn", " scroll"], { hint, status: 0 }, { width: 24 }))).toEqual(["S2"]);
});

test("S2 passes clean breaks and bare-key hints that do not wrap", () => {
  const heading = frame([" Undo turn 1 · Enter undo", " Esc cancel", "", status], { wrapped: [{ top: 0, rows: 2 }], status: 3 }, { width: 32 });
  expect(invariants(heading)).toEqual([]);
  expect(invariants(frame([status, " ↑↓ Enter Esc ^W ^L"], { hint: { text: "↑↓ Enter Esc ^W ^L", top: 1, rows: 1 }, status: 0 }))).toEqual([]);
  expect(invariants(frame([status, " Enter · Tab more options"], { hint: { text: "Enter · Tab more options", top: 1, rows: 1 }, status: 0 }))).toEqual([]);
});

const lines = [`${diffGutter(1, " ", false)}export function clamp(n: number, lo: number, hi: number) {`, `${diffGutter(2, "-", false)}  return Math.max(lo, n);`];
const reviewDiff = (top: number, bottom: number): SweepFrameState["diff"] => ({ top, bottom, x: 1, undo: false, lines });

test("S3 fails a diff continuation that starts under the line numbers", () => {
  const left = frame([" Unstaged · index → worktree", "   1   export function clamp(n: numbe", " r, lo: number, hi: number) {", "   2 -   return Math.max(lo, n);", status],
    { diff: reviewDiff(0, 3), status: 4 });
  expect(sweepFrameFailures(left).map(failure => [failure.invariant, failure.row, failure.message])).toEqual([["S3", 2, "a diff continuation starts under the line numbers"]]);
});

test("S3 passes the same continuation under a 6-cell hanging gutter, in color or not", () => {
  const rows = [" Unstaged · index → worktree", ...wrapDiffLine(diffGutter(1, " ", false), "export function clamp(n: number, lo: number, hi: number) {", 36).map(row => ` ${row}`), "   2 -   return Math.max(lo, n);", status];
  expect(rows[2]).toBe("       r, lo: number, hi: number) {");
  for (const variant of ["sweep-40", "nocolor-dark-40"]) expect(invariants(frame(rows, { diff: reviewDiff(0, 3), status: 4 }, { variant }))).toEqual([]);
});

test("S3 measures Thai and emoji diff rows by cells and keeps their continuations under the gutter", () => {
  const text = "const note = \"บันทึกภาษาไทย 🧪 ทดสอบการตัดบรรทัด\";";
  const gutter = diffGutter(12, "+", true);
  const wrapped = wrapDiffLine(gutter, text, 24);
  expect(wrapped.every(row => Bun.stringWidth(row) <= 24)).toBe(true);
  expect(wrapped.slice(1).every(row => row.startsWith(" ".repeat(6)) && row[6] !== " ")).toBe(true);
  // Graphemes stay whole: rejoining the pieces gives back the line.
  expect(wrapped.map((row, index) => row.slice(index ? 6 : gutter.length)).join("")).toBe(text);
  const diff = { top: 0, bottom: wrapped.length - 1, x: 1, undo: true, lines: [`${gutter}${text}`] };
  expect(invariants(frame([...wrapped.map(row => ` ${row}`), " ◆ Auto"], { diff, status: wrapped.length }, { width: 26 }))).toEqual([]);
  // The same Thai line wrapped at the left edge fails.
  const flat = `${gutter}${text}`, cut = 24;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(flat)].map(part => part.segment);
  let first = "";
  for (const grapheme of graphemes) { if (Bun.stringWidth(first + grapheme) > cut) break; first += grapheme; }
  expect(invariants(frame([` ${first}`, ` ${flat.slice(first.length)}`, " ◆ Auto"], { diff, status: 2 }, { width: 26 }))).toContain("S3");
});

test("S2 checks undo notes and read-only explanations in the diff area, not numbered rows", () => {
  const undoLines = [`${diffGutter(2, "-", true)}  return Math.min(hi, Math.max(lo, n));`];
  const diff = { top: 0, bottom: 4, x: 1, undo: true, lines: undoLines };
  const broken = frame([" Seen during turn 1 · no saved undo", " Undo leaves this file as it is · Alt+R", " review", "", "", status], { diff, status: 5 }, { width: 41 });
  expect(sweepFrameFailures(broken).map(failure => [failure.invariant, failure.row])).toEqual([["S2", 1]]);
  const clean = frame([" Seen during turn 1 · no saved undo", " Undo leaves this file as it is", " Alt+R review", "", "", status], { diff, status: 5 }, { width: 41 });
  expect(invariants(clean)).toEqual([]);
});

test("S4 fails a narrower width that loses the Esc exit; the hint row or the status bar may show it", () => {
  const hint = (top: number) => ({ text: "↑↓ select · Alt+R review · Esc cancel", top, rows: 1 });
  const wide = frame([status, " ↑↓ select · Alt+R review · Esc cancel"], { hint: hint(1), status: 0 }, { width: 41 });
  const statusBar = frame([" Auto · Esc cancel", " Alt+R review"], { hint: hint(1), status: 0 }, { width: 24 });
  const lost = frame([" Auto", " Alt+R review"], { hint: hint(1), status: 0 }, { width: 29 });
  expect(escExitFailures([wide, statusBar])).toEqual([]);
  const failures = escExitFailures([wide, lost, statusBar]);
  expect(failures.map(failure => [failure.invariant, failure.width])).toEqual([["S4", 29]]);
  expect(formatSweepFailure(failures[0]!)).toBe('synthetic 29 columns S4: no Esc exit in the hint row or status bar, though 41 columns show one (row 0: " Auto")');
  // A screen that never shows Esc has nothing to keep.
  expect(escExitFailures([lost])).toEqual([]);
});

test("S5 fails a status bar without the mode and passes the full and compact forms", () => {
  expect(invariants(frame([" Enter allow once · Esc deny"], { status: 0 }, { width: 29 }))).toEqual(["S5"]);
  for (const row of [status, " Auto · Esc cancel", " Ask · Enter allow once", " ◆ Read-only  ● Ready", " Read-only"]) expect(invariants(frame([row], { status: 0 }))).toEqual([]);
  // NO_COLOR frames read the same text.
  expect(invariants(frame([" Ask · Esc back"], { status: 0 }, { variant: "nocolor-dark-24", width: 24 }))).toEqual([]);
});

test("sweep exemptions cover only their screen, width and invariant", () => {
  const failures = sweepFrameFailures(frame([" Enter allow once · Esc deny"], { status: 0 }, { width: 29, screen: "approval-command" }));
  const exact: SweepExemption = { screen: "approval-command", width: 29, invariant: "S5", reason: "test" };
  const other: SweepExemption = { screen: "approval-command", width: 30, invariant: "S5", reason: "test" };
  expect(applySweepExemptions(failures, [other]).remaining).toHaveLength(1);
  const result = applySweepExemptions(failures, [exact, other]);
  expect(result.remaining).toEqual([]);
  expect([...result.used]).toEqual([exact]);
});

test("sweep widths cover 24 and each breakpoint with its neighbours, and 24–64 for panels", () => {
  const widths = sweepWidths("completed-turn");
  for (const breakpoint of Object.values(LAYOUT_BREAKPOINTS)) expect(widths).toEqual(expect.arrayContaining([breakpoint - 1, breakpoint, breakpoint + 1]));
  expect(widths).toContain(24);
  expect(widths).not.toContain(36);
  expect(sweepWidths("undo-preview")).toEqual(expect.arrayContaining(Array.from({ length: 41 }, (_, index) => 24 + index)));
  expect(SWEEP_SMOKE).toEqual([{ screen: "undo-preview", widths: [39, 40, 41] }, { screen: "review-panel", widths: [39, 40, 41] }]);
});
