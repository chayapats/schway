import type { ScreenGolden } from "../screen-catalog/format.ts";
import { hintRowSegments } from "./hint-grammar.ts";

/**
 * Cross-screen invariants every catalog frame must hold (#304). The checker is pure: it reads a parsed golden and a
 * frame-state record captured with it, and classifies the frame from that record rather than from its screen ID.
 */

/** Identifier of one screen invariant: I1 approval choices, I2 recovery cause first, I3 no stop when idle, I4 visible input cursor. */
export type InvariantId = "I1" | "I2" | "I3" | "I4";

/** Controller and view facts captured at the same moment as a frame; they decide which invariants apply to it. */
export interface FrameState {
  /** Panel mode the view shows in place of the conversation body, or "" when none is open. */
  panel: string;
  /** The pending tool approval: the selected choice's label and whether a deny reason is being typed. */
  approval?: { selected: string; enteringReason: boolean };
  /** True when no work runs: status is not running, no activity, readiness is not loading and no sign-in is pending. */
  idle: boolean;
  /** Present while F2 details for a failed turn are open: their outcome heading and the failure cause line ("" when none shows). */
  failedDetails?: { heading: string; cause: string };
  /** The F2 entry that is open. A notice stays a notice when the latest outcome failed. */
  openDetails?: { entryId: string; kind: "notice" | "recovery" };
  /**
   * The focused typing surface, if any. `row` and `col` are the zero-based screen cell where the value (or placeholder) starts,
   * `columns` the field width, `value` the displayed value (masked where the view masks it), `cursor` the logical cursor as a
   * UTF-16 offset into `value`, `placeholder` the text shown while `value` is empty, `scroll` the field's visual rows
   * scrolled above `row` (0 when its first row shows), and `wrap` how the field breaks lines (`word` for the composer).
   */
  input?: { surface: string; row: number; col: number; columns: number; value: string; cursor: number; placeholder: string; scroll?: number; wrap?: "char" | "word" };
}

/** One violated invariant, naming the screen, variant and, when one is at fault, the offending zero-based text row. */
export interface InvariantFailure { screen: string; variant: string; invariant: InvariantId; message: string; row?: number; text?: string }

/** A reasoned exception for one screen (and optionally one variant) and invariant; an entry that matches no failure is stale. */
export interface InvariantExemption { screen: string; variant?: string; invariant: InvariantId; reason: string }

