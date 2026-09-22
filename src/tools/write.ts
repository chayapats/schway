import { Type, type Static } from "@sinclair/typebox";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
  abortError,
  filesystemFailure,
  isAbortError,
  isErrno,
  writeFileAtomically,
} from "./fs.ts";
import { resolveToolPath } from "./path.ts";
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

/** Successful-write paths and whether the destination was absent when checked before writing. */
export interface WriteDetails {
  path: string;
  resolvedPath: string;
  created: boolean;
}

/** Full-file writing definition that runs behind an exclusive scheduling barrier. */
export const writeTool: ToolDefinition<WriteInput> = {
  name: "write",
  description:
    "Create a file or replace an existing file entirely. Prefer edit for targeted changes to existing files. Relative paths resolve from the workspace root. Reading the file first is not required.",
  inputSchema: writeInputSchema,
  execution: "exclusive",
  execute: executeWrite,
};

/**
 * Create parent directories and atomically create or replace a file with the supplied content.
 * Relative paths resolve from the workspace root; filesystem failures return error results
 * and cancellation detected before or during the write rejects.
 */
export async function executeWrite(
  input: WriteInput,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const resolvedPath = resolveToolPath(ctx.workspace.root, input.path);
  if (ctx.signal?.aborted) {
    throw abortError();
  }

  let created = true;
  try {
    const info = await stat(resolvedPath);
    if (info.isDirectory()) {
      return {
        content: `Path is a directory: ${input.path}`,
        isError: true,
        details: { path: input.path, resolvedPath },
      };
    }
    created = false;
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      return filesystemFailure(input.path, resolvedPath, error);
    }
  }

  try {
    await mkdir(dirname(resolvedPath), { recursive: true });
    await writeFileAtomically(resolvedPath, input.content, ctx.signal);
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
      created,
    } satisfies WriteDetails,
  };
}
