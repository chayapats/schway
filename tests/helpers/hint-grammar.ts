import { HINT_KEY } from "../../src/tui/hint-text.ts";
import type { ScreenGolden, StyleRun } from "../screen-catalog/format.ts";
import { BUILT_IN_COMMAND_ORDER } from "../../src/tui/command-catalog.ts";
import { ESC_VERBS } from "./esc-verbs.ts";

/** One key-hint rule from the voice guide's "Write key hints" section. */
export type HintRule = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7";

/** Short name of each rule, used in failure messages. */
export const HINT_RULES: Readonly<Record<HintRule, string>> = {
  R1: "verb per key", R2: "no bare keys", R3: "imperative only", R4: "arrow glyphs",
  R5: "no dangling separators", R6: "key and verb on one row", R7: "chips on the hint row",
};

/** One rule violation on one rendered row of one golden. */
export interface HintFailure {
  screen: string;
  variant: string;
  /** Zero-based row index in the golden's text section. */
  row: number;
  rule: HintRule;
  /** The offending segment, or the whole row for row-level rules. */
  text: string;
  /** The full rendered row, which exemption patterns match against. */
  line: string;
  /** Why the text fails, naming the screen, variant, one-based row and rule. */
  message: string;
}

/**
 * Actions each non-slash key may lead in a ` · ` hint segment, seeded from the valid pairs on the catalog.
 * The whole text after the key must equal one entry, or an entry followed by `: ` and a target such as a session title.
 * Add a pair here on purpose when new copy pairs a key with a new imperative action; never add a noun or third-person form.
 */
export const HINT_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  Esc: ESC_VERBS.flatMap(({ verb, objects }) => [verb, ...objects.map(object => `${verb} ${object}`)]),
  Enter: ["allow once", "confirm", "continue", "current diff", "deny with reason", "fork", "insert", "keep", "open", "preview", "resume",
    "retry", "save", "send", "send a task", "show keys", "sign in", "submit", "toggle", "undo", "use"],
  Tab: ["complete", "existing", "more options", "new fork", "scope"],
  "Shift+Tab": ["change mode", "change in composer"],
  F2: ["back", "details", "files", "inspect details", "repair details"],
  "PgUp/PgDn": ["scroll"],
  "↑↓": ["choose", "choose another", "files", "move", "preview", "previous/next", "scroll", "select"],
  "←→": ["change", "columns", "pan"],
  "Alt+B": ["resume"],
  "Alt+D": ["discard"],
  "Alt+I": ["inspect"],
  "Alt+L": ["connect", "retry", "sign in"],
  "Alt+M": ["choose model"],
  "Alt+R": ["review"],
  "Ctrl+C": ["cancel turn"],
  "Ctrl+End": ["latest"],
  "Ctrl+F": ["find"],
  "Ctrl+O": ["tools"],
  "Ctrl+P": ["pin", "unpin"],
  "Ctrl+R": ["continue", "reload", "retry"],
  "Ctrl+W": ["other workspaces", "scope"],
  C: ["copy", "copy Markdown source", "copy this part"],
  R: ["read"],
  W: ["unwrap", "wrap"],
};

/** Base verbs whose third-person forms R3 rejects, beyond the first words of every allowed action. */
const EXTRA_VERBS = ["cancel", "close", "confirm", "copy", "exchange", "open", "restore", "save", "send", "stop", "submit", "switch", "toggle"];
const VERBS = new Set([...EXTRA_VERBS, ...Object.values(HINT_ACTIONS).flat().map(action => action.split(" ")[0]!)]);

/** A rendered-row exemption scoped to one screen and one rule, with the reason the row is prose or a listing. */
export interface HintExemption { screen: string; pattern: RegExp; rule: HintRule; reason: string }

