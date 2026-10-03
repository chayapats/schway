import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { openSync, closeSync } from "node:fs";
import { mkdir, readFile, readdir, rename, unlink, writeFile, rm, rmdir, stat } from "node:fs/promises";
import { basename, join, isAbsolute, relative, sep } from "node:path";
import { isErrno, observeFile } from "../tools/fs.ts";

/** Content identity, with null representing an absent file. */
export type UndoHash = { sha256: string } | null;
/** Accepted user turn identity shared by original execution and recovery. */
export interface UndoTurn { sessionId: string; turnId: string; turnNumber: number }
/** First pre-image and latest settled post-image for one absolute file path. */
export interface UndoFile { path: string; before: UndoHash; after?: UndoHash; beforeMode?: number; afterMode?: number }
/** Durable file pre-images and shell attribution for one accepted turn. */
export interface UndoManifest extends UndoTurn { version: 1; createdAt: string; files: UndoFile[]; shell: UndoShell }
/** Shell attribution records paths without storing their content. */
export type UndoShell = { detection: "git"; paths: string[] } | { detection: "unavailable" };
/** Persist and read private undo data independently of runtime memory. */
export interface UndoStore {
  /** Save the first pre-image before execution and report whether this call created its entry. */
  capture(turn: UndoTurn, path: string): Promise<{ created: boolean }>;
  /** Record current bytes after execution, dropping newly captured no-op entries. */
  settle(turn: UndoTurn, path: string, created: boolean): Promise<void>;
  /** Atomically record latest detection, merging available paths without replacing original file pre-images. */
  recordShell(turn: UndoTurn, shell: UndoShell): Promise<void>;
  /** Read durable manifests for one validated session, skipping only concurrently removed manifests. */
  list(sessionId: string): Promise<UndoManifest[]>;
  /** Read and verify exact pre-image bytes by their session-local content hash. */
  blob(sessionId: string, sha256: string): Promise<Buffer>;
}

/** Hash exact bytes, retaining absence as a distinct identity. */
export function hashUndoBytes(bytes: Uint8Array | null): UndoHash {
  return bytes === null ? null : { sha256: createHash("sha256").update(bytes).digest("hex") };
}
/** Compare content identities, including absent files. */
export function equalUndoHash(a: UndoHash | undefined, b: UndoHash | undefined): boolean {
  return a === undefined || b === undefined ? a === b : a?.sha256 === b?.sha256;
}
/** Compare recorded content and supported permissions, preserving content-only comparison for legacy pre-images. */
export function unchangedUndoFile(file: UndoFile): boolean {
  return equalUndoHash(file.before, file.after)
    && (file.beforeMode === undefined || file.afterMode === undefined || file.beforeMode === file.afterMode);
}
/** Read current bytes without treating permission or other I/O failures as absence. */
export async function readUndoBytes(path: string): Promise<Buffer | null> {
  try { return await readFile(path); } catch (error) { if (isErrno(error, "ENOENT")) return null; throw error; }
}

