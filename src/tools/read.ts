import { Type, type Static } from "@sinclair/typebox";
import { unlessCancelled, type CoreToolAccess, type ExecutionBackend } from "./backend.ts";
import {
  abortError,
  filesystemError,
  isAbortError,
} from "./fs.ts";
import { localToolAccess } from "./local-backend.ts";
import { TOOL_OUTPUT_BUDGET_BYTES, utf8ByteLength, utf8Prefix } from "./output-budget.ts";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "./types.ts";

/** Default number of lines returned when the model omits `limit`. */
export const DEFAULT_READ_LINE_LIMIT = 2000;
/** UTF-8 byte budget for numbered file text before any truncation notice is appended. */
export const MAX_READ_BYTES = TOOL_OUTPUT_BUDGET_BYTES;

/**
 * Accept a file path with optional positive line offset and limit, rejecting unknown keys during validation.
 * Compiled once when the tool is registered.
 */
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

/** File path and optional one-based offset and line count accepted by the read schema. */
export type ReadInput = Static<typeof readInputSchema>;

/** Read-window metadata with total line count, truncation state, and optional continuation offset. */
export interface ReadDetails {
  path: string;
  resolvedPath: string;
  lineCount: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
  nextOffset?: number;
}

/** Build the file-reading definition over a backend; it is eligible for parallel scheduling. */
export function createReadTool(access: CoreToolAccess): ToolDefinition<ReadInput> {
  return {
    name: "read",
    description:
      "Read a file from the workspace with optional offset and limit. Relative paths resolve from the workspace root. Output is line-numbered and bounded.",
    inputSchema: readInputSchema,
    effect: "read-only",
    execution: "parallel",
    execute: (input, ctx) => unlessCancelled(runRead(access, input, ctx), ctx.signal),
  };
}

/** File-reading definition for the CLI, reading in this process from the workspace root. */
export const readTool: ToolDefinition<ReadInput> = createReadTool(localToolAccess);

/**
 * Read a file as line-numbered, bounded text.
 * Relative paths resolve from the workspace root; numbered text uses the
 * {@link MAX_READ_BYTES} budget before a truncation notice is appended.
 * File, binary-content, and offset failures return error results; stream cancellation rejects.
 */
export function executeRead(
  input: ReadInput,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  return readTool.execute(input, ctx);
}

async function runRead(
  access: CoreToolAccess,
  input: ReadInput,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const backend = access.backend(ctx);
  const resolved = await access.resolve(backend, input.path, { spillFile: true });
  if (!resolved.ok) return resolved.result;
  const resolvedPath = resolved.resolvedPath;
  let info;
  try {
    info = await backend.stat(resolvedPath);
  } catch (error) {
    return {
      content: filesystemError(input.path, error),
      isError: true,
      details: { path: input.path, resolvedPath },
    };
  }

  if (info.type === "directory") {
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
    scanned = await scanFileWindow(backend, resolvedPath, startLine, limit, ctx.signal);
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
  let bytes = 0;
  let lastIncluded = startLine - 2;
  let slicedLine = scanned.slicedLine;
  for (const [offset, text] of scanned.window.entries()) {
    const lineNumber = startLine + offset;
    const line = `${String(lineNumber).padStart(width)}|${text}`;
    const extra = (formatted.length === 0 ? 0 : 1) + utf8ByteLength(line);
    if (formatted.length > 0 && bytes + extra > MAX_READ_BYTES) {
      break;
    }
    if (formatted.length === 0 && extra > MAX_READ_BYTES) {
      formatted.push(utf8Prefix(line, MAX_READ_BYTES));
      lastIncluded = lineNumber - 1;
      bytes = MAX_READ_BYTES;
      slicedLine = true;
      break;
    }
    formatted.push(line);
    bytes += extra;
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
  backend: ExecutionBackend,
  path: string,
  startLine: number,
  limit: number,
  signal?: AbortSignal,
): Promise<{ lineCount: number; window: string[]; slicedLine: boolean; binary: boolean }> {
  const window: string[] = [];
  let lineCount = 0;
  let slicedLine = false;
  for await (const item of iterateFileLines(backend, path, signal)) {
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

/** Yield newline-split lines, capping any single line at {@link MAX_READ_BYTES} UTF-8 bytes on a code-point boundary. */
async function* iterateFileLines(
  backend: ExecutionBackend,
  path: string,
  signal?: AbortSignal,
): AsyncGenerator<{ text: string; truncated: boolean } | { binary: true }> {
  const stream = backend.readFile(path, signal ? { signal } : undefined);
  const decoder = new TextDecoder("utf8");
  let carry = "";
  let skipRestOfLine = false;

  // Leaving the loop early closes the backend iterator, which releases the file.
  for await (const chunk of stream) {
    if (signal?.aborted) {
      throw abortError();
    }
    if (chunk.includes(0)) {
      yield { binary: true };
      return;
    }
    let text = carry + decoder.decode(chunk, { stream: true });
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
        // Carried text stays under the budget in UTF-16 units, which bounds memory; the byte cut happens when the line ends.
        if (text.length > MAX_READ_BYTES) {
          yield { text: utf8Prefix(text, MAX_READ_BYTES), truncated: true };
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
      if (utf8ByteLength(raw) > MAX_READ_BYTES) {
        yield { text: utf8Prefix(raw, MAX_READ_BYTES), truncated: true };
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
    const truncated = utf8ByteLength(tail) > MAX_READ_BYTES;
    yield {
      text: truncated ? utf8Prefix(tail, MAX_READ_BYTES) : tail,
      truncated,
    };
  }
}

