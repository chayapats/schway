import { Type, type Static } from "@sinclair/typebox";
import { unlessCancelled, type CoreToolAccess } from "./backend.ts";
import { abortError, filesystemError, isAbortError, isErrno } from "./fs.ts";
import { localToolAccess } from "./local-backend.ts";
import { TOOL_OUTPUT_BUDGET_BYTES, utf8ByteLength, utf8Prefix } from "./output-budget.ts";
import { displayToolPath, resolveToolPath } from "./path.ts";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "./types.ts";

/** Default match cap when the model omits `maxResults`. */
export const DEFAULT_GREP_MAX_RESULTS = 100;
/** UTF-8 byte budget for formatted matches before any truncation notice is appended. */
export const MAX_GREP_BYTES = TOOL_OUTPUT_BUDGET_BYTES;

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

/** Build the content-search definition over a backend; it is eligible for parallel scheduling. */
export function createGrepTool(access: CoreToolAccess): ToolDefinition<GrepInput> {
  return {
    name: "grep",
    description:
      "Search file contents with a regular expression. Returns path:line:text locations for follow-up reads. Relative paths resolve from the workspace root. Requires ripgrep (rg).",
    inputSchema: grepInputSchema,
    effect: "read-only",
    execution: "parallel",
    execute: (input, ctx) => unlessCancelled(runGrep(access, input, ctx), ctx.signal),
  };
}

/** Ripgrep-backed content-search definition for the CLI, searching in this process from the workspace root. */
export const grepTool: ToolDefinition<GrepInput> = createGrepTool(localToolAccess);

/**
 * Search file contents with ripgrep and return bounded path:line:text matches.
 * Relative paths resolve from the workspace root; missing ripgrep, inaccessible paths,
 * and search failures without matches return error results, while detected cancellation rejects.
 */
export function executeGrep(
  input: GrepInput,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  return grepTool.execute(input, ctx);
}

async function runGrep(
  access: CoreToolAccess,
  input: GrepInput,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const path = input.path ?? ".";
  const backend = access.backend(ctx);
  const root = backend.workspaceRoot;
  const resolved = await access.resolve(backend, path);
  if (!resolved.ok) return resolved.result;
  const resolvedPath = resolved.resolvedPath;
  const maxResults = input.maxResults ?? DEFAULT_GREP_MAX_RESULTS;

  try {
    await backend.stat(resolvedPath);
  } catch (error) {
    return {
      content: filesystemError(path, error),
      isError: true,
      details: { path, resolvedPath, pattern: input.pattern },
    };
  }

  let collected: Array<{ path: string; line: number; text: string }>;
  let truncated: boolean;
  let failure: string | undefined;
  try {
    const ran = await backend.search({
      pattern: input.pattern,
      path: resolvedPath,
      cwd: root,
      ...(input.glob !== undefined ? { glob: input.glob } : {}),
      ...(input.ignoreCase !== undefined ? { ignoreCase: input.ignoreCase } : {}),
      limit: maxResults + 1,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (ctx.signal?.aborted) {
      throw abortError();
    }
    collected = ran.matches.map(match => ({
      path: displayToolPath(root, resolveToolPath(root, match.path)),
      line: match.line,
      text: match.text,
    }));
    truncated = ran.truncated;
    failure = ran.failure;
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

  if (failure !== undefined && collected.length === 0) {
    const detail = failure.trim() || "Invalid search pattern or inaccessible path";
    return {
      content: detail,
      isError: true,
      details: { path, resolvedPath, pattern: input.pattern },
    };
  }

  const lines: string[] = [];
  const matches: GrepMatch[] = [];
  let bytes = 0;
  for (const match of collected) {
    const line = `${match.path}:${match.line}:${match.text}`;
    const extra = (lines.length === 0 ? 0 : 1) + utf8ByteLength(line);
    if (lines.length > 0 && bytes + extra > MAX_GREP_BYTES) {
      truncated = true;
      break;
    }
    if (lines.length === 0 && extra > MAX_GREP_BYTES) {
      lines.push(utf8Prefix(line, MAX_GREP_BYTES));
      matches.push({ path: match.path, line: match.line });
      truncated = true;
      break;
    }
    lines.push(line);
    matches.push({ path: match.path, line: match.line });
    bytes += extra;
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
