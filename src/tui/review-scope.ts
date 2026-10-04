import type { GitPathState } from "../workspace/git.ts";
import type { TurnOutcome } from "./controller-types.ts";

/** Evidence that supplied a review's file list; turn evidence is the only scope today. */
export type ReviewScope = { kind: "turn"; turn: number };

/** Visible title of a review file list, naming the record its paths and counts came from. */
export function reviewFilesLabel(scope: ReviewScope): string {
  return `Files from turn ${scope.turn}`;
}

/** Visible title of content read from Git on request, which is never a historical patch. */
export function currentDiffLabel(path?: string): string {
  return path === undefined ? "Current diff" : `Current diff · ${path}`;
}

/** Fit a display path to `columns` cells by dropping leading graphemes behind `…`, keeping the file name visible. */
export function fitPathStart(path: string, columns: number): string {
  const line = path.replace(/\s+/g, " ");
  if (columns <= 0) return "";
  if (Bun.stringWidth(line) <= columns) return line;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line)].map(part => part.segment);
  let tail = "", width = 0;
  for (let index = graphemes.length - 1; index >= 0; index--) {
    const next = Bun.stringWidth(graphemes[index]!);
    if (width + next > columns - 1) break;
    tail = graphemes[index]! + tail;
    width += next;
  }
  return `…${tail}`;
}

/** Visible title while Details replaces the current diff, so turn evidence is never labelled as Git content. */
export function reviewDetailsLabel(scope: ReviewScope): string {
  return `Turn ${scope.turn} details`;
}

/** Turn evidence beside one listed path: observed tool-edit counts, `?` for an unknown side, or a snapshot marker. */
export function turnFileBadge(file: TurnOutcome["files"][number]): string {
  if (file.source === "shell") return "detected";
  if (file.added === undefined && file.removed === undefined) return "";
  return `+${file.added ?? "?"} −${file.removed ?? "?"}`;
}

/** First current-diff row for a path seen by a Git snapshot rather than a file-tool record. */
export const DETECTED_FILE_NOTE = "Found by Git snapshot · not undoable";

/** Placeholder current-diff row while a newer Git read is pending, so earlier content never looks live. */
export const LOADING_CURRENT_DIFF = "Loading current diff…";

/** Current-diff row for a Git read that failed, offering the reload action. */
export const CURRENT_DIFF_FAILED = "Current diff unavailable · Ctrl+R reload";

/** Short current-diff explanation for a listed path that has no current Git comparison section. */
export function pathStateNote(state: GitPathState): string {
  switch (state) {
    case "clean": return "No current changes · file matches HEAD";
    case "missing": return "File not found · nothing to compare";
    case "ignored": return "Ignored by Git · content not shown";
    case "outside": return "Outside the Git repository · no diff";
    case "unavailable": return CURRENT_DIFF_FAILED;
  }
}

/** Details caveats separating observed turn evidence from current Git content; primary UI keeps only the short labels. */
export function reviewScopeDetails(scope: ReviewScope): string {
  return [
    "Review scope:",
    `${reviewFilesLabel(scope)}: paths observed during that turn from successful file-tool records and before/after Git snapshots. It is not a record of exclusive authorship.`,
    "Line counts add up every file-tool edit observed in the turn, so repeated edits can exceed the net current diff. A blank or ? count is unknown.",
    "Paths marked detected changed between the turn's snapshots without a matching file-tool record. The marker does not identify which command or process changed them.",
    "Current diff is read from Git when review opens, when you select a file and when Ctrl+R reloads. It does not update live and can include earlier, later or external edits.",
    "Unstaged compares the index with the worktree. Staged compares HEAD, or the empty tree before the first commit, with the index. Untracked shows the current file.",
  ].join("\n");
}
