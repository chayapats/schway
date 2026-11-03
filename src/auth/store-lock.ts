import type { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { displayPath, lockFileRefusalText, releaseConnection, tryLockFile, type LockFileRefusal } from "../storage/sqlite-file-lock.ts";
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

/**
 * Resolved lock location. `chosen` marks a path from the override that is
 * not the default location, which earlier builds never used; `folder` marks
 * an override ending in a path separator, which cannot name a lock file.
 */
type LockTarget = { readonly path: string; readonly chosen: boolean; readonly folder: boolean };

/** Device and inode the kernel reaches for a path, following links and `..` physically, or null when nothing is there. */
function identity(path: string): { dev: number; ino: number } | null {
  try {
    const { dev, ino } = statSync(path);
    return { dev, ino };
  } catch {
    return null;
  }
}

/**
 * True when two paths reach the same file. Uses device and inode, so a link
 * alias or a case variant on a case-insensitive filesystem matches, while a
 * `..` after a linked folder is resolved where it physically leads; realpath
 * and lexical normalization would both collapse that `..` too early. When
 * neither file exists yet, their folders and names are compared instead.
 */
function sameLocation(left: string, right: string): boolean {
  const a = identity(left);
  const b = identity(right);
  if (a && b) return a.dev === b.dev && a.ino === b.ino;
  if (a || b) return false;
  const parentA = identity(dirname(left));
  const parentB = identity(dirname(right));
  if (parentA && parentB) return parentA.dev === parentB.dev && parentA.ino === parentB.ino && basename(left) === basename(right);
  return resolve(left) === resolve(right);
}

/** Resolve the lock location from `process.env`, or null for a relative override; an override reaching the default location is the default. */
function resolveLockTarget(): LockTarget | null {
  const override = process.env[CREDENTIAL_LOCK_FILE_ENV];
  const fallback = defaultLockPath();
  if (override === undefined || override.trim() === "") return { path: fallback, chosen: false, folder: false };
  if (!isAbsolute(override)) return null;
  if (override.endsWith("/") || override.endsWith(sep)) return { path: override, chosen: true, folder: true };
  // A lexical match needs no filesystem: the stat pair below is not atomic,
  // and an older Schway creating or removing its folder between the two calls
  // must not turn the default path into a chosen one. A `..` is excluded,
  // because after a linked folder it leads somewhere lexical resolution cannot see.
  const dotDot = (candidate: string) => candidate.split(/[\\/]+/).includes("..");
  if (!dotDot(override) && !dotDot(fallback) && resolve(override) === resolve(fallback)) return { path: override, chosen: false, folder: false };
  return { path: override, chosen: !sameLocation(override, fallback), folder: false };
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

/**
 * Outcome of one non-blocking attempt. `busy` clears by waiting; `legacy` is
 * an earlier build's lock directory at the default path, failing fast only
 * when its owner is provably stopped; `refused` cannot clear by waiting.
 */
type Attempt =
  | { readonly kind: "held"; readonly lock: Database }
  | { readonly kind: "busy"; readonly cantOpen?: true }
  | { readonly kind: "legacy"; readonly stopped: boolean }
  | { readonly kind: "refused"; readonly refusal: LockFileRefusal };

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
    return (error as NodeJS.ErrnoException)?.code === "ESRCH";
  }
}

/**
 * One non-blocking attempt to own the lock file, through the shared SQLite
 * file lock (src/storage/sqlite-file-lock.ts): private creation, the
 * empty-file rule, a connection that proves it can write, an inode check and
 * a pin while held. Only a folder at the lock path is told apart here.
 */
function tryAcquire(target: LockTarget): Attempt {
  const attempt = tryLockFile(target.path);
  if (attempt.kind === "refused" && attempt.refusal.directory) {
    // Earlier builds only ever used the default path, so a directory at a
    // chosen path is the user's own folder, never an older Schway's lock.
    // At the default path it is that older lock: an older Schway holds it,
    // or crashed while holding it. Honor it and never remove it by path;
    // once this file replaces it, earlier builds can no longer create one.
    return target.chosen ? { kind: "refused", refusal: { reason: "not-lock" } } : { kind: "legacy", stopped: legacyOwnerStopped(target.path) };
  }
  if (attempt.kind === "busy") return attempt.cantOpen ? { kind: "busy", cantOpen: true } : { kind: "busy" };
  return attempt;
}

