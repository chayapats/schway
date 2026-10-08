// Pure key-hint text helpers with no renderer import, so headless code and core modules can share them.

// One alternation of whole key tokens, shared by the chip renderer and the catalog hint-grammar lint.
// Single letters are the panel keys (copy, read, wrap); a slash token is `/` alone or a `/command` name.
const KEY_TOKEN = String.raw`F2|(?:Ctrl|Alt|Shift)\+[^\s,.;:]+|Esc|Enter|Tab|PgUp\/PgDn|PageUp\/PageDown|PgUp|PgDn|PageUp|PageDown|Home|End|Space|Up|Down|[↑↓←→](?:\/?[↑↓←→])?|\/[a-z][\w-]*|\/|\^\S+|[CRW]`;

/** Matches text that starts with one whole key token followed by a space or the end; `[0]` is the token. */
export const HINT_KEY = new RegExp(`^(?:${KEY_TOKEN})(?=\\s|$)`);

/** Hint row while a tool approval waits behind another view: Esc returns to the request. */
export const APPROVAL_RETURN_HINT = "Esc back to request";

/**
 * Words of one segment, with each key token glued to the word after it so a break never separates them. A key inside
 * prose ("Wait, then Enter sends") also keeps the word before it, so no wrapped row starts with a key that is not an action.
 */
function hintUnits(segment: string): string[] {
  const words = segment.split(" ");
  const units: string[] = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (HINT_KEY.exec(word)?.[0] !== word) { units.push(word); continue; }
    const before = index > 0 && units.length ? `${units.pop()} ` : "";
    units.push(index + 1 < words.length ? `${before}${word} ${words[++index]}` : `${before}${word}`);
  }
  return units;
}

/**
 * Break hint text into rows of at most `columns` cells, only at ` · ` boundaries; the separator at a break is dropped.
 * A segment wider than a row wraps at spaces, never between a key and the word after it, and may start on the row
 * before it; a segment that fits a row always starts its own. Leading indentation stays on the first row only, as a
 * word-wrapping renderer would show it.
 */
export function wrapHintSegments(text: string, columns: number): string[] {
  const indent = /^ */.exec(text)![0];
  const rows: string[] = [];
  let row = indent;
  for (const segment of text.slice(indent.length).split(" · ")) {
    const joined = row.trim() ? `${row} · ${segment}` : `${row}${segment}`;
    if (Bun.stringWidth(joined) <= columns) { row = joined; continue; }
    const units = hintUnits(segment);
    // A segment wider than any row may start beside the one before it; its first unit keeps a key with its verb.
    const wide = Bun.stringWidth(segment) > columns;
    if (wide && row.trim() && Bun.stringWidth(`${row} · ${units[0]}`) <= columns) row = `${row} · ${units.shift()}`;
    else if (row.trim()) { rows.push(row); row = ""; }
    for (const unit of units) {
      const next = row.trim() ? `${row} ${unit}` : `${row}${unit}`;
      if (!row.trim() || Bun.stringWidth(next) <= columns) row = next;
      else { rows.push(row); row = unit; }
    }
  }
  rows.push(row);
  return rows;
}

/** True for the way out or the stop action (`Esc …`, `Ctrl+C …`), which outrank status decoration when room runs out. */
function exitAction(segment: string): boolean {
  return segment.startsWith("Esc") || segment.startsWith("Ctrl+C ");
}

/**
 * Fit hint text to `columns` without cutting inside a key-led segment. Status decoration after the first segment goes
 * first, then trailing key actions; an Esc or Ctrl+C stop action stays longest and outranks the first segment. A
 * remaining key-led segment stays whole or becomes ""; remaining status text shortens at a word boundary with `…`,
 * or becomes "" when not even its first word fits.
 */
export function fitHintSegments(text: string, columns: number): string {
  const width = (parts: readonly string[]) => Bun.stringWidth(parts.join(" · "));
  if (width([text]) <= columns) return text;
  const segments = text.split(" · ");
  const keyed = (segment: string) => HINT_KEY.test(segment);
  const drop = (removable: (segment: string, index: number) => boolean) => {
    for (let index = segments.length - 1; index > 0 && width(segments) > columns; index--) if (removable(segments[index]!, index)) segments.splice(index, 1);
  };
  drop(segment => !keyed(segment));
  drop(segment => !exitAction(segment));
  // The way out or stop action outranks the status it follows.
  const escape = segments.length > 1 ? segments.at(-1)! : "";
  if (width(segments) > columns && exitAction(escape) && width([escape]) <= columns) return escape;
  drop(() => true);
  if (width(segments) <= columns) return segments.join(" · ");
  if (keyed(segments[0]!)) return "";
  return shortenAtWord(segments[0]!, columns);
}

/**
 * Fit a palette description or reason to `columns`: text with ` · ` segments fits like a hint, while plain prose
 * shortens at a word boundary with `…` even when its first word looks like a key (`End the current…`).
 */
export function fitDescription(text: string, columns: number): string {
  if (Bun.stringWidth(text) <= columns) return text;
  return text.includes(" · ") ? fitHintSegments(text, columns) : shortenAtWord(text, columns);
}

function shortenAtWord(text: string, columns: number): string {
  let fitted = "";
  for (const unit of hintUnits(text)) {
    const next = fitted ? `${fitted} ${unit}` : unit;
    if (Bun.stringWidth(`${next}…`) > columns) break;
    fitted = next;
  }
  return fitted && `${fitted}…`;
}
