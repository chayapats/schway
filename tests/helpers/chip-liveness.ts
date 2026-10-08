import type { CapturedFrame, RGBA } from "@opentui/core";
import { HINT_KEY } from "../../src/tui/hint-text.ts";

/** A key encoding the liveness test presses every advertised chip under (#305). */
export type ChipEncoding = "kitty" | "legacy";
/** Both encodings, in the order the liveness test runs them. */
export const CHIP_ENCODINGS: readonly ChipEncoding[] = ["kitty", "legacy"];

/** One way to press a chip: the direction it tries and the exact bytes a terminal sends for it in one encoding. */
export interface ChipPress { direction: string; bytes: string }

/** Thrown when chip text has no entry in the key map; the message names the chip so the map can be extended on purpose. */
export class UnknownChipError extends Error {}

// Kitty bytes follow the `@opentui/core/testing` kitty encoder; F2 sends a press and its release, as tests/journeys-241.test.ts does.
const KITTY: Readonly<Record<string, string>> = {
  Esc: "\x1b[27u", Enter: "\x1b[13u", Tab: "\x1b[9u", Backspace: "\x1b[127u", Up: "\x1b[57352u", Down: "\x1b[57353u", Left: "\x1b[57350u", Right: "\x1b[57351u",
  PgUp: "\x1b[57354u", PgDn: "\x1b[57355u", Home: "\x1b[57356u", End: "\x1b[57357u", F2: "\x1b[57365;1u\x1b[57365;1:3u",
  "Shift+Tab": "\x1b[9;2u", "Shift+Enter": "\x1b[13;2u", "Ctrl+End": "\x1b[57357;5u", Space: "\x1b[32u",
};
// Legacy bytes are what a terminal without the kitty protocol sends; Shift+Enter has no distinct form there.
const LEGACY: Readonly<Record<string, string>> = {
  Esc: "\x1b", Enter: "\r", Tab: "\t", Backspace: "\x7f", Up: "\x1b[A", Down: "\x1b[B", Right: "\x1b[C", Left: "\x1b[D",
  PgUp: "\x1b[5~", PgDn: "\x1b[6~", Home: "\x1b[H", End: "\x1b[F", F2: "\x1bOQ",
  "Shift+Tab": "\x1b[Z", "Shift+Enter": "\r", "Ctrl+End": "\x1b[1;5F", Space: " ",
};
/** Keys whose legacy bytes another key may share; a chip that sends one of these without being that key is not distinguishable. */
const LEGACY_REFERENCES: readonly { key: string; bytes: string }[] = [
  { key: "Tab", bytes: "\t" }, { key: "Enter", bytes: "\r" }, { key: "Backspace", bytes: "\x7f" }, { key: "Backspace", bytes: "\b" }, { key: "Esc", bytes: "\x1b" },
];
/** Chip glyphs and spellings that name one key or a pair of directions. */
const DIRECTIONS: Readonly<Record<string, readonly string[]>> = {
  "↑↓": ["Up", "Down"], "↑/↓": ["Up", "Down"], "↓↑": ["Down", "Up"], "←→": ["Left", "Right"], "←/→": ["Left", "Right"],
  "↑": ["Up"], "↓": ["Down"], "←": ["Left"], "→": ["Right"], Up: ["Up"], Down: ["Down"],
  "PgUp/PgDn": ["PgUp", "PgDn"], "PageUp/PageDown": ["PgUp", "PgDn"], PgUp: ["PgUp"], PgDn: ["PgDn"], PageUp: ["PgUp"], PageDown: ["PgDn"],
  Home: ["Home"], End: ["End"], Esc: ["Esc"], Enter: ["Enter"], Tab: ["Tab"], F2: ["F2"], Space: ["Space"],
  "Shift+Tab": ["Shift+Tab"], "Shift+Enter": ["Shift+Enter"], "Ctrl+End": ["Ctrl+End"],
};
const table = (encoding: ChipEncoding) => encoding === "kitty" ? KITTY : LEGACY;

