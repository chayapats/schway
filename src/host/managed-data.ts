import { lstat, open, unlink } from "node:fs/promises";
import { closeSync, constants, fsyncSync, lstatSync, openSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { deleteJsonlSession } from "../session/jsonl.ts";
import { deleteHistorySession, HISTORY_STORE_BUSY, historyFilePath } from "../history/store.ts";
import { deleteUndoSession, UNDO_STORE_BUSY } from "../undo/store.ts";
import { openDraftStore } from "../drafts/store.ts";
import { acquireSessionLease } from "./lease.ts";
import { HostError, type HostDeletedArtifact, type HostSessionDeletion, type HostSessionReference } from "./index.ts";

/** Tombstone suffix marking a retired managed session; reopen stays closed. */
const RETIRED_SUFFIX = ".host-retired";

/** Strict UUID shape for opaque managed references; traversal and multi-component paths never pass. */
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Validate a managed session id without accepting traversal or multi-component paths. */
function validId(id: string): void {
  if (typeof id !== "string" || id.length === 0 || id !== basename(id) || id === "." || id === "..") throw new HostError("invalid-reference");
  if (!ID_PATTERN.test(id)) throw new HostError("invalid-reference");
}

/** Resolve a validated artifact path under the canonical managed store. */
function sessionPath(directory: string, id: string): string {
  validId(id);
  return join(directory, `${id}.jsonl`);
}

/** Resolve the validated retirement tombstone for one managed session. */
export function retiredFilePath(directory: string, id: string): string {
  validId(id);
  return join(directory, `${id}${RETIRED_SUFFIX}`);
}

/** Whether a validated tombstone file exists; corrupted content still retires. */
export async function isManagedRetired(directory: string, id: string): Promise<boolean> {
  validId(id);
  try {
    await lstat(join(directory, `${id}${RETIRED_SUFFIX}`));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new HostError("storage");
  }
}

/** Sync tombstone check for admitted-handle fencing; only ENOENT reads as absent. */
export function isManagedRetiredSync(directory: string, id: string): boolean {
  validId(id);
  try {
    lstatSync(join(directory, `${id}${RETIRED_SUFFIX}`));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new HostError("storage");
  }
}

/** Create a retirement tombstone idempotently without rewriting native history. */
export async function markManagedRetired(directory: string, id: string, workspaceRoot: string): Promise<void> {
  validId(id);
  const path = join(directory, `${id}${RETIRED_SUFFIX}`);
  const body = JSON.stringify({ version: 1, id, workspaceRoot, retiredAt: new Date().toISOString() });
  try {
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(body, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    const dir = openSync(dirname(path), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw new HostError("storage");
  }
}

/** Check one artifact; only ENOENT reads as absent, every other fault throws storage. */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new HostError("storage");
  }
}

/** Whether the history sidecar exists; faults other than ENOENT throw storage, never absent. */
async function historyExists(home: string, id: string): Promise<boolean> {
  try {
    await lstat(historyFilePath(home, id));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new HostError("storage");
  }
}

/** Whether undo data remains; faults other than ENOENT throw storage, never absent. */
async function undoExists(home: string, id: string): Promise<boolean> {
  try {
    await lstat(join(home, ".schway", "undo", id));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new HostError("storage");
  }
}

/** Whether a draft checkpoint remains; any store fault throws storage, never absent. */
function draftExists(home: string, workspaceRoot: string, id: string): boolean {
  try {
    return openDraftStore({ home, workspaceRoot, sessionId: id }).checkpoint !== undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new HostError("storage");
  }
}

/** Inventory existing managed artifacts; storage faults throw, only ENOENT reads as absent. */
async function inventory(directory: string, home: string, workspaceRoot: string, id: string): Promise<Set<HostDeletedArtifact>> {
  const found = new Set<HostDeletedArtifact>();
  if (await exists(sessionPath(directory, id))) found.add("conversation");
  if (await exists(`${sessionPath(directory, id)}.meta`)) found.add("metadata");
  if (await exists(join(directory, `${id}.host-lease`))) found.add("lease");
  if (await historyExists(home, id)) found.add("history");
  if (await undoExists(home, id)) found.add("undo");
  if (draftExists(home, workspaceRoot, id)) found.add("draft");
  return found;
}

/** Read and validate the managed header through a pinned descriptor that never follows a symlink. */
export async function readManagedHeader(directory: string, id: string): Promise<{ workspaceRoot: string; extraRoots: readonly string[] }> {
  const path = sessionPath(directory, id);
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw Object.assign(new Error("missing"), { code: "missing" });
    if (code === "ELOOP") throw Object.assign(new Error("alias"), { code: "alias" });
    throw new HostError("storage");
  }
  let first: string;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1) throw Object.assign(new Error("alias"), { code: "alias" });
    const text = await file.readFile("utf8");
    first = text.split("\n", 1)[0] ?? "";
  } catch (error) {
    if ((error as { code?: string }).code === "alias") throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw Object.assign(new Error("missing"), { code: "missing" });
    throw new HostError("storage");
  } finally {
    await file.close();
  }
  let header: unknown;
  try {
    header = JSON.parse(first);
  } catch {
    throw Object.assign(new Error("alias"), { code: "alias" });
  }
  if (!header || typeof header !== "object" || (header as { id?: unknown }).id !== id) throw Object.assign(new Error("alias"), { code: "alias" });
  const root = (header as { workspaceRoot?: unknown }).workspaceRoot;
  const extra = (header as { extraRoots?: unknown }).extraRoots;
  if (typeof root !== "string" || !Array.isArray(extra)) throw Object.assign(new Error("alias"), { code: "alias" });
  return { workspaceRoot: root, extraRoots: extra as readonly string[] };
}

