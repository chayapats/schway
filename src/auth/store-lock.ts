import { Database } from "bun:sqlite";
import { accessSync, closeSync, constants, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { credentialLockError, credentialStoreError } from "./store.ts";

/** Environment variable naming an absolute lock-file path that every cooperating Schway process must share. */
export const CREDENTIAL_LOCK_FILE_ENV = "SCHWAY_CREDENTIAL_LOCK_FILE";

/**
 * Stable per-user rendezvous: the OS keychain itself is per-user, so the
 * mutex is too. `~/.schway` is Schway's established per-user home (config,
 * memory, model preferences); unlike `tmpdir()`, it never differs between
 * processes of the same user. Falls back to a uid-suffixed tmpdir only when
 * the home directory is unavailable. Earlier Schway releases used the same
 * paths for their lock directory, which is what lets the lock file fence
 * them out.
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

/** Lock file for the next mutation from `process.env` and the home directory, or null for a relative override. */
export function credentialStoreLockPath(): string | null {
  const override = process.env[CREDENTIAL_LOCK_FILE_ENV];
  if (override === undefined || override.trim() === "") return defaultLockPath();
  return isAbsolute(override) ? override : null;
}

/** Bounded wait for lock acquisition before failing closed. */
const DEFAULT_LOCK_TIMEOUT_MS = 2000;
/** Poll interval while waiting for a live holder to release. */
const LOCK_POLL_MS = 10;

/** Filesystem errors that waiting cannot clear: the lock location itself is unusable. */
const PERMANENT_FS_ERRORS = new Set(["EACCES", "EPERM", "EROFS", "ENOTDIR", "ELOOP", "ENAMETOOLONG"]);

type Inode = { readonly dev: number; readonly ino: number };

/**
 * Outcome of one non-blocking attempt. `busy` clears by waiting; `legacy`
 * is an earlier release's lock directory, failing fast only when its owner
 * is provably stopped; `unusable` and `damaged` cannot clear by waiting.
 */
type Attempt =
  | { readonly kind: "held"; readonly lock: Database; readonly inode: Inode }
  | { readonly kind: "busy" }
  | { readonly kind: "legacy"; readonly stopped: boolean }
  | { readonly kind: "unusable" }
  | { readonly kind: "damaged" };

const BUSY: Attempt = { kind: "busy" };
const UNUSABLE: Attempt = { kind: "unusable" };
const DAMAGED: Attempt = { kind: "damaged" };

/** Classify a filesystem error from preparing or inspecting the lock path. */
function fsFailure(error: unknown): Attempt {
  return PERMANENT_FS_ERRORS.has((error as NodeJS.ErrnoException)?.code ?? "") ? UNUSABLE : BUSY;
}

/** Classify a SQLite error from opening or locking an existing lock file. */
function sqliteFailure(error: unknown): Attempt {
  const code = String((error as { code?: unknown })?.code ?? "");
  if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) return BUSY;
  if (code.startsWith("SQLITE_NOTADB") || code.startsWith("SQLITE_CORRUPT")) return DAMAGED;
  if (["SQLITE_CANTOPEN", "SQLITE_READONLY", "SQLITE_PERM", "SQLITE_AUTH"].some(permanent => code.startsWith(permanent))) return UNUSABLE;
  return BUSY;
}

/**
 * True only when an earlier release's owner stamp names this host and a
 * positive PID the OS reports as gone. Missing, malformed, foreign and live
 * owners stay unproven. Reads only the owner file inside that directory,
 * never the lock path itself.
 */
