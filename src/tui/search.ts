import type { TuiTranscriptEntry } from "./controller.ts";

/** One transcript row split into the text blocks actually presented by the renderer. */
export interface TranscriptSearchRow {
  id: string;
  kind: TuiTranscriptEntry["kind"];
  segments: readonly string[];
}

/** One literal occurrence in a visible text block of an active-branch row. */
export interface TranscriptSearchMatch {
  id: string;
  kind: TuiTranscriptEntry["kind"];
  segment: number;
  offset: number;
}

/** A capped result set; limited means later displayed content was not searched. */
export interface TranscriptSearchResult {
  matches: readonly TranscriptSearchMatch[];
  limited: boolean;
}

const MAX_SEARCH_CHARS = 8_000_000;
const MAX_SEARCH_MATCHES = 20_000;

/** Map a folded search offset to its source character in NFC rendered text. */
export function renderedOffsetForFolded(text: string, foldedOffset: number): number {
  const normalized = text.normalize("NFC");
  if (normalized.toLocaleLowerCase().length === normalized.length) return Math.min(foldedOffset, normalized.length);
  let folded = 0;
  let rendered = 0;
  for (const character of normalized) {
    const next = folded + character.toLocaleLowerCase().length;
    if (foldedOffset < next) return rendered;
    folded = next;
    rendered += character.length;
  }
  return rendered;
}

type CachedRow = {
  segments: readonly string[];
  budget: number;
  matchBudget: number;
  sourceLength: number;
  limited: boolean;
  hits: readonly { segment: number; offset: number }[];
};

/** Keep unchanged rendered rows indexed while live output or a query changes. */
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

  /** Refresh capped literal matches without rescanning unchanged text blocks. */
  update(entries: readonly TranscriptSearchRow[], query: string): TranscriptSearchResult {
    const needle = query.normalize("NFC").toLocaleLowerCase();
    if (!needle) {
      this.clear();
      return this.result;
    }
    const queryChanged = needle !== this.query;
    this.query = needle;
    let changed = queryChanged || entries.length !== this.rows.size;
    if (!changed) {
      let index = 0;
      for (const id of this.rows.keys()) if (id !== entries[index++]?.id) { changed = true; break; }
    }
    const next = new Map<string, CachedRow>();
    let remainingChars = MAX_SEARCH_CHARS;
    let remainingMatches = MAX_SEARCH_MATCHES;
    let limited = false;
    for (const entry of entries) {
      if (remainingChars <= 0 || remainingMatches <= 0) { limited = true; break; }
      const previous = this.rows.get(entry.id);
      if (previous && !queryChanged && previous.budget === remainingChars && previous.matchBudget === remainingMatches &&
        previous.segments.length === entry.segments.length && previous.segments.every((text, index) => text === entry.segments[index])) {
        next.set(entry.id, previous);
        remainingChars -= previous.sourceLength;
        remainingMatches -= previous.hits.length;
        limited ||= previous.limited;
        if (previous.limited) break;
        continue;
      }
      changed = true;
      const budget = remainingChars;
      const matchBudget = remainingMatches;
      const hits: { segment: number; offset: number }[] = [];
      let rowLimited = false;
      for (const [segment, text] of entry.segments.entries()) {
        if (remainingChars <= 0 || remainingMatches <= 0) { rowLimited = true; break; }
        const clipped = text.slice(0, remainingChars);
        const source = clipped.normalize("NFC").toLocaleLowerCase();
        for (let offset = 0; offset < source.length;) {
          const found = source.indexOf(needle, offset);
          if (found < 0) break;
          if (remainingMatches <= 0) { rowLimited = true; break; }
          hits.push({ segment, offset: found });
          remainingMatches--;
          offset = found + Math.max(1, needle.length);
        }
        remainingChars -= source.length;
        if (text.length > clipped.length || rowLimited) { rowLimited = true; break; }
      }
      next.set(entry.id, { segments: entry.segments, budget, matchBudget, sourceLength: budget - remainingChars, limited: rowLimited, hits });
      limited ||= rowLimited;
      if (rowLimited) break;
    }
    this.rows = next;
    if (!changed) return this.result;
    const matches: TranscriptSearchMatch[] = [];
    for (const entry of entries) {
      const row = next.get(entry.id);
      if (!row) break;
      for (const hit of row.hits) matches.push({ id: entry.id, kind: entry.kind, ...hit });
      if (row.limited) break;
    }
    this.result = { matches, limited };
    return this.result;
  }
}
