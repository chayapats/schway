import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Latest ordinary unsent input, retained until accepted, discarded, or its session is deleted. */
export interface DraftCheckpoint {
  text: string;
  savedAt: string;
}

/** Reject credential UI input, sensitive commands, callbacks, and known secrets before any file write. */
export function isOrdinaryDraft(text: string, credentialEntry = false, secrets: readonly string[] = []): boolean {
  return !credentialEntry
    && !/(?:^|\n)\s*\/(?:login|logout|auth|key|apikey)(?:\s|$)/i.test(text)
    && !/(?:https?:\/\/\S*[?&#](?:code|access_token|refresh_token|id_token)=|(?:^|\s)(?:sk-[\w-]{8,}|Bearer\s+\S+))/i.test(text)
    && !secrets.some(secret => secret.length > 0 && text.includes(secret));
}

/** A single-session checkpoint writer with revision fencing and explicit conflicting-writer rejection. */
export interface DraftStore {
  readonly checkpoint: DraftCheckpoint | undefined;
  readonly path: string;
  save(text: string, revision: number): boolean;
  clear(revision: number): boolean;
}

/** Open user-local storage for a canonical workspace/session without creating files until a mutation. */
export function openDraftStore(options: { home: string; workspaceRoot: string; sessionId: string }): DraftStore {
  const home = realpathSync(options.home);
  const workspaceRoot = realpathSync(options.workspaceRoot);
  const state = join(home, ".schway");
  const directory = join(state, "drafts");
  const identity = createHash("sha256").update(JSON.stringify([workspaceRoot, options.sessionId])).digest("hex");
  const filename = `${identity}.json`;
  const path = join(directory, filename);
  const homeIdentity = directoryIdentity(home);
  const access = <T>(create: boolean, run: (file: string) => T): T | undefined => withDirectory(home, homeIdentity, create, root => run(join(root, filename)));
  let expected = access(false, file => { recoverStoppedWriter(file); return readCheckpoint(file); });
  let checkpoint = decode(expected, workspaceRoot, options.sessionId);
  let latestRevision = -1;

  function mutate(text: string | undefined, revision: number): boolean {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Invalid draft revision");
    if (revision <= latestRevision) return false;
    // Even failed clears fence delayed saves from before an accepted submission.
    latestRevision = revision;
    if (text !== undefined && !isOrdinaryDraft(text)) return false;
    const next = text ? { text, savedAt: new Date().toISOString() } : undefined;
    const encoded = JSON.stringify({ version: 1, workspaceRoot, sessionId: options.sessionId, generation: randomUUID(), ...(next ?? { cleared: true }) });
    if (encoded && Buffer.byteLength(encoded) > MAX_CHECKPOINT_BYTES) throw new Error("Draft checkpoint exceeds recovery limit; previous checkpoint retained.");
    return access(true, file => {
      recoverStoppedWriter(file);
      const lockPath = `${file}.lock`;
      const token = randomUUID();
      let lock: number;
      try { lock = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
      catch { throw new Error("Draft checkpoint is locked by another writer; no checkpoint was changed."); }
      let temporary: string | undefined;
      try {
        writeFileSync(lock, JSON.stringify({ pid: process.pid, token }), "utf8");
        fsyncSync(lock);
        if (readCheckpoint(file) !== expected) throw new Error("Draft checkpoint changed in another process; reopen the session before saving.");
        temporary = `${file}.${token}.tmp`;
        const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(fd, encoded!, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
        // Detect replacement/symlinks again before the atomic rename.
        if (readCheckpoint(file) !== expected) throw new Error("Draft checkpoint changed during save; previous checkpoint retained.");
        renameSync(temporary, file);
        temporary = undefined;
        expected = encoded;
        checkpoint = next;
        return true;
      } finally {
        if (temporary !== undefined) { try { unlinkSync(temporary); } catch { /* Keep original write failure. */ } }
        closeSync(lock);
        unlinkSync(lockPath);
      }
    })!;
  }

  return {
    path,
    get checkpoint() { return checkpoint; },
    save: (text, revision) => mutate(text, revision),
    clear: revision => mutate(undefined, revision),
  };
}

const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;

function directoryIdentity(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { const stat = fstatSync(fd); return `${stat.dev}:${stat.ino}`; } finally { closeSync(fd); }
}

// Pin each ancestor through a directory descriptor. A rename/symlink substitution
// cannot redirect a later lock, temporary write, or replacement into another tree.
function withDirectory<T>(home: string, identity: string, create: boolean, run: (root: string) => T): T | undefined {
  const descriptors: number[] = [];
  const fdPath = (fd: number) => `${process.platform === "linux" ? "/proc/self/fd" : "/dev/fd"}/${fd}`;
  try {
    let fd = openSync(home, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    descriptors.push(fd);
    const stat = fstatSync(fd);
    if (`${stat.dev}:${stat.ino}` !== identity) throw new Error("Draft home directory changed; reopen before saving");
    for (const name of [".schway", "drafts"]) {
      const path = join(fdPath(fd), name);
      if (create) { try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
      try { fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
      catch (error) { if (!create && missing(error)) return undefined; throw error; }
      descriptors.push(fd);
      const child = fstatSync(fd);
      if (typeof process.getuid === "function" && child.uid !== process.getuid()) throw new Error("Draft storage directory belongs to another user");
      if (name === "drafts" && (child.mode & 0o077) !== 0) throw new Error("Draft storage directory must have private permissions (0700)");
    }
    return run(fdPath(fd));
  } finally { for (const fd of descriptors.reverse()) closeSync(fd); }
}

function recoverStoppedWriter(path: string): void {
  const lockPath = `${path}.lock`;
  const raw = readCheckpoint(lockPath);
  if (raw === undefined) return;
  let owner: { pid?: number; token?: string };
  try { owner = JSON.parse(raw); } catch { return; }
  if (!Number.isSafeInteger(owner.pid) || owner.pid! <= 0 || typeof owner.token !== "string" || !/^[a-f0-9-]{36}$/.test(owner.token)) return;
  try { process.kill(owner.pid!, 0); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return; }
  // Recovery itself is serialized. Unknown/active recovery ownership fails safe.
  const recoveryPath = `${path}.recovery`;
  let recovery: number;
  try { recovery = openSync(recoveryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch { throw new Error("Draft checkpoint recovery is already locked; previous checkpoint retained."); }
  try {
    if (readCheckpoint(lockPath) !== raw) throw new Error("Draft writer changed during recovery; reopen the session.");
    const temporary = `${path}.${owner.token}.tmp`;
    try { unlinkSync(temporary); } catch (error) { if (!missing(error)) throw error; }
    unlinkSync(lockPath);
  } finally { closeSync(recovery); unlinkSync(recoveryPath); }
}

function readCheckpoint(path: string): string | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (missing(error)) return undefined; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("Draft checkpoint must be a private regular file");
    if (stat.size > MAX_CHECKPOINT_BYTES) throw new Error("Draft checkpoint exceeds recovery limit");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

function decode(raw: string | undefined, workspaceRoot: string, sessionId: string): DraftCheckpoint | undefined {
  if (raw === undefined) return undefined;
  const value = JSON.parse(raw);
  if (value.version !== 1 || value.workspaceRoot !== workspaceRoot || value.sessionId !== sessionId) throw new Error("Invalid draft checkpoint identity or format");
  if (value.cleared === true && value.text === undefined) return undefined;
  if (typeof value.text !== "string" || typeof value.savedAt !== "string") throw new Error("Invalid draft checkpoint format");
  return { text: value.text, savedAt: value.savedAt };
}

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
