import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Change-tracking mode for observational Git inspection without managing commits or branches. */
export type GitChangeTrackingMode = "off" | "on-demand" | "snapshot";

/** Valid change-tracking modes in display order. */
export const GIT_CHANGE_TRACKING_MODES: readonly GitChangeTrackingMode[] = ["off", "on-demand", "snapshot"] as const;

/** Default mode that reads repository state only on explicit inspection. */
export const DEFAULT_GIT_CHANGE_TRACKING: GitChangeTrackingMode = "on-demand";

/** Maximum files shown in a formatted status or comparison before truncation. */
export const MAX_GIT_DISPLAY_FILES = 50;

/** Maximum entries retained in one snapshot before truncation. */
export const MAX_GIT_SNAPSHOT_FILES = 200;

/** Maximum characters shown in a diff preview before truncation. */
export const MAX_GIT_DIFF_CHARS = 8000;

/** True when the value names a supported change-tracking mode. */
export function isGitChangeTrackingMode(value: unknown): value is GitChangeTrackingMode {
  return value === "off" || value === "on-demand" || value === "snapshot";
}

/** Validate a raw config value as a change-tracking mode with a named error. */
export function parseGitChangeTracking(value: unknown): GitChangeTrackingMode | { error: string } {
  if (isGitChangeTrackingMode(value)) return value;
  return { error: `Invalid git.changeTracking ${JSON.stringify(value)}. Valid modes: off, on-demand, snapshot.` };
}

/** One tracked path with staged/unstaged states, rename origin, and binary marking. */
export interface GitFileChange {
  path: string;
  origPath?: string;
  staged: string;
  unstaged: string;
  untracked: boolean;
  binary: boolean;
}

/** Observational repository state for branch, HEAD, dirty state, and bounded file inspection. */
export type GitStatusSummary =
  | {
    isGit: true;
    root: string;
    branch?: string;
    detached: boolean;
    head: string;
    dirty: boolean;
    stagedCount: number;
    unstagedCount: number;
    untrackedCount: number;
    files: GitFileChange[];
    totalFiles: number;
    truncated: boolean;
  }
  | { isGit: false; root: string };

/** One snapshot entry with content hashes sufficient to compare before/after working state. */
export interface GitSnapshotEntry {
  path: string;
  origPath?: string;
  staged: string;
  unstaged: string;
  untracked: boolean;
  binary: boolean;
  worktreeHash?: string;
  indexHash?: string;
  headHash?: string;
}

/** Retained before/after working state for one turn with a valid identity and root. */
export interface GitSnapshot {
  id: string;
  capturedAt: string;
  root: string;
  branch?: string;
  detached: boolean;
  head: string;
  entries: GitSnapshotEntry[];
  totalFiles: number;
  truncated: boolean;
}

/** Structured turn comparison distinguishing pre-existing dirt from new turn changes. */
export interface GitTurnComparison {
  beforeId: string;
  afterId: string;
  preExistingUnchanged: string[];
  updatedPreExisting: string[];
  newChanges: string[];
  resolved?: string[];
  truncated: boolean;
}

/** Bounded diff preview with explicit truncation and a follow-up hint. */
export interface GitDiffPreview {
  path?: string;
  diff: string;
  truncated: boolean;
  binaryFiles: string[];
}


/**
 * Return the nearest ancestor containing a stat-able `.git` entry, or undefined when none is found.
 * Starts at the supplied directory without canonicalizing it; failed filesystem probes are skipped.
 */
export async function findGitRoot(start: string): Promise<string | undefined> {
  let dir = start;
  while (true) {
    try {
      await stat(join(dir, ".git"));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) {
        return undefined;
      }
      dir = parent;
    }
  }
}

/** Run one observational Git command without touching index, HEAD, branches, or config. */
async function runGit(root: string, args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", "--no-pager", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", PAGER: "cat" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text().catch(() => ""), proc.stderr.text().catch(() => ""), proc.exited]);
  return { exitCode, stdout, stderr };
}

