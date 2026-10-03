import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
export interface FileTarget { mode?: number; target: Stats | null; entry: Stats; bytes?: Buffer }
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

/** Compare inode and mode, plus byte-mutation metadata for regular files and links rather than consumed streams. */
function sameStat(a: Stats | null, b: Stats | null): boolean {
  if (a === null || b === null) return a === b;
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
    && (!(a.isFile() || a.isSymbolicLink()) || (a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs));
}

/** Observe replaceable entries independently from their targets, preserving dangling links and nonregular write destinations. */
export async function observeFileTarget(path: string): Promise<FileTarget | null> {
  let entry: Stats;
  try { entry = await lstat(path); }
  catch (error) { if (isErrno(error, "ENOENT")) return null; throw error; }
  let target: Stats | null;
  try { target = await stat(path); }
  catch (error) { if (entry.isSymbolicLink() && isErrno(error, "ENOENT")) target = null; else throw error; }
  if (target?.isDirectory()) throw Object.assign(new Error(`Path is a directory: ${path}`), { code: "EISDIR" });
  return { mode: target?.isFile() ? ordinaryFileMode(target.mode) : undefined, target, entry };
}

/** Read bytes and permissions with race checks, optionally requiring a regular entry for undo previews. */
export async function observeFile(path: string, signal?: AbortSignal, options: { regularOnly?: boolean } = {}): Promise<FileObservation | null> {
  const observed = await observeFileTarget(path);
  if (!observed?.target) return null;
  if (options.regularOnly && (!observed.entry.isFile() || !observed.target.isFile())) throw Object.assign(new Error(`Path is not a regular file: ${path}`), { code: "EINVAL" });
  const bytes = await readFile(path, { signal });
  await assertFileUnchanged(path, observed, signal);
  return { ...observed, bytes };
}

/** Reject changes in bytes, permissions or identity since the supplied observation, including newly created destinations. */
export async function assertFileUnchanged(path: string, expected: FileTarget | null, signal?: AbortSignal): Promise<void> {
  let current: FileTarget | null;
  try { current = await observeFileTarget(path); }
  catch (error) { if (isErrno(error, "ENOENT") || isErrno(error, "EISDIR") || isErrno(error, "EINVAL")) throw new FileChangedError(path); throw error; }
  if (expected === null ? current !== null : current === null || !sameStat(expected.entry, current.entry)
    || !sameStat(expected.target, current.target)) throw new FileChangedError(path);
  // Nonregular streams retain the historical single read; reading a FIFO again could wait for another writer.
  if (expected?.bytes !== undefined && expected.target?.isFile()) {
    const metadata = { ...expected, bytes: undefined };
    let bytes: Buffer;
    try { bytes = await readFile(path, { signal }); }
    catch (error) {
      // A chmod or replacement during the read is a conflict, while unchanged-target I/O failures remain failures.
      await assertFileUnchanged(path, metadata, signal);
      throw error;
    }
    await assertFileUnchanged(path, metadata, signal);
    if (!expected.bytes.equals(bytes)) throw new FileChangedError(path);
  }
}

interface DirectoryObservation { path: string; info: Stats }

/** Check ordinary POSIX evidence that another UID cannot replace the staging pathname. */
async function stagingParent(path: string): Promise<{ path: string; ancestors: DirectoryObservation[] }> {
  const parent = await realpath(dirname(path));
  if (process.platform === "win32") return { path: parent, ancestors: [] };
  const paths: string[] = [];
  for (let current = parent; ; current = dirname(current)) {
    paths.unshift(current);
    if (dirname(current) === current) break;
  }
  const ancestors: DirectoryObservation[] = [];
  let exposed = true;
  for (const current of paths) {
    const info = await lstat(current);
    if (!info.isDirectory()) throw new FileChangedError(current);
    if (exposed) {
      const trustedOwner = info.uid === process.geteuid!() || info.uid === 0;
      const writable = (info.mode & 0o030) === 0o030 || (info.mode & 0o003) === 0o003;
      if (!trustedOwner || (writable && !(info.mode & 0o1000))) {
        throw new Error(`Cannot safely prepare file replacement in ${current}: another user can replace temporary paths. Use a directory protected from other users.`);
      }
      // A protected ancestor also protects shared-writable descendants from path traversal.
      exposed = (info.mode & 0o011) !== 0;
    }
    ancestors.push({ path: current, info });
  }
  return { path: parent, ancestors };
}

/** Reject observed directory replacement or access changes without following a substituted final symlink. */
async function assertDirectoryUnchanged(observed: DirectoryObservation): Promise<void> {
  const current = await lstat(observed.path);
  if (!current.isDirectory() || !sameIdentity(observed.info, current)
    || observed.info.mode !== current.mode || observed.info.uid !== current.uid || observed.info.gid !== current.gid) {
    throw new FileChangedError(observed.path);
  }
}

function sameIdentity(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }

/** Stage bytes behind protected traversal and atomically publish supported permissions after revalidating the destination. */
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
  const parent = await stagingParent(path);
  const staging = `${join(parent.path, basename(path))}.${crypto.randomUUID()}.tmp`;
  const tempPath = join(staging, "content.tmp");
  let directory: DirectoryObservation | undefined, ownedFile: Stats | undefined;
  const assertStagingUnchanged = async () => {
    for (const ancestor of parent.ancestors) await assertDirectoryUnchanged(ancestor);
    if (directory) await assertDirectoryUnchanged(directory);
  };
  try {
    await assertStagingUnchanged();
    await mkdir(staging, { mode: 0o700 });
    const info = await lstat(staging);
    if (!info.isDirectory() || (process.platform !== "win32" && (info.uid !== process.geteuid!() || (info.mode & 0o077)))) {
      throw new FileChangedError(staging);
    }
    directory = { path: staging, info };
    // Restore owner access stripped by umask while retaining the parent's inherited group behavior.
    await assertStagingUnchanged();
    if (process.platform !== "win32") {
      const mode = 0o700 | (info.mode & 0o2000);
      await chmod(staging, mode);
      directory = { path: staging, info: Object.assign(info, { mode: (info.mode & ~0o7777) | mode }) };
    }
    await assertStagingUnchanged();
    const handle = await open(tempPath, "wx", 0o600);
    try {
      ownedFile = await handle.stat();
      await writeFile(handle, content, { signal });
      if (signal?.aborted) throw abortError();
      await assertStagingUnchanged();
      if (process.platform !== "win32") await handle.chmod(finalMode);
    } finally { await handle.close(); }
    if (beforeReplace) await beforeReplace();
    await assertFileUnchanged(path, observed, signal);
    await assertStagingUnchanged();
    if (signal?.aborted) throw abortError();
    await rename(tempPath, path);
    ownedFile = undefined;
  } finally {
    // A replaced staging path is no longer ours to traverse or remove. Cleanup never recurses.
    if (directory && await lstat(staging).then(info => info.isDirectory() && sameIdentity(directory!.info, info), () => false)) {
      if (ownedFile && await lstat(tempPath).then(info => sameIdentity(ownedFile!, info), () => false)) await unlink(tempPath).catch(() => undefined);
      await rmdir(staging).catch(() => undefined);
    }
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
