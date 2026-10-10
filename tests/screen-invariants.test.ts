import { expect, test } from "bun:test";
import type { ScreenGolden } from "./screen-catalog/format.ts";
import {
  applyExemptions, cursorCell, formatInvariantFailure, frameDetailsState, INVARIANT_EVIDENCE_FRAMES, SCREEN_INVARIANT_EXEMPTIONS, screenInvariantFailures, sliceCells,
  type FrameState, type InvariantExemption,
} from "./helpers/screen-invariants.ts";

/** A synthetic parsed frame: the given text rows, padded to `rows`, with the cursor where a golden header would record it. */
function frame(text: string[], options: { screen?: string; variant?: string; cols?: number; rows?: number; cursor?: [number, number] } = {}): ScreenGolden {
  const rows = options.rows ?? text.length;
  return { screen: options.screen ?? "synthetic", title: "Synthetic", description: "A synthetic frame.", variant: options.variant ?? "dark-40x8",
    cols: options.cols ?? 40, rows, text: [...text, ...Array<string>(Math.max(0, rows - text.length)).fill("")],
    styles: [], cursor: options.cursor ? { x: options.cursor[0], y: options.cursor[1], visible: true } : { x: 1, y: 1, visible: false } };
}
const idle: FrameState = { panel: "", idle: true };
const approving: FrameState = { panel: "tool-approval", idle: false, approval: { selected: "Allow once", enteringReason: false } };
const invariants = (golden: ScreenGolden, state: FrameState) => screenInvariantFailures(golden, state).map(failure => failure.invariant);

test("I1 fails an approval frame whose only › is the composer prompt", () => {
  // The audit's broken 40x8 frame: heading, command, an empty composer and the activity row, but no choice or Esc deny.
  const broken = frame(["  Allow bash? · ask mode", "", "  bun test --filter clamp", "", "  ▄▄▄▄▄▄▄▄▄▄", "  ▌ ›", "  ▀▀▀▀▀▀▀▀▀▀", " Ask · Ctrl+C cancel"], { variant: "nocolor-dark-40x8" });
  const failures = screenInvariantFailures(broken, approving);
  expect(failures.map(failure => failure.message)).toEqual(['no row shows the selected choice as "› Allow once"', "no row names Esc deny"]);
  expect(formatInvariantFailure(failures[0]!)).toStartWith("synthetic nocolor-dark-40x8 I1: ");
  // A choice row without Esc deny still fails.
  expect(invariants(frame(["  › Allow once", " Ask · Enter allow once"]), approving)).toEqual(["I1"]);
});

test("I1 passes an approval frame that marks its selected choice and names Esc deny, in color or not", () => {
  const shown = ["  Allow bash? · ask mode", "", "  bun test --filter clamp", "", "  › Allow once", "    Allow bash for this session", "    Deny with reason…", " Ask · Enter allow once · Esc deny"];
  for (const variant of ["dark-40x8", "nocolor-dark-40x8"]) expect(invariants(frame(shown, { variant }), approving)).toEqual([]);
  // A choice label the width clips with … still names the selected choice.
  expect(invariants(frame(["  › Allow bash for this se…", " Esc deny"]), { ...approving, approval: { selected: "Allow bash for this session", enteringReason: false } })).toEqual([]);
  // Reason entry and a deferred approval behind the reader are not approval-choice frames.
  expect(invariants(frame(["  ▌ › Why? The agent will see this…"]), { ...approving, approval: { selected: "Deny with reason…", enteringReason: true } })).toEqual([]);
  expect(invariants(frame([" ◌ Approval · Esc back to request"]), { panel: "", idle: false, approval: { selected: "Allow once", enteringReason: false } })).toEqual([]);
});

const cause = "Failure details: Provider request failed after 3 transient attempts: Service unavailable";
const details: FrameState = { ...idle, failedDetails: { heading: "✗ Failed", cause } };

test("I2 fails failed-turn details that put the cause below the counts or out of view", () => {
  // Cause last, as before U5: counts take the first content row.
  const late = frame([" ✗ Failed", " No tool results or commands.", "", " Current working-tree content is", " Failure details: Provider request", " failed after 3 transient attempts:", " Service unavailable"], { variant: "dark-40", rows: 20 });
  expect(screenInvariantFailures(late, details).map(failure => [failure.invariant, failure.row])).toEqual([["I2", 1]]);
  // At 20 rows the whole cause must show; here it is cut after its first rows.
  const cut = frame([" ✗ Failed", " Failure details: Provider request", " failed after 3 transient attempts:"], { variant: "dark-40", rows: 20 });
  expect(screenInvariantFailures(cut, details).map(failure => failure.message)).toEqual([`the whole failure cause is not visible without scrolling: "${cause}"`]);
  // No visible heading, or details without a cause, also fail.
  expect(invariants(frame([" Failure details: Provider request"], { rows: 8 }), details)).toEqual(["I2"]);
  expect(invariants(frame([" ✗ Failed", " No tool results or commands."], { rows: 8 }), { ...idle, failedDetails: { heading: "✗ Failed", cause: "" } })).toEqual(["I2"]);
});

