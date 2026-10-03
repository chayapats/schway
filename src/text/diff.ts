/** Exact replacement text with its one-based starting line in the original file. */
export interface DiffHunk {
  startLine: number;
  oldText: string;
  newText: string;
}

/** Changed text on an original deletion line or an edited-file addition line. */
export interface DiffRow {
  sign: "+" | "-";
  line: number;
  text: string;
}

/** Unbounded changed rows with totals that exclude common leading and trailing context. */
export interface TextDiff {
  rows: DiffRow[];
  added: number;
  removed: number;
}

/** A numbered Git patch row or a plain-language explanation without Git metadata. */
export interface GitDiffRow {
  sign: "+" | "-" | " ";
  line?: number;
  text: string;
}

/** Current Git comparison chosen by its command, never inferred from patch or source text. */
export type GitDiffComparison = "index-to-worktree" | "head-to-index" | "empty-to-index" | "untracked";

/** Bounded raw patch or untracked source with separate truncation and binary evidence. */
export interface GitDiffSource {
  diff: string;
  truncated: boolean;
  binaryFiles: readonly string[];
  untrackedContent?: string;
}

/** One current comparison with command-owned scope and bounded, unsanitized source for caller redaction. */
export interface GitDiffSection extends GitDiffSource {
  comparison: GitDiffComparison;
}

