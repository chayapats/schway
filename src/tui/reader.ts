import { displayText } from "./presentation.ts";
import { TranscriptSearchIndex } from "./search.ts";

/** Maximum retained UTF-16 source units, matching the conversation search budget. */
export const READER_SOURCE_LIMIT = 8_000_000;
const MAX_ROWS = 200;
const MAX_COLUMNS = 1000;
const MAX_GRAPHEME_CHARS = 1024;
const TAB_COLUMNS = 4;
const CHECKPOINT_CHARS = 4096;
const MAX_LAYOUTS = 4;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Associate a captured block with its existing inspection target and message. */
export interface ReaderTarget { readonly id: string; readonly messageId: string; readonly kind: "code" | "table" }

/** Keep a canonical UTF-16 source anchor independent of layout and horizontal cell offset. */
export interface ReaderPosition { readonly offset: number; readonly horizontal: number }

/** Request terminal cells; rendering clamps to 1000 columns and 200 rows. */
export interface ReaderViewport { readonly columns: number; readonly rows: number; readonly wrap: boolean }

/** Describe one readable row; source ranges exclude line endings and presentation substitutions. */
export interface ReaderRow {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly continuation: boolean;
  readonly clippedLeft: boolean;
  readonly clippedRight: boolean;
  /** A too-wide, zero-width or over-1024-unit grapheme is represented by an ellipsis. */
  readonly substituted: boolean;
}

/** Return only the requested window and explicit source/layout limits, without adding copy decorations. */
export interface ReaderWindow {
  readonly position: ReaderPosition;
  readonly rows: readonly ReaderRow[];
  readonly columns: number;
  readonly height: number;
  readonly wrap: boolean;
  readonly hasBefore: boolean;
  readonly hasAfter: boolean;
  readonly viewportLimited: boolean;
  readonly sourceTruncated: boolean;
}

/** Locate a literal occurrence in canonical source, retaining the original message association. */
export interface ReaderSearchMatch {
  readonly id: string;
  readonly targetId: string;
  readonly messageId: string;
  readonly start: number;
  readonly end: number;
}

/** A local search; limited means capped source/query or more than 20,000 occurrences. */
export interface ReaderSearchResult { readonly matches: readonly ReaderSearchMatch[]; readonly limited: boolean }

type Range = { start: number; end: number; line: number; column: number; row: number };
type GraphemePoint = { offset: number; column: number };

function floorIndex<T>(items: readonly T[], value: number, key: (item: T) => number): number {
  let low = 0;
  let high = items.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (key(items[middle]!) <= value) low = middle; else high = middle;
  }
  return low;
}

function integer(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? Math.trunc(value) : min));
}

function cellWidth(text: string, column: number): number {
  return text === "\t" ? TAB_COLUMNS - column % TAB_COLUMNS : Math.max(1, Bun.stringWidth(text));
}

function graphemeStart(text: string, offset: number): number {
  if (offset === 0 || offset === text.length) return offset;
  // Iterate boundaries: Bun's Segments.containing can incorrectly include the
  // preceding Thai cluster when offset points at an emoji's leading surrogate.
  for (const part of graphemes.segment(text)) if (part.index + part.segment.length > offset) return part.index;
  return text.length;
}

/** Capture sanitized source; capped input conservatively omits its last prefix grapheme. */
export class ReaderSnapshot {
  readonly target: ReaderTarget;
  readonly source: string;
  readonly truncated: boolean;
  readonly streaming: boolean;
  private readonly lines: Uint32Array;
  private readonly points: readonly GraphemePoint[];
  private readonly layouts = new Map<number, readonly Range[]>();
  private readonly index = new TranscriptSearchIndex();
  private readonly segments: readonly string[];
  private lastQuery: string | undefined;
  private lastSearch: ReaderSearchResult = { matches: [], limited: false };