// Frame, gutter and scrollbar glyphs that sit outside the copy at either end of a row.
const trailingFrame = /[\s│┃█▐▌▀▄]+$/;
const leadingGutter = /^[\s│┃▌▐]+/;
// Status glyphs, selection markers and bullets before the first word of a segment; a `~` path prefix is not decoration.
const leadingDecoration = /^[\s›●◌○✓✗!◆•⚡│┃▌▐*\u2800-\u28ff-]+/u;
const composerRow = /^\s*▌ ›(?:\s|$)/;
const separator = / · |\s{2,}| ·$/g;

interface Segment { text: string; start: number; key?: string; action: string }

const COMMANDS = new Set<string>(BUILT_IN_COMMAND_ORDER.map(name => `/${name}`));

/** The key that leads a segment; a `/name` counts only for a built-in command, so paths such as `/project` are text. */
function leadingKey(text: string): string | undefined {
  const key = HINT_KEY.exec(text)?.[0];
  return key && key.length > 1 && key.startsWith("/") && !COMMANDS.has(key) ? undefined : key;
}

/** Split a row at ` · ` separators and column gaps; `start` is the string index of each segment's first character. */
function segments(line: string): Segment[] {
  const result: Segment[] = [];
  let from = 0;
  const pieces = [...line.matchAll(separator)].map(match => ({ index: match.index, length: match[0].length }));
  for (const piece of [...pieces, { index: line.length, length: 0 }]) {
    const raw = line.slice(from, piece.index);
    const lead = leadingDecoration.exec(raw)?.[0].length ?? 0;
    const text = raw.slice(lead).trimEnd();
    if (text) {
      const key = leadingKey(text);
      result.push({ text, start: from + lead, key, action: key ? text.slice(key.length).trim() : "" });
    }
    from = piece.index + piece.length;
  }
  return result;
}

/** Segments of one rendered row, split at ` · ` separators and column gaps without leading status glyphs or markers, as R1–R7 read them. */
export function hintRowSegments(line: string): string[] {
  return segments(line.replace(trailingFrame, "")).map(segment => segment.text);
}

/** True when an action equals an allowed entry or names a target after it with `: `. */
function allowed(key: string, action: string): boolean {
  return (HINT_ACTIONS[key] ?? []).some(entry => action === entry || action.startsWith(`${entry}: `));
}

/** The base verb a third-person form comes from, when that base is a known hint verb. */
function thirdPersonBase(word: string): string | undefined {
  const bases = [word.endsWith("ies") ? `${word.slice(0, -3)}y` : "", word.endsWith("es") ? word.slice(0, -2) : "", word.endsWith("s") ? word.slice(0, -1) : ""];
  return bases.find(base => base && VERBS.has(base));
}

/** True when the next row continues the current row's text: its first word starts in lower case. */
function continues(next: string | undefined): boolean {
  return next !== undefined && !composerRow.test(next) && /^[a-z]/.test(next.replace(leadingGutter, ""));
}

/** The style run covering one cell column of a row, if any. */
function runAt(styles: readonly StyleRun[], row: number, column: number): StyleRun | undefined {
  return styles.find(run => run.row === row && run.start <= column && column < run.end);
}

/**
 * Check every row of a parsed golden against the key-hint rules R1–R7 and return each failure. The composer input
 * row (`▌ › …`) is user input and exempt. R7 checks only the hint row: the last row when the status bar (`◆ …`) sits
 * directly above it, so a compact footer that replaced the hint row is checked by R1–R6 alone.
 */
