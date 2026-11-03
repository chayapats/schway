import { Database } from "bun:sqlite";
import { accessSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { credentialLockError, credentialStoreError } from "./store.ts";

/** Environment variable naming an absolute lock-file path that every cooperating Schway process must share. */
export const CREDENTIAL_LOCK_FILE_ENV = "SCHWAY_CREDENTIAL_LOCK_FILE";

/** Largest accepted lock wait, in milliseconds. */
export const MAX_LOCK_TIMEOUT_MS = 300_000;

/**
 * Stable per-user rendezvous: the OS keychain itself is per-user, so the
 * mutex is too. `~/.schway` is Schway's established per-user home (config,
 * memory, model preferences); unlike `tmpdir()`, it never differs between
 * processes of the same user. Falls back to a uid-suffixed tmpdir only when
 * the home directory is unavailable. Earlier builds used the same paths for
 * their lock directory, which is what lets the lock file fence them out.
 */
function defaultLockPath(): string {
  try {
    const home = homedir();
    if (typeof home === "string" && home.length > 0) return join(home, ".schway", "credential-store.lock");
  } catch {
    // Fall through to the tmpdir fallback below.
  }
  const getuid = (process as { getuid?: unknown }).getuid;
  const uid = typeof getuid === "function" ? (getuid as () => unknown)() : undefined;
  const suffix = typeof uid === "number" && Number.isSafeInteger(uid) ? `-${uid}` : "";
  return join(tmpdir(), `schway-credential-store${suffix}.lock`);
}

/** Resolved lock location; `chosen` marks a path from the override, which earlier builds never used. */
type LockTarget = { readonly path: string; readonly chosen: boolean };

/** Resolve the lock location from `process.env`, or null for a relative override; an override naming the default path is the default. */
function resolveLockTarget(): LockTarget | null {
  const override = process.env[CREDENTIAL_LOCK_FILE_ENV];
  const fallback = defaultLockPath();
  if (override === undefined || override.trim() === "") return { path: fallback, chosen: false };
  if (!isAbsolute(override)) return null;
  return { path: override, chosen: resolve(override) !== resolve(fallback) };
}

/** Lock file for the next mutation from `process.env` and the home directory, or null for a relative override. */
export function credentialStoreLockPath(): string | null {
  return resolveLockTarget()?.path ?? null;
}

/** Return a lock wait that is a whole number of milliseconds from 1 to `MAX_LOCK_TIMEOUT_MS`, or throw a RangeError naming `name`. */
export function validLockTimeoutMs(value: number, name = "timeoutMs"): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LOCK_TIMEOUT_MS) {
    throw new RangeError(`${name} must be a whole number of milliseconds from 1 to ${MAX_LOCK_TIMEOUT_MS}.`);
  }
  return value;
}

/** Bounded wait for lock acquisition before failing closed. */
const DEFAULT_LOCK_TIMEOUT_MS = 2000;
/** Poll interval while waiting for a live holder to release. */
const LOCK_POLL_MS = 10;
/** Largest earlier-build owner stamp read; real stamps are about 100 bytes. */
const OWNER_STAMP_LIMIT = 4096;

/** Why a lock path cannot be used, each with its own next action. */
type Refusal = "unwritable" | "parent-file" | "link" | "too-long" | "not-lock";

type Inode = { readonly dev: number; readonly ino: number };

/**
 * Outcome of one non-blocking attempt. `busy` clears by waiting; `legacy` is
 * an earlier build's lock directory at the default path, failing fast only
 * when its owner is provably stopped; `refused` cannot clear by waiting.
 */
type Attempt =
  | { readonly kind: "held"; readonly lock: Database; readonly inode: Inode }
  | { readonly kind: "busy" }
  | { readonly kind: "legacy"; readonly stopped: boolean }
  | { readonly kind: "refused"; readonly refusal: Refusal };

const BUSY: Attempt = { kind: "busy" };
const refuse = (refusal: Refusal): Attempt => ({ kind: "refused", refusal });

/** Classify a filesystem error from preparing or inspecting the lock path; anything unlisted, such as ENOENT or EMFILE, is retried. */
function fsFailure(error: unknown): Attempt {
  switch ((error as NodeJS.ErrnoException)?.code) {
    case "EACCES": case "EPERM": case "EROFS": return refuse("unwritable");
    case "ENOTDIR": return refuse("parent-file");
    case "ELOOP": return refuse("link");
    case "ENAMETOOLONG": return refuse("too-long");
    default: return BUSY;
  }
}

