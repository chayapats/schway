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

/** Number Git patch hunks or bounded raw untracked source without interpreting CLI explanation prose. */
export function parseGitDiff(preview: { diff: string; truncated: boolean; binaryFiles: readonly string[]; untrackedContent?: string }, options: { includePaths?: boolean; includeSections?: boolean } = {}): GitDiffRow[] {
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

/** Compare whole-file text as numbered deletion and addition rows, excluding common edge context. */
export function diffLines(oldText: string, newText: string): TextDiff {
  return buildEditDiff([{ startLine: 1, oldText, newText }]);
}
