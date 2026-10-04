import { StyledText, bg, bold, fg, underline, type TextChunk } from "@opentui/core";
import { fitLine } from "./presentation.ts";
import { ReaderSnapshot, READER_SOURCE_LIMIT, type ReaderPosition, type ReaderRow, type ReaderSearchMatch, type ReaderTarget, type ReaderViewport } from "./reader.ts";
import { tint, type TuiTheme } from "./theme.ts";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/** One captured block: `view` is what the reader shows and searches, `copy` is the canonical source C copies. */
export interface ReaderDocument {
  readonly kind: "code" | "table";
  readonly title: string;
  readonly view: ReaderSnapshot;
  readonly copy: ReaderSnapshot;
  /** True when a table is shown as aligned columns rather than its Markdown source. */
  readonly aligned: boolean;
  /** View offset of the first table body row when a header and separator can stay pinned; otherwise 0. */
  readonly bodyStart: number;
  /** Aligned column start cells, used only to report the horizontal column position. */
  readonly columnStarts: readonly number[];
  readonly lineCount: number;
  /** Widest line in terminal cells, bounding horizontal scrolling; Infinity when too large to measure eagerly. */
  readonly maxWidth: number;
  readonly streaming: boolean;
}

/** View-local reader search; `origin` is restored by Esc and `selected` indexes the snapshot's matches. */
export interface ReaderSearch { query: string; selected: number; origin: ReaderPosition }

/** Rows and viewport derived for one panel size; navigation must reuse the viewport that was painted. */
export interface ReaderLayout {
  readonly viewport: ReaderViewport;
  readonly gutter: number;
  readonly markers: boolean;
  readonly pinned: boolean;
  readonly title: boolean;
  readonly status: readonly ("approval" | "snapshot" | "truncated" | "table")[];
  readonly search: boolean;
}

function width(text: string): number {
  let total = 0;
  for (const { segment } of graphemes.segment(text)) total += Math.max(1, Bun.stringWidth(segment));
  return total;
}

function tableCells(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\\" && text[index + 1] === "|") { cell += "\\|"; index++; continue; }
    if (text[index] === "|") { cells.push(cell.trim()); cell = ""; continue; }
    cell += text[index];
  }
  cells.push(cell.trim());
  return cells.map(value => value.replace(/\t/g, " "));
}

/** Align a GFM table's cells into columns without hiding cells; undefined keeps the Markdown source view. */
export function alignTable(source: string): { text: string; columnStarts: number[] } | undefined {
  const lines = source.split("\n");
  if (lines.length < 2 || !TABLE_SEPARATOR.test(lines[1]!)) return undefined;
  const rows = lines.map(tableCells);
  const widths: number[] = [];
  rows.forEach((cells, row) => { if (row !== 1) cells.forEach((cell, column) => { widths[column] = Math.max(widths[column] ?? 1, width(cell)); }); });
  for (let column = 0; column < widths.length; column++) widths[column] ??= 1;
  const lineWidth = widths.reduce((sum, value) => sum + value + 3, 0);
  if (lineWidth * rows.length > READER_SOURCE_LIMIT) return undefined;
  const columnStarts: number[] = [];
  let start = 0;
  for (const value of widths) { columnStarts.push(start); start += value + 3; }
  const text = rows.map((cells, row) => row === 1
    ? widths.map(value => "─".repeat(value)).join("─┼─")
    : widths.map((value, column) => { const cell = cells[column] ?? ""; return cell + " ".repeat(value - width(cell)); }).join(" │ ").trimEnd()).join("\n");
  return { text, columnStarts };
}

