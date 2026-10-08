import type { ScreenGolden } from "../screen-catalog/format.ts";

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
  /**
   * The focused typing surface, if any. `row` and `col` are the zero-based screen cell where the value (or placeholder) starts,
   * `columns` the field width, `value` the displayed value (masked where the view masks it), `cursor` the logical cursor as a
   * UTF-16 offset into `value`, `placeholder` the text shown while `value` is empty, and `scroll` the field's visual rows
   * scrolled above `row` (0 when its first row shows).
   */
  input?: { surface: string; row: number; col: number; columns: number; value: string; cursor: number; placeholder: string; scroll?: number };
}

/** One violated invariant, naming the screen, variant and, when one is at fault, the offending zero-based text row. */
export interface InvariantFailure { screen: string; variant: string; invariant: InvariantId; message: string; row?: number; text?: string }

/** A reasoned exception for one screen (and optionally one variant) and invariant; an entry that matches no failure is stale. */
export interface InvariantExemption { screen: string; variant?: string; invariant: InvariantId; reason: string }

const graphemes = (text: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(part => part.segment);

/** Zero-based cell of a UTF-16 `offset` within `value`, wrapping grapheme by grapheme at `columns` cells and at line breaks. */
export function cursorCell(value: string, offset: number, columns: number): { x: number; y: number } {
  let x = 0, y = 0;
  for (const segment of graphemes(value.slice(0, offset))) {
    if (segment === "\n") { x = 0; y++; continue; }
    const width = Bun.stringWidth(segment);
    if (x > 0 && x + width > columns) { x = 0; y++; }
    x += width;
  }
  return { x, y };
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
    const { surface, row, col, columns, value, cursor, placeholder, scroll = 0 } = state.input;
    // The input row starts with the value's first visible cells, or the placeholder's first word, which a narrow field may clip.
    const shown = sliceCells(golden.text[row] ?? "", col).trimEnd();
    const lead = value ? graphemes(value.split("\n")[0]!).reduce((text, part) => Bun.stringWidth(text + part) <= columns ? text + part : text, "").trimEnd()
      : placeholder.split(" ")[0]!.replace(/…$/, "");
    const length = Math.min(lead.length, shown.length);
    if (scroll === 0 && lead && (!length || shown.slice(0, length) !== lead.slice(0, length))) fail("I4", `${surface} input row does not start with "${lead}" at cell ${col}`, row);
    const cell = cursorCell(value, cursor, columns), x = col + cell.x + 1, y = row + cell.y - scroll + 1;
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
