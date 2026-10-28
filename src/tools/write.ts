import { Type, type Static } from "@sinclair/typebox";
import { countLines } from "../text/diff.ts";
import { unlessCancelled, type CoreToolAccess, type ExecutionFileObservation } from "./backend.ts";
import {
  abortError,
  filesystemFailure,
  isAbortError,
} from "./fs.ts";
import { localToolAccess } from "./local-backend.ts";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "./types.ts";

/**
 * Accept a destination path and complete replacement text, rejecting unknown keys during validation.
 * Compiled once when the tool is registered.
 */
export const writeInputSchema = Type.Object(
  {
    path: Type.String({
      description:
        "Path to the file. Relative paths resolve from the workspace root.",
    }),
    content: Type.String({
      description: "Full file contents. Existing files are replaced entirely.",
    }),
  },
  { additionalProperties: false },
);

/** Destination path and full file contents accepted by the write schema. */
export type WriteInput = Static<typeof writeInputSchema>;

/** Successful-write paths, written-content line count, and whether the destination was absent before writing. */
export interface WriteDetails {
  path: string;
  resolvedPath: string;
  created: boolean;
  lineCount: number;
}

/** Build the full-file writing definition over a backend; it runs behind an exclusive scheduling barrier. */
export function createWriteTool(access: CoreToolAccess): ToolDefinition<WriteInput> {
  return {
    name: "write",
    description:
      "Create a file or replace an existing file entirely. Prefer edit for targeted changes to existing files. Relative paths resolve from the workspace root. Reading the file first is not required.",
    inputSchema: writeInputSchema,
    effect: "mutating",
    execution: "exclusive",
    execute: (input, ctx) => unlessCancelled(runWrite(access, input, ctx), ctx.signal),
  };
}

/** Full-file writing definition for the CLI, writing in this process from the workspace root. */
export const writeTool: ToolDefinition<WriteInput> = createWriteTool(localToolAccess);

/** Atomically write complete content from the workspace root, creating parents, returning filesystem failures, and rejecting detected cancellation. */
export function executeWrite(
  input: WriteInput,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  return writeTool.execute(input, ctx);
}

async function runWrite(
  access: CoreToolAccess,
  input: WriteInput,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const backend = access.backend(ctx);
  const resolved = await access.resolve(backend, input.path);
  if (!resolved.ok) return resolved.result;
  const resolvedPath = resolved.resolvedPath;
  if (ctx.signal?.aborted) {
    throw abortError();
  }

  let observed: ExecutionFileObservation | null;
  try {
    observed = await backend.observeFile(resolvedPath);
  } catch (error) {
    if (ctx.signal?.aborted || isAbortError(error)) throw error instanceof Error ? error : abortError();
    return filesystemFailure(input.path, resolvedPath, error);
  }

  try {
    await backend.writeFileAtomically(resolvedPath, input.content, {
      observed, createParents: true, ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
  } catch (error) {
    if (ctx.signal?.aborted || isAbortError(error)) {
      throw error instanceof Error ? error : abortError();
    }
    return filesystemFailure(input.path, resolvedPath, error);
  }

  return {
    content: `Wrote ${input.path}`,
    details: {
      path: input.path,
      resolvedPath,
      created: observed?.targetExists !== true,
      lineCount: countLines(input.content),
    } satisfies WriteDetails,
  };
}
