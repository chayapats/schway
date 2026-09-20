import { Type, type Static } from "@sinclair/typebox";
import { readFile, stat } from "node:fs/promises";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "./types.ts";
import { resolveToolPath } from "./path.ts";

export const DEFAULT_READ_LINE_LIMIT = 2000;
export const MAX_READ_CHARS = 50_000;

export const readInputSchema = Type.Object(
  {
    path: Type.String({
      description:
        "Path to the file. Relative paths resolve from the workspace root.",
    }),
    offset: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "1-indexed line number to start reading from.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Maximum number of lines to return.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type ReadInput = Static<typeof readInputSchema>;

export interface ReadDetails {
  path: string;
  resolvedPath: string;
  lineCount: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
  nextOffset?: number;
}

export const readTool: ToolDefinition<ReadInput> = {
  name: "read",
  description:
    "Read a file from the workspace with optional offset and limit. Relative paths resolve from the workspace root. Output is line-numbered and bounded.",
  inputSchema: readInputSchema,
  execution: "parallel",
  execute: executeRead,
};

export async function executeRead(
  input: ReadInput,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const resolvedPath = resolveToolPath(ctx.workspace.root, input.path);
  let info;
  try {
    info = await stat(resolvedPath);
  } catch (error) {
    return {
      content: filesystemError(input.path, error),
      isError: true,
      details: { path: input.path, resolvedPath },
    };
  }

  if (info.isDirectory()) {
    return {
      content: `Path is a directory: ${input.path}`,
      isError: true,
      details: { path: input.path, resolvedPath },
    };
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(resolvedPath);
  } catch (error) {
    return {
      content: filesystemError(input.path, error),
      isError: true,
      details: { path: input.path, resolvedPath },
    };
  }

  if (buffer.includes(0)) {
    return {
      content: `Cannot read binary file: ${input.path}`,
      isError: true,
      details: { path: input.path, resolvedPath },
    };
  }

  const lines = splitLines(buffer.toString("utf8"));
  if (lines.length === 0) {
    return {
      content: "(empty file)",
      details: {
        path: input.path,
        resolvedPath,
        lineCount: 0,
        startLine: 1,
        endLine: 0,
        truncated: false,
      } satisfies ReadDetails,
    };
  }

  const startLine = input.offset ?? 1;
  if (startLine > lines.length) {
    return {
      content: `offset ${startLine} is beyond the end of the file (${lines.length} lines)`,
      isError: true,
      details: {
        path: input.path,
        resolvedPath,
        lineCount: lines.length,
        startLine,
        endLine: lines.length,
        truncated: false,
      } satisfies ReadDetails,
    };
  }

  const limit = input.limit ?? DEFAULT_READ_LINE_LIMIT;
  const requestedEnd = Math.min(lines.length, startLine - 1 + limit);
  const width = Math.max(6, String(requestedEnd).length);

  const formatted: string[] = [];
  let chars = 0;
  let lastIncluded = startLine - 2;
  let slicedLine = false;
  for (let index = startLine - 1; index < requestedEnd; index++) {
    const line = `${String(index + 1).padStart(width)}|${lines[index]}`;
    const extra = (formatted.length === 0 ? 0 : 1) + line.length;
    if (formatted.length > 0 && chars + extra > MAX_READ_CHARS) {
      break;
    }
    if (formatted.length === 0 && extra > MAX_READ_CHARS) {
      formatted.push(line.slice(0, MAX_READ_CHARS));
      lastIncluded = index;
      chars = MAX_READ_CHARS;
      slicedLine = true;
      break;
    }
    formatted.push(line);
    chars += extra;
    lastIncluded = index;
  }

  const remainingLines = lines.length - (lastIncluded + 1);
  const truncated = slicedLine || remainingLines > 0;
  const nextOffset = lastIncluded + 2;
  let content = formatted.join("\n");
  if (truncated) {
    if (remainingLines > 0) {
      content += `\n... truncated: ${remainingLines} lines remaining. Use offset=${nextOffset} to continue.`;
    } else {
      content += `\n... truncated: line ${lastIncluded + 1} exceeded the output budget.`;
    }
  }

  return {
    content,
    details: {
      path: input.path,
      resolvedPath,
      lineCount: lines.length,
      startLine,
      endLine: lastIncluded + 1,
      truncated,
      ...(remainingLines > 0 ? { nextOffset } : {}),
    } satisfies ReadDetails,
  };
}

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function filesystemError(path: string, error: unknown): string {
  if (isErrno(error, "ENOENT")) {
    return `File not found: ${path}`;
  }
  if (isErrno(error, "EACCES") || isErrno(error, "EPERM")) {
    return `Permission denied: ${path}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