/** Capture one block once; tables gain an aligned readable view while copy keeps their Markdown source. */
export function createReaderDocument(target: ReaderTarget, source: string, options: { title: string; streaming: boolean }): ReaderDocument {
  const copy = new ReaderSnapshot(target, source, { streaming: options.streaming });
  const aligned = target.kind === "table" && !copy.truncated ? alignTable(copy.source) : undefined;
  const view = aligned ? new ReaderSnapshot(target, aligned.text, { streaming: options.streaming }) : copy;
  let lineCount = 1;
  for (let index = view.source.indexOf("\n"); index >= 0; index = view.source.indexOf("\n", index + 1)) lineCount++;
  const second = target.kind === "table" ? view.source.indexOf("\n", view.source.indexOf("\n") + 1) : -1;
  let maxWidth = view.source.length > 2_000_000 ? Infinity : 0;
  if (maxWidth === 0) {
    let column = 0;
    for (const { segment } of graphemes.segment(view.source)) {
      if (segment === "\n" || segment === "\r\n") { column = 0; continue; }
      column += segment === "\t" ? 4 - column % 4 : Math.max(1, Bun.stringWidth(segment));
      if (column > maxWidth) maxWidth = column;
    }
  }
  return {
    kind: target.kind, title: options.title, view, copy, aligned: !!aligned, streaming: options.streaming,
    bodyStart: second > 0 && view.source.indexOf("\n") > 0 ? second + 1 : 0, columnStarts: aligned?.columnStarts ?? [], lineCount, maxWidth,
  };
}

/** Allocate panel rows by priority: approval, title, search, snapshot, pinned header, then limit labels. */
export function readerLayout(document: ReaderDocument, wrap: boolean, columns: number, rows: number, flags: { approval: boolean; search: boolean }): ReaderLayout {
  let body = Math.max(1, rows);
  const take = (count: number, minimumBody = 1) => { if (body - count < minimumBody) return false; body -= count; return true; };
  const status: ReaderLayout["status"][number][] = [];
  if (flags.approval && take(1)) status.push("approval");
  const title = take(1);
  const search = flags.search && take(1);
  if (document.streaming && take(1, 2)) status.push("snapshot");
  const pinned = document.bodyStart > 0 && take(2, 2);
  if (document.copy.truncated && take(1, 3)) status.push("truncated");
  if (document.kind === "table" && take(1, 3)) status.push("table");
  const effectiveWrap = document.kind === "code" && wrap;
  const gutter = document.kind === "code" ? String(document.lineCount).length + 1 : 0;
  const markers = !effectiveWrap;
  return { viewport: { columns: Math.max(1, columns - gutter - (markers ? 2 : 0)), rows: body, wrap: effectiveWrap }, gutter, markers, pinned, title, status, search };
}

/** Next horizontal offset: tables step by aligned column, code by half a page, both bounded by the widest line. */
export function panReader(document: ReaderDocument, layout: ReaderLayout, horizontal: number, direction: -1 | 1): number {
  const limit = Math.max(0, document.maxWidth - layout.viewport.columns);
  const starts = document.columnStarts;
  const next = starts.length > 1
    ? direction > 0 ? starts.find(start => start > horizontal) ?? horizontal : [...starts].reverse().find(start => start < horizontal) ?? 0
    : horizontal + direction * Math.max(4, Math.floor(layout.viewport.columns / 2));
  return Math.max(0, Math.min(limit, next));
}

/** Scroll by rows; moving down never leaves blank rows below the last line when earlier rows could fill them. */
export function scrollReader(document: ReaderDocument, layout: ReaderLayout, position: ReaderPosition, rows: number): ReaderPosition {
  const moved = readerBodyPosition(document, layout, document.view.move(readerBodyPosition(document, layout, position), layout.viewport, { rows }));
  if (rows <= 0) return moved;
  const window = document.view.view(moved, layout.viewport);
  if (window.hasAfter || window.rows.length >= layout.viewport.rows) return moved;
  const last = readerEnd(document, layout, moved.horizontal);
  return last.offset >= position.offset ? last : position;
}

/** Top anchor of the last full page. */
export function readerEnd(document: ReaderDocument, layout: ReaderLayout, horizontal: number): ReaderPosition {
  const end = document.view.positionAt(document.view.source.length);
  return readerBodyPosition(document, layout, document.view.move({ offset: end.offset, horizontal }, layout.viewport, { rows: -(layout.viewport.rows - 1) }));
}

/** Keep the body below a pinned table header without changing the canonical anchor otherwise. */
export function readerBodyPosition(document: ReaderDocument, layout: ReaderLayout, position: ReaderPosition): ReaderPosition {
  return layout.pinned && position.offset < document.bodyStart ? { offset: document.bodyStart, horizontal: position.horizontal } : position;
}