/** Sanitized retry guidance that never carries paths, tokens or provider payloads. */
function guidance(kind: "deleted" | "already" | "partial" | "busy" | "conflict"): string {
  switch (kind) {
    case "deleted":
      return "Session deleted. No further action needed.";
    case "already":
      return "Session already deleted. Retry is safe with no further action needed.";
    case "partial":
      return "Deletion incomplete. Retry deletion after checking session storage permissions.";
    case "busy":
      return "Session is busy. Cancel admitted work, close the open session, then retry deletion.";
    default:
      return "Session ownership changed. Reopen under exclusive ownership, close it, then retry deletion.";
  }
}

/** Delete owned managed artifacts for one session id with honest status.
 *
 * Retire and delete are scoped to the session id across branches: the tombstone and the
 * conversation file are per id, so a reference carrying any valid branchId deletes the same
 * underlying session. Ownership verdicts (busy owner, replaced alias) report blocked status;
 * programming and configuration faults (unreadable store, workspace mismatch) throw.
 * This function owns the delete lease: it inventories before admitting ownership so the
 * self-created lease never appears in the removed set, and it releases on every path.
 */
export async function deleteManagedSession(options: {
  directory: string;
  home: string;
  workspaceRoot: string;
  reference: HostSessionReference;
}): Promise<HostSessionDeletion> {
  const { directory, home, workspaceRoot, reference } = options;
  validId(reference.id);
  const session = Object.freeze({ id: reference.id, branchId: reference.branchId });
  const before = await inventory(directory, home, workspaceRoot, reference.id);
  const isMissing = !before.has("conversation");

  let lease;
  try {
    lease = acquireSessionLease(directory, reference.id);
  } catch (error) {
    if (error instanceof HostError && error.code === "busy") {
      return { status: "blocked", session, reason: "busy", nextAction: guidance("busy") };
    }
    throw new HostError("storage");
  }
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    // Best-effort: a fault here already surfaces as storage from the surrounding path.
    try { lease.release(); } catch { /* Preserve the deletion verdict. */ }
  };

  try {
    if (isMissing) {
      if (!(await isManagedRetired(directory, reference.id))) {
        release();
        return { status: "already-deleted", session, nextAction: guidance("already") };
      }
      const remaining = await cleanRemaining(directory, home, workspaceRoot, reference.id, release);
      if (remaining.length === 0) {
        release();
        return { status: "already-deleted", session, nextAction: guidance("already") };
      }
      if (remainingBlocked(remaining)) {
        release();
        return { status: "blocked", session, reason: "busy", nextAction: guidance("busy") };
      }
      const removed = [...before].filter(a => !remaining.includes(a));
      release();
      return { status: "partial", session, removed: Object.freeze(removed), remaining: Object.freeze(remaining), nextAction: guidance("partial") };
    }

    let header: { workspaceRoot: string; extraRoots: readonly string[] };
    try {
      header = await readManagedHeader(directory, reference.id);
    } catch (error) {
      if ((error as { code?: string }).code === "missing") {
        if (!(await isManagedRetired(directory, reference.id))) {
          release();
          return { status: "already-deleted", session, nextAction: guidance("already") };
        }
        const remaining = await cleanRemaining(directory, home, workspaceRoot, reference.id, release);
        if (remaining.length === 0) {
          release();
          return { status: "already-deleted", session, nextAction: guidance("already") };
        }
        release();
        return { status: "partial", session, removed: Object.freeze([] as HostDeletedArtifact[]), remaining: Object.freeze(remaining), nextAction: guidance("partial") };
      }
      if (error instanceof HostError) {
        release();
        throw error;
      }
      release();
      return { status: "blocked", session, reason: "conflict", nextAction: guidance("conflict") };
    }
    if (header.workspaceRoot !== workspaceRoot || header.extraRoots.length !== 0) {
      release();
      throw new HostError("workspace-mismatch");
    }

    try {
      await deleteJsonlSession({ directory, home, id: reference.id });
    } catch (error) {
      if (isBusyStore(error)) {
        const after = await inventory(directory, home, workspaceRoot, reference.id);
        const removed = [...before].filter(a => !after.has(a));
        if (removed.length === 0) {
          release();
          return { status: "blocked", session, reason: "busy", nextAction: guidance("busy") };
        }
        await markManagedRetired(directory, reference.id, workspaceRoot);
        release();
        const remaining = [...after];
        return { status: "partial", session, removed: Object.freeze(removed), remaining: Object.freeze(remaining), nextAction: guidance("partial") };
      }
      await markManagedRetired(directory, reference.id, workspaceRoot);
      release();
      const after = await inventory(directory, home, workspaceRoot, reference.id);
      const removed = [...before].filter(a => !after.has(a));
      const remaining = [...after];
      if (remaining.length === 0) {
        return { status: "deleted", session, removed: Object.freeze(removed), nextAction: guidance("deleted") };
      }
      return { status: "partial", session, removed: Object.freeze(removed), remaining: Object.freeze(remaining), nextAction: guidance("partial") };
    }

    await markManagedRetired(directory, reference.id, workspaceRoot);
    release();
    const after = await inventory(directory, home, workspaceRoot, reference.id);
    const removed = [...before].filter(a => !after.has(a));
    const remaining = [...after];
    if (remaining.length === 0) {
      return { status: "deleted", session, removed: Object.freeze(removed), nextAction: guidance("deleted") };
    }
    return { status: "partial", session, removed: Object.freeze(removed), remaining: Object.freeze(remaining), nextAction: guidance("partial") };
  } finally {
    release();
  }
}

