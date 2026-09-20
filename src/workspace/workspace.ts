import { realpath } from "node:fs/promises";
import { findGitRoot } from "./git.ts";

export interface Workspace {
  root: string;
  launchCwd: string;
  extraRoots: string[];
}

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
