import type { GitFileChange, GitPathState } from "../workspace/git.ts";
import type { TurnOutcome } from "./controller-types.ts";

/** Evidence that supplied a review's file list: a retained live turn, or Git status of the current working tree. */
export type ReviewScope = { kind: "turn"; turn: number } | { kind: "workspace" };

/** One path Git reports as changed now, with a short current state word; never historical turn evidence. */
export interface WorkspaceReviewFile {
  path: string;
  source: "git";
  state: string;
}

/** Heading of the read-only review that lists current Git changes when no live turn record is held. */
export const WORKSPACE_REVIEW_HEADING = "Review · current changes";

/** Visible title of a review file list, naming the record its paths and counts came from. */
export function reviewFilesLabel(scope: ReviewScope): string {
  return scope.kind === "workspace" ? "Current working tree" : `Files from turn ${scope.turn}`;
}

/** Placeholder file-list row when a scope has no paths, worded so a clean tree never implies no earlier edits. */
export function emptyFilesLabel(scope: ReviewScope): string {
  return scope.kind === "workspace" ? "None listed" : "None observed";
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
  return scope.kind === "workspace" ? "Current changes details" : `Turn ${scope.turn} details`;
}

/** Badge beside any listed review path: turn evidence for turn files, the current Git state for workspace files. */
export function reviewFileBadge(file: TurnOutcome["files"][number] | WorkspaceReviewFile): string {
  return file.source === "git" ? file.state : turnFileBadge(file);
}

/** Short current Git state word for one status entry, matching the comparison labels the current diff shows. */
export function gitFileState(change: GitFileChange): string {
  if (change.untracked) return "untracked";
  if (change.staged === "U" || change.unstaged === "U" || (change.staged === "A" && change.unstaged === "A") || (change.staged === "D" && change.unstaged === "D")) return "conflict";
  if (change.staged === "D" || change.unstaged === "D") return "deleted";
  if (change.staged === "R" || change.staged === "C") return "renamed";
  if (change.staged !== "." && change.unstaged !== ".") return "partly staged";
  return change.staged !== "." ? "staged" : "unstaged";
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

/** Current-changes rows shown instead of a file list when the working tree cannot be read, each naming its next action. */
export const WORKSPACE_REVIEW_STATES = {
  loading: "Loading current changes…",
  off: ["Change tracking is off · /config set git {\"changeTracking\":\"on-demand\"} enable", "No Git state was read. Esc back"],
  noWorkspace: ["No workspace active · Esc back", "Restart Schway in a workspace to review changes."],
  nonGit: ["Not a Git workspace · Esc back", "Current changes need Git. Coding and undo still work."],
  clean: ["No current changes · Esc back", "The working tree matches HEAD. Earlier turns may have changed files that were since committed or reverted."],
} as const;

/** Rows for a primary workspace directory that is missing or unreadable, naming the path and the reload action. */
export function workspaceUnavailableRows(root: string): string[] {
  return ["Workspace unavailable · Ctrl+R reload", `Restore ${root}, then reload.`];
}

/** Rows for a Git status read that failed, keeping the bounded Git error below the status. */
export function workspaceFailedRows(error: string): string[] {
  return ["Current changes unavailable · Ctrl+R reload", error];
}

/** Details for current changes: why turn details are absent, the live workspace identity, then the scope notes. */
export function workspaceReviewDetails(identity: { root?: string; branch?: string; detached?: boolean; shown?: number; total?: number }): string {
  return [
    "Previous turn details unavailable",
    "No live turn record is held, so this review shows the current working tree instead. Schway keeps file-tool counts, snapshots, elapsed time and command exits only in memory for the latest turn of this run. After restart, resume or a session or branch switch it cannot show what an earlier turn changed, and it does not rebuild that from saved conversation text.",
    "",
    ...(identity.root === undefined ? [] : [`Workspace: ${identity.root}`]),
    ...(identity.detached ? ["Branch: detached HEAD"] : identity.branch === undefined ? [] : [`Branch: ${identity.branch}`]),
    ...(identity.total !== undefined && identity.shown !== undefined && identity.total > identity.shown ? [`Showing the first ${identity.shown} of ${identity.total} changed paths. /changes status lists the counts.`] : []),
    ...(identity.root === undefined && identity.branch === undefined && !identity.detached ? [] : [""]),
    reviewScopeDetails({ kind: "workspace" }),
  ].join("\n");
}

/** Details caveats separating observed turn evidence from current Git content; primary UI keeps only the short labels. */
export function reviewScopeDetails(scope: ReviewScope): string {
  if (scope.kind === "workspace") return [
    "Review scope:",
    `${reviewFilesLabel(scope)}: paths Git reports as staged, unstaged or untracked when review opens or Ctrl+R reloads. They can include edits from earlier turns, other tools and people, and omit changes that were committed or reverted. The state beside each path is current Git state, not authorship.`,
    "Current diff is read from Git when review opens, when you select a file and when Ctrl+R reloads. It does not update live and is never the exact patch of a resumed turn.",
    "Unstaged compares the index with the worktree. Staged compares HEAD, or the empty tree before the first commit, with the index. Untracked shows the current file.",
  ].join("\n");
  return [
    "Review scope:",
    `${reviewFilesLabel(scope)}: paths observed during that turn from successful file-tool records and before/after Git snapshots. It is not a record of exclusive authorship.`,
    "Line counts add up every file-tool edit observed in the turn, so repeated edits can exceed the net current diff. A blank or ? count is unknown.",
    "Paths marked detected changed between the turn's snapshots without a matching file-tool record. The marker does not identify which command or process changed them.",
    "Current diff is read from Git when review opens, when you select a file and when Ctrl+R reloads. It does not update live and can include earlier, later or external edits.",
    "Unstaged compares the index with the worktree. Staged compares HEAD, or the empty tree before the first commit, with the index. Untracked shows the current file.",
  ].join("\n");
}