function legacyOwnerStopped(path: string): boolean {
  let owner: { host?: unknown; pid?: unknown } | null;
  try {
    owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as { host?: unknown; pid?: unknown } | null;
  } catch {
    return false;
  }
  if (!owner || owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0) return false;
  try {
    process.kill(owner.pid as number, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * One non-blocking attempt to own the lock file. SQLite's `BEGIN IMMEDIATE`
 * takes a POSIX advisory record lock (LockFileEx on Windows) that the kernel
 * drops when the holder exits for any reason, including SIGKILL, so nothing
 * ever has to decide that an owner is stale or remove a lock by path.
 */
function tryAcquire(path: string): Attempt {
  // The parent is idempotent shared setup, never the mutex itself.
  try {
    mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  } catch (error) {
    // A recursive mkdir reports EEXIST only when the parent is not a directory.
    return (error as NodeJS.ErrnoException).code === "EEXIST" ? UNUSABLE : fsFailure(error);
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
    return fsFailure(error);
  }
  // A directory here is an earlier release's lock: an older Schway holds it,
  // or crashed while holding it. Honor it and never remove it by path; once
  // this file replaces it, older releases can no longer create one.
  if (before.isDirectory()) return { kind: "legacy", stopped: legacyOwnerStopped(path) };
  if (!before.isFile()) return DAMAGED;
  // SQLite silently opens a file it cannot write read-only, and a read-only
  // connection's BEGIN IMMEDIATE takes no exclusive lock. Refuse such a file
  // instead of admitting a second holder. This checks the path, not a
  // descriptor, so it cannot drop record locks.
  try {
    accessSync(path, constants.R_OK | constants.W_OK);
  } catch (error) {
    return fsFailure(error);
  }
  let lock: Database;
  try {
    lock = new Database(path, { readwrite: true, create: false });
  } catch (error) {
    return sqliteFailure(error);
  }
  try {
    lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
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

/**
 * Connections whose open transaction is a held lock. A held connection must
 * stay reachable until `release`: a holder waiting on a promise nothing else
 * references would otherwise let the garbage collector finalize the
 * connection and silently drop the lock while the holder still counts as inside.
 */
const HELD = new Set<Database>();

/** Close the connection, which rolls back its empty transaction and drops the lock. */
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

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// A nested acquisition from the same process opens a second connection,
// which SQLite reports busy; it waits out the bounded window, then fails
// closed instead of deadlocking. Nested paths are rare (the guarded wrapper
// never nests locked calls); the bound keeps them from hanging.

/**
 * Runs work while holding the cross-process credential-store lock, so
 * Schway-mediated keychain mutations in any local process cannot interleave.
 * The OS releases the lock when its holder exits, so a crashed holder never
 * wedges later writers. Every refusal happens before work runs, so nothing
 * mutates without the lock. A live holder that outlasts the bounded wait gets
 * the generic sanitized store error. A relative override, an unusable or
 * damaged lock file, and an earlier release's lock directory with a stopped
 * owner fail at once with a specific next action; one with a live or unknown
 * owner waits out the bound first. Reads stay outside the lock; single-key
 * reads have no torn state to fence.
 */
export async function withCredentialStoreLock<T>(work: () => Promise<T>, opts?: { timeoutMs?: number; operation?: "save" | "delete" }): Promise<T> {
  const operation = opts?.operation ?? "save";
  const path = credentialStoreLockPath();
  if (path === null) {
    throw credentialLockError(operation, `${CREDENTIAL_LOCK_FILE_ENV} must be an absolute path. Set an absolute path or unset it, then retry.`);
  }
  const shown = displayPath(path);
  const legacy = () => credentialLockError(operation, `An older Schway's lock folder is at ${shown}. Close every older Schway, delete that folder, then retry.`);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const attempt = tryAcquire(path);
    if (attempt.kind === "held") {
      if (stillNamesInode(path, attempt.inode)) {
        try {
          return await work();
        } finally {
          release(attempt.lock);
        }
      }
      release(attempt.lock);
    } else if (attempt.kind === "unusable") {
      throw credentialLockError(operation, `Schway cannot create or open its lock file at ${shown}. Make that location writable for this user, then retry.`);
    } else if (attempt.kind === "damaged") {
      throw credentialLockError(operation, `The file at ${shown} is not a Schway lock file. With no Schway running, delete it, then retry.`);
    } else if (attempt.kind === "legacy" && attempt.stopped) {
      throw legacy();
    }
    // Fail closed instead of mutating without the lock: the operation never
    // ran, so callers map this to a terminal store state and retry the turn.
    if (Date.now() >= deadline) throw attempt.kind === "legacy" ? legacy() : new Error(credentialStoreError(operation));
    await sleep(Math.min(LOCK_POLL_MS, Math.max(0, deadline - Date.now())));
  }
}
