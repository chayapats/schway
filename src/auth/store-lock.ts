import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

/** Shared cross-process mutex for OS keychain mutations (set/delete/compare-and-delete). */
const LOCK_DIR = join(tmpdir(), "schway-credential-store.lock");
const OWNER_FILE = join(LOCK_DIR, "owner.json");

/** Lock directory path, exposed for deterministic tests that fabricate stale owners. */
export function credentialStoreLockDir(): string {
  return LOCK_DIR;
}

/** Bounded wait for lock acquisition before degrading to unserialized progress. */
const DEFAULT_LOCK_TIMEOUT_MS = 2000;
/** Poll interval while waiting for a live holder to release. */
const LOCK_POLL_MS = 10;

type LockOwner = { host: string; pid: number };

function readOwner(): LockOwner | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(OWNER_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const { host, pid } = parsed as { host?: unknown; pid?: unknown };
    if (typeof host !== "string" || !Number.isSafeInteger(pid)) return null;
    return { host, pid: pid as number };
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
  try {
    mkdirSync(LOCK_DIR, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  }
  try {
    writeFileSync(OWNER_FILE, JSON.stringify({ host: hostname(), pid: process.pid }), { mode: 0o600 });
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
  if (owner !== null && ownerAlive(owner) === false) release();
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// Reentrancy within one process degrades safely: a nested acquisition sees
// its own directory, waits out the bounded window, then proceeds instead
// of deadlocking. Nested paths are rare (the guarded wrapper never nests
// locked calls); the bound keeps them from hanging.

/**
 * Runs work while holding the cross-process credential-store lock, so
 * Schway-mediated keychain mutations in any local process cannot interleave.
 * The wait is bounded: a wedged holder degrades to unserialized progress
 * rather than hanging callers. Reads stay outside the lock; single-key
 * reads have no torn state to fence.
 */
export async function withCredentialStoreLock<T>(work: () => Promise<T>, opts?: { timeoutMs?: number }): Promise<T> {
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
    if (Date.now() >= deadline) return work();
    await sleep(Math.min(LOCK_POLL_MS, Math.max(0, deadline - Date.now())));
  }
}