/** Classify a SQLite error from locking or verifying an open connection; anything unlisted is retried. */
function sqliteFailure(error: unknown): Attempt {
  const code = String((error as { code?: unknown })?.code ?? "");
  if (code.startsWith("SQLITE_NOTADB") || code.startsWith("SQLITE_CORRUPT")) return refuse("not-lock");
  if (["SQLITE_READONLY", "SQLITE_PERM", "SQLITE_AUTH"].some(permanent => code.startsWith(permanent))) return refuse("unwritable");
  return BUSY;
}

/**
 * Diagnose a failed open. A missing file (deleted since the stat) or a
 * descriptor shortage clears by retrying; only a path this user cannot
 * access is refused. `access` checks the path without opening a descriptor,
 * and only explains a failure here; it never admits a holder.
 */
function openFailure(path: string): Attempt {
  try {
    accessSync(path, constants.R_OK | constants.W_OK);
    return BUSY;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EACCES" || code === "EPERM" || code === "EROFS" ? refuse("unwritable") : BUSY;
  }
}

/** Read an earlier build's owner stamp without blocking: only a small regular file is read, never a FIFO, device or link. */
function readOwnerStamp(directory: string): unknown {
  let fd: number;
  try {
    fd = openSync(join(directory, "owner.json"), constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > OWNER_STAMP_LIMIT) return null;
    const buffer = Buffer.alloc(OWNER_STAMP_LIMIT + 1);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    return length > OWNER_STAMP_LIMIT ? null : JSON.parse(buffer.subarray(0, length).toString("utf8"));
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * True only when an earlier build's owner stamp names this host and a
 * positive PID the OS reports as gone. Missing, malformed, foreign and live
 * owners stay unproven. Reads only the owner file inside that directory,
 * never the lock path itself.
 */
function legacyOwnerStopped(directory: string): boolean {
  const owner = readOwnerStamp(directory) as { host?: unknown; pid?: unknown } | null;
  if (!owner || typeof owner !== "object" || owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0) return false;
  try {
    process.kill(owner.pid as number, 0);
    return false;
  } catch (error) {
    // A shared hostname across PID namespaces can make a live owner look gone; see docs/credentials.md.
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Connections whose open transaction is a held lock. A held connection must
 * stay reachable until `release`: a holder waiting on a promise nothing else
 * references would otherwise let the garbage collector finalize the
 * connection and silently drop the lock while the holder still counts as inside.
 */
const HELD = new Set<Database>();

/**
 * One non-blocking attempt to own the lock file. SQLite's `BEGIN IMMEDIATE`
 * takes a POSIX advisory record lock (LockFileEx on Windows) that the kernel
 * drops when the holder exits for any reason, including SIGKILL, so nothing
 * ever has to decide that an owner is stale or remove a lock by path.
 */
function tryAcquire(target: LockTarget): Attempt {
  const { path, chosen } = target;
  // The parent is idempotent shared setup, never the mutex itself.
  try {
    mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  } catch (error) {
    // A recursive mkdir reports EEXIST only when an ancestor is not a directory.
    return (error as NodeJS.ErrnoException).code === "EEXIST" ? refuse("parent-file") : fsFailure(error);
  }
  // Create the lock inode once, privately, and keep it forever. Only SQLite
  // opens an existing lock file: closing any other descriptor for it can drop
  // this process's POSIX locks. A brand-new inode has no locks to drop.
  try {
    closeSync(openSync(path, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return fsFailure(error);
  }
  let before: ReturnType<typeof statSync>;
  try {
    before = statSync(path);
  } catch (error) {
    // The exclusive create saw something here; a link whose target is gone stays broken.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        if (lstatSync(path).isSymbolicLink()) return refuse("link");
      } catch {
        // Removed since the create: retry.
      }
    }
    return fsFailure(error);
  }
  if (before.isDirectory()) {
    // Earlier builds only ever used the default path, so a directory at a
    // chosen path is the user's own folder, never an older Schway's lock.
    // At the default path it is that older lock: an older Schway holds it,
    // or crashed while holding it. Honor it and never remove it by path;
    // once this file replaces it, earlier builds can no longer create one.
    return chosen ? refuse("not-lock") : { kind: "legacy", stopped: legacyOwnerStopped(path) };
  }
  if (!before.isFile()) return refuse("not-lock");
  let lock: Database;
  try {
    lock = new Database(path, { readwrite: true, create: false });
  } catch (error) {
    return String((error as { code?: unknown })?.code ?? "").startsWith("SQLITE_CANTOPEN") ? openFailure(path) : sqliteFailure(error);
  }
  try {
    // An in-memory journal keeps the verification write below from creating
    // a side file. The transaction is never committed, so the file never changes.
    lock.exec("PRAGMA busy_timeout = 0; PRAGMA journal_mode = MEMORY; BEGIN IMMEDIATE");
  } catch (error) {
    release(lock);
    return sqliteFailure(error);
  }
  try {
    // Verify the connection, not the path. SQLite silently opens a file it
    // cannot write read-only (permissions, a read-only mount, or a sandbox
    // where access(2) and open(2) disagree), and a read-only connection's
    // BEGIN IMMEDIATE excludes nobody. A write inside the open transaction
    // fails with SQLITE_READONLY on such a connection.
    lock.exec("PRAGMA user_version = 1");
  } catch (error) {
    release(lock);
    return sqliteFailure(error);
  }
  HELD.add(lock);
  return { kind: "held", lock, inode: { dev: before.dev, ino: before.ino } };
}

/**
 * True when the path still names the inode this process locked. Checked
 * immediately before the mutation starts: a replacement up to that point
 * would let a later process lock a different inode behind the same path,
 * so the attempt is retried. A removal during the mutation is not detected.
 */
function stillNamesInode(path: string, inode: Inode): boolean {
  try {
    const current = statSync(path);
    return current.dev === inode.dev && current.ino === inode.ino;
  } catch {
    return false;
  }
}

/** Close the connection, which rolls back its uncommitted transaction and drops the lock. */
function release(lock: Database): void {
  HELD.delete(lock);
  try {
    lock.close();
  } catch {
    // Process exit releases the lock regardless.
  }
}

/** Lock path for recovery text: home shortened to `~`, terminal control characters removed. */
function displayPath(path: string): string {
  let shown = path;
  try {
    const home = homedir();
    if (home && (shown === home || shown.startsWith(home + sep))) shown = `~${shown.slice(home.length)}`;
  } catch {
    // Show the full path.
  }
  return shown.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

/** Next-action text for a refusal; a chosen path is never called deletable, because the user owns it. */
function refusalReason(refusal: Refusal, target: LockTarget, shown: string): string {
  switch (refusal) {
    case "unwritable": return `Schway cannot write its lock file at ${shown}. Make that location writable for this user, then retry.`;
    case "parent-file": return `A parent of ${shown} is a file, not a folder. Move that file, then retry.`;
    case "link": return `The lock path ${shown} is a broken or looping symbolic link. Fix that link, then retry.`;
    case "too-long": return `The lock path ${shown} is too long. Set ${CREDENTIAL_LOCK_FILE_ENV} to a shorter absolute path, then retry.`;
    case "not-lock": return target.chosen
      ? `${CREDENTIAL_LOCK_FILE_ENV} does not name a Schway lock file. Set it to a new file path, then retry.`
      : `The file at ${shown} is not a Schway lock file. With no Schway running, delete it, then retry.`;
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Run work under the cross-process credential-store lock, refusing before work runs whenever the lock cannot be held. */
export async function withCredentialStoreLock<T>(work: () => Promise<T>, opts?: { timeoutMs?: number; operation?: "save" | "delete" }): Promise<T> {
  // Every refusal happens before work runs, so nothing mutates without the
  // lock. A live holder that outlasts the bound gets the generic sanitized
  // store error. Conditions that waiting cannot clear (a relative override,
  // an unusable path or file, an earlier build's lock directory with a
  // stopped owner) fail at once with a specific next action; a legacy
  // directory with a live or unknown owner waits out the bound first.
  // A nested acquisition from the same process opens a second connection,
  // which SQLite reports busy, so it fails closed rather than deadlocking.
  // Reads stay outside the lock; single-key reads have no torn state to fence.
  const operation = opts?.operation ?? "save";
  const timeoutMs = validLockTimeoutMs(opts?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  const target = resolveLockTarget();
  if (target === null) {
    throw credentialLockError(operation, `${CREDENTIAL_LOCK_FILE_ENV} must be an absolute path. Set an absolute path or unset it, then retry.`);
  }
  const shown = displayPath(target.path);
  const legacy = () => credentialLockError(operation, `An older Schway's lock folder is at ${shown}. Close every older Schway, delete that folder, then retry.`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const attempt = tryAcquire(target);
    if (attempt.kind === "held") {
      if (stillNamesInode(target.path, attempt.inode)) {
        try {
          return await work();
        } finally {
          release(attempt.lock);
        }
      }
      release(attempt.lock);
    } else if (attempt.kind === "refused") {
      throw credentialLockError(operation, refusalReason(attempt.refusal, target, shown));
    } else if (attempt.kind === "legacy" && attempt.stopped) {
      throw legacy();
    }
    // Fail closed instead of mutating without the lock: the operation never
    // ran, so callers map this to a terminal store state and retry the turn.
    if (Date.now() >= deadline) throw attempt.kind === "legacy" ? legacy() : new Error(credentialStoreError(operation));
    await sleep(Math.min(LOCK_POLL_MS, Math.max(0, deadline - Date.now())));
  }
}
