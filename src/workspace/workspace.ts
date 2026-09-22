import { realpath } from "node:fs/promises";
import { findGitRoot } from "./git.ts";

/** Workspace directories whose primary root anchors relative tool paths, with launch location and optional extra roots. */
export interface Workspace {
  root: string;
  launchCwd: string;
  extraRoots: string[];
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
