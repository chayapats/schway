import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  unconfinedAccess,
  type CoreToolAccess,
  type ExecutionBackend,
  type ExecutionFileObservation,
  type ExecutionSearchMatch,
  type ExecutionSearchRequest,
  type ExecutionSearchResult,
  type ExecutionSpawnRequest,
  type ExecutionSpawnResult,
} from "./backend.ts";
import {
  abortError,
  isAbortError,
  observeFile,
  observeFileTarget,
  writeFileAtomically,
  type FileTarget,
} from "./fs.ts";

/** Internal observations behind the public objects handed to tools. */
const observations = new WeakMap<ExecutionFileObservation, FileTarget>();

/** Run core tools in this process with Node/Bun filesystem and process APIs, exactly as the CLI does. */
export function localExecutionBackend(workspaceRoot: string): ExecutionBackend {
  if (typeof workspaceRoot !== "string" || !isAbsolute(workspaceRoot)) {
    throw new TypeError("workspaceRoot must be an absolute path");
  }
  return createLocalBackend(workspaceRoot);
}

/** Build the local backend for an already-trusted root without validating it. */
export function createLocalBackend(workspaceRoot: string): ExecutionBackend {
  return {
    workspaceRoot,
    get temporaryDirectory() { return tmpdir(); },
    realpath: path => realpath(path),
    async stat(path) {
      const info = await stat(path);
      return { type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other" };
    },
    readFile: (path, options) => createReadStream(path, { signal: options?.signal }),
    async observeFile(path, options) {
      const observed = options?.content
        ? await observeFile(path, options.signal)
        : await observeFileTarget(path);
      if (!observed) return null;
      const observation: ExecutionFileObservation = {
        targetExists: observed.target !== null,
        ...(observed.bytes ? { bytes: observed.bytes } : {}),
      };
      observations.set(observation, observed);
      return observation;
    },
    async writeFileAtomically(path, content, options = {}) {
      let observed: FileTarget | null | undefined;
      if (options.observed !== undefined && options.observed !== null) {
        observed = observations.get(options.observed);
        if (!observed) throw new TypeError("File observation was not issued by this backend");
      } else observed = options.observed;
      if (options.createParents) await mkdir(dirname(path), { recursive: true });
      await writeFileAtomically(path, content, options.signal, undefined, observed === undefined ? {} : { observed });
    },
    async writePrivateFile(path, content) {
      await writeFile(path, content, { mode: 0o600 });
      await chmod(path, 0o600);
    },
    async list(path) {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map(entry => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : entry.isFile() ? "file" : "other",
      }));
    },
    glob(pattern, options) {
      return new Bun.Glob(pattern).scan({ cwd: options.cwd, onlyFiles: true, followSymlinks: false });
    },
    search: searchWithRipgrep,
    spawn: runShell,
  };
}

/** CLI access: a local backend at each call's workspace root, resolving paths lexically without confinement. */
export const localToolAccess: CoreToolAccess = unconfinedAccess(ctx => createLocalBackend(ctx.workspace.root));

/** Search with ripgrep, collecting at most `limit` JSON matches. */
async function searchWithRipgrep(request: ExecutionSearchRequest): Promise<ExecutionSearchResult> {
  const rg = Bun.which("rg");
  if (!rg) throw Object.assign(new Error("ripgrep (rg) was not found on PATH"), { code: "ENOENT" });
  if (request.signal?.aborted) {
    throw abortError();
  }

  const args = ["--json", "--no-config"];
  if (request.ignoreCase === true) {
    args.push("-i");
  }
  if (request.glob !== undefined && request.glob.length > 0) {
    args.push("-g", request.glob);
  }
  args.push("--", request.pattern, request.path);

  const proc = Bun.spawn([rg, ...args], {
    cwd: request.cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    signal: request.signal,
  });

  const matches: ExecutionSearchMatch[] = [];
  let truncated = false;
  const stdoutTask = readMatches(
    proc.stdout,
    request.limit,
    matches,
    () => {
      truncated = true;
      proc.kill();
    },
    request.signal,
  );
  const stderrTask = proc.stderr.text().catch(() => "");

  try {
    await stdoutTask;
  } catch (error) {
    proc.kill();
    if (request.signal?.aborted || isAbortError(error)) {
      throw error instanceof Error ? error : abortError();
    }
    if (!truncated) {
      throw error;
    }
  }

  const exitCode = await proc.exited;
  const stderr = await stderrTask;
  return { matches, truncated, ...(exitCode === 2 ? { failure: stderr } : {}) };
}

/** Parse ripgrep JSON lines until `limit` or the stream ends. */
async function readMatches(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  matches: ExecutionSearchMatch[],
  onTruncate: () => void,
  signal?: AbortSignal,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    if (signal?.aborted) {
      throw abortError();
    }
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const match = parseRipgrepMatch(line);
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
    const match = parseRipgrepMatch(buffer);
    if (match) {
      matches.push(match);
      if (matches.length >= limit) {
        onTruncate();
      }
    }
  }
}

/** Decode one ripgrep `--json` match line, keeping the path exactly as ripgrep reported it. */
function parseRipgrepMatch(line: string): ExecutionSearchMatch | undefined {
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
  return { path: rawPath, line: lineNumber, text: body };
}

/** Spawn a fresh bash process, stream chunks, and wait for exit. */
async function runShell(request: ExecutionSpawnRequest): Promise<ExecutionSpawnResult> {
  const { command, cwd, signal: abortSignal, timeoutMs: timeout } = request;
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
  abortSignal?.addEventListener("abort", onAbort);

  try {
    if (abortSignal?.aborted) {
      throw abortError();
    }

    child = spawn("bash", ["-c", command], {
      cwd,
      env: request.env ?? process.env,
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

    if (abortSignal?.aborted) {
      terminate();
    }

    const stdout = collectStream(child.stdout, "stdout", request.onOutput);
    const stderr = collectStream(child.stderr, "stderr", request.onOutput);
    const streams = Promise.all([stdout, stderr]);
    // A pipe may fail before process exit; handle it immediately while retaining the original rejection.
    void streams.catch(terminate);
    const drainStreams = async () => {
      // Stop inherited writers without discarding buffered normal output; failures escalate via terminate.
      const drainTimer = setTimeout(() => killTree("SIGKILL"), 200);
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
    if (abortSignal?.aborted) {
      throw abortError();
    }

    return {
      stdout: stdoutText,
      stderr: stderrText,
      exitCode,
      timedOut,
    };
  } finally {
    abortSignal?.removeEventListener("abort", onAbort);
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
  onOutput: ExecutionSpawnRequest["onOutput"],
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
      onOutput?.({ stream: name, text: piece });
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
        onOutput?.({ stream: name, text: tail });
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
