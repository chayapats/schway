import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { accessSync, chmodSync, closeSync, constants, linkSync, lstatSync, mkdirSync, openSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

// Cross-process locks built on SQLite's `BEGIN IMMEDIATE`. The transaction
// takes a POSIX advisory record lock (LockFileEx on Windows) that the kernel
// drops when the holder exits for any reason, including SIGKILL, so nothing
// ever has to decide that an owner is stale or remove a lock by path.
//
// POSIX drops every record lock a process holds on a file when that process
// closes any descriptor for the file, in any thread, Worker threads included.
// So only SQLite, which defers such closes while another of its connections
// holds a lock, ever opens a descriptor on a lock file.

/** Why a lock file cannot be used, which waiting cannot fix; `at` names the offending component when it is not the lock path itself. */
export type LockFileRefusal = {
  readonly reason: "unwritable" | "parent-file" | "link" | "too-long" | "not-lock";
  readonly at?: string;
  /** Set when a folder, not a file, is at the lock path. */
  readonly directory?: true;
  /** The filesystem or SQLite error behind the refusal, when there was one. */
  readonly cause?: unknown;
};

/** Outcome of one non-blocking attempt: a held lock, a busy state that may clear by waiting, or a refusal that cannot. */
export type LockFileAttempt =
  // A pinned connection whose open transaction is the lock, until `releaseConnection`.
  | { readonly kind: "held"; readonly lock: Database }
  // `contended`: another connection holds the lock. `cantOpen`: SQLite could not
  // open a file access(2) allows. Otherwise a transient failure described by `cause`.
  | { readonly kind: "busy"; readonly contended?: true; readonly cantOpen?: true; readonly cause?: unknown }
  | { readonly kind: "refused"; readonly refusal: LockFileRefusal };

type Inode = { readonly dev: number; readonly ino: number };

const BUSY: LockFileAttempt = { kind: "busy" };
const refuse = (reason: LockFileRefusal["reason"], cause?: unknown, at?: string): LockFileAttempt =>
  ({ kind: "refused", refusal: { reason, ...(at === undefined ? {} : { at }), ...(cause === undefined ? {} : { cause }) } });
const transient = (cause: unknown): LockFileAttempt => ({ kind: "busy", cause });

/** Errno code of a filesystem error, if any. */
const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;
/** SQLite result code of an error, or an empty string. */
const sqliteCode = (error: unknown): string => String((error as { code?: unknown })?.code ?? "");

/** Filesystem errors that mean this user may not write the location. */
const DENIED = new Set(["EACCES", "EPERM", "EROFS"]);

/**
 * Connections whose open transaction is a held lock file. A held connection
 * must stay reachable until `releaseConnection`: a holder waiting on a promise
 * nothing else references would otherwise let the garbage collector finalize
 * the connection and silently drop the lock while the holder still counts as inside.
 */
const HELD = new Set<Database>();

/**
 * Find the first component of the lock path that cannot lead to a lock
 * file: an ancestor that is not a folder, or a broken or looping symbolic
 * link at an ancestor or the lock path itself. Uses only lstat and stat, so
 * no descriptor is opened. Null when nothing is wrong or the path cannot be
 * inspected; a missing component is fine because the parent is created.
 */
function diagnosePath(path: string, cause: unknown): LockFileAttempt | null {
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
        return ["ENOENT", "ELOOP", "ENOTDIR"].includes(errno(error) ?? "") ? refuse("link", cause, component) : null;
      }
      if (!last && !target.isDirectory()) return refuse("parent-file", cause, component);
    } else if (!last && !entry.isDirectory()) {
      return refuse("parent-file", cause, component);
    }
  }
  return null;
}

/** Classify a filesystem error from preparing or inspecting the lock path; anything unlisted, such as ENOENT or EMFILE, is retried. */
function fsFailure(path: string, error: unknown): LockFileAttempt {
  const code = errno(error);
  if (code !== undefined && DENIED.has(code)) return refuse("unwritable", error);
  if (code === "ENAMETOOLONG") return refuse("too-long", error);
  if (code === "EISDIR") return refuse("not-lock", error);
  // Path-shape errors name the component at fault; a race that cleared it is retried.
  if (code === "ENOTDIR" || code === "ELOOP" || code === "ENOENT" || code === "EEXIST") return diagnosePath(path, error) ?? transient(error);
  return transient(error);
}

/** Classify a SQLite error from locking or verifying an open connection; anything unlisted is retried. */
function sqliteFailure(error: unknown): LockFileAttempt {
  const code = sqliteCode(error);
  if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) return { kind: "busy", contended: true, cause: error };
  if (code.startsWith("SQLITE_NOTADB") || code.startsWith("SQLITE_CORRUPT")) return refuse("not-lock", error);
  if (["SQLITE_READONLY", "SQLITE_PERM", "SQLITE_AUTH"].some(permanent => code.startsWith(permanent))) return refuse("unwritable", error);
  return transient(error);
}

/**
 * Diagnose a failed SQLite open of an existing regular file without opening
 * a descriptor. A path `access(2)` denies is refused; anything else (a file
 * deleted since the stat, a descriptor shortage, or a sandbox that allows
 * access(2) but denies the open) is retried and marked `cantOpen`.
 */