/** Bytes for one modified letter or bracket (`Ctrl+R`, `Alt+L`, `^O`), or undefined when the token is not one. */
function modifiedKey(token: string, encoding: ChipEncoding): string | undefined {
  const match = /^(?:(Ctrl|Alt)\+|(\^))([A-Za-z[])$/.exec(token);
  if (!match) return undefined;
  const ctrl = match[1] === "Ctrl" || match[2] === "^", char = match[3]!.toLowerCase(), code = char.charCodeAt(0);
  if (encoding === "kitty") return `\x1b[${code};${ctrl ? 5 : 3}u`;
  return ctrl ? String.fromCharCode(char === "[" ? 0x1b : code - 96) : `\x1b${char}`;
}

/**
 * Presses for one chip key token in one encoding: one entry per direction a two-way chip tries (`↑↓`, `←→`, `PgUp/PgDn`),
 * otherwise exactly one. A `/command` token types the command and Enter. Throws `UnknownChipError` naming the token
 * when the map has no entry for it.
 */
export function chipPresses(token: string, encoding: ChipEncoding): ChipPress[] {
  const keys = table(encoding);
  const named = DIRECTIONS[token];
  if (named) return named.map(direction => ({ direction, bytes: keys[direction]! }));
  const modified = modifiedKey(token, encoding);
  if (modified !== undefined) return [{ direction: token, bytes: modified }];
  if (token === "/") return [{ direction: "/", bytes: "/" }];
  if (/^\/[a-z][\w-]*$/.test(token)) return [{ direction: token, bytes: `${token}${keys.Enter}` }];
  // A single uppercase letter is a panel key such as C copy, R read or W wrap; the terminal sends the unshifted letter.
  if (/^[A-Z]$/.test(token)) {
    const char = token.toLowerCase();
    return [{ direction: token, bytes: encoding === "kitty" ? `\x1b[${char.charCodeAt(0)}u` : char }];
  }
  throw new UnknownChipError(`No key map entry for chip key "${token}". Add it to chipPresses in tests/helpers/chip-liveness.ts with its kitty and legacy bytes.`);
}

/**
 * The other key whose legacy bytes equal this chip key's, such as Tab for `Ctrl+I`, Enter for `Ctrl+M`, Backspace for
 * `Ctrl+H` and Esc for `Ctrl+[`; undefined when a legacy terminal can send the key distinctly. Throws for unknown keys.
 */
export function legacyCollision(token: string): string | undefined {
  const presses = chipPresses(token, "legacy");
  for (const press of presses) {
    const other = LEGACY_REFERENCES.find(reference => reference.bytes === press.bytes && reference.key !== press.direction);
    if (other) return other.key;
  }
  return undefined;
}

/** Where a chip was found: a bold key run on its own chip background, or a key-led segment of the hint row. */
export type ChipSource = "chip" | "hint-row";
/** One advertised key on a frame: its key token, its `Key action` label, zero-based row and cell column, and its source. */
export interface DiscoveredChip { key: string; label: string; row: number; column: number; source: ChipSource }

const BOLD = 1;
const sameColor = (a: RGBA, b: RGBA) => a.intent === b.intent && a.toInts().join() === b.toInts().join();
// Frame, gutter and selection glyphs at the start of a row, which are never part of a hint segment.
const leadingGutter = /^[\s│┃▌▐›]+/;

/** The action after a key: text up to the next ` · ` separator or column gap, trimmed. */
function actionAfter(rest: string): string {
  const end = rest.search(/ · |\s{2,}/);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

/**
 * Advertised chips on a captured frame. A chip is a bold run whose whole text is one `HINT_KEY` token and whose
 * background differs from the cell after it (before it at a row end), as `keyHintChunks` paints it on any row: hint
 * row, status bar, outcome strip, readiness card, transcript error rows and panel hint lines. Every key-led ` · `
 * segment of each row in `hintRows` is a chip too. A key that only documents itself (followed by ` or ` or a column
 * gap, as palette result rows list keys) or that shares its row's highlight is not a chip. Labels repeat once per place.
 */
export function discoverChips(frame: CapturedFrame, hintRows: readonly number[] = []): DiscoveredChip[] {
  const chips: DiscoveredChip[] = [];
  frame.lines.forEach((line, row) => {
    const text = line.spans.map(span => span.text).join("");
    let column = 0, offset = 0;
    line.spans.forEach((span, index) => {
      const start = column, startOffset = offset;
      column += span.width; offset += span.text.length;
      if (!(span.attributes & BOLD) || HINT_KEY.exec(span.text)?.[0] !== span.text) return;
      const neighbour = line.spans[index + 1] ?? line.spans[index - 1];
      if (!neighbour || sameColor(neighbour.bg, span.bg)) return;
      const rest = text.slice(startOffset + span.text.length);
      if (/^ or |^\s{2,}/.test(rest)) return;
      const action = actionAfter(rest);
      chips.push({ key: span.text, label: action ? `${span.text} ${action}` : span.text, row, column: start, source: "chip" });
    });
    if (!hintRows.includes(row)) return;
    const gutter = leadingGutter.exec(text)?.[0] ?? "";
    let cell = Bun.stringWidth(gutter);
    for (const segment of text.slice(gutter.length).replace(/\s+$/, "").split(" · ")) {
      const key = HINT_KEY.exec(segment)?.[0];
      if (key) chips.push({ key, label: segment.trim(), row, column: cell, source: "hint-row" });
      cell += Bun.stringWidth(segment) + 3;
    }
  });
  return chips;
}

/** Visible failure notices that do not count as a chip acting: the key was heard but could not do its job. */
export const FAILURE_NOTICES: readonly RegExp[] = [/Unknown command/, /Nothing to [a-z]/, /No [\w ]+ to show/, /Wait for this turn/];

/** Why an allowlisted chip may stay dead or notice-only; see docs/screen-catalog.md "Key chip liveness". */
export type ChipAllowReason = "single-item" | "content-fits" | "notice-by-design" | "encoding-limit" | "known-defect";
/**
 * One chip the liveness test accepts as not acting on one screen, optionally in one encoding. `note` explains it; for
 * `single-item` and `content-fits` it names, in backticks, a catalog screen where the same chip is proven live or a
 * `tests/*.test.ts` file and a quoted test name that proves it. `known-defect` requires the open `issue` that fixes it.
 */
export interface ChipAllowEntry { screen: string; chip: string; encoding?: ChipEncoding; reason: ChipAllowReason; note: string; issue?: number }
