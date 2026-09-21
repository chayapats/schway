import { Type, type Static } from "@sinclair/typebox";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  abortError,
  filesystemError,
  filesystemFailure,
  isAbortError,
  isErrno,
} from "./fs.ts";
import { displayToolPath, resolveToolPath } from "./path.ts";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "./types.ts";

/** Hard cap on model-facing characters, including truncation notes. */
export const MAX_FIND_CHARS = 50_000;

/** TypeBox schema for `find`. Compiled once when the tool is registered. */
export const findInputSchema = Type.Object(
  {
    pattern: Type.String({
      minLength: 1,
      description:
        'Glob pattern to match, such as "**/*.ts". This is not Unix find syntax.',
    }),
    path: Type.Optional(
      Type.String({
        description:
          "Directory to search. Relative paths resolve from the workspace root. Defaults to the workspace root.",
      }),
    ),
  },
  { additionalProperties: false },
);

/** Validated arguments for the built-in `find` tool. */
export type FindInput = Static<typeof findInputSchema>;

/** Structured extras attached to a successful or failed discovery. */
export interface FindDetails {
  path: string;
  resolvedPath: string;
  pattern: string;
  fileCount: number;
  truncated: boolean;
}

/** Built-in file discovery. Declares parallel execution. */
export const findTool: ToolDefinition<FindInput> = {
  name: "find",
  description:
    'Discover files with a simple glob pattern such as "**/*.ts". Relative paths resolve from the workspace root. Use bash for advanced Unix find syntax.',
  inputSchema: findInputSchema,
  execution: "parallel",
  execute: executeFind,
};

/**
 * Discover files matching a glob under an optional search path.
 * Relative paths resolve from the workspace root.
 */
export async function executeFind(
  input: FindInput,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const path = input.path ?? ".";
  const resolvedPath = resolveToolPath(ctx.workspace.root, path);

  let info;
  try {
    info = await stat(resolvedPath);
  } catch (error) {
    return {
      content: filesystemError(path, error),
      isError: true,
      details: { path, resolvedPath, pattern: input.pattern },
    };
  }

  if (!info.isDirectory()) {
    return {
      content: `Path is a file: ${path}`,
      isError: true,
      details: { path, resolvedPath, pattern: input.pattern },
    };
  }

  if (ctx.signal?.aborted) {
    throw abortError();
  }

  let collected: { matches: string[]; truncated: boolean };
  try {
    collected = await collectMatches(input.pattern, resolvedPath, ctx);
  } catch (error) {
    if (ctx.signal?.aborted || isAbortError(error)) {
      throw error instanceof Error ? error : abortError();
    }
    if (isErrno(error, "ENOENT") || isErrno(error, "EACCES") || isErrno(error, "EPERM")) {
      return filesystemFailure(path, resolvedPath, error);
    }
    const detail = error instanceof Error ? error.message : String(error);
    return {
      content: `Invalid glob pattern: ${input.pattern} (${detail})`,
      isError: true,
      details: { path, resolvedPath, pattern: input.pattern },
    };
  }

  let content =
    collected.matches.length === 0 ? "(no matching files)" : collected.matches.join("\n");
  if (collected.truncated) {
    content +=
      "\n... truncated: too many files. Narrow with a more specific pattern or path.";
  }

  return {
    content,
    details: {
      path,
      resolvedPath,
      pattern: input.pattern,
      fileCount: collected.matches.length,
      truncated: collected.truncated,
    } satisfies FindDetails,
  };
}

/** Scan `pattern` under `cwd` and return workspace-relative display paths. */
async function collectMatches(
  pattern: string,
  cwd: string,
  ctx: ToolContext,
): Promise<{ matches: string[]; truncated: boolean }> {
  const glob = new Bun.Glob(pattern);
  const matches: string[] = [];
  let chars = 0;
  let truncated = false;
  for await (const file of glob.scan({
    cwd,
    onlyFiles: true,
    followSymlinks: false,
  })) {
    if (ctx.signal?.aborted) {
      throw abortError();
    }
    const display = displayToolPath(ctx.workspace.root, resolve(cwd, file));
    const extra = (matches.length === 0 ? 0 : 1) + display.length;
    if (matches.length > 0 && chars + extra > MAX_FIND_CHARS) {
      truncated = true;
      break;
    }
    matches.push(display);
    chars += extra;
  }
  matches.sort((a, b) => a.localeCompare(b));
  return { matches, truncated };
}
