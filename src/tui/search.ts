import type { TuiTranscriptEntry } from "./controller.ts";
import { displayText, fitLine, toolPresentation } from "./presentation.ts";

/** One literal occurrence in the bounded text presented for a transcript row. */
export interface TranscriptSearchMatch {
  id: string;
  kind: TuiTranscriptEntry["kind"];
  offset: number;
}

/** A capped result set; limited means later displayed content was not searched. */
export interface TranscriptSearchResult {
  matches: readonly TranscriptSearchMatch[];
  limited: boolean;
}

const MAX_SEARCH_CHARS = 8_000_000;
const MAX_SEARCH_MATCHES = 20_000;

/** Return only the text available in a row's current display state, clipped to a search budget. */
export function transcriptSearchText(entry: TuiTranscriptEntry, expanded: boolean, width: number, maxChars = Infinity): string {
  if (entry.kind !== "tool") return displayText(entry.text.slice(0, maxChars));
  const tool = toolPresentation(entry, expanded);
  const suffix = ` · ${tool.state}`;
  const name = fitLine(entry.toolName ?? "tool", Math.max(1, width - Bun.stringWidth(suffix) - 5));
  const targetWidth = width - Bun.stringWidth(name + suffix) - 5;
  const target = targetWidth > 0 ? fitLine(tool.target, targetWidth) : "";
  return [name, target, tool.state, tool.detail].filter(Boolean).join("\n").slice(0, maxChars);
}

type CachedRow = {
  text: string;
  toolName?: string;
  toolSummary?: string;
  toolStatus?: TuiTranscriptEntry["toolStatus"];
  expanded: boolean;
  width: number;
  budget: number;
  matchBudget: number;
  sourceLength: number;
  limited: boolean;
  hits: readonly number[];
};

/** Keep unchanged rows indexed while live output or a search query changes. */
export class TranscriptSearchIndex {
  private rows = new Map<string, CachedRow>();
  private query = "";
  private result: TranscriptSearchResult = { matches: [], limited: false };

  /** Release cached display rows when a search closes or the branch changes. */
  clear(): void {
    this.rows.clear();
    this.query = "";
    this.result = { matches: [], limited: false };
  }

  /** Refresh bounded literal matches without revisiting unchanged row text. */
  update(entries: readonly TuiTranscriptEntry[], query: string, expanded: (id: string) => boolean, width: number): TranscriptSearchResult {
    const needle = query.normalize("NFC").toLocaleLowerCase();
    if (!needle) {
      this.query = "";
      this.rows.clear();
      this.result = { matches: [], limited: false };
      return this.result;
    }
    const queryChanged = needle !== this.query;
    if (queryChanged) this.query = needle;
    let changed = queryChanged || entries.length !== this.rows.size;
    if (!changed) {
      let index = 0;
      for (const id of this.rows.keys()) if (id !== entries[index++]?.id) { changed = true; break; }
    }
    const next = new Map<string, CachedRow>();
    let remaining = MAX_SEARCH_CHARS;
    let remainingMatches = MAX_SEARCH_MATCHES;
    let limited = false;
    for (const entry of entries) {
      if (remaining <= 0 || remainingMatches <= 0) { limited = true; break; }
      const isExpanded = expanded(entry.id);
      const previous = this.rows.get(entry.id);
      if (previous && !queryChanged && previous.text === entry.text && previous.toolName === entry.toolName &&
        previous.toolSummary === entry.toolSummary && previous.toolStatus === entry.toolStatus && previous.expanded === isExpanded && previous.width === width && previous.budget === remaining && previous.matchBudget === remainingMatches) {
        next.set(entry.id, previous);
        remaining -= previous.sourceLength;
        remainingMatches -= previous.hits.length;
        limited ||= previous.limited;
        if (previous.limited) break;
        continue;
      }
      changed = true;
      const source = transcriptSearchText(entry, isExpanded, width, remaining).normalize("NFC").toLocaleLowerCase();
      const sourceLimited = entry.kind === "tool" ? transcriptSearchText(entry, isExpanded, width).length > remaining : entry.text.length > remaining;
      const hits: number[] = [];
      let matchLimited = false;
      if (needle) for (let offset = 0; offset < source.length;) {
        const found = source.indexOf(needle, offset);
        if (found < 0) break;
        if (hits.length >= remainingMatches) { matchLimited = true; break; }
        hits.push(found);
        offset = found + Math.max(1, needle.length);
      }
      next.set(entry.id, { text: entry.text, toolName: entry.toolName, toolSummary: entry.toolSummary, toolStatus: entry.toolStatus, expanded: isExpanded, width, budget: remaining, matchBudget: remainingMatches, sourceLength: source.length, limited: sourceLimited || matchLimited, hits });
      remaining -= source.length;
      remainingMatches -= hits.length;
      limited ||= sourceLimited || matchLimited;
      if (sourceLimited || matchLimited) break;
    }
    this.rows = next;
    if (!changed) return this.result;
    const matches: TranscriptSearchMatch[] = [];
    for (const entry of entries) {
      const row = next.get(entry.id);
      if (!row) break;
      for (const offset of row.hits) matches.push({ id: entry.id, kind: entry.kind, offset });
      if (row.limited) break;
    }
    this.result = { matches, limited };
    return this.result;
  }
}
