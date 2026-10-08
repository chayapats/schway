// Pure wrapping for numbered diff rows in the undo and review panels; no renderer import.

/** Gutter before a numbered diff row's text: the line number right-aligned to three cells, then `│` and the sign (undo) or the sign and a space (review). */
export function diffGutter(line: number, sign: string, undo: boolean): string {
  return `${String(line).padStart(3)} ${undo ? "│" : ""}${sign}${undo ? "" : " "}`;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Tab stop for diff text, the reader's 4 columns; `Bun.stringWidth` counts a tab as 0 cells while the renderer draws it wider. */
const TAB_COLUMNS = 4;

/** Text with each tab replaced by spaces up to the next 4-column stop, counted in cells from the start of `text`. */
export function expandTabs(text: string): string {
  if (!text.includes("\t")) return text;
  let result = "", column = 0;
  for (const { segment } of segmenter.segment(text)) {
    const cells = segment === "\t" ? TAB_COLUMNS - column % TAB_COLUMNS : Bun.stringWidth(segment);
    result += segment === "\t" ? " ".repeat(cells) : segment;
    column += cells;
  }
  return result;
}

// Tabs expand to 4-column stops first; text then breaks at grapheme boundaries measured with `Bun.stringWidth`, so
// Thai marks and emoji stay whole. When the gutter leaves no room, the line comes back unwrapped for the renderer to wrap.
/** Rows of one numbered diff line at most `columns` cells wide, continuations under a blank gutter as wide as `gutter`. */
export function wrapDiffLine(gutter: string, raw: string, columns: number): string[] {
  const text = expandTabs(raw);
  const indent = Bun.stringWidth(gutter);
  const room = columns - indent;
  if (room < 1 || Bun.stringWidth(text) <= room) return [`${gutter}${text}`];
  const chunks: string[] = [];
  let chunk = "", width = 0;
  for (const { segment } of segmenter.segment(text)) {
    const cells = Bun.stringWidth(segment);
    if (chunk && width + cells > room) { chunks.push(chunk); chunk = ""; width = 0; }
    chunk += segment; width += cells;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map((part, index) => `${index ? " ".repeat(indent) : gutter}${part}`);
}