/** Number Git patch hunks or bounded raw untracked source without interpreting CLI explanation prose. */
export function parseGitDiff(preview: GitDiffSource & { sections?: readonly GitDiffSection[] }, options: { includePaths?: boolean; includeSections?: boolean; includeComparisons?: boolean } = {}): GitDiffRow[] {
  if (options.includeComparisons && preview.sections?.length) {
    const labels: Record<GitDiffComparison, string> = {
      "index-to-worktree": "Unstaged · index → worktree",
      "head-to-index": "Staged · HEAD → index",
      "empty-to-index": "Staged · empty tree → index",
      untracked: "Untracked · current file",
    };
    return preview.sections.flatMap(section => [
      { sign: " " as const, text: labels[section.comparison] },
      ...parseGitDiff(section, { includePaths: options.includePaths }),
    ]);
  }
  const rows: GitDiffRow[] = [];
  const explain = (text: string) => rows.push({ sign: " ", text });
  if (preview.untrackedContent !== undefined) {
    for (const [index, text] of splitLines(preview.untrackedContent).entries()) rows.push({ sign: "+", line: index + 1, text });
  } else {
    let oldLine = 0, newLine = 0, oldRemaining = 0, newRemaining = 0, renamedFrom: string | undefined, oldPath = "";
    const headerPath = (value: string) => value.replace(/^(["']?)[abiw]\//, "$1").replace(/\t$/, "");
    for (const text of preview.diff.split("\n")) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
      if (hunk) { oldLine = Number(hunk[1]); oldRemaining = Number(hunk[2] ?? 1); newLine = Number(hunk[3]); newRemaining = Number(hunk[4] ?? 1); continue; }
      if (oldRemaining > 0 || newRemaining > 0) {
        if (text.startsWith("-")) { rows.push({ sign: "-", line: oldLine++, text: text.slice(1) }); oldRemaining--; continue; }
        if (text.startsWith("+")) { rows.push({ sign: "+", line: newLine++, text: text.slice(1) }); newRemaining--; continue; }
        if (text.startsWith(" ")) { rows.push({ sign: " ", line: newLine++, text: text.slice(1) }); oldLine++; oldRemaining--; newRemaining--; continue; }
      }
      if (options.includePaths) {
        // Path headers occur outside hunks; literal source rows above remain untouched.
        if (text.startsWith("--- ")) oldPath = headerPath(text.slice(4));
        if (text.startsWith("+++ ")) explain(`File: ${text.slice(4) === "/dev/null" ? oldPath : headerPath(text.slice(4))}`);

      }
      if (options.includeSections && (text === "Unstaged:" || text === "Staged:")) explain(text === "Staged:" ? "Staged changes" : "Unstaged changes");
      if (text.startsWith("deleted file mode ")) explain("File deleted");
      if (text.startsWith("rename from ")) renamedFrom = text.slice("rename from ".length);
      if (text.startsWith("rename to ")) { explain(`Renamed from ${renamedFrom ?? "previous path"} to ${text.slice("rename to ".length)}`); renamedFrom = undefined; }
      if (/^(diff --git |Unstaged:|Staged:)/.test(text)) { oldRemaining = 0; newRemaining = 0; }
    }
  }
  if (preview.binaryFiles.length) explain("Binary file · content not shown");
  if (preview.truncated) explain("Preview truncated · use git diff for full content");
  if (!rows.length) explain("No textual diff");
  return rows;
}

/** Count newline-separated lines, treating empty text as zero and excluding a final empty segment. */
export function countLines(text: string): number {
  if (!text) return 0;
  return countLineBreaks(text) + (text.endsWith("\n") ? 0 : 1);
}

/** Trim common context from stably sorted hunks, numbering deletions originally and additions after prior newline changes. */
export function buildEditDiff(hunks: readonly DiffHunk[]): TextDiff {
  const diff: TextDiff = { rows: [], added: 0, removed: 0 };
  for (const hunk of buildEditDiffHunks(hunks)) {
    for (const row of hunk.rows) diff.rows.push(row);
    diff.added += hunk.added;
    diff.removed += hunk.removed;
  }
  return diff;
}

/** Return one trimmed diff per stably sorted hunk, retaining full prior newline shifts for callers that bound individual groups. */
export function buildEditDiffHunks(hunks: readonly DiffHunk[]): TextDiff[] {
  const diffs: TextDiff[] = [];
  let lineShift = 0;
  for (const hunk of [...hunks].sort((a, b) => a.startLine - b.startLine)) {
    const diff: TextDiff = { rows: [], added: 0, removed: 0 };
    const oldLines = splitLines(hunk.oldText);
    const newLines = splitLines(hunk.newText);
    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
      prefix++;
    }
    let oldEnd = oldLines.length;
    let newEnd = newLines.length;
    while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
    for (let index = prefix; index < oldEnd; index++) {
      diff.rows.push({ sign: "-", line: hunk.startLine + index, text: oldLines[index]! });
    }
    for (let index = prefix; index < newEnd; index++) {
      diff.rows.push({ sign: "+", line: hunk.startLine + lineShift + index, text: newLines[index]! });
    }
    diff.removed += oldEnd - prefix;
    diff.added += newEnd - prefix;
    lineShift += countLineBreaks(hunk.newText) - countLineBreaks(hunk.oldText);
    diffs.push(diff);
  }
  return diffs;
}

/** Split recorded text without inventing a row for empty text or a trailing newline. */
function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

/** Count newline characters that shift later exact-substring replacements. */
function countLineBreaks(text: string): number {
  let count = 0;
  for (const character of text) {
    if (character === "\n") count++;
  }
  return count;
}

/** Compare whole-file lines, preserving newline identity and omitting unchanged rows with linear working memory. */
export function diffLines(oldText: string, newText: string): TextDiff {
  // Include the terminator in equality, but keep the existing row display shape.
  const oldLines = oldText.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const newLines = newText.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const diff: TextDiff = { rows: [], added: 0, removed: 0 };
  const pending = [[0, oldLines.length, 0, newLines.length]];
  /** Append changed lines with original-side numbering and matching addition or deletion totals. */
  const emit = (sign: "+" | "-", lines: string[], start: number, end: number) => {
    for (let index = start; index < end; index++) {
      const text = lines[index]!;
      diff.rows.push({ sign, line: index + 1, text: text.endsWith("\n") ? text.slice(0, -1) : text });
    }
    if (sign === "+") diff.added += end - start;
    else diff.removed += end - start;
  };
  while (pending.length) {
    let [oldStart, oldEnd, newStart, newEnd] = pending.pop()! as [number, number, number, number];
    while (oldStart < oldEnd && newStart < newEnd && oldLines[oldStart] === newLines[newStart]) { oldStart++; newStart++; }
    while (oldStart < oldEnd && newStart < newEnd && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
    if (oldStart === oldEnd) { emit("+", newLines, newStart, newEnd); continue; }
    if (newStart === newEnd) { emit("-", oldLines, oldStart, oldEnd); continue; }
    // Completely unrelated files need no edit-distance search.
    const candidates = new Set(oldLines.slice(oldStart, oldEnd));
    const shared = newLines.slice(newStart, newEnd).some(line => candidates.has(line));
    const split = shared ? bisectLines(oldLines, newLines, oldStart, oldEnd, newStart, newEnd) : undefined;
    if (!split || (split[0] === oldStart && split[1] === newStart) || (split[0] === oldEnd && split[1] === newEnd)) {
      emit("-", oldLines, oldStart, oldEnd); emit("+", newLines, newStart, newEnd);
    } else {
      pending.push([split[0], oldEnd, split[1], newEnd], [oldStart, split[0], newStart, split[1]]);
    }
  }
  return diff;
}

/** Find the middle of a shortest edit path using two Myers frontiers rather than a quadratic trace. */
function bisectLines(oldLines: string[], newLines: string[], oldStart: number, oldEnd: number, newStart: number, newEnd: number): [number, number] | undefined {
  const n = oldEnd - oldStart, m = newEnd - newStart;
  const limit = Math.ceil((n + m) / 2), offset = limit + 1;
  const forward = new Int32Array(2 * limit + 3).fill(-1), backward = new Int32Array(2 * limit + 3).fill(-1);
  forward[offset + 1] = backward[offset + 1] = 0;
  const delta = n - m, odd = delta % 2 !== 0;
  let forwardStart = 0, forwardEnd = 0, backwardStart = 0, backwardEnd = 0;
  for (let distance = 0; distance <= limit; distance++) {
    for (let k = -distance + forwardStart; k <= distance - forwardEnd; k += 2) {
      const index = offset + k;
      let x = k === -distance || (k !== distance && forward[index - 1]! < forward[index + 1]!) ? forward[index + 1]! : forward[index - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && oldLines[oldStart + x] === newLines[newStart + y]) { x++; y++; }
      forward[index] = x;
      if (x > n) forwardEnd += 2;
      else if (y > m) forwardStart += 2;
      else if (odd) {
        const opposite = offset + delta - k;
        if (opposite >= 0 && opposite < backward.length && backward[opposite]! !== -1 && x >= n - backward[opposite]!) return [oldStart + x, newStart + y];
      }
    }
    for (let k = -distance + backwardStart; k <= distance - backwardEnd; k += 2) {
      const index = offset + k;
      let x = k === -distance || (k !== distance && backward[index - 1]! < backward[index + 1]!) ? backward[index + 1]! : backward[index - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && oldLines[oldEnd - x - 1] === newLines[newEnd - y - 1]) { x++; y++; }
      backward[index] = x;
      if (x > n) backwardEnd += 2;
      else if (y > m) backwardStart += 2;
      else if (!odd) {
        const opposite = offset + delta - k;
        if (opposite >= 0 && opposite < forward.length && forward[opposite]! !== -1 && forward[opposite]! >= n - x) {
          const middle = forward[opposite]!;
          return [oldStart + middle, newStart + middle - (delta - k)];
        }
      }
    }
  }
  return undefined;
}