  constructor(target: ReaderTarget, canonicalSource: string, options: { streaming?: boolean } = {}) {
    const prefix = canonicalSource.slice(0, READER_SOURCE_LIMIT);
    let end = prefix.length;
    if (end < canonicalSource.length) {
      // Never segment beyond the cap: the last prefix cluster might continue
      // arbitrarily far into omitted text. Conservatively omit that cluster.
      for (const part of graphemes.segment(prefix)) end = part.index;
    }
    this.source = prefix.slice(0, end);
    // Validation only: upstream capture owns sanitization/redaction. Do not invent
    // another copy representation, nor remove CRLF that this caller preserved.
    const checked = this.source.replace(/\r\n/g, "\n");
    if (displayText(checked) !== checked) throw new Error("Reader source must already be sanitized");
    this.truncated = end < canonicalSource.length;
    this.streaming = options.streaming ?? false;
    this.target = Object.freeze({ id: target.id, messageId: target.messageId, kind: target.kind });
    this.segments = [this.source];
    let count = 1;
    for (let offset = 0; offset < this.source.length; offset++) if (this.source[offset] === "\n") count++;
    this.lines = new Uint32Array(count);
    let line = 1;
    for (let offset = 0; offset < this.source.length; offset++) if (this.source[offset] === "\n") this.lines[line++] = offset + 1;
    const points: GraphemePoint[] = [{ offset: 0, column: 0 }];
    let column = 0;
    for (const part of graphemes.segment(this.source)) {
      if (part.index - points.at(-1)!.offset >= CHECKPOINT_CHARS) points.push({ offset: part.index, column });
      column = part.segment.endsWith("\n") ? 0 : column + cellWidth(part.segment, column);
    }
    this.points = points;
  }

  /** Copy exactly the retained canonical bytes; complete=false requires a partial-copy notice. */
  copy(): { readonly text: string; readonly complete: boolean } {
    return { text: this.source, complete: !this.truncated };
  }

  /** Reveal a source grapheme, including its horizontal position when code is unwrapped. */
  positionAt(offset: number): ReaderPosition {
    const anchor = this.anchor(offset);
    const line = this.lineAt(anchor);
    const point = this.points[floorIndex(this.points, anchor, point => point.offset)]!;
    const start = Math.max(point.offset, this.lines[line]!);
    let horizontal = start === point.offset ? point.column : 0;
    for (const part of graphemes.segment(this.source.slice(start, Math.min(anchor, this.lineEnd(line))))) {
      horizontal += cellWidth(part.segment, horizontal);
    }
    return { offset: anchor, horizontal };
  }

  /** Generate at most 200 visible rows; resizing or toggling wrapping leaves the source anchor intact. */
  view(position: ReaderPosition, viewport: ReaderViewport): ReaderWindow {
    const layout = this.layout(viewport);
    const current = this.position(position);
    const first = this.locate(current.offset, layout.columns, layout.wrap);
    const rows: ReaderRow[] = [];
    let hasAfter = false;
    for (const range of this.ranges(first, layout.columns, layout.wrap)) {
      if (rows.length === layout.height) { hasAfter = true; break; }
      rows.push(this.render(range, layout.columns, layout.wrap ? range.column : current.horizontal));
    }
    return { ...layout, position: current, rows, hasBefore: first.start > 0, hasAfter, sourceTruncated: this.truncated };
  }

  /** Move by up to one maximum page (200 rows) and terminal columns without changing source bytes. */
  move(position: ReaderPosition, viewport: ReaderViewport, delta: { rows?: number; columns?: number }): ReaderPosition {
    const layout = this.layout(viewport);
    const current = this.position(position);
    const first = this.locate(current.offset, layout.columns, layout.wrap);
    const amount = integer(delta.rows ?? 0, -MAX_ROWS, MAX_ROWS);
    let offset = current.offset;
    if (amount !== 0) {
      const target = Math.max(0, first.row + amount);
      const points = layout.wrap ? this.wrapPoints(layout.columns) : undefined;
      const line = Math.min(target, this.lines.length - 1);
      const start = points ? points[floorIndex(points, target, point => point.row)]!
        : { start: this.lines[line]!, end: this.lineEnd(line), line, column: 0, row: line };
      for (const range of this.ranges(start, layout.columns, layout.wrap)) {
        offset = range.start;
        if (range.row >= target) break;
      }
    }
    return { offset, horizontal: layout.wrap ? current.horizontal : integer(current.horizontal + (delta.columns ?? 0), 0, READER_SOURCE_LIMIT * TAB_COLUMNS) };
  }