interface ParsedStatus {
  branch?: string;
  detached: boolean;
  head: string;
  files: Array<{ path: string; origPath?: string; staged: string; unstaged: string; untracked: boolean; indexHash?: string; headHash?: string }>;
}

/** Parse NUL-separated porcelain v2 records into branch, HEAD, and per-file staged states. */
function parsePorcelainV2(output: string): ParsedStatus {
  let branch: string | undefined;
  let detached = false;
  let head = "";
  const files: ParsedStatus["files"] = [];
  const records = output.split("\0");
  for (const record of records) {
    if (!record) continue;
    if (record.startsWith("# branch.head ")) {
      const name = record.slice("# branch.head ".length).trim();
      if (name === "(detached)") {
        detached = true;
        branch = undefined;
      } else {
        detached = false;
        branch = name;
      }
      continue;
    }
    if (record.startsWith("# branch.oid ")) {
      const oid = record.slice("# branch.oid ".length).trim();
      head = oid === "(initial)" ? "(initial)" : oid;
      continue;
    }
    if (record.startsWith("# ")) continue;
    if (record.startsWith("? ")) {
      const path = record.slice(2);
      if (!path) continue;
      files.push({ path, staged: "?", unstaged: "?", untracked: true });
      continue;
    }
    if (record.startsWith("! ")) continue;
    if (record.startsWith("1 ")) {
      const parts = record.split(" ");
      if (parts.length < 9) continue;
      const xy = parts[1] ?? "..";
      const headHash = parts[6];
      const indexHash = parts[7];
      const path = parts.slice(8).join(" ");
      if (!path) continue;
      files.push({ path, staged: xy[0] ?? ".", unstaged: xy[1] ?? ".", untracked: false, indexHash: indexHash !== "0000000000000000000000000000000000000000" ? indexHash : undefined, headHash: headHash !== "0000000000000000000000000000000000000000" ? headHash : undefined });
      continue;
    }
    if (record.startsWith("2 ")) {
      const tab = record.indexOf("\t");
      const head = tab === -1 ? record : record.slice(0, tab);
      const origPath = tab === -1 ? undefined : record.slice(tab + 1) || undefined;
      const parts = head.split(" ");
      if (parts.length < 10) continue;
      const xy = parts[1] ?? "..";
      const headHash = parts[6];
      const indexHash = parts[7];
      const path = parts.slice(9).join(" ");
      if (!path) continue;
      files.push({ path, origPath, staged: xy[0] ?? ".", unstaged: xy[1] ?? ".", untracked: false, indexHash: indexHash !== "0000000000000000000000000000000000000000" ? indexHash : undefined, headHash: headHash !== "0000000000000000000000000000000000000000" ? headHash : undefined });
      continue;
    }
    if (record.startsWith("u ")) {
      const parts = record.split(" ");
      if (parts.length < 11) continue;
      const xy = parts[1] ?? "UU";
      const path = parts.slice(10).join(" ");
      if (!path) continue;
      files.push({ path, staged: xy[0] ?? "U", unstaged: xy[1] ?? "U", untracked: false });
      continue;
    }
  }
  return { branch, detached, head, files };
}

/** Collect binary paths from numstat where both counts are dashes. */
async function binaryPathsFromNumstat(root: string): Promise<Set<string>> {
  const binary = new Set<string>();
  const result = await runGit(root, ["diff", "--no-color", "--numstat", "HEAD", "--"]);
  if (result.exitCode !== 0) return binary;
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    if (parts[0] === "-" && parts[1] === "-") {
      const raw = parts.slice(2).join("\t");
      const arrow = raw.indexOf(" => ");
      if (arrow !== -1) {
        binary.add(raw.slice(arrow + 4).trim());
        binary.add(raw.slice(0, arrow).trim());
      } else {
        const braces = /\{[^}]* => [^}]*\}/.exec(raw);
        if (braces) continue;
        binary.add(raw);
      }
    }
  }
  return binary;
}

