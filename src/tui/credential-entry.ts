import type { TuiSnapshot } from "./controller-types.ts";

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

/** Fit a displayed value into `rows` rows of `columns` cells; a longer value keeps its end, where the caret sits, behind a leading `…`. */
export function fitEntryValue(value: string, columns: number, rows: number): string {
  // A pasted line break or tab would add rows the bound cannot see, so the field shows it as a space.
  const line = value.replace(/[\t\n\r]/g, " ");
  const room = Math.max(1, columns) * Math.max(1, rows);
  if (Bun.stringWidth(line) <= room) return line;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line)].map(part => part.segment);
  let tail = "", width = 0;
  for (let index = graphemes.length - 1; index >= 0; index--) {
    const next = Bun.stringWidth(graphemes[index]!);
    if (width + next > room - 1) break;
    tail = graphemes[index] + tail; width += next;
  }
  return `…${tail}`;
}
