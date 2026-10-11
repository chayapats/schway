import { wrappedRows } from "./approval-layout.ts";
import type { TuiSnapshot } from "./controller-types.ts";
import { wrapHintSegments } from "./hint-text.ts";
import { fitLine } from "./presentation.ts";

/** Empty endpoint field instruction; it is not a URL, so it cannot pass for a prefilled value. */
export const ENDPOINT_URL_PLACEHOLDER = "Paste or type a URL…";
/** Empty API-key field instruction; it avoids starting with the name of the Enter key. */
export const API_KEY_PLACEHOLDER = "Paste key…";
/** Empty browser-callback field instruction. */
export const CALLBACK_PLACEHOLDER = "Paste redirect URL or code…";

/** One sign-in typing surface as the composer shows it: a title row, the value or placeholder row, an optional field error and one key hint. */
export interface CredentialEntryPanel {
  /** Panel mode of the surface, matching the view's `PANEL_MODES` entry. */
  kind: "endpoint" | "credential" | "callback";
  /** Title row, such as `Endpoint URL` or `API key · OpenAI`. */
  title: string;
  /** Displayed value: the typed endpoint URL or the mask; empty while the field is empty. */
  value: string;
  /** Verb-first instruction ending in `…`, shown only while `value` is empty. */
  placeholder: string;
  /** Field-local validation message shown below the value row. */
  error?: string;
  /** Enter and Esc actions; the panel and the hint row show it whole and the compact status bar shows its Esc action. */
  hint: string;
}

/** Describe the open sign-in typing surface, or undefined when none is open; Esc is `back` only on the endpoint key step, which returns to the typed URL. */
export function credentialEntryPanel(snapshot: Pick<TuiSnapshot, "endpointUrlEntry" | "credentialEntry" | "loginCallbackEntry">): CredentialEntryPanel | undefined {
  const { endpointUrlEntry: endpoint, credentialEntry: key, loginCallbackEntry: callback } = snapshot;
  if (endpoint) return { kind: "endpoint", title: "Endpoint URL", value: endpoint.value, placeholder: ENDPOINT_URL_PLACEHOLDER,
    ...(endpoint.error ? { error: endpoint.error } : {}), hint: "Enter continue · Esc cancel" };
  if (key) return { kind: "credential", title: `API key · ${key.label}`, value: key.masked, placeholder: API_KEY_PLACEHOLDER,
    hint: `Enter save · Esc ${key.returnsToUrl ? "back" : "cancel"}` };
  if (callback) return { kind: "callback", title: "Browser callback", value: callback.masked, placeholder: CALLBACK_PLACEHOLDER, hint: "Enter sign in · Esc cancel" };
  return undefined;
}

/** The Esc action of an entry hint, such as `Esc cancel`, for the compact status bar. */
export function credentialEntryEscape(panel: CredentialEntryPanel): string {
  return panel.hint.slice(panel.hint.indexOf("Esc "));
}

/**
 * One-based terminal cell for the entry caret: right after the last displayed value cell, or at the value start while the field is empty.
 * `origin` is the zero-based screen cell of the value row and `lineWidths` the wrapped row widths of the displayed value, so the caret
 * reveals nothing beyond what the frame already shows.
 */
export function credentialCaretCell(origin: { x: number; y: number }, lineWidths: readonly number[], empty: boolean): { x: number; y: number } {
  const last = empty ? 0 : Math.max(0, lineWidths.length - 1);
  return { x: origin.x + (empty ? 0 : lineWidths[last] ?? 0) + 1, y: origin.y + last + 1 };
}

