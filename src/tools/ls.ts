import { Type, type Static } from "@sinclair/typebox";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { abortError, filesystemError, isAbortError } from "./fs.ts";
import { displayToolPath, resolveToolPath } from "./path.ts";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "./types.ts";

/** Default listing depth when the model omits `depth`. */
export const DEFAULT_LS_DEPTH = 1;
/** Hard cap on model-facing characters, including truncation notes. */
export const MAX_LS_CHARS = 50_000;

/** TypeBox schema for `ls`. Compiled once when the tool is registered. */
export const lsInputSchema = Type.Object(
  {
    path: Type.Optional(
      Type.String({
        description:
          "Directory to list. Relative paths resolve from the workspace root. Defaults to the workspace root.",
      }),
    ),
    depth: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "How many directory levels to include. Defaults to 1 (the directory itself, no recursion).",
      }),
    ),
  },
  { additionalProperties: false },
);

/** Validated arguments for the built-in `ls` tool. */
export type LsInput = Static<typeof lsInputSchema>;

/** Structured extras attached to a successful or failed listing. */
export interface LsDetails {
  path: string;
  resolvedPath: string;
  depth: number;
  entryCount: number;
  truncated: boolean;
}

/** Built-in directory lister. Declares parallel execution. */
export const lsTool: ToolDefinition<LsInput> = {
  name: "ls",
  description:
    "List a directory with an explicit depth instead of dumping the whole tree. Relative paths resolve from the workspace root. Depth defaults to 1.",
  inputSchema: lsInputSchema,
  execution: "parallel",
  execute: executeLs,
};

/**
 * List a directory up to `depth` levels.
 * Relative paths resolve from the workspace root.
 */
export async function executeLs(
  input: LsInput,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const path = input.path ?? ".";
  const depth = input.depth ?? DEFAULT_LS_DEPTH;
  const resolvedPath = resolveToolPath(ctx.workspace.root, path);

  let info;
  try {
    info = await stat(resolvedPath);
  } catch (error) {
    return {
      content: filesystemError(path, error),
      isError: true,
      details: { path, resolvedPath },
    };
  }

  if (!info.isDirectory()) {
    return {
      content: `Path is a file: ${path}`,
      isError: true,
      details: { path, resolvedPath },
    };
  }

  const lines: string[] = [];
  let truncated = false;
  try {
    truncated = await walkDirectory(resolvedPath, depth, ctx, lines, { chars: 0 });
  } catch (error) {
    if (ctx.signal?.aborted || isAbortError(error)) {
      throw error instanceof Error ? error : abortError();
    }
    return {
      content: filesystemError(path, error),
      isError: true,
      details: { path, resolvedPath },
    };
  }

  let content = lines.length === 0 ? "(empty directory)" : lines.join("\n");
  if (truncated) {
    content += "\n... truncated: output limited. Use a more specific path or lower depth.";
  }

  return {
    content,
    details: {
      path,
      resolvedPath,
      depth,
      entryCount: lines.length,
      truncated,
    } satisfies LsDetails,
  };
}

/** Walk `dir` up to `depth` levels, appending workspace-relative entries. */
async function walkDirectory(
  dir: string,
  depth: number,
  ctx: ToolContext,
  lines: string[],
  state: { chars: number },
): Promise<boolean> {
  if (ctx.signal?.aborted) {
    throw abortError();
  }
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (ctx.signal?.aborted) {
      throw abortError();
    }
    const child = join(dir, entry.name);
    const relative = displayToolPath(ctx.workspace.root, child);
    const isDir = entry.isDirectory();
    const line = isDir ? `${relative}/` : relative;
    const extra = (lines.length === 0 ? 0 : 1) + line.length;
    if (lines.length > 0 && state.chars + extra > MAX_LS_CHARS) {
      return true;
    }
    lines.push(line);
    state.chars += extra;
    if (isDir && depth > 1) {
      const truncated = await walkDirectory(child, depth - 1, ctx, lines, state);
      if (truncated) {
        return true;
      }
    }
  }
  return false;
}
