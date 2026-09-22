import { readFile, realpath, stat } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { Workspace } from "../workspace/workspace.ts";

const GLOBAL_SCOPE_DEPTH = -1;

/** One AGENTS.md file that applies to the current request. */
export interface AgentsInstruction {
  path: string;
  displayPath: string;
  content: string;
}

/**
 * Discover applicable AGENTS.md files from general to specific.
 * Nested files are included only for ancestor chains of `targetPaths`.
 * Canonical paths deduplicate files and exclude targets outside the workspace;
 * missing, empty, and unreadable instruction files are skipped.
 */
export async function discoverAgentsInstructions(options: {
  workspace: Workspace;
  home?: string;
  targetPaths: readonly string[];
}): Promise<AgentsInstruction[]> {
  const primaryRoot = await canonicalPath(options.workspace.root);
  const roots = [...new Set(await Promise.all([primaryRoot, ...options.workspace.extraRoots].map(canonicalPath)))];
  const dirs = new Map<string, { depth: number; root: string; global: boolean }>();
  if (options.home !== undefined) {
    const dir = await canonicalPath(join(options.home, ".schway"));
    dirs.set(dir, { depth: GLOBAL_SCOPE_DEPTH, root: dir, global: true });
  }
  for (const root of roots) {
    for (const target of options.targetPaths) {
      for (const dir of await ancestorDirsWithinRoot(target, root)) {
        if (!dirs.has(dir)) dirs.set(dir, { depth: dir.split(sep).filter(Boolean).length, root, global: false });
      }
    }
  }
  const ordered = [...dirs.entries()].sort((a, b) => a[1].depth - b[1].depth || a[0].localeCompare(b[0]));
  const instructions: AgentsInstruction[] = [];
  const seen = new Set<string>();
  for (const [dir, scope] of ordered) {
    const loaded = await readAgentsFile(join(dir, "AGENTS.md"), scope.root);
    if (loaded === undefined || seen.has(loaded.path)) continue;
    seen.add(loaded.path);
    instructions.push({ ...loaded, displayPath: scope.global ? loaded.path : displayInstructionPath(loaded.path, primaryRoot) });
  }
  return instructions;
}

/** Format discovered instructions for the project-instructions context section. */
export function formatAgentsInstructions(
  instructions: readonly AgentsInstruction[],
): string {
  return instructions
    .map((instruction) => {
      const body = instruction.content.replace(/\s+$/, "");
      return `Source: ${instruction.displayPath}\n${body}`;
    })
    .join("\n\n");
}

async function ancestorDirsWithinRoot(
  target: string,
  root: string,
): Promise<string[]> {
  let current = await canonicalPath(target);
  try {
    const info = await stat(current);
    if (!info.isDirectory()) {
      current = dirname(current);
    }
  } catch {
    current = dirname(current);
  }

  const dirs: string[] = [];
  while (isInside(root, current)) {
    dirs.push(current);
    if (current === root) {
      break;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return dirs;
}

async function readAgentsFile(
  path: string,
  allowedRoot: string,
): Promise<Omit<AgentsInstruction, "displayPath"> | undefined> {
  const canonical = await canonicalPath(path);
  if (!isInside(allowedRoot, canonical)) {
    return undefined;
  }
  try {
    const info = await stat(canonical);
    if (!info.isFile()) {
      return undefined;
    }
    const content = await readFile(canonical, "utf8");
    if (content.trim().length === 0) {
      return undefined;
    }
    return { path: canonical, content };
  } catch {
    return undefined;
  }
}

function displayInstructionPath(path: string, workspaceRoot: string): string {
  const rel = relative(workspaceRoot, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return path;
  }
  return rel.split(sep).join("/");
}

/** Resolve existing ancestors as well as absent leaf files so symlinked write targets retain their actual scope. */
async function canonicalPath(path: string): Promise<string> {
  let current = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try { return resolve(await realpath(current), ...suffix); } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      suffix.unshift(relative(parent, current));
      current = parent;
    }
  }
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
}