/** Whether remaining artifacts indicate lock contention rather than partial writes.
 *
 * History or undo contention blocks the delete with those artifacts remaining; a remaining
 * conversation or metadata means the delete itself failed and reports partial for retry.
 * Busy paths always retain history or undo, so draft-only residue without contention stays partial.
 */
function remainingBlocked(remaining: readonly HostDeletedArtifact[]): boolean {
  return remaining.includes("history") || remaining.includes("undo");
}

/** True only for the exact history/undo lock-contention codes; message text never implies busyness. */
function isBusyStore(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === HISTORY_STORE_BUSY || code === UNDO_STORE_BUSY;
}

/** Clean sidecars that remain after the conversation file is already gone.
 *
 * Every path runs the lease release and the conversation recheck, including lock contention,
 * so a late writer racing cleanup is still reported instead of silently dropped.
 */
async function cleanRemaining(directory: string, home: string, workspaceRoot: string, id: string, releaseLease: () => void): Promise<readonly HostDeletedArtifact[]> {
  const remaining: HostDeletedArtifact[] = [];
  const pushUnique = (artifact: HostDeletedArtifact): void => {
    if (!remaining.includes(artifact)) remaining.push(artifact);
  };
  if (await exists(`${sessionPath(directory, id)}.meta`)) {
    try {
      await unlink(`${sessionPath(directory, id)}.meta`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") pushUnique("metadata");
    }
  }
  try {
    await deleteHistorySession({ home, sessionId: id }, async () => undefined);
  } catch (error) {
    // History contention runs before any sidecar changes, so the history artifact stays remaining.
    pushUnique("history");
  }
  try {
    await deleteUndoSession({ home, sessionId: id });
  } catch (error) {
    if (isBusyStore(error)) {
      // Undo contention may race another deleter mid-flight, so history stays conservatively remaining.
      pushUnique("history");
      pushUnique("undo");
    } else {
      pushUnique("undo");
    }
  }
  try {
    openDraftStore({ home, workspaceRoot, sessionId: id }).clear(Number.MAX_SAFE_INTEGER);
  } catch {
    pushUnique("draft");
  }
  try {
    releaseLease();
  } catch {
    pushUnique("lease");
  }
  try {
    if (await exists(sessionPath(directory, id))) pushUnique("conversation");
  } catch {
    pushUnique("conversation");
  }
  return Object.freeze(remaining);
}
