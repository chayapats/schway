import { Type, type Static } from "@sinclair/typebox";
import { spillFilePath, unlessCancelled, type CoreToolAccess } from "./backend.ts";
import { abortError } from "./fs.ts";
import { localToolAccess } from "./local-backend.ts";
import { TOOL_OUTPUT_BUDGET_BYTES, utf8ByteLength, utf8Prefix } from "./output-budget.ts";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "./types.ts";

/** Combined stdout/stderr UTF-8 byte cap before exit metadata and truncation notices are added. */
export const MAX_BASH_BYTES = TOOL_OUTPUT_BUDGET_BYTES;

/**
 * Accept a nonempty shell command with optional cwd and positive millisecond timeout, rejecting unknown keys.
 * Compiled once when the tool is registered.
 */
export const bashInputSchema = Type.Object(
  {
    command: Type.String({
      minLength: 1,
      description: "Shell command to run in a fresh bash process.",
    }),
    cwd: Type.Optional(
      Type.String({
        description:
          "Working directory. Relative paths resolve from the workspace root.",
      }),
    ),
    timeout: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Timeout in milliseconds. The command is killed when it elapses.",
      }),
    ),
  },
  { additionalProperties: false },
);

/** Shell command, optional working directory, and millisecond timeout accepted by the bash schema. */
export type BashInput = Static<typeof bashInputSchema>;

/** Shell exit status and bounded streams with optional timeout flag, full-output spill-file path and byte counts. */
export interface BashDetails {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  outputPath?: string;
  timedOut?: boolean;
  /** UTF-8 bytes of stdout plus stderr kept in the result; set when output is truncated. */
  shownBytes?: number;
  /** UTF-8 bytes of the full stdout plus stderr; set when output is truncated. */
  totalBytes?: number;
}

/** Build the shell-execution definition over a backend; it runs behind an exclusive scheduling barrier. */
export function createBashTool(access: CoreToolAccess): ToolDefinition<BashInput> {
  return {
    name: "bash",
    description:
      "Run a shell command in a fresh bash process. Defaults to the workspace root. A non-zero exit code is ordinary result data, not a tool failure. Output is bounded; oversized output is spilled to a temporary file.",
    inputSchema: bashInputSchema,
    effect: "mutating",
    execution: "exclusive",
    execute: (input, ctx) => unlessCancelled(runBash(access, input, ctx), ctx.signal),
  };
}

/** Shell-execution definition for the CLI, running in this process from the workspace root. */
export const bashTool: ToolDefinition<BashInput> = createBashTool(localToolAccess);

/**
 * Run `command` in a fresh bash shell.
 * Relative `cwd` resolves from the workspace root; each call has its own process and streams live output.
 * Oversized output spills to a temporary file; nonzero exits are result data and timeouts are tool errors.
 * Cancellation terminates the process group and rejects; process or spill-file failures also reject.
 */
export function executeBash(
  input: BashInput,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  return bashTool.execute(input, ctx);
}

async function runBash(
  access: CoreToolAccess,
  input: BashInput,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  if (ctx.signal?.aborted) {
    throw abortError();
  }

  const backend = access.backend(ctx);
  let cwd = backend.workspaceRoot;
  if (input.cwd) {
    const resolved = await access.resolve(backend, input.cwd);
    if (!resolved.ok) return resolved.result;
    cwd = resolved.resolvedPath;
  }

  const env = access.env(ctx);
  const collected = await backend.spawn({
    command: input.command,
    cwd,
    ...(env ? { env } : {}),
    ...(input.timeout !== undefined ? { timeoutMs: input.timeout } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.onOutput ? { onOutput: ctx.onOutput } : {}),
  });
  // A backend that settles after cancellation must not publish its late result.
  if (ctx.signal?.aborted) {
    throw abortError();
  }
  const totalBytes =
    utf8ByteLength(collected.stdout) + utf8ByteLength(collected.stderr);
  const truncated = totalBytes > MAX_BASH_BYTES;
  let outputPath: string | undefined;
  if (truncated) {
    outputPath = spillFilePath(backend);
    await backend.writePrivateFile(
      outputPath,
      `stdout:\n${collected.stdout}\nstderr:\n${collected.stderr}\n`,
    );
  }
  const bounded = boundStreams(
    collected.stdout,
    collected.stderr,
    MAX_BASH_BYTES,
  );

  const details: BashDetails = {
    command: input.command,
    cwd,
    exitCode: collected.exitCode,
    stdout: bounded.stdout,
    stderr: bounded.stderr,
    truncated,
    ...(outputPath ? { outputPath } : {}),
    ...(collected.timedOut ? { timedOut: true } : {}),
    ...(truncated
      ? {
          shownBytes:
            utf8ByteLength(bounded.stdout) + utf8ByteLength(bounded.stderr),
          totalBytes,
        }
      : {}),
  };

  return {
    content: collected.timedOut
      ? `Command timed out after ${input.timeout}ms.\n${formatContent(details)}`
      : formatContent(details),
    details,
    ...(collected.timedOut ? { isError: true } : {}),
  };
}

/** Model-facing summary: exit code plus stdout/stderr. */
function formatContent(details: BashDetails): string {
  const sections = [`Exit code: ${details.exitCode ?? "(none)"}`];
  if (details.stdout.length > 0) {
    sections.push("", "stdout:", details.stdout);
  }
  if (details.stderr.length > 0) {
    sections.push("", "stderr:", details.stderr);
  }
  if (details.truncated && details.outputPath) {
    sections.push(
      "",
      `[Output truncated: showing ${details.shownBytes} of ${details.totalBytes} bytes. Full output: ${details.outputPath}. Use read with offset to see the rest.]`,
    );
  }
  return sections.join("\n");
}

/** Cap combined stdout+stderr at `maxBytes` UTF-8 bytes on code-point boundaries, preferring to keep stdout. */
function boundStreams(
  stdout: string,
  stderr: string,
  maxBytes: number,
): { stdout: string; stderr: string } {
  const stdoutBytes = utf8ByteLength(stdout);
  if (stdoutBytes + utf8ByteLength(stderr) <= maxBytes) {
    return { stdout, stderr };
  }
  if (stdoutBytes >= maxBytes) {
    return { stdout: utf8Prefix(stdout, maxBytes), stderr: "" };
  }
  return { stdout, stderr: utf8Prefix(stderr, maxBytes - stdoutBytes) };
}
