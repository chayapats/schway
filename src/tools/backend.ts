import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { filesystemError, isErrno } from "./fs.ts";
import { resolveToolPath } from "./path.ts";
import type { ToolContext, ToolExecutionResult, ToolOutputChunk } from "./types.ts";

/** Entry kind after following symlinks; anything that is neither a regular file nor a directory is `other`. */
export type ExecutionEntryType = "file" | "directory" | "other";

/** Followed-symlink metadata for one backend path. */
export interface ExecutionStat {
  readonly type: ExecutionEntryType;
}

/** One directory entry described by its own type, without following a symlink entry. */
export interface ExecutionDirectoryEntry {
  readonly name: string;
  readonly type: ExecutionEntryType | "symlink";
}

/**
 * Backend-issued observation of one path. Schway passes the same object back to
 * `writeFileAtomically` so the backend can refuse a replacement after a concurrent change.
 */
export interface ExecutionFileObservation {
  /** False when the entry exists but its target does not, such as a dangling symlink. */
  readonly targetExists: boolean;
  /** Observed file bytes, present only when content was requested and the target exists. */
  readonly bytes?: Uint8Array;
}

/** One shell command for `spawn`; the backend owns the process and its termination. */
export interface ExecutionSpawnRequest {
  /** Command text run by `bash -c` in a fresh process. */
  readonly command: string;
  /** Absolute backend working directory, already checked by Schway. */
  readonly cwd: string;
  /** Subprocess environment; when absent the backend applies its own default. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Positive millisecond limit after which the backend terminates the command and reports `timedOut`. */
  readonly timeoutMs?: number;
  /** Cancellation; the backend terminates the command and rejects with an `AbortError`. */
  readonly signal?: AbortSignal;
  /** Live decoded output in arrival order. */
  readonly onOutput?: (chunk: ToolOutputChunk) => void;
}