export function hintGrammarFailures(golden: ScreenGolden): HintFailure[] {
  const failures: HintFailure[] = [];
  const fail = (row: number, rule: HintRule, text: string, why: string) => failures.push({
    screen: golden.screen, variant: golden.variant, row, rule, text, line: golden.text[row]!,
    message: `${golden.screen} ${golden.variant} row ${row + 1}: ${rule} ${HINT_RULES[rule]}: ${why}: "${text}"`,
  });
  const hintRow = golden.text.length - 1;
  const statusAbove = hintRow > 0 && golden.text[hintRow - 1]!.trimStart().startsWith("◆ ");
  golden.text.forEach((line, row) => {
    if (composerRow.test(line)) return;
    const clean = line.replace(trailingFrame, "");
    const next = golden.text[row + 1];
    const wraps = continues(next);
    for (const arrow of clean.match(/↑\/↓|←\/→/g) ?? []) fail(row, "R4", arrow, `write ${arrow.replace("/", "")}, not ${arrow}`);
    if (/(?:^|\s)[·/]$/.test(clean)) fail(row, "R5", clean.trim(), "the row ends with a dangling separator");
    const parts = segments(clean);
    const last = parts.at(-1);
    // The row ends inside a key-led segment that is not yet a complete allowed action, or ends on a key token
    // anywhere in its segment, while the next row continues the text.
    const lastWord = clean.trim().split(/\s+/).at(-1) ?? "";
    // A segment wider than a whole row may wrap after its key and first action word, never between them.
    const nextSegment = next?.replace(leadingGutter, "").split(/ · |\s{2,}/)[0] ?? "";
    const tooWide = !!last && Bun.stringWidth(`${last.text} ${nextSegment}`) > golden.cols - Bun.stringWidth(leadingGutter.exec(clean)?.[0] ?? "") && !!last.action;
    const openSegment = !!last?.key && !tooWide && (last.key.startsWith("/") ? last.key === "/" || !!last.action : !allowed(last.key, last.action));
    const splitKey = wraps && !!last && (openSegment || leadingKey(lastWord) === lastWord);
    if (splitKey) fail(row, "R6", `${last!.text} / ${nextSegment}`, "the segment wraps across rows; wrap at ` · ` and keep the key with its action");
    for (const segment of parts) {
      const { key, action } = segment;
      if (!key || (segment === last && splitKey)) continue;
      const slash = key.startsWith("/");
      const firstWord = action.split(" ")[0] ?? "";
      if (!slash && allowed(key, action)) continue;
      if (!action) fail(row, "R2", segment.text, `bare key ${key} with no action`);
      else if (slash ? firstWord.endsWith("…") : action.includes("…")) fail(row, "R2", segment.text, `the action after ${key} is cut off`);
      else if (slash) continue;
      else if (thirdPersonBase(firstWord)) fail(row, "R3", segment.text, `write the imperative "${thirdPersonBase(firstWord)}", not "${firstWord}"`);
      else fail(row, "R1", segment.text, `"${action}" is not an allowed action for ${key}; add the pair to HINT_ACTIONS in tests/helpers/hint-grammar.ts on purpose`);
    }
    if (row !== hintRow || !statusAbove) return;
    for (const segment of parts) {
      if (!segment.key || !segment.action) continue;
      const column = Bun.stringWidth(clean.slice(0, segment.start));
      const end = column + Bun.stringWidth(segment.key);
      const chip = runAt(golden.styles, row, column);
      const after = runAt(golden.styles, row, end);
      const why = !chip || chip.start !== column || chip.end < end ? "the key is not one style run starting at its first cell"
        : !chip.attrs.includes("b") ? "the key chip is not bold"
          : after && after.bg === chip.bg ? "the key chip has the same background as its action" : "";
      if (why) fail(row, "R7", segment.text, why);
    }
  });
  return failures;
}

/** Split failures into those no exemption covers and the exemptions that covered none, so stale entries surface. */
export function applyHintExemptions(failures: readonly HintFailure[], exemptions: readonly HintExemption[]) {
  const used = new Set<HintExemption>();
  const unexempt = failures.filter(failure => {
    const exemption = exemptions.find(entry => entry.screen === failure.screen && entry.rule === failure.rule && entry.pattern.test(failure.line));
    if (exemption) used.add(exemption);
    return !exemption;
  });
  return { unexempt, stale: exemptions.filter(entry => !used.has(entry)) };
}