/** Position that reveals a match a third of the way down the body, scrolling horizontally only when needed. */
export function revealMatch(document: ReaderDocument, layout: ReaderLayout, current: ReaderPosition, match: ReaderSearchMatch): ReaderPosition {
  const at = document.view.positionAt(match.start);
  const end = document.view.positionAt(match.end);
  const columns = layout.viewport.columns;
  const visible = layout.viewport.wrap || at.horizontal >= current.horizontal && end.horizontal <= current.horizontal + columns;
  const horizontal = visible ? current.horizontal : Math.max(0, at.horizontal - Math.floor(columns / 3));
  const moved = document.view.move({ offset: at.offset, horizontal }, layout.viewport, { rows: -Math.floor((layout.viewport.rows - 1) / 3) });
  return readerBodyPosition(document, layout, { offset: moved.offset, horizontal });
}

function matchesIn(matches: readonly ReaderSearchMatch[], start: number, end: number): number[] {
  let low = 0, high = matches.length;
  while (low < high) { const middle = (low + high) >>> 1; if (matches[middle]!.end <= start) low = middle + 1; else high = middle; }
  const found: number[] = [];
  for (let index = low; index < matches.length && matches[index]!.start < Math.max(end, start + 1); index++) found.push(index);
  return found;
}

function rowChunks(document: ReaderDocument, row: ReaderRow, viewStart: number, columns: number, color: string, theme: TuiTheme, matches: readonly ReaderSearchMatch[], selected: number): TextChunk[] {
  const ranges = matchesIn(matches, row.start, row.end).map(index => {
    const match = matches[index]!;
    const from = document.view.positionAt(Math.max(match.start, row.start)).horizontal - viewStart;
    const to = match.end >= row.end ? Infinity : document.view.positionAt(match.end).horizontal - viewStart;
    return { from, to, selected: index === selected };
  }).filter(range => range.to > 0 && range.from < columns);
  if (!ranges.length) return [fg(color)(row.text)];
  const chunks: TextChunk[] = [];
  let column = 0, text = "", style = 0;
  const flush = () => {
    if (!text) return;
    if (style === 0) chunks.push(fg(color)(text));
    else chunks.push(style === 2 ? bold(underline(bg(tint(theme, theme.accent))(fg(theme.text)(text)))) : underline(bg(theme.border)(fg(theme.text)(text))));
    text = "";
  };
  for (const { segment } of graphemes.segment(row.text)) {
    const range = ranges.find(candidate => column >= candidate.from && column < candidate.to);
    const next = range ? range.selected ? 2 : 1 : 0;
    if (next !== style) { flush(); style = next; }
    text += segment;
    column += Math.max(1, Bun.stringWidth(segment));
  }
  flush();
  return chunks;
}

function positionLabel(document: ReaderDocument, layout: ReaderLayout, rows: readonly ReaderRow[], horizontal: number, compact: boolean): string {
  if (!rows.length) return "";
  const offset = document.kind === "table" && document.bodyStart > 0 ? 2 : 0;
  const first = Math.max(1, rows[0]!.line - offset), last = Math.max(1, rows.at(-1)!.line - offset), total = Math.max(1, document.lineCount - offset);
  const vertical = compact ? `${first}–${last}/${total}` : `${document.kind === "table" && offset ? "Rows" : "Lines"} ${first}–${last} of ${total}`;
  if (layout.viewport.wrap) return vertical;
  if (document.aligned && document.columnStarts.length) {
    const starts = document.columnStarts;
    let left = 0, right = 0;
    starts.forEach((start, index) => { if (start <= horizontal) left = index; if (start < horizontal + layout.viewport.columns) right = index; });
    return compact ? `${vertical} · Col ${left + 1}–${right + 1}/${starts.length}` : `${vertical} · Columns ${left + 1}–${right + 1} of ${starts.length}`;
  }
  return horizontal > 0 ? `${vertical} · Col ${horizontal + 1}` : vertical;
}