/** Complete decoded process output; Schway applies its own byte bounds and spill files. */
export interface ExecutionSpawnResult {
  readonly stdout: string;
  readonly stderr: string;
  /** Exit status, or null when the process ended by a signal. A non-zero code is data, not a rejection. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

/** One regular-expression content search rooted at `path`. */
export interface ExecutionSearchRequest {
  readonly pattern: string;
  /** Absolute backend file or directory to search, already checked by Schway. */
  readonly path: string;
  /** Absolute backend directory that relative match paths are reported against. */
  readonly cwd: string;
  readonly glob?: string;
  readonly ignoreCase?: boolean;
  /** Stop after this many matches and report `truncated`. */
  readonly limit: number;
  readonly signal?: AbortSignal;
}

/** One matching line; `path` is absolute or relative to the request `cwd`. */
export interface ExecutionSearchMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/** Search outcome; `failure` carries diagnostic text when the search itself failed. */
export interface ExecutionSearchResult {
  readonly matches: readonly ExecutionSearchMatch[];
  readonly truncated: boolean;
  readonly failure?: string;
}

/**
 * Where core tools read, write, list, search and run commands.
 *
 * Paths are absolute backend paths. Schway resolves model paths against `workspaceRoot`,
 * refuses `..` and symlink escapes using `realpath`, and applies output bounds; a backend
 * never sees an unchecked model path. Failures reject with a Node-style `code` such as
 * `ENOENT`, `EACCES`, `EPERM`, `EISDIR` or `ENOTDIR`; a stale observation rejects with
 * `ECHANGED`, and an unavailable search program rejects `search` with `ENOENT`.
 * The backend is trusted host code, not a Schway sandbox.
 */
export interface ExecutionBackend {
  /** Absolute primary workspace root in backend paths. */
  readonly workspaceRoot: string;
  /** Absolute backend directory for private bash full-output spill files. */
  readonly temporaryDirectory: string;
  /** Resolve every symlink in an existing path; reject `ENOENT` when it does not exist. */
  realpath(path: string): Promise<string>;
  /** Describe a path after following symlinks. */
  stat(path: string): Promise<ExecutionStat>;
  /** Stream a file's bytes; stopping iteration releases the file. */
  readFile(path: string, options?: { readonly signal?: AbortSignal }): AsyncIterable<Uint8Array>;
  /** Observe a path for a later fenced replacement, reading bytes when `content` is set; null when no entry exists. */
  observeFile(path: string, options?: { readonly content?: boolean; readonly signal?: AbortSignal }): Promise<ExecutionFileObservation | null>;
  /**
   * Atomically replace the path's own entry; a final symlink is replaced, never followed. With `observed`, reject
   * `ECHANGED` when the path no longer matches that observation (null means it must still be absent);
   * `createParents` creates missing parent directories.
   */
  writeFileAtomically(path: string, content: string, options?: {
    readonly observed?: ExecutionFileObservation | null;
    readonly createParents?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  /** Create or replace an owner-only file in `temporaryDirectory`. */
  writePrivateFile(path: string, content: string): Promise<void>;
  /** List one directory level in any order. */
  list(path: string, options?: { readonly signal?: AbortSignal }): Promise<readonly ExecutionDirectoryEntry[]>;
  /** Yield regular files under `cwd` matching a glob, as paths relative to `cwd`, without following symlinks. */
  glob(pattern: string, options: { readonly cwd: string; readonly signal?: AbortSignal }): AsyncIterable<string>;
  /** Search file contents with a regular expression. */
  search(request: ExecutionSearchRequest): Promise<ExecutionSearchResult>;
  /** Run one shell command to completion. */
  spawn(request: ExecutionSpawnRequest): Promise<ExecutionSpawnResult>;
}

/** Options for host-built core tools. */
export interface CoreToolOptions {
  /** Subprocess environment for `bash`; when absent the per-call tool environment, then the backend default, applies. */
  readonly env?: Readonly<Record<string, string>>;
}

/** A model path resolved to a backend path, or the model-visible refusal. */
export type CorePathResolution =
  | { readonly ok: true; readonly resolvedPath: string }
  | { readonly ok: false; readonly result: ToolExecutionResult };

/** How one core tool family reaches its backend and checks model paths. */
export interface CoreToolAccess {
  /** Select the backend for one invocation. */
  backend(ctx: ToolContext): ExecutionBackend;
  /** Resolve a model path against the backend root, refusing escapes when the family is confined. */
  resolve(backend: ExecutionBackend, path: string, options?: { readonly spillFile?: boolean }): Promise<CorePathResolution>;
  /** Subprocess environment for one invocation. */
  env(ctx: ToolContext): Readonly<Record<string, string | undefined>> | undefined;
}

/** Spill-file names that `read` may open in the backend's temporary directory under confinement. */
const SPILL_FILE = /^schway-bash-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.log$/;

/** Name a fresh bash spill file in the backend's temporary directory. */
export function spillFilePath(backend: ExecutionBackend): string {
  return join(backend.temporaryDirectory, `schway-bash-${crypto.randomUUID()}.log`);
}

/** Resolve lexically from the backend root without refusing any path, as the CLI always has. */
export function unconfinedAccess(
  backend: (ctx: ToolContext) => ExecutionBackend,
): CoreToolAccess {
  return {
    backend,
    async resolve(selected, path) {
      return { ok: true, resolvedPath: resolveToolPath(selected.workspaceRoot, path) };
    },
    env: ctx => ctx.env,
  };
}

/**
 * Confine model paths to the backend workspace root. Lexical `..` escapes are refused before any
 * backend call; symlink escapes are refused after `realpath` and before any read, write or spawn.
 */
export function confinedAccess(backend: ExecutionBackend, options: CoreToolOptions = {}): CoreToolAccess {
  return {
    backend: () => backend,
    resolve: (selected, path, resolveOptions) => confinePath(selected, path, resolveOptions?.spillFile === true),
    env: ctx => options.env ?? ctx.env,
  };
}

async function confinePath(backend: ExecutionBackend, path: string, allowSpill: boolean): Promise<CorePathResolution> {
  const root = resolve(backend.workspaceRoot);
  const resolvedPath = resolveToolPath(root, path);
  const refused = (): CorePathResolution => ({
    ok: false,
    result: { content: `Path is outside the workspace: ${path}`, isError: true, details: { path, resolvedPath } },
  });
  const spill = allowSpill && SPILL_FILE.test(basename(resolvedPath))
    && dirname(resolvedPath) === resolve(backend.temporaryDirectory);
  if (!spill && !within(root, resolvedPath)) return refused();
  try {
    if (spill) {
      const real = await backend.realpath(resolvedPath);
      const directory = await backend.realpath(backend.temporaryDirectory);
      return real === join(directory, basename(resolvedPath)) ? { ok: true, resolvedPath } : refused();
    }
    const realRoot = await backend.realpath(root);
    const real = await realExistingPath(backend, root, resolvedPath);
    return within(realRoot, real) ? { ok: true, resolvedPath } : refused();
  } catch (error) {
    return { ok: false, result: { content: filesystemError(path, error), isError: true, details: { path, resolvedPath } } };
  }
}

/** Resolve symlinks through the deepest existing ancestor, appending the missing tail unchanged. */
async function realExistingPath(backend: ExecutionBackend, root: string, path: string): Promise<string> {
  const missing: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    try {
      const real = await backend.realpath(current);
      return missing.length === 0 ? real : join(real, ...missing.reverse());
    } catch (error) {
      if (!(isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) || current === root || dirname(current) === current) throw error;
      missing.push(basename(current));
    }
  }
}

/** True when `path` is `root` or lies beneath it. */
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
