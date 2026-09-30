import { Type, type Static } from "@sinclair/typebox";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { countLines } from "../text/diff.ts";
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

/** Successful-write paths, written-content line count, and whether the destination was absent before writing. */
export interface WriteDetails {
  path: string;
  resolvedPath: string;
  created: boolean;
  lineCount: number;
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

/** Atomically write complete content from the workspace root, creating parents, returning filesystem failures, and rejecting detected cancellation. */
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
      lineCount: countLines(input.content),
    } satisfies WriteDetails,
  };
}