/** True when the first bytes contain NUL, using Git's binary heuristic for existing files. */
async function hasNullByte(root: string, path: string): Promise<boolean> {
  if (path.endsWith("/")) return false;
  try {
    const file = Bun.file(join(root, path));
    if (!(await file.exists())) return false;
    const chunk = await file.slice(0, 8000).arrayBuffer().catch(() => undefined);
    if (!chunk) return false;
    const bytes = new Uint8Array(chunk);
    for (const byte of bytes) if (byte === 0) return true;
    return false;
  } catch {
    return false;
  }
}

/** Batch worktree hashes with one read-only hash-object call per chunk. */
async function worktreeHashes(root: string, paths: readonly string[]): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const existing = paths.filter((path) => !path.endsWith("/"));
  for (let i = 0; i < existing.length; i += 50) {
    const chunk = existing.slice(i, i + 50);
    const result = await runGit(root, ["hash-object", "--", ...chunk]);
    if (result.exitCode !== 0) {
      for (const path of chunk) {
        const single = await runGit(root, ["hash-object", "--", path]);
        if (single.exitCode === 0) {
          const hash = single.stdout.trim().split(/\s+/)[0];
          if (hash) hashes.set(path, hash);
        }
      }
      continue;
    }
    const lines = result.stdout.split("\n").filter(Boolean);
    for (let j = 0; j < chunk.length && j < lines.length; j++) {
      const hash = lines[j]!.trim();
      if (/^[0-9a-f]{40}$/.test(hash)) hashes.set(chunk[j]!, hash);
    }
  }
  return hashes;
}

/** Resolve the canonical toplevel or report a non-Git workspace without blocking. */
async function resolveGitRoot(root: string): Promise<{ ok: true; toplevel: string } | { ok: false; reason: string }> {
  const result = await runGit(root, ["rev-parse", "--show-toplevel"]);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "not a git repository";
    return { ok: false, reason: detail.split("\n")[0] ?? "not a git repository" };
  }
  const toplevel = result.stdout.trim().split("\n")[0]?.trim();
  if (!toplevel) return { ok: false, reason: "git toplevel is empty" };
  return { ok: true, toplevel };
}

