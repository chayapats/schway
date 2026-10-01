import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join, isAbsolute } from "node:path";
import { isErrno } from "../tools/fs.ts";

/** Content identity, with null representing an absent file. */
export type UndoHash = { sha256: string } | null;
/** Accepted user turn identity shared by original execution and recovery. */
export interface UndoTurn { sessionId: string; turnId: string; turnNumber: number }
/** First pre-image and latest settled post-image for one absolute file path. */
export interface UndoFile { path: string; before: UndoHash; after?: UndoHash }
/** Durable first-change-ordered file changes for one accepted turn. */
export interface UndoManifest extends UndoTurn { version: 1; createdAt: string; files: UndoFile[] }
/** Persist and read private undo data independently of runtime memory. */
export interface UndoStore {
  /** Save the first pre-image before execution and report whether this call created its entry. */
  capture(turn: UndoTurn, path: string): Promise<{ created: boolean }>;
  /** Record current bytes after execution, dropping newly captured no-op entries. */
  settle(turn: UndoTurn, path: string, created: boolean): Promise<void>;
  /** Read all durable manifests for one validated session identity. */
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
/** Read current bytes without treating permission or other I/O failures as absence. */
export async function readUndoBytes(path: string): Promise<Buffer | null> {
  try { return await readFile(path); } catch (error) { if (isErrno(error, "ENOENT")) return null; throw error; }
}

/** Open a private content-addressed store under the supplied home without creating files until capture. */
export function openUndoStore({ home }: { home: string }): UndoStore {
  const root = join(home, ".schway", "undo");
  const sessionPath = (id: string) => join(root, validId(id));
  const manifestPath = (turn: UndoTurn) => join(sessionPath(turn.sessionId), "turns", `${validId(turn.turnId)}.json`);
  const load = async (turn: UndoTurn): Promise<UndoManifest | undefined> => {
    try { return parseManifest(JSON.parse(await readFile(manifestPath(turn), "utf8")), turn.sessionId, turn.turnId); }
    catch (error) { if (isErrno(error, "ENOENT")) return undefined; throw error; }
  };
  const save = (manifest: UndoManifest) => writePrivateAtomically(manifestPath(manifest), JSON.stringify(manifest));
  return {
    async capture(turn, path) {
      manifestPath(turn);
      if (!isAbsolute(path)) throw new Error("Undo paths must be absolute");
      const existing = await load(turn);
      if (existing?.files.some(file => file.path === path)) { await save(existing); return { created: false }; }
      const bytes = await readUndoBytes(path);
      const before = hashUndoBytes(bytes);
      await mkdir(join(sessionPath(turn.sessionId), "blobs"), { recursive: true, mode: 0o700 });
      await mkdir(join(sessionPath(turn.sessionId), "turns"), { recursive: true, mode: 0o700 });
      if (before && bytes) {
        await writePrivateAtomically(join(sessionPath(turn.sessionId), "blobs", before.sha256), bytes);
      }
      const manifest: UndoManifest = existing ?? { version: 1, ...turn, createdAt: new Date().toISOString(), files: [] };
      manifest.files.push({ path, before });
      await save(manifest);
      return { created: true };
    },
    async settle(turn, path, created) {
      const manifest = await load(turn);
      const file = manifest?.files.find(file => file.path === path);
      if (!manifest || !file) throw new Error("Undo pre-image is missing");
      const after = hashUndoBytes(await readUndoBytes(path));
      if (created && equalUndoHash(after, file.before)) manifest.files = manifest.files.filter(entry => entry !== file);
      else file.after = after;
      await save(manifest);
    },
    async list(sessionId) {
      const directory = join(sessionPath(sessionId), "turns");
      let names: string[];
      try { names = await readdir(directory); } catch (error) { if (isErrno(error, "ENOENT")) return []; throw error; }
      return Promise.all(names.filter(name => name.endsWith(".json")).map(async name => parseManifest(JSON.parse(await readFile(join(directory, name), "utf8")), sessionId, name.slice(0, -5))));
    },
    async blob(sessionId, sha256) {
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid undo blob hash");
      const bytes = await readFile(join(sessionPath(sessionId), "blobs", sha256));
      if (hashUndoBytes(bytes)?.sha256 !== sha256) throw new Error("Undo blob is corrupt");
      return bytes;
    },
  };
}

function validId(id: string): string {
  if (!id || id === "." || id === ".." || basename(id) !== id) throw new Error(`Invalid undo id: ${id}`);
  return id;
}
function parseManifest(value: unknown, sessionId: string, turnId: string): UndoManifest {
  const m = value as UndoManifest;
  const hash = (h: UndoHash | undefined) => h === null || (typeof h === "object" && h !== null && typeof h.sha256 === "string" && /^[a-f0-9]{64}$/.test(h.sha256));
  if (!m || m.version !== 1 || m.sessionId !== validId(sessionId) || m.turnId !== validId(turnId) || !Number.isInteger(m.turnNumber) || m.turnNumber < 1 || typeof m.createdAt !== "string" || !Number.isFinite(Date.parse(m.createdAt)) || !Array.isArray(m.files)
    || !m.files.every(file => file && typeof file.path === "string" && isAbsolute(file.path) && hash(file.before) && (file.after === undefined || hash(file.after)))) throw new Error("Malformed undo manifest");
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