test("I2 classifies notice details after a failed turn by the open entry, not the outcome", () => {
  const notice = { id: "sys-2", kind: "notice" as const, text: "Details · Esc keep editing\nThe choice could not be saved." };
  const state = { ...idle, ...frameDetailsState(notice, true) };
  expect(state.openDetails).toEqual({ entryId: "sys-2", kind: "notice" });
  expect(state.failedDetails).toBeUndefined();
  expect(invariants(frame([" Details · Esc keep editing", " The choice could not be saved."]), state)).toEqual([]);
  const recovery = { id: "sys-3", kind: "recovery" as const, text: "✗ Failed\nNo tool results or commands." };
  const failed = { ...idle, ...frameDetailsState(recovery, true) };
  expect(failed.openDetails).toEqual({ entryId: "sys-3", kind: "recovery" });
  expect(invariants(frame([" ✗ Failed", " No tool results or commands."], { rows: 8 }), failed)).toEqual(["I2"]);
});

test("I2 passes details that lead with the cause: whole at 20 rows, its start at 8", () => {
  const whole = frame([" ⚡ schway  ~/demo", "", " ✗ Failed", " Failure details: Provider request", " failed after 3 transient attempts:", " Service unavailable", " No tool results or commands.", "", " ✗ Failed · 0.0s · Alt+R review"], { variant: "nocolor-dark-40", rows: 20 });
  expect(invariants(whole, details)).toEqual([]);
  const start = frame([" ✗ Failed", " Failure details:", " Provider request", " failed after 3", " ▄▄▄▄", " ▌ › งานถัดไป 🧪", " ▀▀▀▀", " Auto · Esc back"], { cols: 24, variant: "dark-24" });
  expect(invariants(start, details)).toEqual([]);
});

test("I3 fails an idle frame that still offers Esc stop, in any row", () => {
  const stale = frame(["  Compacting older turns · Esc stop", "", "  Compaction cancelled · /compact retry", "  ▌ › Ask Schway…", " ◆ Auto  ● Ready"], { variant: "nocolor-dark-80" });
  expect(screenInvariantFailures(stale, idle).map(failure => [failure.invariant, failure.row, failure.text])).toEqual([["I3", 0, "  Compacting older turns · Esc stop"]]);
  expect(invariants(frame([" ◆ Auto  ● Ready · Esc stops"]), idle)).toEqual(["I3"]);
});

test("I3 passes Esc stop while work runs, and an idle frame without it", () => {
  expect(invariants(frame(["  ● Compacting context · Esc stop", " Esc stop"]), { panel: "", idle: false })).toEqual([]);
  expect(invariants(frame(["  Compaction cancelled · /compact retry", " Enter send · Ctrl+F find"]), idle)).toEqual([]);
});

const composer = (value: string, cursor = value.length): FrameState => ({ ...idle, input: { surface: "composer", row: 1, col: 5, columns: 30, value, cursor, placeholder: "Ask Schway…" } });

test("I4 places the cursor by cell width, so Thai combining marks and emoji map to their cells", () => {
  const value = "งานถัดไป 🧪";
  // Thai combining marks take no cell and the emoji takes two: ten cells, eleven UTF-16 units.
  expect([value.length, Bun.stringWidth(value)]).toEqual([11, 10]);
  const rows = [" ▄▄▄▄", ` ▌ › ${value}`, " ▀▀▀▀"];
  expect(invariants(frame(rows, { cursor: [5 + 10 + 1, 2] }), composer(value))).toEqual([]);
  // A cursor placed by string length, not cells, is one cell too far.
  expect(screenInvariantFailures(frame(rows, { cursor: [5 + 11 + 1, 2] }), composer(value)).map(failure => failure.message)).toEqual(["composer cursor is at 17 2, expected 16 2"]);
  // A cursor inside the value sits after the cells before it.
  expect(invariants(frame(rows, { cursor: [5 + Bun.stringWidth("งานถัดไป") + 1, 2] }), composer(value, "งานถัดไป".length))).toEqual([]);
});

test("I4 fails a focused field with a hidden cursor, and a placeholder cursor placed after the placeholder", () => {
  // Endpoint entry before #309: the value row shows the placeholder but the terminal cursor is hidden.
  const endpoint: FrameState = { panel: "endpoint", idle: true, input: { surface: "endpoint entry", row: 1, col: 5, columns: 30, value: "", cursor: 0, placeholder: "Paste or type a URL…" } };
  const rows = ["  Endpoint URL", "     Paste or type a URL…", "  Enter continue · Esc cancel"];
  expect(screenInvariantFailures(frame(rows, { variant: "nocolor-dark-80" }), endpoint).map(failure => failure.message)).toEqual(["endpoint entry has focus but the cursor is hidden"]);
  // Without color, a cursor after the placeholder reads as typed text; it belongs on the placeholder's first cell.
  expect(invariants(frame(rows, { variant: "nocolor-dark-80", cursor: [6 + Bun.stringWidth("Paste or type a URL…"), 2] }), endpoint)).toEqual(["I4"]);
  expect(invariants(frame(rows, { variant: "nocolor-dark-80", cursor: [6, 2] }), endpoint)).toEqual([]);
  // The cursor must sit on the field's own row: a row that does not start with the value fails.
  expect(invariants(frame(["", "     something else"], { cursor: [6, 2] }), endpoint)).toEqual(["I4"]);
});