function openFailure(path: string, error: unknown): LockFileAttempt {
  try {
    accessSync(path, constants.R_OK | constants.W_OK);
    return { kind: "busy", cantOpen: true, cause: error };
  } catch (denied) {
    return DENIED.has(errno(denied) ?? "") ? refuse("unwritable", denied) : transient(error);
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
 * Create an empty file this user can read and write at `path`, without ever
 * holding a descriptor on it outside SQLite, and keep whatever is already
 * there. The descriptor belongs to a private temporary name that is closed
 * before `link(2)` publishes it, and the link fails rather than following or
 * replacing anything at the path. On a filesystem without hard links, SQLite
 * itself creates the file. Throws the filesystem or SQLite error otherwise.
 */
function createEmptyFile(path: string): void {
  // The name is no longer than any lock file name that fits SQLite's limit
  // plus the 7 bytes between that limit and the OS's, so a lock path that
  // fits never fails here as too long. EEXIST from a clash with another
  // process's name is thrown, retried and never removed.
  const temporary = join(dirname(path), temporaryName());
  closeSync(openSync(temporary, "wx", 0o600));
  try {
    // The create mode is filtered by the umask; a file this user cannot
    // write would open read-only and refuse every later lock.
    chmodSync(temporary, 0o600);
    try {
      linkSync(temporary, path);
      return;
    } catch (error) {
      if (errno(error) === "EEXIST") return;
      if (!NO_HARD_LINKS.has(errno(error) ?? "")) throw error;
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // A leftover temporary name is harmless; the path never refers to it.
    }
  }
  // No hard links: let SQLite create the file. Its own close keeps every
  // other connection's lock on that file, in any thread of this process.
  try {
    lstatSync(path);
    return;
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
  }
  new Database(path, { readwrite: true, create: true }).close();
  chmodSync(path, 0o600);
}

/**
 * True when the path still names the inode this process locked. Checked
 * just before the lock is handed out: a replacement up to that point would
 * let a later process lock a different inode behind the same path, so the
 * attempt is retried. A removal while the lock is held is not detected.
 */
function stillNamesInode(path: string, inode: Inode): boolean {
  try {
    const current = statSync(path);
    return current.dev === inode.dev && current.ino === inode.ino;
  } catch {
    return false;
  }
}

/** Try once, without waiting, to hold the empty lock file at `path`, creating it privately when absent; a held connection has proved it can write and stays pinned until released. */
export function tryLockFile(path: string): LockFileAttempt {
  // The file is created once and kept forever: it is never removed or replaced.
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
  try {
    lstatSync(path);
  } catch (error) {
    if (errno(error) !== "ENOENT") return fsFailure(path, error);
    try {
      createEmptyFile(path);
    } catch (failure) {
      return fsFailure(path, failure);
    }
  }
  let before: ReturnType<typeof statSync>;
  try {
    before = statSync(path);
  } catch (error) {
    // Something is here that does not resolve: a broken, looping or file-crossing link is named.
    return fsFailure(path, error);
  }
  if (before.isDirectory()) return { kind: "refused", refusal: { reason: "not-lock", directory: true } };
  // A Schway lock file is always empty: it is created empty and never
  // committed. Anything else, such as an existing database, is not opened,
  // because even switching its journal mode could rewrite it.
  if (!before.isFile() || before.size !== 0) return refuse("not-lock");
  // A link from here to a longer target can still exceed SQLite's limit.
  if (tooLongForSqlite(path)) return refuse("too-long");
  let lock: Database;
  try {
    lock = new Database(path, { readwrite: true, create: false });
  } catch (error) {
    return sqliteCode(error).startsWith("SQLITE_CANTOPEN") ? openFailure(path, error) : sqliteFailure(error);
  }
  try {
    // An in-memory journal keeps the verification write below from creating
    // a side file. The transaction is never committed, so the file never
    // changes. BEGIN IMMEDIATE stays last: Bun's exec reports only the last
    // statement's error, and a lost BEGIN error would hand out no lock at all.
    lock.exec("PRAGMA busy_timeout = 0; PRAGMA journal_mode = MEMORY; BEGIN IMMEDIATE");
  } catch (error) {
    releaseConnection(lock);
    return sqliteFailure(error);
  }
  try {
    // Verify the connection, not the path. SQLite silently opens a file it
    // cannot write read-only (permissions, a read-only mount, or a sandbox
    // where access(2) and open(2) disagree), and a read-only connection's
    // BEGIN IMMEDIATE takes only a read lock, which excludes nobody. A write
    // inside the open transaction fails with SQLITE_READONLY on such a connection.
    lock.exec("PRAGMA user_version = 1");
  } catch (error) {
    releaseConnection(lock);
    return sqliteFailure(error);
  }
  if (!stillNamesInode(path, { dev: before.dev, ino: before.ino })) {
    releaseConnection(lock);
    return BUSY;
  }
  HELD.add(lock);
  return { kind: "held", lock };
}

/** Unpin a held connection and close it through SQLite, which rolls back its open transaction and drops its lock. */
export function releaseConnection(connection: Database): void {
  HELD.delete(connection);
  try {
    connection.close();
  } catch {
    // Process exit releases the lock regardless.
  }
}

/** Open the database at `path` read-write, first creating it empty with mode 0600 when absent; an existing file is not changed, and the caller closes it. */
export function openPrivateDatabase(path: string): Database {
  // Creating it here, rather than through an ordinary open, keeps every
  // descriptor on it inside SQLite, and the umask cannot leave it unwritable.
  try {
    lstatSync(path);
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
    createEmptyFile(path);
  }
  return new Database(path, { readwrite: true, create: false });
}

/** Throw SQLITE_READONLY unless the open `BEGIN IMMEDIATE` transaction holds a write lock, changing nothing; `table` must exist. */
export function proveWritable(database: Database, table: string): void {
  // A read-only connection's BEGIN IMMEDIATE takes only a read lock. This
  // deletion needs a write transaction but matches no row, so on a writable
  // connection it neither dirties a page nor needs a journal; unlike the
  // lock-file probe it is safe for a database with content that is committed.
  database.exec(`DELETE FROM "${table.replaceAll("\"", "\"\"")}" WHERE 0`);
}

/** Error code for a lock file that waiting cannot make usable, when no filesystem errno describes it. */
export const LOCK_FILE_UNUSABLE = "LOCK_FILE_UNUSABLE";

/** Path for recovery text: home shortened to `~`, terminal control characters removed. */
export function displayPath(path: string): string {
  let shown = path;
  try {
    const home = homedir();
    if (home && (shown === home || shown.startsWith(home + sep))) shown = `~${shown.slice(home.length)}`;
  } catch {
    // Show the full path.
  }
  return shown.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

/** Next-action text for a refusal of the lock file at `path`, a location Schway chose under the user's home. */
export function lockFileRefusalText(refusal: LockFileRefusal, path: string): string {
  const lock = displayPath(path);
  const at = displayPath(refusal.at ?? path);
  switch (refusal.reason) {
    case "unwritable": return `Schway cannot write its lock file at ${lock}. Make that location writable for this user, then retry.`;
    case "parent-file": return `${at} is a file, not a folder. Move that file, then retry.`;
    case "link": return `The symbolic link at ${at} is broken or loops. Fix that link, then retry.`;
    case "too-long": return `The lock path ${lock} is too long. Use a shorter home folder path, then retry.`;
    case "not-lock": return refusal.directory
      ? `${lock} is a folder, not a Schway lock file. With no Schway running, delete that folder, then retry.`
      : `The file at ${lock} is not a Schway lock file. With no Schway running, delete it, then retry.`;
  }
}

/** Build the error for a refused lock file: next-action text, the filesystem cause's errno as `code` (else LOCK_FILE_UNUSABLE), and the cause. */
export function lockFileError(path: string, refusal: LockFileRefusal): Error {
  // Keeping a filesystem errno keeps each site's existing errno wording, such as "Permission denied".
  const code = errno(refusal.cause);
  return Object.assign(new Error(lockFileRefusalText(refusal, path), refusal.cause === undefined ? undefined : { cause: refusal.cause }),
    { code: code !== undefined && !code.startsWith("SQLITE_") ? code : LOCK_FILE_UNUSABLE });
}

/** Attempts of a failure that is not contention before a site that does not wait gives up on it. */
const TRANSIENT_ATTEMPTS = 3;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Hold the lock file at `path`, throwing `busy()` when contention outlasts `waitMs` (0 rejects at once) and `lockFileError` at once on a refusal. */
export async function holdLockFile(path: string, opts: { waitMs: number; busy: () => Error; pollMs?: number }): Promise<Database> {
  // Any other failure is retried within the wait, at least TRANSIENT_ATTEMPTS
  // times, then throws its cause, unless some attempt met another holder.
  // Release the result with `releaseConnection`.
  const deadline = Date.now() + opts.waitMs;
  // Met another holder: the wait then ends busy, whatever its last attempt hit.
  let contended = false;
  for (let attempts = 1; ; attempts++) {
    const attempt = tryLockFile(path);
    if (attempt.kind === "held") return attempt.lock;
    if (attempt.kind === "refused") throw lockFileError(path, attempt.refusal);
    if (attempt.contended) contended = true;
    if (Date.now() >= deadline) {
      if (contended) throw opts.busy();
      if (attempts >= TRANSIENT_ATTEMPTS) throw attempt.cause ?? opts.busy();
      // A race such as a replaced or vanished lock file clears at once.
      continue;
    }
    await sleep(Math.min(opts.pollMs ?? 10, Math.max(0, deadline - Date.now())));
  }
}

/** Run `work` while holding the lock file at `path` under `holdLockFile`'s rules, releasing it however `work` ends. */
export async function withLockFile<T>(path: string, opts: { waitMs: number; busy: () => Error; pollMs?: number }, work: () => Promise<T>): Promise<T> {
  const lock = await holdLockFile(path, opts);
  try {
    return await work();
  } finally {
    releaseConnection(lock);
  }
}
