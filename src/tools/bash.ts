import { Type, type Static } from "@sinclair/typebox";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { abortError } from "./fs.ts";
import { resolveToolPath } from "./path.ts";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "./types.ts";

/** Combined stdout/stderr character cap before exit metadata and truncation notices are added. */
export const MAX_BASH_CHARS = 50_000;

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

/** Shell exit status and bounded streams with optional timeout flag and full-output spill-file path. */
export interface BashDetails {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  outputPath?: string;
  timedOut?: boolean;
}

/** Shell-execution definition that runs behind an exclusive scheduling barrier. */
export const bashTool: ToolDefinition<BashInput> = {
  name: "bash",
  description:
    "Run a shell command in a fresh bash process. Defaults to the workspace root. A non-zero exit code is ordinary result data, not a tool failure. Output is bounded; oversized output is spilled to a temporary file.",
  inputSchema: bashInputSchema,
  effect: "mutating",
  execution: "exclusive",
  execute: executeBash,
};

/**
 * Run `command` in a fresh bash shell.
 * Relative `cwd` resolves from the workspace root; each call has its own process and streams live output.
 * Oversized output spills to a temporary file; nonzero exits are result data and timeouts are tool errors.
 * Cancellation terminates the process group and rejects; process or spill-file failures also reject.
 */
export async function executeBash(
  input: BashInput,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  if (ctx.signal?.aborted) {
    throw abortError();
  }

  const cwd = input.cwd
    ? resolveToolPath(ctx.workspace.root, input.cwd)
    : ctx.workspace.root;

  const collected = await runShell(input.command, cwd, input.timeout, ctx);
  const truncated =
    collected.stdout.length + collected.stderr.length > MAX_BASH_CHARS;
  let outputPath: string | undefined;
  if (truncated) {
    outputPath = join(tmpdir(), `schway-bash-${crypto.randomUUID()}.log`);
    await writeFile(
      outputPath,
      `stdout:\n${collected.stdout}\nstderr:\n${collected.stderr}\n`,
      { mode: 0o600 },
    );
    await chmod(outputPath, 0o600);
  }
  const bounded = boundStreams(
    collected.stdout,
    collected.stderr,
    MAX_BASH_CHARS,
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
  };

  return {
    content: collected.timedOut
      ? `Command timed out after ${input.timeout}ms.\n${formatContent(details)}`
      : formatContent(details),
    details,
    ...(collected.timedOut ? { isError: true } : {}),
  };
}

interface ShellOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/** Spawn a fresh bash process, stream chunks, and wait for exit. */
async function runShell(
  command: string,
  cwd: string,
  timeout: number | undefined,
  ctx: ToolContext,
): Promise<ShellOutput> {
  let child: ChildProcess | undefined;
  let pgid: number | undefined;
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

  const killTree = (signal: NodeJS.Signals) => {
    if (pgid === undefined) {
      return;
    }
    try {
      process.kill(-pgid, signal);
    } catch {
      try {
        child?.kill(signal);
      } catch {
        // already exited
      }
    }
  };

  const forceTerminate = () => {
    killTree("SIGKILL");
    // An inherited descriptor can outlive the group; close our handles so collectors settle too.
    child?.stdout?.destroy();
    child?.stderr?.destroy();
  };

  const terminate = () => {
    if (killTimer !== undefined) return;
    killTree("SIGTERM");
    killTimer = setTimeout(forceTerminate, 200);
  };

  const onAbort = () => {
    terminate();
  };
  ctx.signal?.addEventListener("abort", onAbort);

  try {
    if (ctx.signal?.aborted) {
      throw abortError();
    }

    child = spawn("bash", ["-c", command], {
      cwd,
      env: ctx.env ?? process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    pgid = child.pid;

    if (timeout !== undefined) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeout);
    }

    if (ctx.signal?.aborted) {
      terminate();
    }

    const stdout = collectStream(child.stdout, "stdout", ctx);
    const stderr = collectStream(child.stderr, "stderr", ctx);
    const streams = Promise.all([stdout, stderr]);
    // A pipe may fail before process exit; handle it immediately while retaining the original rejection.
    void streams.catch(terminate);
    const drainStreams = async () => {
      const drainTimer = setTimeout(forceTerminate, 200);
      try {
        // A fail-fast rejection must not cancel escalation while the other pipe is still open.
        await Promise.allSettled([stdout, stderr]);
      } finally {
        clearTimeout(drainTimer);
      }
    };

    let exitCode: number | null;
    try {
      exitCode = await new Promise<number | null>((resolve, reject) => {
        const cleanup = () => {
          child!.removeListener("error", onError);
          child!.removeListener("exit", onExit);
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onExit = (code: number | null) => {
          cleanup();
          resolve(code);
        };
        child!.once("error", onError);
        child!.once("exit", onExit);
      });
    } catch (error) {
      terminate();
      await drainStreams();
      throw error;
    }

    await drainStreams();
    const [stdoutText, stderrText] = await streams;
    if (ctx.signal?.aborted) {
      throw abortError();
    }

    return {
      stdout: stdoutText,
      stderr: stderrText,
      exitCode,
      timedOut,
    };
  } finally {
    ctx.signal?.removeEventListener("abort", onAbort);
    if (timeoutTimer !== undefined) {
      clearTimeout(timeoutTimer);
    }
    if (killTimer !== undefined) {
      clearTimeout(killTimer);
    }
  }
}

/** Decode a pipe as UTF-8, forwarding chunks to `onOutput`. */
function collectStream(
  stream: NodeJS.ReadableStream | null | undefined,
  name: "stdout" | "stderr",
  ctx: ToolContext,
): Promise<string> {
  if (!stream) {
    return Promise.resolve("");
  }
  const decoder = new StringDecoder("utf8");
  let text = "";
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      stream.removeListener("data", onData);
      stream.removeListener("error", onError);
      stream.removeListener("end", onFinish);
      stream.removeListener("close", onFinish);
    };
    const onData = (chunk: Buffer | string) => {
      const piece =
        typeof chunk === "string" ? chunk : decoder.write(chunk);
      if (piece.length === 0) {
        return;
      }
      text += piece;
      ctx.onOutput?.({ stream: name, text: piece });
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onFinish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const tail = decoder.end();
      if (tail.length > 0) {
        text += tail;
        ctx.onOutput?.({ stream: name, text: tail });
      }
      resolve(text);
    };
    stream.on("data", onData);
    stream.once("error", onError);
    stream.once("end", onFinish);
    // An unsuccessful spawn can close a pipe without ever emitting end or error.
    stream.once("close", onFinish);
  });
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
    sections.push("", `... truncated. Full output: ${details.outputPath}`);
  }
  return sections.join("\n");
}

/** Cap combined stdout+stderr at `max`, preferring to keep stdout. */
function boundStreams(
  stdout: string,
  stderr: string,
  max: number,
): { stdout: string; stderr: string } {
  if (stdout.length + stderr.length <= max) {
    return { stdout, stderr };
  }
  if (stdout.length >= max) {
    return { stdout: stdout.slice(0, max), stderr: "" };
  }
  return { stdout, stderr: stderr.slice(0, max - stdout.length) };
}
