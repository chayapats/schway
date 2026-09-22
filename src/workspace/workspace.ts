import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { findGitRoot } from "./git.ts";

/** Workspace directories whose primary root anchors relative tool paths, with launch location and optional extra roots. */
export interface Workspace {
  root: string;
  launchCwd: string;
  extraRoots: string[];
}

/** Validate all contextual attachments before returning a deduplicated copy, anchored to the unchanged primary root. */
export async function addWorkspaceRoots(workspace: Workspace, directories: readonly string[], signal?: AbortSignal): Promise<Workspace> {
  const roots = new Set([workspace.root, ...workspace.extraRoots]);
  for (const directory of directories) {
    signal?.throwIfAborted();
    if (!directory.trim()) throw new Error("An attached directory must not be empty.");
    const path = resolve(workspace.root, directory);
    try {
      const canonical = await realpath(path);
      if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
      await access(canonical, constants.R_OK | constants.X_OK);
      roots.add(canonical);
    } catch (error) {
      throw new Error(`Cannot attach directory ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  signal?.throwIfAborted();
  roots.delete(workspace.root);
  return { ...workspace, extraRoots: [...roots] };
}

/** Restore usable attachments without changing primary identity or discarding the caller's saved root metadata. */
export async function restoreWorkspace(workspace: Workspace): Promise<{ workspace: Workspace; diagnostics: string[] }> {
  let usable = { ...workspace, extraRoots: [] as string[] };
  const diagnostics: string[] = [];
  for (const root of workspace.extraRoots) {
    try {
      usable = await addWorkspaceRoots(usable, [root]);
    } catch (error) {
      diagnostics.push(`Saved attachment unavailable: ${root}. ${error instanceof Error ? error.message : String(error)} Restore it and retry /add-dir or --add-dir.`);
    }
  }
  return { workspace: usable, diagnostics };
}

/**
 * Canonicalize the launch directory and nearest Git root, falling back to launch with no extra roots.
 * Rejects when a required realpath lookup fails; Git discovery accepts `.git` files and directories.
 */
export async function resolveWorkspace(launchCwd: string): Promise<Workspace> {
  const canonicalLaunch = await realpath(launchCwd);
  const gitRoot = await findGitRoot(canonicalLaunch);
  const root = gitRoot ? await realpath(gitRoot) : canonicalLaunch;
  return {
    root,
    launchCwd: canonicalLaunch,
    extraRoots: [],
  };
}