/** Read branch, HEAD, dirty state, and bounded changed files without writing anything. */
export async function inspectGitStatus(root: string): Promise<GitStatusSummary | { error: string }> {
  const resolved = await resolveGitRoot(root);
  if (!resolved.ok) return { isGit: false, root } as GitStatusSummary;
  const toplevel = resolved.toplevel;
  const status = await runGit(toplevel, ["status", "--porcelain=v2", "--branch", "--untracked-files=normal", "-z"]);
  if (status.exitCode !== 0) {
    return { error: `Git status failed: ${(status.stderr.trim() || status.stdout.trim() || "unknown error").slice(0, 500)}` };
  }
  const parsed = parsePorcelainV2(status.stdout);
  const binary = await binaryPathsFromNumstat(toplevel);
  const files: GitFileChange[] = [];
  for (const entry of parsed.files) {
    let isBinary = binary.has(entry.path) || (entry.origPath !== undefined && binary.has(entry.origPath));
    if (!isBinary && !entry.untracked) {
      isBinary = await hasNullByte(toplevel, entry.path);
    }
    if (!isBinary && entry.untracked) {
      isBinary = await hasNullByte(toplevel, entry.path);
    }
    files.push({ path: entry.path, ...(entry.origPath !== undefined ? { origPath: entry.origPath } : {}), staged: entry.staged, unstaged: entry.unstaged, untracked: entry.untracked, binary: isBinary });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const stagedCount = files.filter((file) => file.staged !== "." && file.staged !== "?" && file.staged !== "!").length;
  const unstagedCount = files.filter((file) => file.unstaged !== "." && file.staged !== "?").length + files.filter((file) => file.untracked).length;
  const untrackedCount = files.filter((file) => file.untracked).length;
  const totalFiles = files.length;
  const truncated = totalFiles > MAX_GIT_DISPLAY_FILES;
  return {
    isGit: true,
    root: toplevel,
    ...(parsed.branch !== undefined ? { branch: parsed.branch } : {}),
    detached: parsed.detached,
    head: parsed.head || "(unknown)",
    dirty: totalFiles > 0,
    stagedCount,
    unstagedCount,
    untrackedCount,
    files: truncated ? files.slice(0, MAX_GIT_DISPLAY_FILES) : files,
    totalFiles,
    truncated,
  };
}

/** Capture a snapshot with content hashes sufficient to distinguish pre-existing dirt from turn edits. */
export async function captureGitSnapshot(root: string): Promise<GitSnapshot | { error: string }> {
  const resolved = await resolveGitRoot(root);
  if (!resolved.ok) return { error: `Not a Git workspace (${resolved.reason}). Coding continues; use /changes in a Git checkout for inspection.` };
  const toplevel = resolved.toplevel;
  const status = await runGit(toplevel, ["status", "--porcelain=v2", "--branch", "--untracked-files=normal", "-z"]);
  if (status.exitCode !== 0) {
    return { error: `Git snapshot unavailable: ${(status.stderr.trim() || status.stdout.trim() || "status failed").slice(0, 500)}` };
  }
  const parsed = parsePorcelainV2(status.stdout);
  const binary = await binaryPathsFromNumstat(toplevel);
  const hashable = parsed.files.filter((entry) => entry.staged !== "D" && entry.unstaged !== "D" && !entry.path.endsWith("/")).map((entry) => entry.path);
  const hashes = await worktreeHashes(toplevel, hashable);
  const entries: GitSnapshotEntry[] = [];
  for (const entry of parsed.files) {
    let isBinary = binary.has(entry.path) || (entry.origPath !== undefined && binary.has(entry.origPath));
    if (!isBinary) isBinary = await hasNullByte(toplevel, entry.path);
    entries.push({
      path: entry.path,
      ...(entry.origPath !== undefined ? { origPath: entry.origPath } : {}),
      staged: entry.staged,
      unstaged: entry.unstaged,
      untracked: entry.untracked,
      binary: isBinary,
      ...(hashes.get(entry.path) !== undefined ? { worktreeHash: hashes.get(entry.path)! } : {}),
      ...(entry.indexHash !== undefined ? { indexHash: entry.indexHash } : {}),
      ...(entry.headHash !== undefined ? { headHash: entry.headHash } : {}),
    });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const totalFiles = entries.length;
  const truncated = totalFiles > MAX_GIT_SNAPSHOT_FILES;
  return {
    id: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    root: toplevel,
    ...(parsed.branch !== undefined ? { branch: parsed.branch } : {}),
    detached: parsed.detached,
    head: parsed.head || "(unknown)",
    entries: truncated ? entries.slice(0, MAX_GIT_SNAPSHOT_FILES) : entries,
    totalFiles,
    truncated,
  };
}

/** Compare before/after snapshots by content hash so untouched pre-existing dirt stays separate. */
export function compareGitSnapshots(before: GitSnapshot, after: GitSnapshot): GitTurnComparison | { error: string } {
  if (before.root !== after.root) return { error: `Git snapshot unavailable: workspace root changed (${before.root} -> ${after.root}).` };
  if (!before.id || !after.id) return { error: "Git snapshot unavailable: missing snapshot identity." };
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
  const preExistingUnchanged: string[] = [];
  const updatedPreExisting: string[] = [];
  const newChanges: string[] = [];
  const resolved: string[] = [];
  for (const [path, afterEntry] of afterByPath) {
    const beforeEntry = beforeByPath.get(path);
    if (!beforeEntry) {
      newChanges.push(path);
      continue;
    }
    const sameWorktree = (beforeEntry.worktreeHash ?? null) === (afterEntry.worktreeHash ?? null);
    const sameStaged = beforeEntry.staged === afterEntry.staged && beforeEntry.unstaged === afterEntry.unstaged && beforeEntry.indexHash === afterEntry.indexHash;
    if (sameWorktree && sameStaged) {
      preExistingUnchanged.push(path);
    } else {
      updatedPreExisting.push(path);
    }
    void afterEntry;
  }
  for (const path of beforeByPath.keys()) {
    if (!afterByPath.has(path)) resolved.push(path);
  }
  const all = [...preExistingUnchanged, ...updatedPreExisting, ...newChanges, ...resolved];
  const truncated = before.truncated || after.truncated;
  return { beforeId: before.id, afterId: after.id, preExistingUnchanged: preExistingUnchanged.sort(), updatedPreExisting: updatedPreExisting.sort(), newChanges: newChanges.sort(), resolved: resolved.sort(), truncated: truncated || all.length > MAX_GIT_DISPLAY_FILES };
}

/** Render branch, HEAD, dirty state, and bounded files without renderer dependencies. */
export function formatGitStatus(summary: GitStatusSummary): string {
  if (!summary.isGit) return `Not a Git workspace (${summary.root}). Coding continues; Git inspection is unavailable here.`;
  const headShort = summary.head.length > 40 ? summary.head.slice(0, 12) : summary.head.length === 40 ? summary.head.slice(0, 12) : summary.head;
  const branch = summary.detached ? `detached HEAD at ${headShort}` : summary.branch !== undefined ? summary.branch : `detached HEAD at ${headShort}`;
  const lines = [`Branch: ${branch}`, `HEAD: ${summary.head}`, `Dirty: ${summary.dirty ? "yes" : "no"} (staged ${summary.stagedCount}, unstaged ${summary.unstagedCount}, untracked ${summary.untrackedCount})`];
  if (!summary.dirty) {
    lines.push("Working tree is clean.");
    return lines.join("\n");
  }
  lines.push(`Changed files (${summary.totalFiles}):`);
  for (const file of summary.files) {
    const rename = file.origPath !== undefined ? ` (renamed from ${file.origPath})` : "";
    const kind = file.untracked ? "untracked" : file.staged !== "." && file.unstaged !== "." ? `staged ${file.staged}/unstaged ${file.unstaged}` : file.staged !== "." ? `staged ${file.staged}` : `unstaged ${file.unstaged}`;
    const binary = file.binary ? " [binary]" : "";
    const deleted = file.staged === "D" || file.unstaged === "D" ? " [deleted]" : "";
    lines.push(`- ${file.path}${rename} [${kind}]${binary}${deleted}`);
  }
  if (summary.truncated) lines.push(`… truncated to ${summary.files.length} of ${summary.totalFiles} files. Use git status --short in ${summary.root} for the full list.`);
  lines.push(`Inspect further with git status --short or git diff -- <path> in ${summary.root}.`);
  return lines.join("\n");
}

/** Render a before/after comparison with pre-existing dirt shown separately from turn edits. */
export function formatGitComparison(before: GitSnapshot, after: GitSnapshot, comparison: GitTurnComparison): string {
  const branch = after.detached ? `detached HEAD at ${after.head.slice(0, 12)}` : after.branch ?? `detached HEAD at ${after.head.slice(0, 12)}`;
  const lines = [`Snapshot comparison for ${after.root}`, `Branch: ${branch}`, `HEAD: ${before.head} -> ${after.head}`, `Baseline: ${before.id} at ${before.capturedAt}`, `Current: ${after.id} at ${after.capturedAt}`];
  if (comparison.newChanges.length === 0 && comparison.updatedPreExisting.length === 0 && (comparison.resolved?.length ?? 0) === 0) {
    lines.push("No new turn changes. Working state matches the baseline.");
  } else {
    if (comparison.newChanges.length > 0) {
      lines.push(`New turn changes (${comparison.newChanges.length}):`);
      for (const path of comparison.newChanges.slice(0, MAX_GIT_DISPLAY_FILES)) lines.push(`- ${path}`);
    }
    if (comparison.updatedPreExisting.length > 0) {
      lines.push(`Pre-existing files changed further (${comparison.updatedPreExisting.length}):`);
      for (const path of comparison.updatedPreExisting.slice(0, MAX_GIT_DISPLAY_FILES)) lines.push(`- ${path}`);
    }
    if ((comparison.resolved?.length ?? 0) > 0) {
      lines.push(`No longer dirty (${comparison.resolved!.length}):`);
      for (const path of comparison.resolved!.slice(0, MAX_GIT_DISPLAY_FILES)) lines.push(`- ${path}`);
    }
  }
  if (comparison.preExistingUnchanged.length > 0) {
    lines.push(`Pre-existing, unchanged by this turn (${comparison.preExistingUnchanged.length}):`);
    for (const path of comparison.preExistingUnchanged.slice(0, MAX_GIT_DISPLAY_FILES)) lines.push(`- ${path}`);
  }
  if (comparison.truncated || before.truncated || after.truncated) lines.push("… truncated. Snapshots retain only the most recent turn pair; use git status --short for the full list.");
  lines.push("Snapshots are observational and cannot restore files. Use git diff for content.");
  return lines.join("\n");
}

/** Read a bounded diff preview without altering index, HEAD, branches, or working files. */
export async function getGitDiffPreview(root: string, path?: string, maxChars: number = MAX_GIT_DIFF_CHARS): Promise<GitDiffPreview | { error: string }> {
  const resolved = await resolveGitRoot(root);
  if (!resolved.ok) return { error: `Not a Git workspace (${resolved.reason}).` };
  const toplevel = resolved.toplevel;
  const args = path ? ["diff", "--no-color", "--no-ext-diff", "--stat", "--patch", "--", path] : ["diff", "--no-color", "--no-ext-diff", "--stat", "--patch", "--"];
  const result = await runGit(toplevel, args);
  if (result.exitCode !== 0) {
    return { error: `Git diff failed: ${(result.stderr.trim() || result.stdout.trim() || "unknown error").slice(0, 500)}` };
  }
  const binaryFiles: string[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.includes("Binary files ") && line.includes(" differ")) binaryFiles.push(line.trim().slice(0, 200));
  }
  if (result.stdout.length > maxChars) {
    return { ...(path !== undefined ? { path } : {}), diff: `${result.stdout.slice(0, maxChars)}\n… truncated at ${maxChars} chars. Use git diff -- ${path ?? "--stat"} in ${toplevel} for the full diff.`, truncated: true, binaryFiles: binaryFiles.slice(0, 10) };
  }
  const diff = result.stdout.trim().length === 0 ? "No textual diff. Staged, untracked, or binary-only changes may still be listed by /changes status." : result.stdout;
  return { ...(path !== undefined ? { path } : {}), diff, truncated: false, binaryFiles: binaryFiles.slice(0, 10) };
}

/** Render a diff preview with explicit truncation and follow-up guidance. */
export function formatGitDiffPreview(preview: GitDiffPreview): string {
  const header = preview.path !== undefined ? `Diff for ${preview.path}:` : "Working-tree diff:";
  const lines = [header, preview.diff];
  if (preview.binaryFiles.length > 0) {
    lines.push(`Binary files (${preview.binaryFiles.length}):`);
    for (const entry of preview.binaryFiles) lines.push(`- ${entry}`);
    lines.push("Binary content is summarized, not shown. Use git diff --stat for sizes.");
  }
  if (preview.truncated) lines.push("Preview truncated. Use git diff in the workspace for full content.");
  return lines.join("\n");
}
