import { Type, type Static } from "@sinclair/typebox";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  abortError,
  filesystemFailure,
  isAbortError,
  isErrno,
} from "./fs.ts";
import { resolveToolPath } from "./path.ts";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "./types.ts";

/** TypeBox schema for `write`. Compiled once when the tool is registered. */
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

/** Validated arguments for the built-in `write` tool. */
export type WriteInput = Static<typeof writeInputSchema>;

/** Structured extras attached to a successful or failed write. */
export interface WriteDetails {
  path: string;
  resolvedPath: string;
  created: boolean;
}

/** Built-in file writer. Declares exclusive execution. */
export const writeTool: ToolDefinition<WriteInput> = {
  name: "write",
  description:
    "Create a file or replace an existing file entirely. Prefer edit for targeted changes to existing files. Relative paths resolve from the workspace root. Reading the file first is not required.",
  inputSchema: writeInputSchema,
  execution: "exclusive",
  execute: executeWrite,
};

/**
 * Create or fully replace a file.
 * Relative paths resolve from the workspace root.
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
    await writeFile(resolvedPath, input.content);
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
