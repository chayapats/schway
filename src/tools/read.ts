import { Type, type Static } from "@sinclair/typebox";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "./types.ts";
import { resolveToolPath } from "./path.ts";

/** Default number of lines returned when the model omits `limit`. */
export const DEFAULT_READ_LINE_LIMIT = 2000;
/** Hard cap on model-facing characters, including line-number prefixes. */
export const MAX_READ_CHARS = 50_000;

/** TypeBox schema for `read`. Compiled once when the tool is registered. */
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

/** Validated arguments for the built-in `read` tool. */
export type ReadInput = Static<typeof readInputSchema>;

/** Structured extras attached to a successful or failed read. */
export interface ReadDetails {
  path: string;
  resolvedPath: string;
  lineCount: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
  nextOffset?: number;
}

/** Built-in file reader. Declares parallel execution. */
export const readTool: ToolDefinition<ReadInput> = {
  name: "read",
  description:
    "Read a file from the workspace with optional offset and limit. Relative paths resolve from the workspace root. Output is line-numbered and bounded.",
  inputSchema: readInputSchema,
  execution: "parallel",
  execute: executeRead,
};

/**
 * Read a file as line-numbered, bounded text.
 * Relative paths resolve from the workspace root. Output never exceeds
 * {@link MAX_READ_CHARS}. AbortSignal cancels an in-flight stream.
 */
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

  const startLine = input.offset ?? 1;
  const limit = input.limit ?? DEFAULT_READ_LINE_LIMIT;
  let scanned;
  try {
    scanned = await scanFileWindow(resolvedPath, startLine, limit, ctx.signal);
  } catch (error) {
    if (ctx.signal?.aborted || isAbortError(error)) {
      throw error instanceof Error ? error : new Error("The operation was aborted");
    }
    return {
      content: filesystemError(input.path, error),
      isError: true,
      details: { path: input.path, resolvedPath },
    };
  }

  if (scanned.binary) {
    return {
      content: `Cannot read binary file: ${input.path}`,
      isError: true,
      details: { path: input.path, resolvedPath },
    };
  }

  if (scanned.lineCount === 0) {
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

  if (startLine > scanned.lineCount) {
    return {
      content: `offset ${startLine} is beyond the end of the file (${scanned.lineCount} lines)`,
      isError: true,
      details: {
        path: input.path,
        resolvedPath,
        lineCount: scanned.lineCount,
        startLine,
        endLine: scanned.lineCount,
        truncated: false,
      } satisfies ReadDetails,
    };
  }

  const requestedEnd = Math.min(scanned.lineCount, startLine - 1 + limit);
  const width = Math.max(6, String(requestedEnd).length);

  const formatted: string[] = [];
  let chars = 0;
  let lastIncluded = startLine - 2;
  let slicedLine = scanned.slicedLine;
  for (const [offset, text] of scanned.window.entries()) {
    const lineNumber = startLine + offset;
    const line = `${String(lineNumber).padStart(width)}|${text}`;
    const extra = (formatted.length === 0 ? 0 : 1) + line.length;
    if (formatted.length > 0 && chars + extra > MAX_READ_CHARS) {
      break;
    }
    if (formatted.length === 0 && extra > MAX_READ_CHARS) {
      formatted.push(line.slice(0, MAX_READ_CHARS));
      lastIncluded = lineNumber - 1;
      chars = MAX_READ_CHARS;
      slicedLine = true;
      break;
    }
    formatted.push(line);
    chars += extra;
    lastIncluded = lineNumber - 1;
  }

  const remainingLines = scanned.lineCount - (lastIncluded + 1);
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
      lineCount: scanned.lineCount,
      startLine,
      endLine: lastIncluded + 1,
      truncated,
      ...(remainingLines > 0 ? { nextOffset } : {}),
    } satisfies ReadDetails,
  };
}

/**
 * Stream the file once: keep only the requested line window in memory and
 * count remaining lines without storing them.
 */
async function scanFileWindow(
  path: string,
  startLine: number,
  limit: number,
  signal?: AbortSignal,
): Promise<{ lineCount: number; window: string[]; slicedLine: boolean; binary: boolean }> {
  const window: string[] = [];
  let lineCount = 0;
  let slicedLine = false;
  for await (const item of iterateFileLines(path, signal)) {
    if ("binary" in item) {
      return { lineCount: 0, window: [], slicedLine: false, binary: true };
    }
    lineCount += 1;
    if (lineCount < startLine || window.length >= limit) {
      continue;
    }
    window.push(item.text);
    if (item.truncated) {
      slicedLine = true;
    }
  }
  return { lineCount, window, slicedLine, binary: false };
}

/** Yield newline-split lines, capping any single line at {@link MAX_READ_CHARS}. */
async function* iterateFileLines(
  path: string,
  signal?: AbortSignal,
): AsyncGenerator<{ text: string; truncated: boolean } | { binary: true }> {
  const stream = createReadStream(path, { signal });
  const decoder = new TextDecoder("utf8");
  let carry = "";
  let skipRestOfLine = false;

  try {
    for await (const chunk of stream) {
      if (signal?.aborted) {
        throw abortError();
      }
      const buffer = chunk as Buffer;
      if (buffer.includes(0)) {
        yield { binary: true };
        return;
      }
      let text = carry + decoder.decode(buffer, { stream: true });
      carry = "";

      if (skipRestOfLine) {
        const newline = text.indexOf("\n");
        if (newline === -1) {
          continue;
        }
        text = text.slice(newline + 1);
        skipRestOfLine = false;
      }

      while (text.length > 0) {
        const newline = text.indexOf("\n");
        if (newline === -1) {
          if (text.length > MAX_READ_CHARS) {
            yield { text: text.slice(0, MAX_READ_CHARS), truncated: true };
            skipRestOfLine = true;
            text = "";
          } else {
            carry = text;
            text = "";
          }
          break;
        }

        const raw = text.slice(0, newline);
        text = text.slice(newline + 1);
        if (raw.length > MAX_READ_CHARS) {
          yield { text: raw.slice(0, MAX_READ_CHARS), truncated: true };
        } else {
          yield { text: raw, truncated: false };
        }
      }
    }

    if (skipRestOfLine) {
      return;
    }
    const tail = carry + decoder.decode();
    if (tail.length > 0) {
      yield {
        text: tail.slice(0, MAX_READ_CHARS),
        truncated: tail.length > MAX_READ_CHARS,
      };
    }
  } finally {
    stream.destroy();
  }
}

/** Error used when an AbortSignal fires during a read. */
function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/** True for AbortError / ABORT_ERR from streams or AbortSignal. */
function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ABORT_ERR")
  );
}

/** Map common filesystem failures to model-visible messages. */
function filesystemError(path: string, error: unknown): string {
  if (isErrno(error, "ENOENT")) {
    return `File not found: ${path}`;
  }
  if (isErrno(error, "EACCES") || isErrno(error, "EPERM")) {
    return `Permission denied: ${path}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Narrow Node/Bun filesystem errors by `code`. */
function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
