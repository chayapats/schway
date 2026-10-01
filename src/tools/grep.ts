import { Type, type Static } from "@sinclair/typebox";
import { stat } from "node:fs/promises";
import { abortError, filesystemError, isAbortError, isErrno } from "./fs.ts";
import { displayToolPath, resolveToolPath } from "./path.ts";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "./types.ts";

/** Default match cap when the model omits `maxResults`. */
export const DEFAULT_GREP_MAX_RESULTS = 100;
/** Character budget for formatted matches before any truncation notice is appended. */
export const MAX_GREP_CHARS = 50_000;

/** Actionable setup text when ripgrep is not installed. */
export const RIPGREP_MISSING_GUIDANCE =
  "ripgrep (rg) was not found on PATH. Install it to use grep, for example:\n  brew install ripgrep\n  apt install ripgrep";

/**
 * Accept a nonempty regex with optional path, glob, case flag, and positive result limit, rejecting unknown keys.
 * Compiled once when the tool is registered.
 */
export const grepInputSchema = Type.Object(
  {
    pattern: Type.String({
      minLength: 1,
      description: "Regular expression to search for.",
    }),
    path: Type.Optional(
      Type.String({
        description:
          "File or directory to search. Relative paths resolve from the workspace root. Defaults to the workspace root.",
      }),
    ),
    glob: Type.Optional(
      Type.String({
        description: 'Optional file glob filter, such as "*.ts".',
      }),
    ),
    ignoreCase: Type.Optional(
      Type.Boolean({
        description: "Case-insensitive search.",
      }),
    ),
    maxResults: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Maximum number of matches to return.",
      }),
    ),
  },
  { additionalProperties: false },
);

/** Regex, search scope, and match-limit options accepted by the grep schema. */
export type GrepInput = Static<typeof grepInputSchema>;

/** Display path and one-based line number locating a match without repeating its text. */
export interface GrepMatch {
  path: string;
  line: number;
}

/** Successful search metadata with the returned match count, truncation state, and optional follow-up locations. */
export interface GrepDetails {
  path: string;
  resolvedPath: string;
  pattern: string;
  matchCount: number;
  truncated: boolean;
  matches?: GrepMatch[];
}

/** Ripgrep-backed content-search definition eligible for parallel scheduling. */
export const grepTool: ToolDefinition<GrepInput> = {
  name: "grep",
  description:
    "Search file contents with a regular expression. Returns path:line:text locations for follow-up reads. Relative paths resolve from the workspace root. Requires ripgrep (rg).",
  inputSchema: grepInputSchema,
  effect: "read-only",
  execution: "parallel",
  execute: executeGrep,
};

/**
 * Search file contents with ripgrep and return bounded path:line:text matches.
 * Relative paths resolve from the workspace root; missing ripgrep, inaccessible paths,
 * and search failures without matches return error results, while detected cancellation rejects.
 */
export async function executeGrep(
  input: GrepInput,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const path = input.path ?? ".";
  const resolvedPath = resolveToolPath(ctx.workspace.root, path);
  const maxResults = input.maxResults ?? DEFAULT_GREP_MAX_RESULTS;

  try {
    await stat(resolvedPath);
  } catch (error) {
    return {
      content: filesystemError(path, error),
      isError: true,
      details: { path, resolvedPath, pattern: input.pattern },
    };
  }

  const rg = Bun.which("rg");
  if (!rg) {
    return {
      content: RIPGREP_MISSING_GUIDANCE,
      isError: true,
      details: { path, resolvedPath, pattern: input.pattern },
    };
  }

  if (ctx.signal?.aborted) {
    throw abortError();
  }

  let collected: Array<{ path: string; line: number; text: string }>;
  let truncated: boolean;
  let stderr: string;
  let exitCode: number;
  try {
    const ran = await runRipgrep(rg, input, path, maxResults, ctx);
    collected = ran.matches;
    truncated = ran.truncated;
    stderr = ran.stderr;
    exitCode = ran.exitCode;
    if (collected.length > maxResults) {
      collected = collected.slice(0, maxResults);
      truncated = true;
    }
  } catch (error) {
    if (ctx.signal?.aborted || isAbortError(error)) {
      throw error instanceof Error ? error : abortError();
    }
    if (isErrno(error, "ENOENT")) {
      return {
        content: RIPGREP_MISSING_GUIDANCE,
        isError: true,
        details: { path, resolvedPath, pattern: input.pattern },
      };
    }
    return {
      content: error instanceof Error ? error.message : String(error),
      isError: true,
      details: { path, resolvedPath, pattern: input.pattern },
    };
  }

  if (exitCode === 2 && collected.length === 0) {
    const detail = stderr.trim() || "Invalid search pattern or inaccessible path";
    return {
      content: detail,
      isError: true,
      details: { path, resolvedPath, pattern: input.pattern },
    };
  }

  const lines: string[] = [];
  const matches: GrepMatch[] = [];
  let chars = 0;
  for (const match of collected) {
    const line = `${match.path}:${match.line}:${match.text}`;
    const extra = (lines.length === 0 ? 0 : 1) + line.length;
    if (lines.length > 0 && chars + extra > MAX_GREP_CHARS) {
      truncated = true;
      break;
    }
    if (lines.length === 0 && extra > MAX_GREP_CHARS) {
      lines.push(line.slice(0, MAX_GREP_CHARS));
      matches.push({ path: match.path, line: match.line });
      truncated = true;
      break;
    }
    lines.push(line);
    matches.push({ path: match.path, line: match.line });
    chars += extra;
  }

  let content = lines.length === 0 ? "(no matches)" : lines.join("\n");
  if (truncated) {
    content +=
      "\n... truncated: stopped early. Narrow with path, glob, maxResults, or a more specific pattern.";
  }

  return {
    content,
    details: {
      path,
      resolvedPath,
      pattern: input.pattern,
      matchCount: matches.length,
      truncated,
      matches,
    } satisfies GrepDetails,
  };
}

