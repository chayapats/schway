import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { accessSync, chmodSync, closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
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

/** Why a lock path cannot be used; `at` names the offending component when it is not the lock path itself. */
type Refusal = {
  readonly reason: "unwritable" | "parent-file" | "link" | "too-long" | "not-lock";
  readonly at?: string;
};

type Inode = { readonly dev: number; readonly ino: number };

/**
 * Outcome of one non-blocking attempt. `busy` clears by waiting; `legacy` is
 * an earlier build's lock directory at the default path, failing fast only
 * when its owner is provably stopped; `refused` cannot clear by waiting.
 */
type Attempt =
  | { readonly kind: "held"; readonly lock: Database; readonly inode: Inode }
  | { readonly kind: "busy"; readonly cantOpen?: true }
  | { readonly kind: "legacy"; readonly stopped: boolean }
  | { readonly kind: "refused"; readonly refusal: Refusal };

const BUSY: Attempt = { kind: "busy" };
/** SQLite could not open an existing regular file that access(2) allows; see `withCredentialStoreLock`. */
const CANT_OPEN: Attempt = { kind: "busy", cantOpen: true };
const refuse = (reason: Refusal["reason"], at?: string): Attempt => ({ kind: "refused", refusal: at === undefined ? { reason } : { reason, at } });

/** Errno code of a filesystem error, if any. */
const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;

/** Filesystem errors that mean this user may not write the location. */
const DENIED = new Set(["EACCES", "EPERM", "EROFS"]);

/**
 * Find the first component of the lock path that cannot lead to a lock
 * file: an ancestor that is not a folder, or a broken or looping symbolic
 * link at an ancestor or the lock path itself. Uses only lstat and stat, so
 * no descriptor is opened. Null when nothing is wrong or the path cannot be
 * inspected; a missing component is fine because the parent is created.
 */
function diagnosePath(path: string): Attempt | null {
  // Walk the path as written, so the kernel resolves each `..` physically.
  const components: string[] = [];
  for (let component = path; ; component = dirname(component)) {
    components.unshift(component);
    if (dirname(component) === component) break;
  }
  for (const [index, component] of components.entries()) {
    const last = index === components.length - 1;
    let entry: ReturnType<typeof lstatSync>;
    try {
      entry = lstatSync(component);
    } catch {
      return null;
    }
    if (entry.isSymbolicLink()) {
      let target: ReturnType<typeof statSync>;
      try {
        target = statSync(component);
      } catch (error) {
        // ENOTDIR: the link's target runs through a regular file, so it leads nowhere.
        return ["ENOENT", "ELOOP", "ENOTDIR"].includes(errno(error) ?? "") ? refuse("link", component) : null;
      }
      if (!last && !target.isDirectory()) return refuse("parent-file", component);
    } else if (!last && !entry.isDirectory()) {
      return refuse("parent-file", component);
    }
  }
  return null;
}

/** Classify a filesystem error from preparing or inspecting the lock path; anything unlisted, such as ENOENT or EMFILE, is retried. */
function fsFailure(path: string, error: unknown): Attempt {
  const code = errno(error);
  if (code !== undefined && DENIED.has(code)) return refuse("unwritable");
  if (code === "ENAMETOOLONG") return refuse("too-long");
  if (code === "EISDIR") return refuse("not-lock");
  // Path-shape errors name the component at fault; a race that cleared it is retried.
  if (code === "ENOTDIR" || code === "ELOOP" || code === "ENOENT" || code === "EEXIST") return diagnosePath(path) ?? BUSY;
  return BUSY;
}

/** Classify a SQLite error from locking or verifying an open connection; anything unlisted is retried. */
function sqliteFailure(error: unknown): Attempt {
  const code = String((error as { code?: unknown })?.code ?? "");
  if (code.startsWith("SQLITE_NOTADB") || code.startsWith("SQLITE_CORRUPT")) return refuse("not-lock");
  if (["SQLITE_READONLY", "SQLITE_PERM", "SQLITE_AUTH"].some(permanent => code.startsWith(permanent))) return refuse("unwritable");
  return BUSY;
}

/**
 * Connections whose open transaction is a held lock. A held connection must
 * stay reachable until `release`: a holder waiting on a promise nothing else
 * references would otherwise let the garbage collector finalize the
 * connection and silently drop the lock while the holder still counts as inside.
 */
const HELD = new Set<Database>();

/**
 * Diagnose a failed SQLite open of an existing regular file without opening
 * a descriptor: closing any descriptor on the lock file outside SQLite can
 * drop this process's POSIX locks, including one another thread holds. A
 * path `access(2)` denies is refused; anything else (a file deleted since
 * the stat, a descriptor shortage, or a sandbox that allows access(2) but
 * denies the open) is retried and remembered for the bound.
 */
function openFailure(path: string): Attempt {
  try {
    accessSync(path, constants.R_OK | constants.W_OK);
    return CANT_OPEN;
  } catch (error) {
    return DENIED.has(errno(error) ?? "") ? refuse("unwritable") : BUSY;
  }
}

/** Longest full lock path SQLite opens: its path limit (1024 bytes on macOS, 512 elsewhere) minus 8 for the `-journal` name. */
const SQLITE_PATH_LIMIT = process.platform === "darwin" ? 1016 : 504;

/**
 * True when SQLite would refuse the lock path as too long once links are
 * resolved. Works before anything exists: the deepest existing ancestor is
 * resolved and the missing rest appended, so nothing needs creating first.
 */
function tooLongForSqlite(path: string): boolean {
  const rest: string[] = [];
  let resolved = resolve(path);
  for (let existing = path; ; existing = dirname(existing)) {
    try {
      resolved = join(realpathSync(existing), ...rest);
      break;
    } catch {
      if (dirname(existing) === existing) break;
      rest.unshift(basename(existing));
    }
  }
  return Buffer.byteLength(resolved, "utf8") > SQLITE_PATH_LIMIT;
}

/** Length of the private temporary name; with SQLite's limit 7 bytes under the OS's, any lock path that fits leaves room for it. */
const TEMPORARY_NAME_BYTES = 8;

/** A private `.cl`-prefixed temporary name of TEMPORARY_NAME_BYTES bytes, unique enough to retry on a rare clash. */
function temporaryName(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const suffix = [...randomBytes(TEMPORARY_NAME_BYTES - 3)].map(byte => alphabet[byte % alphabet.length]).join("");
  return `.cl${suffix}`;
}

/** Filesystem errors from `link(2)` that mean the filesystem has no hard links. */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

/**
 * Create the empty lock file once, without ever holding a descriptor on it
 * outside SQLite. The descriptor belongs to a private temporary name that is
 * closed before `link(2)` publishes it, and the link fails rather than
 * following or replacing anything already at the lock path. On a filesystem
 * without hard links, SQLite itself creates the file, so even then only
 * SQLite holds a descriptor. Returns null when the file now exists.
 */
function createLockFile(path: string): Attempt | null {
  // The name is no longer than any lock file name that fits SQLite's limit
  // plus the 7 bytes between that limit and the OS's, so a lock path that
  // fits never fails here as too long.
  const temporary = join(dirname(path), temporaryName());
  try {
    closeSync(openSync(temporary, "wx", 0o600));
  } catch (error) {
    // Includes EEXIST from a clash with another process's name: retried, never removed.
    return fsFailure(path, error);
  }
  try {
    // The create mode is filtered by the umask; a lock file this user cannot
    // write would refuse every later save.
    chmodSync(temporary, 0o600);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // A leftover temporary name is harmless.
    }
    return fsFailure(path, error);
  }
  try {
    linkSync(temporary, path);
    return null;
  } catch (error) {
    if (errno(error) === "EEXIST") return null;
    if (!NO_HARD_LINKS.has(errno(error) ?? "")) return fsFailure(path, error);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // A leftover temporary name is harmless; the lock path never refers to it.
    }
  }
  // No hard links: let SQLite create the file. Its own close keeps every
  // other connection's lock on that file, in any thread of this process.
  try {
    lstatSync(path);
    return null;
  } catch (error) {
    if (errno(error) !== "ENOENT") return fsFailure(path, error);
  }
  try {
    new Database(path, { readwrite: true, create: true }).close();
    chmodSync(path, 0o600);
    return null;
  } catch (error) {
    return fsFailure(path, error);
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
    return errno(error) === "ESRCH";
  }
}