test("I4 passes a masked value with the cursor after its last mask cell, and frames with no focused field", () => {
  const masked = "•".repeat(14);
  const key: FrameState = { panel: "credential", idle: true, input: { surface: "credential entry", row: 1, col: 5, columns: 30, value: masked, cursor: masked.length, placeholder: "Paste key…" } };
  expect(invariants(frame(["  API key · OpenAI", `     ${masked}`], { cursor: [5 + 14 + 1, 2] }), key)).toEqual([]);
  expect(invariants(frame(["  Review · current changes"]), { panel: "review", idle: true })).toEqual([]);
});

test("I4 follows composer word wrap, so a soft-wrapped draft keeps the cursor on the next word", () => {
  // Character wrap of "aaaa bbbb" in 7 cells lands at (2, 1). The composer wraps before "bbbb", at (4, 1).
  expect(cursorCell("aaaa bbbb", 9, 7)).toEqual({ x: 2, y: 1 });
  expect(cursorCell("aaaa bbbb", 9, 7, "word")).toEqual({ x: 4, y: 1 });
  // A word wider than the field fills the row, then continues. A space that does not fit is not drawn on the next row.
  expect(cursorCell("bbbbbbbb", 8, 7, "word")).toEqual({ x: 1, y: 1 });
  expect(cursorCell("bbbbbbbb", 7, 7, "word")).toEqual({ x: 0, y: 1 });
  expect(cursorCell("aaaa b", 4, 4, "word")).toEqual({ x: 4, y: 0 });
  expect(cursorCell("aaaa b", 6, 4, "word")).toEqual({ x: 1, y: 1 });
  const value = "aaaa bbbb";
  const state: FrameState = { ...idle, input: { surface: "composer", row: 1, col: 0, columns: 7, value, cursor: value.length, placeholder: "", wrap: "word" } };
  expect(invariants(frame(["", "aaaa", "bbbb"], { cursor: [5, 3] }), state)).toEqual([]);
  const token = "bbbbbbbb";
  const wide: FrameState = { ...idle, input: { surface: "composer", row: 0, col: 0, columns: 7, value: token, cursor: token.length, placeholder: "", wrap: "word" } };
  expect(invariants(frame(["bbbbbbb", "b"], { cursor: [2, 2] }), wide)).toEqual([]);
});

test("I4 follows line breaks, wrapping and editor scrolling", () => {
  expect(cursorCell("ab\nก้ข", 6, 10)).toEqual({ x: 2, y: 1 });
  expect(cursorCell("abcdef", 6, 4)).toEqual({ x: 2, y: 1 });
  expect(cursorCell("abc🧪", 5, 4)).toEqual({ x: 2, y: 1 });
  expect(sliceCells(" ▌ › งานถัดไป 🧪", 5)).toBe("งานถัดไป 🧪");
  // A field scrolled to its last line keeps the cursor on the visible row, whatever the hidden first line holds.
  const value = "first\nยังไม่ส่ง 🧪";
  const scrolled: FrameState = { ...idle, input: { surface: "composer", row: 3, col: 5, columns: 20, value, cursor: value.length, placeholder: "Ask Schway…", scroll: 1 } };
  expect(invariants(frame(["", "", "", " ▌ › ยังไม่ส่ง 🧪"], { cursor: [5 + Bun.stringWidth("ยังไม่ส่ง 🧪") + 1, 4] }), scrolled)).toEqual([]);
});

test("exemptions cover matching failures only, and an unused exemption is reported as stale", () => {
  const failures = screenInvariantFailures(frame(["  Compacting · Esc stop"], { screen: "busy-notice", variant: "dark-80" }), idle);
  const exemption: InvariantExemption = { screen: "busy-notice", invariant: "I3", reason: "Busy rejection notice; follow-up filed." };
  const stale: InvariantExemption = { screen: "busy-notice", variant: "dark-120", invariant: "I3", reason: "Wrong variant." };
  expect(applyExemptions(failures, [exemption]).remaining).toEqual([]);
  const result = applyExemptions(failures, [stale]);
  expect(result.remaining).toHaveLength(1);
  expect(result.used.has(stale)).toBe(false);
});

test("no catalog exemption covers a frame from the #304 evidence", () => {
  const covered = INVARIANT_EVIDENCE_FRAMES.filter(evidence => SCREEN_INVARIANT_EXEMPTIONS.some(exemption => exemption.screen === evidence.screen && exemption.invariant === evidence.invariant
    && (exemption.variant === undefined || evidence.variant === undefined || exemption.variant === evidence.variant)));
  expect(covered).toEqual([]);
  for (const exemption of SCREEN_INVARIANT_EXEMPTIONS) expect(exemption.reason.trim()).not.toBe("");
});
