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
 */
export async function discoverAgentsInstructions(options: {
  workspace: Workspace;
  home?: string;
  targetPaths: readonly string[];
}): Promise<AgentsInstruction[]> {
  const root = await canonicalPath(options.workspace.root);
  const dirs = new Map<string, number>();
  dirs.set(root, 0);

  if (options.home !== undefined) {
    dirs.set(
      await canonicalPath(join(options.home, ".schway")),
      GLOBAL_SCOPE_DEPTH,
    );
  }

  for (const target of options.targetPaths) {
    for (const dir of await ancestorDirsWithinRoot(target, root)) {
      const depth = relative(root, dir).split(sep).filter(Boolean).length;
      if (!dirs.has(dir)) {
        dirs.set(dir, depth);
      }
    }
  }

  const ordered = [...dirs.entries()].sort((a, b) => {
    if (a[1] !== b[1]) {
      return a[1] - b[1];
    }
    return a[0].localeCompare(b[0]);
  });

  const instructions: AgentsInstruction[] = [];
  const seen = new Set<string>();
  for (const [dir, depth] of ordered) {
    const allowedRoot = depth === GLOBAL_SCOPE_DEPTH ? dir : root;
    const loaded = await readAgentsFile(join(dir, "AGENTS.md"), allowedRoot);
    if (loaded === undefined || seen.has(loaded.path)) {
      continue;
    }
    seen.add(loaded.path);
    instructions.push({
      ...loaded,
      displayPath:
        depth === GLOBAL_SCOPE_DEPTH
          ? loaded.path
          : displayInstructionPath(loaded.path, root),
    });
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

async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
}