const graphemes = (text: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(part => part.segment);

/** Classify the open F2 entry from the kind the view recorded. A notice is not failed-turn details, so I2 does not ask it for a failure cause. */
export function frameDetailsState(entry: { id: string; text: string; kind: "notice" | "recovery" } | undefined, outcomeFailed: boolean): Pick<FrameState, "openDetails" | "failedDetails"> {
  if (!entry) return {};
  const lines = entry.text.split("\n");
  return {
    openDetails: { entryId: entry.id, kind: entry.kind },
    ...(entry.kind === "recovery" && outcomeFailed ? { failedDetails: { heading: lines[0] ?? "", cause: lines.find(line => line.startsWith("Failure details:")) ?? "" } } : {}),
  };
}

/** Cell where grapheme `index` is placed, before its width is added. Word wrap breaks before a word that does not fit. */
function placedCell(x: number, y: number, index: number, segments: readonly string[], columns: number, wrap: "char" | "word"): { x: number; y: number; width: number } {
  const segment = segments[index]!;
  if (segment === "\n") return { x: 0, y: y + 1, width: 0 };
  const width = Bun.stringWidth(segment);
  let nextX = x, nextY = y;
  if (wrap === "word" && segment !== " " && nextX > 0) {
    let wordWidth = 0;
    for (let cursor = index; cursor < segments.length && segments[cursor] !== " " && segments[cursor] !== "\n"; cursor++) wordWidth += Bun.stringWidth(segments[cursor]!);
    if (nextX + wordWidth > columns) { nextX = 0; nextY++; }
  } else if (nextX > 0 && nextX + width > columns) {
    nextX = 0; nextY++;
  }
  return { x: nextX, y: nextY, width };
}

/** Zero-based cell of a UTF-16 `offset` within `value`. `char` wraps grapheme by grapheme; `word` breaks before a word that does not fit. */
export function cursorCell(value: string, offset: number, columns: number, wrap: "char" | "word" = "char"): { x: number; y: number } {
  const segments = graphemes(value);
  let x = 0, y = 0, consumed = 0;
  for (let index = 0; index < segments.length && consumed < offset; index++) {
    const placed = placedCell(x, y, index, segments, columns, wrap);
    x = placed.x + placed.width;
    y = placed.y;
    consumed += segments[index]!.length;
  }
  return { x, y };
}

/** Text of the first visual line of `value`, using the same wrap as `cursorCell`. */
function firstWrappedLine(value: string, columns: number, wrap: "char" | "word"): string {
  const segments = graphemes(value);
  let x = 0, text = "";
  for (let index = 0; index < segments.length && segments[index] !== "\n"; index++) {
    const placed = placedCell(x, 0, index, segments, columns, wrap);
    if (placed.y > 0) break;
    text += segments[index];
    x = placed.x + placed.width;
  }
  return text;
}

/** The part of a text row that starts at terminal cell `start`, measuring cells with `Bun.stringWidth`. */
export function sliceCells(row: string, start: number): string {
  let cells = 0, index = 0;
  for (const segment of graphemes(row)) {
    if (cells >= start) break;
    cells += Bun.stringWidth(segment); index += segment.length;
  }
  return row.slice(index);
}

const STOP = /\bEsc stops?\b/;
const compact = (text: string) => text.replace(/\s+/g, "");

/** Check I1–I4 against one frame and its captured state; returns every failure, or an empty list when the frame holds them all. */
export function screenInvariantFailures(golden: ScreenGolden, state: FrameState): InvariantFailure[] {
  const failures: InvariantFailure[] = [];
  const fail = (invariant: InvariantId, message: string, row?: number) =>
    failures.push({ screen: golden.screen, variant: golden.variant, invariant, message, ...(row === undefined ? {} : { row, text: golden.text[row] ?? "" }) });

  // I1: an approval frame shows its selected choice outside the composer, and Esc deny, so Enter never acts on a hidden choice.
  if (state.panel === "tool-approval" && state.approval && !state.approval.enteringReason) {
    const label = state.approval.selected;
    const shown = golden.text.some(line => {
      const trimmed = line.trimStart();
      if (!trimmed.startsWith("› ")) return false;
      const rest = trimmed.slice(2).trimEnd();
      return rest.startsWith(label) || (rest.length > 1 && rest.endsWith("…") && label.startsWith(rest.slice(0, -1)));
    });
    if (!shown) fail("I1", `no row shows the selected choice as "› ${label}"`);
    if (!golden.text.some(line => line.includes("Esc deny"))) fail("I1", "no row names Esc deny");
  }

  // I2: F2 details for a failed turn lead with the cause; 20+ rows show all of it, shorter frames at least its start.
  if (state.failedDetails) {
    const { heading, cause } = state.failedDetails;
    const headingRow = golden.text.findIndex(line => line.trim() === heading);
    if (!cause) fail("I2", "failed-turn details show no failure cause");
    else if (headingRow < 0) fail("I2", `outcome heading "${heading}" is not visible`);
    else {
      const first = golden.text.findIndex((line, index) => index > headingRow && line.trim() !== "");
      const wanted = compact(cause);
      if (first < 0 || !compact(golden.text[first]!) || !wanted.startsWith(compact(golden.text[first]!))) {
        fail("I2", "the first content row after the outcome heading does not start the failure cause", first < 0 ? headingRow : first);
      } else if (golden.rows >= 20) {
        let seen = "";
        for (let index = first; index < golden.text.length && seen.length < wanted.length; index++) {
          const next = seen + compact(golden.text[index]!);
          if (!wanted.startsWith(next.slice(0, wanted.length))) break;
          seen = next;
        }
        if (!seen.startsWith(wanted)) fail("I2", `the whole failure cause is not visible without scrolling: "${cause}"`, first);
      }
    }
  }

  // I3: nothing offers to stop work while nothing runs, in transcript, activity, status or hint rows alike.
  if (state.idle) golden.text.forEach((line, row) => { if (STOP.test(line)) fail("I3", "an idle frame offers Esc stop", row); });

  // I4: a focused text field shows the terminal cursor on its input row, at its logical cursor cell.
  if (state.input) {
    const { surface, row, col, columns, value, cursor, placeholder, scroll = 0, wrap = "char" } = state.input;
    // The input row starts with the value's first visible cells, or the placeholder's first word, which a narrow field may clip.
    const shown = sliceCells(golden.text[row] ?? "", col).trimEnd();
    const lead = value ? firstWrappedLine(value.split("\n")[0]!, columns, wrap).trimEnd()
      : placeholder.split(" ")[0]!.replace(/…$/, "");
    const length = Math.min(lead.length, shown.length);
    if (scroll === 0 && lead && (!length || shown.slice(0, length) !== lead.slice(0, length))) fail("I4", `${surface} input row does not start with "${lead}" at cell ${col}`, row);
    const cell = cursorCell(value, cursor, columns, wrap), x = col + cell.x + 1, y = row + cell.y - scroll + 1;
    if (!golden.cursor.visible) fail("I4", `${surface} has focus but the cursor is hidden`, row);
    else if (golden.cursor.x !== x || golden.cursor.y !== y) {
      fail("I4", `${surface} cursor is at ${golden.cursor.x} ${golden.cursor.y}, expected ${x} ${y}`, Math.max(0, golden.cursor.y - 1));
    }
  }
  return failures;
}

/** Split failures into those an exemption covers and those that remain, and report exemptions that covered nothing. */
export function applyExemptions(failures: readonly InvariantFailure[], exemptions: readonly InvariantExemption[]): { remaining: InvariantFailure[]; used: Set<InvariantExemption> } {
  const used = new Set<InvariantExemption>();
  const remaining = failures.filter(failure => {
    const exemption = exemptions.find(entry => entry.screen === failure.screen && entry.invariant === failure.invariant && (entry.variant === undefined || entry.variant === failure.variant));
    if (exemption) used.add(exemption);
    return !exemption;
  });
  return { remaining, used };
}

/** One readable line per failure: screen, variant, invariant, message and the offending row. */
export function formatInvariantFailure(failure: InvariantFailure): string {
  return `${failure.screen} ${failure.variant} ${failure.invariant}: ${failure.message}${failure.row === undefined ? "" : ` (row ${failure.row}: ${JSON.stringify(failure.text)})`}`;
}

/**
 * Reasoned exceptions to the catalog invariants. Add `{ screen, variant?, invariant, reason }` only for a frame that is
 * correct as shown; an entry that no failure uses fails the catalog test, and none may cover `INVARIANT_EVIDENCE_FRAMES`.
 */
export const SCREEN_INVARIANT_EXEMPTIONS: readonly InvariantExemption[] = [];

/** Frames from the #304 audit evidence that must hold their invariant with no exemption. */
export const INVARIANT_EVIDENCE_FRAMES: readonly { screen: string; variant?: string; invariant: InvariantId }[] = [
  ...["dark-40x8", "dark-50x8", "light-40x8", "light-50x8", "nocolor-dark-40x8", "nocolor-dark-50x8"].map(variant => ({ screen: "approval-command", variant, invariant: "I1" as const })),
  ...["dark-40", "light-40", "nocolor-dark-40", "dark-24", "light-24", "nocolor-dark-24"].map(variant => ({ screen: "details-recovery", variant, invariant: "I2" as const })),
  ...["compaction", "compaction-completed", "compaction-cancelled", "compaction-failed", "compaction-noop"].map(screen => ({ screen, invariant: "I3" as const })),
  ...["endpoint-url-empty", "endpoint-url-error", "api-key-entry", "callback-entry"].map(screen => ({ screen, invariant: "I4" as const })),
];

/*
 * Breakpoint-sweep invariants (#307). The sweep renders screens one column either side of every layout breakpoint
 * without writing goldens and checks S1–S5 on each frame, from layout facts captured with it.
 */

/** Identifier of one sweep invariant: S1 whole hint segments, S2 clean breaks, S3 diff gutter kept, S4 Esc exit kept, S5 mode shown. */
export type SweepInvariantId = "S1" | "S2" | "S3" | "S4" | "S5";

/** Layout facts captured with one sweep frame. Rows are zero-based text rows; `x` is a zero-based cell. */
export interface SweepFrameState {
  /** The whole hint text the view set and the rows its visible hint row occupies (two or more when review or history wraps it). */
  hint?: { text: string; top: number; rows: number };
  /** Row of the status bar, when it shows. */
  status?: number;
  /** Row ranges the view wraps itself, such as the undo, review and history headings; S2 checks each as one block. */
  wrapped: { top: number; rows: number }[];
  /**
   * The undo or review diff text area: its first and last visible row, the cell where its text starts, whether it is
   * the undo panel (whose notes and explanations S2 also checks) and every numbered diff line as gutter plus text.
   */
  diff?: { top: number; bottom: number; x: number; undo: boolean; lines: string[] };
}

/** One frame of a sweep: its parsed text, terminal width and captured state. */
export interface SweepFrame { golden: ScreenGolden; width: number; state: SweepFrameState }

/** One violated sweep invariant, naming the screen, width and, when one is at fault, the offending zero-based row. */
export interface SweepFailure { screen: string; width: number; invariant: SweepInvariantId; message: string; row?: number; text?: string }

/** A reasoned exception for one screen (and optionally one width) and sweep invariant; an entry that matches no failure is stale. */
export interface SweepExemption { screen: string; width?: number; invariant: SweepInvariantId; reason: string }

/** Key names that must never end a wrapped row while their action starts the next one. */
const WRAP_KEY = /^(?:Enter|Esc|Tab|Shift\+Tab|F2|PgUp\/PgDn|↑↓|←→|(?:Alt|Ctrl)\+\S+)$/;
/** Gutter of a numbered undo (`  2 │-`) or review (`  2 - `) diff row. */
const DIFF_GUTTER = /^ *\d+ (?:│[-+ ]|[-+ ] )/;
const ESC_EXIT = /(?:^|\s)Esc(?:\s|$)/;
const MODE = /^(?:◆ )?(?:Auto|Ask|Read-only)(?:\s|$)/;

/** Rows of a numbered diff line's continuations that start under the line numbers, and every continuation row seen. */
function diffContinuations(golden: ScreenGolden, diff: NonNullable<SweepFrameState["diff"]>) {
  const misplaced: number[] = [], continuations = new Set<number>(), numbered = new Set<number>();
  for (let row = diff.top; row <= diff.bottom; row++) {
    const shown = sliceCells(golden.text[row] ?? "", diff.x).trimEnd();
    const gutter = DIFF_GUTTER.exec(shown)?.[0];
    if (!gutter || continuations.has(row)) continue;
    numbered.add(row);
    const start = compact(shown);
    const lines = diff.lines.filter(line => DIFF_GUTTER.exec(line)?.[0] === gutter && compact(line).startsWith(start));
    // A row that shows a whole line, or one the checker cannot attribute, has no continuation to check.
    if (!lines.length || lines.some(line => compact(line) === start)) continue;
    const wanted = compact(lines[0]!), indent = Bun.stringWidth(gutter);
    let seen = start;
    for (let next = row + 1; next <= diff.bottom && seen.length < wanted.length; next++) {
      const text = sliceCells(golden.text[next] ?? "", diff.x);
      if (!text.trim()) break;
      continuations.add(next);
      if (text.slice(0, indent).trim()) misplaced.push(next);
      seen += compact(text);
    }
  }
  return { misplaced, continuations, numbered };
}

/** Text after the leading body padding and gutter glyphs of a row. */
const content = (row: string) => row.replace(/^[\s│┃▌▐]+/, "");

/** Check S2 on each adjacent pair of rows in one wrapped block from `top` through `bottom`. */
function cleanBreakFailures(golden: ScreenGolden, top: number, bottom: number, fail: (invariant: SweepInvariantId, message: string, row?: number) => void) {
  for (let row = top; row < bottom; row++) {
    const line = (golden.text[row] ?? "").trimEnd(), next = content(golden.text[row + 1] ?? "");
    if (!line.trim() || !next) continue;
    const last = line.trim().split(/\s+/).at(-1)!;
    if (/(?:^|\s)·$/.test(line)) fail("S2", "a wrapped row ends with a dangling ` ·`", row);
    else if (next === "·" || next.startsWith("· ")) fail("S2", "a wrapped row starts with `· `", row + 1);
    else if (WRAP_KEY.test(last)) fail("S2", `a wrapped row ends with ${last} and its action starts the next row`, row);
  }
}

/** Check S1, S2, S3 and S5 against one sweep frame; S4 compares frames and lives in `escExitFailures`. */
export function sweepFrameFailures(frame: SweepFrame): SweepFailure[] {
  const { golden, width, state } = frame;
  const failures: SweepFailure[] = [];
  const fail = (invariant: SweepInvariantId, message: string, row?: number) =>
    failures.push({ screen: golden.screen, width, invariant, message, ...(row === undefined ? {} : { row, text: golden.text[row] ?? "" }) });

  // S1: the hint row shows only whole ` · ` segments of the text the view set; a wrapped review or history hint counts as one row.
  if (state.hint && state.hint.text) {
    const whole = new Set(hintRowSegments(state.hint.text));
    const parts = Array.from({ length: state.hint.rows }, (_, index) => state.hint!.top + index)
      .flatMap(row => hintRowSegments(golden.text[row] ?? "").map(text => ({ row, text })));
    for (let index = 0; index < parts.length; index++) {
      const { row } = parts[index]!;
      let text = parts[index]!.text;
      // A segment wider than its row may wrap inside itself; rejoin it before checking.
      while (!whole.has(text) && index + 1 < parts.length && [...whole].some(segment => segment.startsWith(`${text} `))) text = `${text} ${parts[++index]!.text}`;
      if (!whole.has(text)) fail("S1", `hint segment "${text}" is not a whole segment of "${state.hint.text}"`, row);
    }
  }

  // S3: a numbered diff line's continuation starts at its text column under a blank gutter.
  const diff = state.diff && diffContinuations(golden, state.diff);
  for (const row of diff?.misplaced ?? []) fail("S3", "a diff continuation starts under the line numbers", row);

  // S2: hint rows, panel headings and undo notes and explanations break between whole key-and-action segments.
  const blocks = [...(state.hint ? [{ top: state.hint.top, rows: state.hint.rows }] : []), ...state.wrapped];
  for (const block of blocks) cleanBreakFailures(golden, block.top, block.top + block.rows - 1, fail);
  if (state.diff?.undo && diff) {
    let start = -1;
    for (let row = state.diff.top; row <= state.diff.bottom + 1; row++) {
      const explanation = row <= state.diff.bottom && !diff.numbered.has(row) && !diff.continuations.has(row) && !!sliceCells(golden.text[row] ?? "", state.diff.x).trim();
      if (explanation && start < 0) start = row;
      if (!explanation && start >= 0) { cleanBreakFailures(golden, start, row - 1, fail); start = -1; }
    }
  }

  // S5: the status bar names the effective mode, in full or compact form.
  if (state.status !== undefined && !MODE.test((golden.text[state.status] ?? "").trim())) fail("S5", "the status bar does not show the mode", state.status);
  return failures;
}

/** True when the frame's hint row or status bar offers an Esc action. */
export function escExitShown(frame: SweepFrame): boolean {
  const rows = [...(frame.state.hint ? Array.from({ length: frame.state.hint.rows }, (_, index) => frame.state.hint!.top + index) : []), ...(frame.state.status === undefined ? [] : [frame.state.status])];
  return rows.some(row => ESC_EXIT.test(frame.golden.text[row] ?? ""));
}

/** S4: once a width of a screen shows an Esc exit in its hint row or status bar, every narrower frame of that screen shows one too. */
export function escExitFailures(frames: readonly SweepFrame[]): SweepFailure[] {
  const widest = [...frames].sort((a, b) => b.width - a.width).find(escExitShown);
  if (!widest) return [];
  return frames.filter(frame => frame.width < widest.width && !escExitShown(frame)).map(frame => ({
    screen: frame.golden.screen, width: frame.width, invariant: "S4" as const,
    message: `no Esc exit in the hint row or status bar, though ${widest.width} columns show one`,
    ...(frame.state.status === undefined ? {} : { row: frame.state.status, text: frame.golden.text[frame.state.status] ?? "" }),
  }));
}

/** Split sweep failures into those an exemption covers and those that remain, and report the exemptions used. */
export function applySweepExemptions(failures: readonly SweepFailure[], exemptions: readonly SweepExemption[]): { remaining: SweepFailure[]; used: Set<SweepExemption> } {
  const used = new Set<SweepExemption>();
  const remaining = failures.filter(failure => {
    const exemption = exemptions.find(entry => entry.screen === failure.screen && entry.invariant === failure.invariant && (entry.width === undefined || entry.width === failure.width));
    if (exemption) used.add(exemption);
    return !exemption;
  });
  return { remaining, used };
}

/** One readable line per sweep failure: screen, width, invariant, message and the offending row. */
export function formatSweepFailure(failure: SweepFailure): string {
  return `${failure.screen} ${failure.width} columns ${failure.invariant}: ${failure.message}${failure.row === undefined ? "" : ` (row ${failure.row}: ${JSON.stringify(failure.text)})`}`;
}
