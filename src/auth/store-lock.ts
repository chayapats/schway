import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { credentialStoreError } from "./store.ts";

/**
 * Stable per-user rendezvous: the OS keychain itself is per-user, so the
 * mutex is too. `~/.schway` is Schway's established per-user home (config,
 * memory, model preferences); unlike `tmpdir()`, it never differs between
 * processes of the same user. Falls back to a uid-suffixed tmpdir only when
 * the home directory is unavailable.
 */
function lockDir(): string {
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

/** Shared cross-process mutex for OS keychain mutations (set/delete/compare-and-delete). */
const LOCK_DIR = lockDir();
const OWNER_FILE = join(LOCK_DIR, "owner.json");
const LOCK_PARENT = join(LOCK_DIR, "..");

/** Lock directory path, exposed for deterministic tests that fabricate stale owners. */
export function credentialStoreLockDir(): string {
  return LOCK_DIR;
}

/** Bounded wait for lock acquisition before failing closed. */
const DEFAULT_LOCK_TIMEOUT_MS = 2000;
/** Poll interval while waiting for a live holder to release. */
const LOCK_POLL_MS = 10;

type LockOwner = { host: string; pid: number; token: string };

function readOwner(): LockOwner | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(OWNER_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const { host, pid, token } = parsed as { host?: unknown; pid?: unknown; token?: unknown };
    if (typeof host !== "string" || !Number.isSafeInteger(pid) || typeof token !== "string" || token.length === 0) return null;
    return { host, pid: pid as number, token };
  } catch {
    return null;
  }
}

function ownerAlive(owner: LockOwner): boolean | null {
  if (owner.host !== hostname()) return null;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : true;
  }
}

function tryAcquire(): boolean {
  // The parent is idempotent shared setup, never the mutex itself: only the
  // leaf mkdir below decides ownership.
  try {
    mkdirSync(LOCK_PARENT, { mode: 0o700, recursive: true });
  } catch {
    return false;
  }
  try {
    mkdirSync(LOCK_DIR, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  }
  try {
    writeFileSync(OWNER_FILE, JSON.stringify({ host: hostname(), pid: process.pid, token: randomUUID() }), { mode: 0o600 });
  } catch {
    // Owner stamp is diagnostic only; the directory itself is the mutex.
  }
  return true;
}

function release(): void {
  try {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch {
    // Best effort; a stale directory only costs contenders their bounded wait.
  }
}

function breakIfStale(): void {
  const owner = readOwner();
  if (owner === null || ownerAlive(owner) !== false) return;
  // Token-safe recovery: re-read before removing. The directory itself is
  // the mutex, so no new owner could have appeared while it existed — but
  // our liveness verdict was computed from a possibly stale read. Only
  // remove when the owner file still names the same dead owner; otherwise a
  // legitimate holder that acquired after our read would lose its mutex.
  const current = readOwner();
  if (current !== null && current.token === owner.token) release();
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// A nested acquisition from the same process sees its own directory, waits
// out the bounded window, then fails closed instead of deadlocking. Nested
// paths are rare (the guarded wrapper never nests locked calls); the bound
// keeps them from hanging.

/**
 * Runs work while holding the cross-process credential-store lock, so
 * Schway-mediated keychain mutations in any local process cannot interleave.
 * The wait is bounded: a wedged holder fails closed with a sanitized store
 * error instead of hanging callers or mutating without the lock. Reads stay
 * outside the lock; single-key reads have no torn state to fence.
 */
export async function withCredentialStoreLock<T>(work: () => Promise<T>, opts?: { timeoutMs?: number; operation?: "save" | "delete" }): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (tryAcquire()) {
      try {
        return await work();
      } finally {
        release();
      }
    }
    breakIfStale();
    // Fail closed instead of mutating without the lock: the operation never
    // ran, so callers map this to a terminal store state and retry the turn.
    if (Date.now() >= deadline) throw new Error(credentialStoreError(opts?.operation ?? "save"));
    await sleep(Math.min(LOCK_POLL_MS, Math.max(0, deadline - Date.now())));
  }
}
