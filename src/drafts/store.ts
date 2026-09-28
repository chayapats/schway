import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
  const path = join(directory, `${identity}.json`);
  checkDirectory(state);
  checkDirectory(directory);
  let expected = readCheckpoint(path);
  let checkpoint = decode(expected, workspaceRoot, options.sessionId);
  let latestRevision = -1;

  function mutate(text: string | undefined, revision: number): boolean {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Invalid draft revision");
    if (revision <= latestRevision) return false;
    // Even failed clears fence delayed saves from before an accepted submission.
    latestRevision = revision;
    if (text !== undefined && !isOrdinaryDraft(text)) return false;
    ensureDirectory(state);
    ensureDirectory(directory);
    const lockPath = `${path}.lock`;
    let lock: number;
    try { lock = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch { throw new Error("Draft checkpoint is locked by another writer; no checkpoint was changed."); }
    let temporary: string | undefined;
    try {
      if (readCheckpoint(path) !== expected) throw new Error("Draft checkpoint changed in another process; reopen the session before saving.");
      if (text === undefined || text.length === 0) {
        if (expected !== undefined) unlinkSync(path);
        expected = undefined;
        checkpoint = undefined;
        return true;
      }
      const next = { text, savedAt: new Date().toISOString() };
      const encoded = JSON.stringify({ version: 1, workspaceRoot, sessionId: options.sessionId, ...next });
      temporary = `${path}.${randomUUID()}.tmp`;
      const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, encoded, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
      // Detect replacement/symlinks again before the atomic rename.
      if (readCheckpoint(path) !== expected) throw new Error("Draft checkpoint changed during save; previous checkpoint retained.");
      renameSync(temporary, path);
      temporary = undefined;
      expected = encoded;
      checkpoint = next;
      return true;
    } finally {
      if (temporary !== undefined) { try { unlinkSync(temporary); } catch { /* Keep original write failure. */ } }
      closeSync(lock);
      unlinkSync(lockPath);
    }
  }

  return {
    path,
    get checkpoint() { return checkpoint; },
    save: (text, revision) => mutate(text, revision),
    clear: revision => mutate(undefined, revision),
  };
}

function checkDirectory(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Draft storage directory is not a regular directory");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Draft storage directory belongs to another user");
  } catch (error) { if (!missing(error)) throw error; }
}

function ensureDirectory(path: string): void {
  checkDirectory(path);
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  checkDirectory(path);
  if ((lstatSync(path).mode & 0o077) !== 0 && path.endsWith("/drafts")) throw new Error("Draft storage directory must have private permissions (0700)");
}

function readCheckpoint(path: string): string | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (missing(error)) return undefined; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("Draft checkpoint must be a private regular file");
    if (stat.size > 4 * 1024 * 1024) throw new Error("Draft checkpoint exceeds recovery limit");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

function decode(raw: string | undefined, workspaceRoot: string, sessionId: string): DraftCheckpoint | undefined {
  if (raw === undefined) return undefined;
  const value = JSON.parse(raw);
  if (value.version !== 1 || value.workspaceRoot !== workspaceRoot || value.sessionId !== sessionId || typeof value.text !== "string" || typeof value.savedAt !== "string") throw new Error("Invalid draft checkpoint identity or format");
  return { text: value.text, savedAt: value.savedAt };
}

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
