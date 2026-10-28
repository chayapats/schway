import { Type, type Static } from "@sinclair/typebox";
import { resolve } from "node:path";
import { unlessCancelled, type CoreToolAccess, type ExecutionBackend } from "./backend.ts";
import {
  abortError,
  filesystemError,
  filesystemFailure,
  isAbortError,
  isErrno,
} from "./fs.ts";
import { localToolAccess } from "./local-backend.ts";
import { TOOL_OUTPUT_BUDGET_BYTES, utf8ByteLength } from "./output-budget.ts";
import { displayToolPath } from "./path.ts";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "./types.ts";

/** UTF-8 byte budget checked before adding further paths; the first path and truncation note may exceed it. */
export const MAX_FIND_BYTES = TOOL_OUTPUT_BUDGET_BYTES;

/**
 * Accept a nonempty glob and optional search directory, rejecting unknown keys during validation.
 * Compiled once when the tool is registered.
 */
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

/** Glob pattern and optional directory accepted by the file-discovery schema. */
export type FindInput = Static<typeof findInputSchema>;

/** Successful discovery metadata identifying the searched directory, pattern, returned count, and truncation state. */
export interface FindDetails {
  path: string;
  resolvedPath: string;
  pattern: string;
  fileCount: number;
  truncated: boolean;
}

/** Build the glob-based file-discovery definition over a backend; it is eligible for parallel scheduling. */
export function createFindTool(access: CoreToolAccess): ToolDefinition<FindInput> {
  return {
    name: "find",
    description:
      'Discover files with a simple glob pattern such as "**/*.ts". Relative paths resolve from the workspace root. Use bash for advanced Unix find syntax.',
    inputSchema: findInputSchema,
    effect: "read-only",
    execution: "parallel",
    execute: (input, ctx) => unlessCancelled(runFind(access, input, ctx), ctx.signal),
  };
}

/** Glob-based file-discovery definition for the CLI, scanning in this process from the workspace root. */
export const findTool: ToolDefinition<FindInput> = createFindTool(localToolAccess);

/**
 * Discover files matching a glob under an optional search path.
 * Relative paths resolve from the workspace root; results are sorted display paths with a character budget.
 * Invalid paths and glob failures return error results, while detected cancellation rejects.
 */
export function executeFind(
  input: FindInput,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  return findTool.execute(input, ctx);
}

async function runFind(
  access: CoreToolAccess,
  input: FindInput,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const path = input.path ?? ".";
  const backend = access.backend(ctx);
  const resolved = await access.resolve(backend, path);
  if (!resolved.ok) return resolved.result;
  const resolvedPath = resolved.resolvedPath;

  let info;
  try {
    info = await backend.stat(resolvedPath);
  } catch (error) {
    return {
      content: filesystemError(path, error),
      isError: true,
      details: { path, resolvedPath, pattern: input.pattern },
    };
  }

  if (info.type !== "directory") {
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
    collected = await collectMatches(backend, input.pattern, resolvedPath, ctx);
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
  backend: ExecutionBackend,
  pattern: string,
  cwd: string,
  ctx: ToolContext,
): Promise<{ matches: string[]; truncated: boolean }> {
  const matches: string[] = [];
  let bytes = 0;
  let truncated = false;
  for await (const file of backend.glob(pattern, { cwd, ...(ctx.signal ? { signal: ctx.signal } : {}) })) {
    if (ctx.signal?.aborted) {
      throw abortError();
    }
    const display = displayToolPath(backend.workspaceRoot, resolve(cwd, file));
    const extra = (matches.length === 0 ? 0 : 1) + utf8ByteLength(display);
    if (matches.length > 0 && bytes + extra > MAX_FIND_BYTES) {
      truncated = true;
      break;
    }
    matches.push(display);
    bytes += extra;
  }
  matches.sort((a, b) => a.localeCompare(b));
  return { matches, truncated };
}
