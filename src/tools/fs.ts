import type { Stats } from "node:fs";
import { lstat, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import type { ToolExecutionResult } from "./types.ts";

/** Create an Error named AbortError for tool cancellation handling. */
export function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/** True for AbortError / ABORT_ERR from streams or AbortSignal. */
export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ABORT_ERR")
  );
}

/** Map common filesystem failures to model-visible messages. */
export function filesystemError(path: string, error: unknown): string {
  if (isErrno(error, "ENOENT")) {
    return `File not found: ${path}`;
  }
  if (isErrno(error, "EACCES") || isErrno(error, "EPERM")) {
    return `Permission denied: ${path}`;
  }
  if (isErrno(error, "EISDIR")) {
    return `Path is a directory: ${path}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Wrap a filesystem failure as model-visible error text with supplied and resolved paths in details. */
export function filesystemFailure(
  path: string,
  resolvedPath: string,
  error: unknown,
): ToolExecutionResult {
  return {
    content: filesystemError(path, error),
    isError: true,
    details: { path, resolvedPath },
  };
}

/** Observed ordinary permissions and identities used to detect later replacement or mutation without requiring read access. */
export interface FileTarget { mode?: number; target: Stats; entry: Stats; bytes?: Buffer }
/** Observed bytes and permissions checked for mutation during the read. */
export interface FileObservation extends FileTarget { bytes: Buffer }

/** Signal an observed filesystem race without claiming an atomic compare-and-swap. */
export class FileChangedError extends Error {
  constructor(path: string) { super(`File changed before replacement: ${path}`); }
}

/** Report only ordinary POSIX permissions, omitting metadata on unsupported Windows filesystems. */
export function ordinaryFileMode(mode: number, platform = process.platform): number | undefined {
  return platform === "win32" ? undefined : mode & 0o777;
}

/** Compare file identities and mutation metadata, excluding access times changed by reading. */
function sameStat(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** Observe a regular destination's permissions and identities, following existing symlinks as file tools do. */
export async function observeFileTarget(path: string): Promise<FileTarget | null> {
  let entry: Stats;
  try { entry = await lstat(path); }
  catch (error) { if (isErrno(error, "ENOENT")) return null; throw error; }
  const target = await stat(path);
  if (!target.isFile()) throw Object.assign(new Error(`Path is not a regular file: ${path}`), { code: target.isDirectory() ? "EISDIR" : "EINVAL" });
  return { mode: ordinaryFileMode(target.mode), target, entry };
}

/** Read bytes and permissions together, rejecting observable races and nonregular targets; only missing entries are absent. */
export async function observeFile(path: string, signal?: AbortSignal): Promise<FileObservation | null> {
  const observed = await observeFileTarget(path);
  if (!observed) return null;
  const bytes = await readFile(path, { signal });
  await assertFileUnchanged(path, observed, signal);
  return { ...observed, bytes };
}

/** Reject changes in bytes, permissions or identity since the supplied observation, including newly created destinations. */
export async function assertFileUnchanged(path: string, expected: FileTarget | null, signal?: AbortSignal): Promise<void> {
  let current: FileTarget | null;
  try { current = expected?.bytes !== undefined ? await observeFile(path, signal) : await observeFileTarget(path); }
  catch (error) { if (isErrno(error, "ENOENT") || isErrno(error, "EISDIR") || isErrno(error, "EINVAL")) throw new FileChangedError(path); throw error; }
  if (expected === null ? current !== null : current === null || !sameStat(expected.entry, current.entry)
    || !sameStat(expected.target, current.target)
    || (expected.bytes !== undefined && (current.bytes === undefined || !expected.bytes.equals(current.bytes)))) throw new FileChangedError(path);
}

/** Publish a complete private temporary write with exact supported final permissions after revalidating the observed destination. */
export async function writeFileAtomically(
  path: string,
  content: string | Uint8Array | AsyncIterable<string | Uint8Array>,
  signal?: AbortSignal,
  beforeReplace?: () => Promise<void>,
  options: { mode?: number; observed?: FileTarget | null } = {},
): Promise<void> {
  if (signal?.aborted) throw abortError();
  const observed = options.observed === undefined ? await observeFileTarget(path) : options.observed;
  const finalMode = options.mode ?? observed?.mode ?? (0o666 & ~process.umask());
  if (!Number.isInteger(finalMode) || finalMode < 0 || finalMode > 0o777) throw new Error("Invalid file permissions");
  const tempPath = `${path}.${crypto.randomUUID()}.tmp`;
  let owned = false;
  try {
    const handle = await open(tempPath, "wx", 0o600);
    owned = true;
    try {
      await writeFile(handle, content, { signal });
      if (signal?.aborted) throw abortError();
      if (process.platform !== "win32") await handle.chmod(finalMode);
    } finally { await handle.close(); }
    if (beforeReplace) await beforeReplace();
    await assertFileUnchanged(path, observed, signal);
    if (signal?.aborted) throw abortError();
    await rename(tempPath, path);
  } catch (error) {
    if (owned) await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

/** Narrow Node/Bun filesystem errors by `code`. */
export function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
