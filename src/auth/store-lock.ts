import { Database } from "bun:sqlite";
import { closeSync, mkdirSync, openSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { credentialStoreError } from "./store.ts";

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

/**
 * Lock file for the next credential mutation: an absolute override wins, a
 * blank one falls through to the per-user default, and a relative one returns
 * null because it cannot name one rendezvous for processes with different
 * working directories.
 */
export function credentialStoreLockPath(env: Record<string, string | undefined> = process.env): string | null {
  const override = env[CREDENTIAL_LOCK_FILE_ENV];
  if (override === undefined || override.trim() === "") return defaultLockPath();
  return isAbsolute(override) ? override : null;
}

/** Bounded wait for lock acquisition before failing closed. */
const DEFAULT_LOCK_TIMEOUT_MS = 2000;
/** Poll interval while waiting for a live holder to release. */
const LOCK_POLL_MS = 10;

/**
 * One non-blocking attempt to own the lock file, returning the connection
 * whose open transaction is the lock. SQLite's `BEGIN IMMEDIATE` takes a
 * POSIX advisory record lock (LockFileEx on Windows) that the kernel drops
 * when the holder exits for any reason, including SIGKILL, so nothing ever
 * has to decide that an owner is stale or remove a lock by path.
 */
function tryAcquire(path: string): Database | null {
  // The parent is idempotent shared setup, never the mutex itself.
  try {
    mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  } catch {
    return null;
  }
  // Create the lock inode once, privately, and keep it forever. Only SQLite
  // opens an existing lock file: closing any other descriptor for it can drop
  // this process's POSIX locks. A brand-new inode has no locks to drop.
  try {
    closeSync(openSync(path, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
  }
  let before: ReturnType<typeof statSync>;
  try {
    before = statSync(path);
  } catch {
    return null;
  }
  // A directory here is an earlier release's lock: an older Schway holds it,
  // or crashed while holding it. Honor it for the bounded wait and never
  // remove it by path; once this file replaces it, older releases can no
  // longer create one.
  if (!before.isFile()) return null;
  let lock: Database;
  try {
    lock = new Database(path, { readwrite: true, create: false });
  } catch {
    return null;
  }
  try {
    lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    // Own the inode the path still names, so a replaced file can never let
    // two holders lock different inodes behind the same path.
    const after = statSync(path);
    if (after.dev === before.dev && after.ino === before.ino) return lock;
  } catch {
    // Busy or unusable: retry until the bounded deadline.
  }
  release(lock);
  return null;
}

/** Close the connection, which rolls back its empty transaction and drops the lock. */
function release(lock: Database): void {
  try {
    lock.close();
  } catch {
    // Process exit releases the lock regardless.
  }
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
 * wedges later writers. The wait is bounded: a live holder that outlasts it,
 * an earlier release's lock directory, or a relative lock-file override fails
 * closed with a sanitized store error before work runs, never mutating without
 * the lock. Reads stay outside the lock; single-key reads have no torn state
 * to fence.
 */
export async function withCredentialStoreLock<T>(work: () => Promise<T>, opts?: { timeoutMs?: number; operation?: "save" | "delete" }): Promise<T> {
  const failure = () => new Error(credentialStoreError(opts?.operation ?? "save"));
  const path = credentialStoreLockPath();
  if (path === null) throw failure();
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const lock = tryAcquire(path);
    if (lock) {
      try {
        return await work();
      } finally {
        release(lock);
      }
    }
    // Fail closed instead of mutating without the lock: the operation never
    // ran, so callers map this to a terminal store state and retry the turn.
    if (Date.now() >= deadline) throw failure();
    await sleep(Math.min(LOCK_POLL_MS, Math.max(0, deadline - Date.now())));
  }
}
