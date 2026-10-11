import type { ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { LAYOUT_BREAKPOINTS } from "../../src/tui/layout.ts";
import { diffGutter } from "../../src/tui/diff-wrap.ts";
import { displayText } from "../../src/tui/presentation.ts";
import { undoRows } from "../../src/tui/undo-view.ts";
import { buildScreen } from "../screen-catalog/harness.ts";
import { parseScreen, serializeScreen } from "../screen-catalog/format.ts";
import type { Screen, Variant } from "../screen-catalog/screens.ts";
import type { SweepExemption, SweepFrame, SweepFrameState, SweepInvariantId } from "./screen-invariants.ts";

/** Screens that fit or wrap their own hints and headings (undo, review, history); the sweep also renders them at every width from 24 to 64. */
export const PANEL_SWEEP_SCREEN = /^(?:undo-|review-|resumed-review|history-)/;

/**
 * Narrowest sweep width at which a screen's `ready` predicate can hold, for screens whose predicate reads copy that a
 * narrower frame clips. The sweep skips narrower widths of these screens. The named width is the narrowest at which
 * `ready` holds; the full sweep fails an entry whose screen renders there and also one column narrower, as it does a stale exemption.
 */
export const SWEEP_MIN_WIDTHS: readonly { screen: string; width: number; reason: string }[] = [
  { screen: "command-palette-exact", width: 31, reason: "ready reads `Enter send`, which the 30-column hint row drops for `Esc keep editing`" },
  { screen: "help-palette-actions", width: 31, reason: "ready reads `Enter show keys`, which the narrower hint row drops" },
  { screen: "help-palette-disabled", width: 35, reason: "ready reads the whole `! No details to show · Esc back` reason row" },
  { screen: "help-palette-guidance", width: 40, reason: "ready reads the guidance sentence `Return to the conversation and press`, which wraps below 40 columns" },
  { screen: "help-palette-no-matches", width: 28, reason: "ready reads `No matches · Esc restore`, which narrower frames clip" },
  { screen: "inspection-tool", width: 25, reason: "ready reads `Second result line`, which 24 columns clip" },
  { screen: "reader-code", width: 32, reason: "ready reads the `Col ` position, which the reader drops below 32 columns" },
  { screen: "reader-no-matches", width: 26, reason: "ready reads the reader's `No matches` status, which narrower frames drop" },
];

/** Sweep widths for one screen, widest first: 24, each `LAYOUT_BREAKPOINTS` value and the column either side, and 24–64 for panel screens. */
export function sweepWidths(screenId: string): number[] {
  const widths = new Set([24, ...Object.values(LAYOUT_BREAKPOINTS).flatMap(width => [width - 1, width, width + 1])]);
  if (PANEL_SWEEP_SCREEN.test(screenId)) for (let width = 24; width <= 64; width++) widths.add(width);
  const min = SWEEP_MIN_WIDTHS.find(entry => entry.screen === screenId)?.width ?? 0;
  return [...widths].filter(width => width >= min).sort((a, b) => b - a);
}

/** The default `bun test` smoke subset that keeps the sweep code working: two panels either side of 40 columns. */
export const SWEEP_SMOKE: readonly { screen: string; widths: readonly number[] }[] = [
  { screen: "undo-preview", widths: [39, 40, 41] },
  { screen: "review-panel", widths: [39, 40, 41] },
];

/**
 * Reasoned exceptions to S1–S5. Add `{ screen, width?, invariant, reason }` only for a frame that is correct as shown or
 * whose fix needs its own layout decision; omit `width` to cover every width. An entry that covers no failure in the
 * full sweep fails it, and no entry may cover a frame in `SWEEP_EVIDENCE_FRAMES`.
 */
export const SWEEP_EXEMPTIONS: readonly SweepExemption[] = [
  // While a request waits, the compact status bar keeps the request's whole action over the mode label: Enter's verb and
  // Esc deny in the approval panel, whose heading names `ask mode`, or the only way back to the request from the reader.
  ...["approval-command", "approval-edit", "approval-diff-overflow"].map(screen => ({ screen, width: 29, invariant: "S5" as const,
    reason: "a waiting approval's compact status bar shows `Enter allow once · Esc deny` instead of the mode; the panel heading names ask mode" })),
  { screen: "reader-approval", width: 24, invariant: "S5", reason: "a request waiting behind the reader keeps `Esc back to request` over the mode in the 24-column compact status bar" },
  // The session picker shortens its status at a word or grapheme with … by design (#333); its key-led actions stay whole.
  ...([["session-picker-empty", [24, 29, 30, 31, 33, 34, 35]], ["session-picker-no-matches", [24, 29, 30, 31]], ["session-picker-resume-failed", [24, 29, 30, 31, 33]]] as const)
    .flatMap(([screen, widths]) => widths.map(width => ({ screen, width, invariant: "S1" as const,
      reason: "fitSessionPickerHint shortens the picker status with … to keep its key actions; the status is not a key-led segment" }))),
];

/** The panel frames from the #307 audit evidence (defects 1–4), which must hold their invariant with no exemption. */
export const SWEEP_EVIDENCE_FRAMES: readonly { screen: string; width: number; invariant: SweepInvariantId }[] = [
  ...[24, 40, 50, 59].flatMap(width => ["review-panel", "resumed-review", "review-multi-turn", "review-staged-unstaged"].map(screen => ({ screen, width, invariant: "S3" as const }))),
  ...[24, 40, 46].map(width => ({ screen: "undo-preview", width, invariant: "S3" as const })),
  ...["undo-preview", "undo-older-target", "undo-shell-only"].map(screen => ({ screen, width: 24, invariant: "S1" as const })),
  ...[24, 29, 32, 33].map(width => ({ screen: "undo-preview", width, invariant: "S2" as const })),
  ...[39, 40, 41, 42, 43, 44].map(width => ({ screen: "undo-older-target", width, invariant: "S2" as const })),
  ...[24, 30, 41, 42, 43, 44, 45, 46, 50].map(width => ({ screen: "undo-shell-only", width, invariant: "S2" as const })),
  ...[24, 29, 30, 31].flatMap(width => ["review-panel", "history-detail"].map(screen => ({ screen, width, invariant: "S2" as const }))),
];

/** The sweep variant of one screen: the dark theme at `cols` columns and the screen's own row count. */
export function sweepVariant(screen: Screen, cols: number): Variant {
  return { id: `sweep-${cols}`, theme: "dark", cols, rows: screen.rows ?? 30, noColor: screen.id === "no-color" };
}

/** Render one screen in memory at `cols` columns, without writing a golden, and capture the layout facts S1–S5 read. */
export async function sweepFrame(screen: Screen, cols: number): Promise<SweepFrame> {
  const variant = sweepVariant(screen, cols);
  const ui = await buildScreen(screen, variant);
  try {
    await screen.drive(ui); await ui.waitFor(snapshot => screen.ready(snapshot, ui)); ui.advance(); await ui.settle();
    const snapshot = ui.controller.snapshot();
    if (!screen.ready(snapshot, ui)) throw new Error(`Screen ${screen.id} left its ready state before capture\n${ui.captureCharFrame()}`);
    const golden = parseScreen(serializeScreen(ui.captureSpans(), { screen: screen.id, title: screen.title, description: screen.description, variant: variant.id, cursor: ui.renderer.getCursorState() }));
    const find = (id: string) => ui.renderer.root.findDescendantById(id);
    const hints = find("hints") as TextRenderable, footer = find("footer") as TextRenderable;
    const state: SweepFrameState = { wrapped: [] };
    if (hints.visible) state.hint = { text: ui.view.hintText(), top: hints.screenY, rows: Math.max(1, hints.height) };
    if (footer.visible) state.status = footer.screenY;
    const mode = ui.view.panelMode();
    const heading = mode === "history" ? find("history-heading") : mode === "review" || mode === "undo" ? find("change-review-heading") : undefined;
    if (heading?.visible) state.wrapped.push({ top: heading.screenY, rows: Math.max(1, heading.height) });
    const review = snapshot.undoPreview ? { undo: true, rows: undoRows(snapshot.undoPreview) } : snapshot.changeReview && !snapshot.changeReview.showingDetails ? { undo: false, rows: snapshot.changeReview.rows } : undefined;
    if ((mode === "review" || mode === "undo") && review) {
      const scroll = find("change-review-diff") as ScrollBoxRenderable, text = find("change-review-text") as TextRenderable;
      state.diff = { top: scroll.screenY, bottom: scroll.screenY + scroll.viewport.height - 1, x: text.screenX, undo: review.undo,
        lines: review.rows.flatMap(row => row.line === undefined ? [] : [`${diffGutter(row.line, row.sign, review.undo)}${displayText(row.text)}`]) };
    }
    return { golden, width: cols, state };
  } finally { await ui.dispose(); }
}