/** Next-action text for a refusal; a chosen path is never called deletable or movable, because the user owns it. */
function refusalReason(refusal: LockFileRefusal, target: LockTarget): string {
  const at = displayPath(refusal.at ?? target.path);
  if (refusal.reason === "too-long") return `The lock path ${displayPath(target.path)} is too long. Set ${CREDENTIAL_LOCK_FILE_ENV} to a shorter absolute path, then retry.`;
  if (target.chosen && refusal.reason === "parent-file") return `${at} is a file, not a folder. Set ${CREDENTIAL_LOCK_FILE_ENV} to a path inside a folder, then retry.`;
  if (target.chosen && refusal.reason === "not-lock") return `${CREDENTIAL_LOCK_FILE_ENV} does not name a Schway lock file. Set it to a new file path, then retry.`;
  return lockFileRefusalText(refusal, target.path);
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Run work under the cross-process credential-store lock, refusing before work runs whenever the lock cannot be held. */
export async function withCredentialStoreLock<T>(work: () => Promise<T>, opts?: { timeoutMs?: number; operation?: "save" | "delete" }): Promise<T> {
  // Every refusal happens before work runs, so nothing mutates without the
  // lock. A live holder that outlasts the bound gets the generic sanitized
  // store error. Conditions that waiting cannot clear (a relative or
  // folder-shaped override, an unusable path or file, an earlier build's lock
  // directory with a stopped owner) fail at once with a specific next action;
  // a legacy directory with a live or unknown owner waits out the bound first.
  // A nested acquisition from the same process opens a second connection,
  // which SQLite reports busy, so it fails closed rather than deadlocking.
  // Reads stay outside the lock; single-key reads have no torn state to fence.
  const operation = opts?.operation ?? "save";
  const timeoutMs = validLockTimeoutMs(opts?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  const target = resolveLockTarget();
  if (target === null) {
    throw credentialLockError(operation, `${CREDENTIAL_LOCK_FILE_ENV} must be an absolute path. Set an absolute path or unset it, then retry.`);
  }
  if (target.folder) throw credentialLockError(operation, refusalReason({ reason: "not-lock" }, target));
  const legacy = () => credentialLockError(operation, `An older Schway's lock folder is at ${displayPath(target.path)}. Close every older Schway, delete that folder, then retry.`);
  const deadline = Date.now() + timeoutMs;
  // When every attempt in the bound failed only because SQLite could not
  // open a file access(2) allows, as in a sandbox that denies the open, the
  // bound ends with the cannot-write action instead of the generic text.
  // Without a descriptor, that cannot be told apart from a transient failure sooner.
  let onlyCantOpen = true;
  for (;;) {
    const attempt = tryAcquire(target);
    if (attempt.kind !== "busy" || attempt.cantOpen !== true) onlyCantOpen = false;
    if (attempt.kind === "held") {
      try {
        return await work();
      } finally {
        releaseConnection(attempt.lock);
      }
    } else if (attempt.kind === "refused") {
      throw credentialLockError(operation, refusalReason(attempt.refusal, target));
    } else if (attempt.kind === "legacy" && attempt.stopped) {
      throw legacy();
    }
    // Fail closed instead of mutating without the lock: the operation never
    // ran, so callers map this to a terminal store state and retry the turn.
    if (Date.now() >= deadline) {
      if (attempt.kind === "legacy") throw legacy();
      if (onlyCantOpen) throw credentialLockError(operation, refusalReason({ reason: "unwritable" }, target));
      throw new Error(credentialStoreError(operation));
    }
    await sleep(Math.min(LOCK_POLL_MS, Math.max(0, deadline - Date.now())));
  }
}