/**
 * One non-blocking attempt to own the lock file. SQLite's `BEGIN IMMEDIATE`
 * takes a POSIX advisory record lock (LockFileEx on Windows) that the kernel
 * drops when the holder exits for any reason, including SIGKILL, so nothing
 * ever has to decide that an owner is stale or remove a lock by path.
 */
function tryAcquire(target: LockTarget): Attempt {
  const { path, chosen } = target;
  // SQLite refuses a full path past its limit with SQLITE_CANTOPEN, so say so
  // before creating anything, parent folders included.
  if (tooLongForSqlite(path)) return refuse("too-long");
  // The parent is idempotent shared setup, never the mutex itself. A
  // recursive mkdir reports EEXIST when an ancestor is not a folder and
  // ENOENT under a broken link; the diagnosis names that component.
  try {
    mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  } catch (error) {
    return fsFailure(path, error);
  }
  // Create the lock inode once, privately, and keep it forever. Only SQLite
  // ever holds a descriptor on it: closing any other descriptor for it can
  // drop this process's POSIX locks, in every thread.
  try {
    lstatSync(path);
  } catch (error) {
    if (errno(error) !== "ENOENT") return fsFailure(path, error);
    const created = createLockFile(path);
    if (created) return created;
  }
  let before: ReturnType<typeof statSync>;
  try {
    before = statSync(path);
  } catch (error) {
    // Something is here that does not resolve: a broken, looping or file-crossing link is named.
    return fsFailure(path, error);
  }
  if (before.isDirectory()) {
    // Earlier builds only ever used the default path, so a directory at a
    // chosen path is the user's own folder, never an older Schway's lock.
    // At the default path it is that older lock: an older Schway holds it,
    // or crashed while holding it. Honor it and never remove it by path;
    // once this file replaces it, earlier builds can no longer create one.
    return chosen ? refuse("not-lock") : { kind: "legacy", stopped: legacyOwnerStopped(path) };
  }
  // A Schway lock file is always empty: it is created empty and never
  // committed. Anything else, such as an existing database, is not opened,
  // because even switching its journal mode could rewrite it.
  if (!before.isFile() || before.size !== 0) return refuse("not-lock");
  // A link from here to a longer target can still exceed SQLite's limit.
  if (tooLongForSqlite(path)) return refuse("too-long");
  const inode = { dev: before.dev, ino: before.ino };
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
  return { kind: "held", lock, inode };
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

/** Path for recovery text: home shortened to `~`, terminal control characters removed. */
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

/** Next-action text for a refusal; a chosen path is never called deletable or movable, because the user owns it. */
function refusalReason(refusal: Refusal, target: LockTarget): string {
  const lock = displayPath(target.path);
  const at = displayPath(refusal.at ?? target.path);
  switch (refusal.reason) {
    case "unwritable": return `Schway cannot write its lock file at ${lock}. Make that location writable for this user, then retry.`;
    case "parent-file": return target.chosen
      ? `${at} is a file, not a folder. Set ${CREDENTIAL_LOCK_FILE_ENV} to a path inside a folder, then retry.`
      : `${at} is a file, not a folder. Move that file, then retry.`;
    case "link": return `The symbolic link at ${at} is broken or loops. Fix that link, then retry.`;
    case "too-long": return `The lock path ${lock} is too long. Set ${CREDENTIAL_LOCK_FILE_ENV} to a shorter absolute path, then retry.`;
    case "not-lock": return target.chosen
      ? `${CREDENTIAL_LOCK_FILE_ENV} does not name a Schway lock file. Set it to a new file path, then retry.`
      : `The file at ${lock} is not a Schway lock file. With no Schway running, delete it, then retry.`;
  }
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
      if (stillNamesInode(target.path, attempt.inode)) {
        try {
          return await work();
        } finally {
          release(attempt.lock);
        }
      }
      release(attempt.lock);
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