/** Open a private content-addressed store under the supplied home without creating files until a turn is recorded. */
export function openUndoStore({ home }: { home: string }): UndoStore {
  const root = join(home, ".schway", "undo");
  /** Resolve a session directory only after rejecting unsafe identity components. */
  const sessionPath = (id: string) => join(root, validId(id));
  /** Resolve one accepted turn's manifest beneath its validated session directory. */
  const manifestPath = (turn: UndoTurn) => join(sessionPath(turn.sessionId), "turns", `${validId(turn.turnId)}.json`);
  /** Read and validate a durable turn, treating only a missing manifest as absent. */
  const load = async (turn: UndoTurn): Promise<UndoManifest | undefined> => {
    try { return parseManifest(JSON.parse(await readFile(manifestPath(turn), "utf8")), turn.sessionId, turn.turnId); }
    catch (error) { if (isErrno(error, "ENOENT")) return undefined; throw error; }
  };
  /** Publish the complete current manifest through a private atomic replacement. */
  const save = (manifest: UndoManifest) => writePrivateAtomically(manifestPath(manifest), JSON.stringify(manifest));
  return {
    async capture(turn, path) {
      manifestPath(turn);
      if (!isAbsolute(path)) throw new Error("Undo paths must be absolute");
      return withStoreLock(home, async () => {
        const existing = await load(turn);
        if (existing?.files.some(file => file.path === path)) { await save(existing); return { created: false }; }
        const observed = await observeFile(path);
        const bytes = observed?.bytes ?? null;
        const before = hashUndoBytes(bytes);
        await mkdir(join(sessionPath(turn.sessionId), "blobs"), { recursive: true, mode: 0o700 });
        await mkdir(join(sessionPath(turn.sessionId), "turns"), { recursive: true, mode: 0o700 });
        if (before && bytes) {
          await writePrivateAtomically(join(sessionPath(turn.sessionId), "blobs", before.sha256), bytes);
        }
        const manifest: UndoManifest = existing ?? { version: 1, ...turn, createdAt: new Date().toISOString(), files: [], shell: { detection: "unavailable" } };
        manifest.files.push({ path, before, ...(observed?.mode === undefined ? {} : { beforeMode: observed.mode }) });
        await save(manifest);
        return { created: true };
      });
    },
    async settle(turn, path, created) {
      manifestPath(turn);
      return withStoreLock(home, async () => {
        const manifest = await load(turn);
        const file = manifest?.files.find(file => file.path === path);
        if (!manifest || !file) throw new Error("Undo pre-image is missing");
        const observed = await observeFile(path);
        file.after = hashUndoBytes(observed?.bytes ?? null);
        if (observed?.mode === undefined) delete file.afterMode;
        else file.afterMode = observed.mode;
        if (created && unchangedUndoFile(file)) manifest.files = manifest.files.filter(entry => entry !== file);
        await save(manifest);
      });
    },
    async recordShell(turn, shell) {
      manifestPath(turn);
      return withStoreLock(home, async () => {
        const manifest = await load(turn) ?? { version: 1, ...turn, createdAt: new Date().toISOString(), files: [], shell: { detection: "unavailable" } };
        const toolPaths = new Set(manifest.files.map(file => file.path));
        manifest.shell = shell.detection === "git" ? { detection: "git", paths: [...new Set([
          ...(manifest.shell.detection === "git" ? manifest.shell.paths : []), ...shell.paths,
        ])].filter(path => !toolPaths.has(path)) } : { detection: "unavailable" };
        await mkdir(join(sessionPath(turn.sessionId), "turns"), { recursive: true, mode: 0o700 });
        await save(manifest);
      });
    },
    async list(sessionId) {
      const directory = join(sessionPath(sessionId), "turns");
      let names: string[];
      try { names = await readdir(directory); } catch (error) { if (isErrno(error, "ENOENT")) return []; throw error; }
      const manifests = await Promise.all(names.filter(name => name.endsWith(".json")).map(async name => {
        try { return parseManifest(JSON.parse(await readFile(join(directory, name), "utf8")), sessionId, name.slice(0, -5)); }
        catch (error) { if (isErrno(error, "ENOENT")) return undefined; throw error; }
      }));
      return manifests.filter((manifest): manifest is UndoManifest => manifest !== undefined);
    },
    async blob(sessionId, sha256) {
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid undo blob hash");
      const bytes = await readFile(join(sessionPath(sessionId), "blobs", sha256));
      if (hashUndoBytes(bytes)?.sha256 !== sha256) throw new Error("Undo blob is corrupt");
      return bytes;
    },
  };
}

/** Reject empty, traversal and multi-component identities before constructing store paths. */
function validId(id: string): string {
  if (!id || id === "." || id === ".." || basename(id) !== id) throw new Error(`Invalid undo id: ${id}`);
  return id;
}
/** Validate manifest structure and identity before accepting durable undo data. */
function parseManifest(value: unknown, sessionId: string, turnId: string): UndoManifest {
  const m = value as UndoManifest;
  /** Accept only recorded absence or a complete lowercase SHA-256 identity. */
  const hash = (h: UndoHash | undefined) => h === null || (typeof h === "object" && h !== null && typeof h.sha256 === "string" && /^[a-f0-9]{64}$/.test(h.sha256));
  const mode = (value: number | undefined, image: UndoHash | undefined) => value === undefined
    || (image != null && Number.isInteger(value) && value >= 0 && value <= 0o777);
  if (!m || m.version !== 1 || m.sessionId !== validId(sessionId) || m.turnId !== validId(turnId) || !Number.isInteger(m.turnNumber) || m.turnNumber < 1 || typeof m.createdAt !== "string" || !Number.isFinite(Date.parse(m.createdAt)) || !Array.isArray(m.files)
    || !m.files.every(file => file && typeof file.path === "string" && isAbsolute(file.path) && hash(file.before) && (file.after === undefined || hash(file.after))
      && mode(file.beforeMode, file.before) && mode(file.afterMode, file.after))) throw new Error("Malformed undo manifest");
  if (m.shell === undefined) m.shell = { detection: "unavailable" };
  if (!m.shell || (m.shell.detection !== "unavailable" && (m.shell.detection !== "git" || !Array.isArray(m.shell.paths) || !m.shell.paths.every(path => typeof path === "string" && isAbsolute(path))))) throw new Error("Malformed undo shell metadata");
  return m;
}

/** Publish private bytes only after a complete same-directory temporary write. */
async function writePrivateAtomically(path: string, content: string | Uint8Array): Promise<void> {
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}

/** Inventory regular-file sizes without reading content, following symlinks or creating storage. */
export async function undoStoreSize({ home }: { home: string }): Promise<number> {
  return (await inventory(join(home, ".schway", "undo"))).reduce((total, file) => total + file.size, 0);
}