/** Spawn ripgrep and collect up to `maxResults` JSON matches. */
async function runRipgrep(
  command: string,
  input: GrepInput,
  path: string,
  maxResults: number,
  ctx: ToolContext,
): Promise<{
  matches: Array<{ path: string; line: number; text: string }>;
  truncated: boolean;
  stderr: string;
  exitCode: number;
}> {
  const args = ["--json", "--no-config"];
  if (input.ignoreCase === true) {
    args.push("-i");
  }
  if (input.glob !== undefined && input.glob.length > 0) {
    args.push("-g", input.glob);
  }
  args.push("--", input.pattern, path);

  const proc = Bun.spawn([command, ...args], {
    cwd: ctx.workspace.root,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    signal: ctx.signal,
  });

  const matches: Array<{ path: string; line: number; text: string }> = [];
  let truncated = false;
  const stdoutTask = readMatches(
    proc.stdout,
    ctx.workspace.root,
    maxResults,
    matches,
    () => {
      truncated = true;
      proc.kill();
    },
    ctx.signal,
  );
  const stderrTask = proc.stderr.text().catch(() => "");

  try {
    await stdoutTask;
  } catch (error) {
    proc.kill();
    if (ctx.signal?.aborted || isAbortError(error)) {
      throw error instanceof Error ? error : abortError();
    }
    if (!truncated) {
      throw error;
    }
  }

  const exitCode = await proc.exited;
  const stderr = await stderrTask;
  return { matches, truncated, stderr, exitCode };
}

/** Parse ripgrep JSON lines until `maxResults` or the stream ends. */
async function readMatches(
  stream: ReadableStream<Uint8Array>,
  workspaceRoot: string,
  maxResults: number,
  matches: Array<{ path: string; line: number; text: string }>,
  onTruncate: () => void,
  signal?: AbortSignal,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  const limit = maxResults + 1;
  for await (const chunk of stream) {
    if (signal?.aborted) {
      throw abortError();
    }
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const match = parseRipgrepMatch(line, workspaceRoot);
      if (!match) {
        continue;
      }
      matches.push(match);
      if (matches.length >= limit) {
        onTruncate();
        return;
      }
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0 && matches.length < limit) {
    const match = parseRipgrepMatch(buffer, workspaceRoot);
    if (match) {
      matches.push(match);
      if (matches.length >= limit) {
        onTruncate();
      }
    }
  }
}

/** Decode one ripgrep `--json` match line into a model-facing hit. */
function parseRipgrepMatch(
  line: string,
  workspaceRoot: string,
): { path: string; line: number; text: string } | undefined {
  if (line.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const object = parsed as {
    type?: unknown;
    data?: {
      path?: { text?: unknown };
      line_number?: unknown;
      lines?: { text?: unknown };
    };
  };
  if (object.type !== "match" || object.data === undefined) {
    return undefined;
  }
  const rawPath = object.data.path?.text;
  const lineNumber = object.data.line_number;
  const text = object.data.lines?.text;
  if (typeof rawPath !== "string" || typeof lineNumber !== "number") {
    return undefined;
  }
  const body =
    typeof text === "string" ? text.replace(/[\r\n]+$/, "") : "";
  return {
    path: displayToolPath(workspaceRoot, resolveToolPath(workspaceRoot, rawPath)),
    line: lineNumber,
    text: body,
  };
}