  /** Search with existing NFC/case folding; occurrence identities are scoped to this immutable snapshot. */
  search(query: string): ReaderSearchResult {
    if (query.length > READER_SOURCE_LIMIT) return { matches: [], limited: true };
    if (query === this.lastQuery) return this.lastSearch;
    const result = this.index.update([{ id: this.target.id, kind: "assistant", segments: this.segments }], query);
    const needleLength = query.normalize("NFC").toLocaleLowerCase().length;
    const matches: ReaderSearchMatch[] = [];
    let hit = 0;
    let foldedOffset = 0;
    let start = 0;
    if (result.matches.length) for (const part of graphemes.segment(this.source)) {
      const length = part.segment.length === 1 && part.segment.charCodeAt(0) < 128 ? 1
        : part.segment.normalize("NFC").toLocaleLowerCase().length;
      const end = foldedOffset + length;
      while (hit < result.matches.length) {
        const found = result.matches[hit]!.offset;
        if (found >= end) break;
        if (found >= foldedOffset) start = part.index;
        if (found + needleLength > end) break;
        const sourceEnd = part.index + part.segment.length;
        const id = `${this.target.id}:${start}:${sourceEnd}`;
        // Several folded characters may belong to one original grapheme.
        if (matches.at(-1)?.id !== id) matches.push({ id, targetId: this.target.id, messageId: this.target.messageId, start, end: sourceEnd });
        hit++;
      }
      foldedOffset = end;
      if (hit === result.matches.length) break;
    }
    this.lastQuery = query;
    this.lastSearch = { matches, limited: this.truncated || result.limited };
    return this.lastSearch;
  }

  private position(position: ReaderPosition): ReaderPosition {
    return { offset: this.anchor(position.offset), horizontal: integer(position.horizontal, 0, READER_SOURCE_LIMIT * TAB_COLUMNS) };
  }

  private anchor(offset: number): number {
    const value = integer(offset, 0, this.source.length);
    if (value === this.source.length) return value;
    const line = this.lineAt(value);
    const index = floorIndex(this.points, value, point => point.offset);
    const beginning = Math.max(this.lines[line]!, this.points[index]!.offset);
    const end = Math.min(this.lines[line + 1] ?? this.source.length, this.points[index + 1]?.offset ?? this.source.length);
    return beginning + graphemeStart(this.source.slice(beginning, end), value - beginning);
  }

  private layout(viewport: ReaderViewport) {
    const columns = integer(viewport.columns, 1, MAX_COLUMNS);
    const height = integer(viewport.rows, 1, MAX_ROWS);
    return { columns, height, wrap: this.target.kind === "code" && viewport.wrap, viewportLimited: columns !== viewport.columns || height !== viewport.rows };
  }