/** Delete expired then oldest manifests against actual store bytes, collecting unreferenced blobs only afterwards. */
export async function pruneUndoStore({ home, maxAgeDays, maxSizeBytes, now = new Date() }: {
  home: string; maxAgeDays: number; maxSizeBytes: number; now?: Date;
}): Promise<void> {
  const root = join(home, ".schway", "undo");
  if (!await storeExists(root)) return;
  return withStoreLock(home, () => pruneLocked(root, maxAgeDays, maxSizeBytes, now));
}

/** Inventory and collect while all Schway store mutations are excluded across processes. */
async function pruneLocked(root: string, maxAgeDays: number, maxSizeBytes: number, now: Date): Promise<void> {
  const files = await inventory(root);
  let totalBytes = files.reduce((total, file) => total + file.size, 0);
  const manifests: { path: string; size: number; manifest: UndoManifest; removed: boolean }[] = [];
  for (const file of files) {
    const parts = storeEntry(root, file.path);
    if (parts?.[1] === "turns" && parts[2]!.endsWith(".json")) {
      manifests.push({ path: file.path, size: file.size, manifest: parseManifest(JSON.parse(await readFile(file.path, "utf8")), parts[0]!, parts[2]!.slice(0, -5)), removed: false });
    }
  }
  manifests.sort((a, b) => Date.parse(a.manifest.createdAt) - Date.parse(b.manifest.createdAt) || a.path.localeCompare(b.path));
  for (const entry of manifests) if (Date.parse(entry.manifest.createdAt) < now.getTime() - maxAgeDays * 86400000) {
    await unlink(entry.path); totalBytes -= entry.size; entry.removed = true;
  }
  for (const entry of manifests) {
    if (totalBytes <= maxSizeBytes) break;
    if (!entry.removed) { await unlink(entry.path); totalBytes -= entry.size; entry.removed = true; }
  }
  const referenced = new Set(manifests.filter(m => !m.removed).flatMap(({ manifest: m }) => m.files.flatMap(file =>
    [file.before, file.after].filter(hash => hash != null).map(hash => join(root, m.sessionId, "blobs", hash!.sha256)))));
  for (const file of files) if (storeEntry(root, file.path)?.[1] === "blobs" && !referenced.has(file.path)) await unlink(file.path);
  let sessions;
  try { sessions = await readdir(root, { withFileTypes: true }); } catch (error) { if (isErrno(error, "ENOENT")) return; throw error; }
  for (const session of sessions) if (session.isDirectory()) {
    const directory = join(root, session.name);
    for (const name of ["blobs", "turns"]) {
      const child = join(directory, name);
      await removeEmptyDirectory(child);
    }
    await removeEmptyDirectory(directory);
  }
}

/** Remove existing session undo data under publication/pruning exclusion, without locking an absent target. */
export async function deleteUndoSession({ home, sessionId }: { home: string; sessionId: string }): Promise<void> {
  const path = join(home, ".schway", "undo", validId(sessionId));
  if (!await storeExists(path)) return;
  return withStoreLock(home, () => rm(path, { recursive: true, force: true }));
}

/** Remove only an empty directory, leaving content created since enumeration intact. */
async function removeEmptyDirectory(path: string): Promise<void> {
  try { await rmdir(path); }
  catch (error) { if (!isErrno(error, "ENOENT") && !isErrno(error, "ENOTEMPTY") && !isErrno(error, "EEXIST")) throw error; }
}

/** Check storage without creating it, preserving missing-store startup and deletion behavior. */
async function storeExists(root: string): Promise<boolean> {
  try { await stat(root); return true; }
  catch (error) { if (isErrno(error, "ENOENT")) return false; throw error; }
}

/** Exclude mutations with an OS-released lock, rejecting contention immediately with UNDO_STORE_BUSY. */
async function withStoreLock<T>(home: string, operation: () => Promise<T>): Promise<T> {
  const directory = join(home, ".schway");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // This inode stays outside the collectible store and is never removed or counted by retention/doctor.
  // Only SQLite opens an existing lock inode: unrelated POSIX closes can release process locks.
  const path = join(directory, "undo.lock");
  try { closeSync(openSync(path, "wx", 0o600)); }
  catch (error) { if (!isErrno(error, "EEXIST")) throw error; }
  const lock = new Database(path);
  try {
    try { lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE"); }
    catch (error) {
      if (isErrno(error, "SQLITE_BUSY") || isErrno(error, "SQLITE_LOCKED")) throw Object.assign(new Error("Undo store busy"), { code: "UNDO_STORE_BUSY" });
      throw error;
    }
    return await operation();
  } finally { lock.close(); }
}

/** Enumerate regular files and sizes while ignoring absent directories and symbolic links. */
async function inventory(directory: string): Promise<{ path: string; size: number }[]> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (isErrno(error, "ENOENT")) return []; throw error; }
  const files: { path: string; size: number }[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await inventory(path));
    else if (entry.isFile()) files.push({ path, size: (await stat(path)).size });
  }
  return files;
}

/** Identify session-local store files with the native path separator and exact directory depth. */
function storeEntry(root: string, path: string): string[] | undefined {
  const parts = relative(root, path).split(sep);
  return parts.length === 3 ? parts : undefined;
}
