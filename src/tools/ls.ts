import { Type, type Static } from "@sinclair/typebox";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { abortError, filesystemError, isAbortError, isErrno } from "./fs.ts";
import { TOOL_OUTPUT_BUDGET_BYTES, utf8ByteLength } from "./output-budget.ts";
import { displayToolPath, resolveToolPath } from "./path.ts";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "./types.ts";

/** Default listing depth when the model omits `depth`. */
export const DEFAULT_LS_DEPTH = 1;
/** UTF-8 byte budget checked before adding further entries; the first entry and truncation note may exceed it. */
export const MAX_LS_BYTES = TOOL_OUTPUT_BUDGET_BYTES;

/**
 * Accept an optional directory and positive listing depth, rejecting unknown keys during validation.
 * Compiled once when the tool is registered.
 */
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

/** Optional directory and depth accepted by the listing schema, defaulting to the workspace root and one level. */
export type LsInput = Static<typeof lsInputSchema>;

/** Successful listing metadata with searched paths, requested depth, returned count, and truncation state. */
export interface LsDetails {
  path: string;
  resolvedPath: string;
  depth: number;
  entryCount: number;
  truncated: boolean;
}

/** Bounded directory-listing definition eligible for parallel scheduling. */
export const lsTool: ToolDefinition<LsInput> = {
  name: "ls",
  description:
    "List a directory with an explicit depth instead of dumping the whole tree. Relative paths resolve from the workspace root. Depth defaults to 1.",
  inputSchema: lsInputSchema,
  effect: "read-only",
  execution: "parallel",
  execute: executeLs,
};

/**
 * List a directory up to `depth` levels.
 * Relative paths resolve from the workspace root; output observes a character budget.
 * Filesystem failures return error results, nested permission failures are skipped, and detected cancellation rejects.
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
    truncated = await walkDirectory(
      resolvedPath,
      depth,
      ctx,
      lines,
      { bytes: 0 },
      true,
    );
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
  state: { bytes: number },
  topLevel = false,
): Promise<boolean> {
  if (ctx.signal?.aborted) {
    throw abortError();
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (
      topLevel ||
      isAbortError(error) ||
      (!isErrno(error, "EACCES") && !isErrno(error, "EPERM"))
    ) {
      throw error;
    }
    return false;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (ctx.signal?.aborted) {
      throw abortError();
    }
    const child = join(dir, entry.name);
    const relative = displayToolPath(ctx.workspace.root, child);
    const isDir = entry.isDirectory();
    const line = isDir ? `${relative}/` : relative;
    const extra = (lines.length === 0 ? 0 : 1) + utf8ByteLength(line);
    if (lines.length > 0 && state.bytes + extra > MAX_LS_BYTES) {
      return true;
    }
    lines.push(line);
    state.bytes += extra;
    if (isDir && depth > 1) {
      const truncated = await walkDirectory(child, depth - 1, ctx, lines, state);
      if (truncated) {
        return true;
      }
    }
  }
  return false;
}
