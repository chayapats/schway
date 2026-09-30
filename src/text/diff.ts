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

/** Count newline-separated lines, treating empty text as zero and excluding a final empty segment. */
export function countLines(text: string): number {
  if (!text) return 0;
  return countLineBreaks(text) + (text.endsWith("\n") ? 0 : 1);
}

/** Trim common context from stably sorted hunks, numbering deletions originally and additions after prior newline changes. */
export function buildEditDiff(hunks: readonly DiffHunk[]): TextDiff {
  const diff: TextDiff = { rows: [], added: 0, removed: 0 };
  let lineShift = 0;
  for (const hunk of [...hunks].sort((a, b) => a.startLine - b.startLine)) {
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
  }
  return diff;
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