/** Paint the reader panel exactly `rows` lines tall; rows and markers are presentation only and never copied. */
export function paintReader(input: {
  document: ReaderDocument; layout: ReaderLayout; position: ReaderPosition; columns: number; rows: number; theme: TuiTheme;
  search?: ReaderSearch;
}): StyledText {
  const { document, layout, theme, columns } = input;
  const position = readerBodyPosition(document, layout, input.position);
  const window = document.view.view(position, layout.viewport);
  const lines: TextChunk[][] = [];
  const result = input.search?.query ? document.view.search(input.search.query) : { matches: [], limited: false };
  const selected = input.search?.query ? input.search.selected : -1;
  if (layout.status.includes("approval")) {
    const approval = width("◌ Approval waiting · Esc review request") <= columns ? "◌ Approval waiting · Esc review request" : "◌ Approval · Esc review request";
    lines.push([bold(fg(theme.warning)(fitLine(approval, columns)))]);
  }
  if (layout.title) {
    const left = `Read ${document.kind}${document.kind === "code" && document.title !== "code" ? ` · ${document.title}` : ""}`;
    let right = positionLabel(document, layout, window.rows, position.horizontal, false);
    if (width(left) + 2 + width(right) > columns) right = positionLabel(document, layout, window.rows, position.horizontal, true);
    if (width(left) + 2 + width(right) > columns) right = "";
    const title = fitLine(left, right ? columns - width(right) - 2 : columns);
    lines.push([bold(fg(theme.text)(title)), fg(theme.muted)(right ? " ".repeat(Math.max(2, columns - width(title) - width(right))) + right : "")]);
  }
  for (const status of layout.status) {
    if (status === "snapshot") lines.push([fg(theme.accent)(fitLine("Snapshot · Esc back", columns))]);
    if (status === "truncated") lines.push([fg(theme.warning)(fitLine(`Showing first ${READER_SOURCE_LIMIT.toLocaleString("en-US")} characters · C copies this part`, columns))]);
    if (status === "table") lines.push([fg(theme.muted)(fitLine(document.aligned ? "Aligned columns · C copies Markdown source" : "Markdown source · C copy", columns))]);
  }
  const gutter = (row: ReaderRow | undefined) => layout.gutter ? [fg(theme.muted)(row && !row.continuation ? String(row.line).padStart(layout.gutter - 1) + " " : " ".repeat(layout.gutter))] : [];
  const paintRow = (row: ReaderRow, color: string, header = false) => {
    const viewStart = layout.viewport.wrap ? document.view.positionAt(row.start).horizontal : position.horizontal;
    const content = rowChunks(document, row, viewStart, layout.viewport.columns, color, theme, result.matches, selected);
    const pad = " ".repeat(Math.max(0, layout.viewport.columns - width(row.text)));
    lines.push([...gutter(row),
      ...(layout.markers ? [fg(theme.muted)(row.clippedLeft ? "‹" : " ")] : []),
      ...(header ? content.map(chunk => bold(chunk)) : content),
      ...(layout.markers && row.clippedRight ? [fg(theme.muted)(pad + "›")] : [])]);
  };
  if (layout.pinned) {
    const header = document.view.view({ offset: 0, horizontal: position.horizontal }, { ...layout.viewport, rows: 2 }).rows;
    header.forEach((row, index) => paintRow(row, index ? theme.muted : theme.text, index === 0));
  }
  for (const row of window.rows) paintRow(row, document.kind === "code" ? theme.code : theme.text);
  for (let index = window.rows.length; index < layout.viewport.rows; index++) lines.push([]);
  if (layout.search) {
    const query = fitLine(input.search?.query ?? "", Math.max(1, Math.floor(columns / 2)));
    const text = !input.search?.query ? "Find in this block · Type a query · Esc back"
      : result.matches.length ? `Find: ${query} · ${selected + 1}/${result.matches.length}${result.limited ? "+" : ""} · ↑↓ next · Enter keep · Esc restore`
      : `Find: ${query} · No matches · Esc restore`;
    lines.push([fg(theme.accent)(fitLine(text, columns))]);
  }
  return new StyledText(lines.flatMap((chunks, index) => index ? [fg(theme.muted)("\n"), ...chunks] : chunks));
}