const graphemes = (text: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(part => part.segment);

/** Rows that character wrapping at `columns` takes for graphemes of these cell widths; a grapheme that does not fit moves to the next row. */
function charRows(cells: readonly number[], columns: number): number {
  let rows = 1, column = 0;
  for (const width of cells) {
    if (column > 0 && column + width > columns) { rows++; column = 0; }
    column += width;
  }
  return rows;
}

/** Fit a displayed value into `rows` character-wrapped rows of `columns` cells; a longer value keeps its end, where the caret sits, behind a leading `…`. */
export function fitEntryValue(value: string, columns: number, rows: number): string {
  // Rows are counted as the renderer wraps them, so a wide grapheme that skips a row's last cell costs that cell.
  // A pasted line break or tab would add rows the bound cannot see, so the field shows it as a space.
  const line = value.replace(/[\t\n\r]/g, " ");
  const width = Math.max(1, columns), limit = Math.max(1, rows), room = width * limit;
  if (Bun.stringWidth(line) <= width) return line;
  const parts = graphemes(line), cells = parts.map(part => Bun.stringWidth(part));
  if (Bun.stringWidth(line) <= room && charRows(cells, width) <= limit) return line;
  // Take the tail that fills the cells behind `…`, then drop leading graphemes until the wrapped rows fit.
  let start = parts.length, used = 1;
  while (start > 0 && used + cells[start - 1]! <= room) used += cells[--start]!;
  while (start < parts.length - 1 && charRows([1, ...cells.slice(start)], width) > limit) start++;
  return `…${parts.slice(start).join("")}`;
}

/** One entry panel as the composer shows it: each text is final, and an empty title or error takes no row. */
export interface CredentialEntryLayout {
  /** Title text, whole, shortened to one row, or empty. */
  title: string;
  /** Fitted value, or the placeholder while the field is empty. */
  value: string;
  /** Error text, whole, shortened to its leading sentences on one row, or empty. */
  error: string;
  /** Hint rows joined by line breaks, broken only at ` · `; never shortened. */
  hint: string;
}

/** Leading ` · ` sentences of an error that fit one row, or its first sentence shortened with `…`. */
function errorRow(error: string, columns: number): string {
  const sentences = error.split(" · ");
  for (let count = sentences.length; count > 0; count--) {
    const row = sentences.slice(0, count).join(" · ");
    if (Bun.stringWidth(row) <= columns) return row;
  }
  return fitLine(sentences[0]!, columns);
}

/** Fit an entry panel into `rows` rows of `columns` cells with at most `maxValueRows` value rows, always keeping the whole hint and one value row. */
export function fitCredentialEntry(panel: CredentialEntryPanel, columns: number, rows: number, maxValueRows: number): CredentialEntryLayout {
  // When rows run short the panel gives up extra value rows first, then the error's wrapped rows (it keeps its leading
  // sentences on one row), then the title's wrapped rows (it shortens to one row), then the title, then the error.
  const hintRows = wrapHintSegments(panel.hint, columns);
  // The value row keeps one spare cell so a caret after a full row stays inside the panel.
  const valueColumns = Math.max(1, columns - 1);
  const shown = panel.value.replace(/[\t\n\r]/g, " ") || panel.placeholder;
  const valueNeed = charRows(graphemes(shown).map(part => Bun.stringWidth(part)), valueColumns);
  const cap = Math.max(1, Math.min(maxValueRows, valueNeed));
  const left = rows - hintRows.length - 1;
  const title = { whole: panel.title, rows: wrappedRows(panel.title, columns) };
  const error = panel.error ? { whole: panel.error, rows: wrappedRows(panel.error, columns) } : { whole: "", rows: 0 };
  const short = { title: fitLine(panel.title, columns), error: panel.error ? errorRow(panel.error, columns) : "" };
  const shortErrorRows = short.error ? 1 : 0;
  const choices: [string, number, string, number][] = [
    [title.whole, title.rows, error.whole, error.rows],
    [title.whole, title.rows, short.error, shortErrorRows],
    [short.title, 1, short.error, shortErrorRows],
    ["", 0, short.error, shortErrorRows],
  ];
  const [titleText, titleRows, errorText, errorRows] = choices.find(([, titleRows, , errorRows]) => titleRows + errorRows <= left) ?? ["", 0, "", 0];
  const valueRows = Math.min(cap, 1 + Math.max(0, left - titleRows - errorRows));
  const value = panel.value ? fitEntryValue(panel.value, valueColumns, valueRows) : valueNeed <= valueRows ? panel.placeholder : fitLine(panel.placeholder, valueColumns);
  return { title: titleText, value, error: errorText, hint: hintRows.join("\n") };
}