  private lineAt(offset: number): number {
    let low = 0;
    let high = this.lines.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (this.lines[middle]! <= offset) low = middle; else high = middle;
    }
    return low;
  }

  private lineEnd(line: number): number {
    if (line + 1 === this.lines.length) return this.source.length;
    const newline = this.lines[line + 1]! - 1;
    return this.source[newline - 1] === "\r" ? newline - 1 : newline;
  }

  private locate(offset: number, columns: number, wrap: boolean): Range {
    const line = this.lineAt(offset);
    const end = this.lineEnd(line);
    if (!wrap) return { start: this.lines[line]!, end, line, column: 0, row: line };
    const points = this.wrapPoints(columns);
    const first = points[floorIndex(points, offset, point => point.start)]!;
    for (const range of this.ranges(first, columns, wrap)) {
      if (offset < range.end || range.line === line && range.end === end) return range;
    }
    throw new Error("Reader anchor is outside its snapshot");
  }

  private wrapPoints(columns: number): readonly Range[] {
    const cached = this.layouts.get(columns);
    if (cached) return cached;
    const points: Range[] = [];
    const initial = { start: 0, end: this.lineEnd(0), line: 0, column: 0, row: 0 };
    let last = initial;
    for (const range of this.ranges(initial, columns, true)) {
      if (!points.length || range.start - points.at(-1)!.start >= CHECKPOINT_CHARS) points.push(range);
      last = range;
    }
    if (last.start !== points.at(-1)!.start) points.push(last);
    if (this.layouts.size === MAX_LAYOUTS) this.layouts.delete(this.layouts.keys().next().value!);
    this.layouts.set(columns, points);
    return points;
  }

  private *ranges(first: Range, columns: number, wrap: boolean): Generator<Range> {
    let row = first.row;
    for (let line = first.line; line < this.lines.length; line++) {
      const beginning = line === first.line ? first.start : this.lines[line]!;
      const end = this.lineEnd(line);
      if (!wrap) { yield { start: beginning, end, line, column: 0, row: row++ }; continue; }
      let start = beginning;
      let rowColumn = line === first.line ? first.column : 0;
      let column = rowColumn;
      for (const part of graphemes.segment(this.source.slice(beginning, end))) {
        const next = beginning + part.index;
        const width = cellWidth(part.segment, column);
        if (column - rowColumn + width > columns && next > start) {
          yield { start, end: next, line, column: rowColumn, row: row++ };
          start = next; rowColumn = column;
        }
        column += width;
      }
      yield { start, end, line, column: rowColumn, row: row++ };
    }
  }

  private render(range: Range, columns: number, horizontal: number): ReaderRow {
    let text = "";
    let beginning = range.start;
    let column = range.column;
    let low = floorIndex(this.points, range.start, point => point.offset);
    if (this.points[low]!.offset < range.start) low++;
    let high = floorIndex(this.points, range.end, point => point.offset) + 1;
    // Within this physical line, checkpoint columns are monotonic. Start near
    // the horizontal viewport instead of repeatedly traversing hidden cells.
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.points[middle]!.column <= horizontal) low = middle + 1; else high = middle;
    }
    const point = this.points[low - 1];
    if (point && point.offset >= range.start && point.offset <= range.end && point.column <= horizontal) {
      beginning = point.offset; column = point.column;
    }
    let substituted = false;
    let clippedRight = false;
    for (const part of graphemes.segment(this.source.slice(beginning, range.end))) {
      const width = cellWidth(part.segment, column);
      const next = column + width;
      if (next > horizontal && column < horizontal + columns) {
        const visible = Math.min(next, horizontal + columns) - Math.max(column, horizontal);
        if (part.segment === "\t") text += " ".repeat(visible);
        else if (column < horizontal || next > horizontal + columns) {
          // A whole wide grapheme that cannot fit even a wrapped row gets an
          // explicit placeholder; horizontal edge fragments stay blank cells.
          if (range.column === horizontal && range.end - range.start === part.segment.length && width > columns) {
            text += "…"; substituted = true;
          } else text += " ".repeat(visible);
        } else if (part.segment.length > MAX_GRAPHEME_CHARS || Bun.stringWidth(part.segment) === 0) {
          text += "…" + " ".repeat(Math.max(0, visible - 1)); substituted = true;
        } else text += part.segment;
      }
      if (next > horizontal + columns) clippedRight = true;
      column = next;
      if (column >= horizontal + columns) {
        clippedRight ||= part.index + part.segment.length < range.end - beginning;
        break;
      }
    }
    return { text, start: range.start, end: range.end, line: range.line + 1, continuation: range.start > this.lines[range.line]!, clippedLeft: horizontal > range.column && range.end > range.start, clippedRight, substituted };
  }
}
