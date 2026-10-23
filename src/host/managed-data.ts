import { lstat, readFile, unlink } from "node:fs/promises";
import { openSync, closeSync, fsyncSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { deleteJsonlSession } from "../session/jsonl.ts";
import { deleteHistorySession, HISTORY_STORE_BUSY } from "../history/store.ts";
import { deleteUndoSession } from "../undo/store.ts";
import { openDraftStore } from "../drafts/store.ts";
import { HostError, type HostDeletedArtifact, type HostSessionDeletion, type HostSessionReference } from "./index.ts";

/** Tombstone suffix marking a retired managed session; reopen stays closed. */
const RETIRED_SUFFIX = ".host-retired";

/** Validate a managed session id without accepting traversal or multi-component paths. */
function validId(id: string): void {
  if (typeof id !== "string" || id.length === 0 || id !== basename(id) || id === "." || id === "..") throw new HostError("invalid-reference");
  if (!/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(id)) throw new HostError("invalid-reference");
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

/** Create a retirement tombstone idempotently without rewriting native history. */
export async function markManagedRetired(directory: string, id: string, workspaceRoot: string): Promise<void> {
  validId(id);
  const path = join(directory, `${id}${RETIRED_SUFFIX}`);
  const body = JSON.stringify({ version: 1, id, workspaceRoot, retiredAt: new Date().toISOString() });
  try {
    const file = await import("node:fs/promises").then(m => m.open(path, "wx", 0o600));
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

/** Check one artifact without following unexpected replacements. */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Whether the history sidecar exists for one validated session id. */
async function historyExists(home: string, id: string): Promise<boolean> {
  try {
    const { historyFilePath } = await import("../history/store.ts");
    return exists(historyFilePath(home, id));
  } catch {
    return false;
  }
}

/** Whether undo data remains for one validated session id. */
async function undoExists(home: string, id: string): Promise<boolean> {
  try {
    await lstat(join(home, ".schway", "undo", id));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Whether a draft checkpoint remains for one validated workspace and session. */
function draftExists(home: string, workspaceRoot: string, id: string): boolean {
  try {
    return openDraftStore({ home, workspaceRoot, sessionId: id }).checkpoint !== undefined;
  } catch {
    return false;
  }
}

/** Inventory existing managed artifacts without repairing or rewriting them. */
async function inventory(directory: string, home: string, workspaceRoot: string, id: string): Promise<Set<HostDeletedArtifact>> {
  const found = new Set<HostDeletedArtifact>();
  if (await exists(sessionPath(directory, id))) found.add("conversation");
  if (await exists(`${sessionPath(directory, id)}.meta`)) found.add("metadata");
  if (await exists(join(directory, `${id}.host-lease`))) found.add("lease");
  try {
    if (await historyExists(home, id)) found.add("history");
  } catch {
    found.add("history");
  }
  try {
    if (await undoExists(home, id)) found.add("undo");
  } catch {
    found.add("undo");
  }
  try {
    if (draftExists(home, workspaceRoot, id)) found.add("draft");
  } catch {
    found.add("draft");
  }
  return found;
}

/** Read and validate the managed header without following a symlink alias. */
async function readManagedHeader(directory: string, id: string): Promise<{ workspaceRoot: string; extraRoots: readonly string[] }> {
  const path = sessionPath(directory, id);
  const info = await lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw Object.assign(new Error("missing"), { code: "missing" });
    throw error;
  });
  if (!info.isFile() || info.nlink !== 1) throw Object.assign(new Error("alias"), { code: "alias" });
  let first: string;
  try {
    const text = await readFile(path, "utf8");
    first = text.split("\n", 1)[0] ?? "";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw Object.assign(new Error("missing"), { code: "missing" });
    throw error;
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

/** Sanitized retry guidance that never carries paths, tokens, or provider payloads. */
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

/** Delete owned managed artifacts for an exact validated reference with honest status. */
export async function deleteManagedSession(options: {
  directory: string;
  home: string;
  workspaceRoot: string;
  reference: HostSessionReference;
  /** Current lease release; called after conversation cleanup to drop ownership. */
  releaseLease: () => void;
}): Promise<HostSessionDeletion> {
  const { directory, home, workspaceRoot, reference } = options;
  validId(reference.id);
  const session = Object.freeze({ id: reference.id, branchId: reference.branchId });
  const before = await inventory(directory, home, workspaceRoot, reference.id).catch(() => new Set<HostDeletedArtifact>());
  const isMissing = !before.has("conversation");

  if (isMissing) {
    const retired = await isManagedRetired(directory, reference.id).catch(() => false);
    if (!retired) {
      return { status: "already-deleted", session, nextAction: guidance("already") };
    }
    const remaining = await cleanRemaining(directory, home, workspaceRoot, reference.id, options.releaseLease);
    if (remaining.length === 0) return { status: "already-deleted", session, nextAction: guidance("already") };
    if (remainingBlocked(remaining)) return { status: "blocked", session, reason: "busy", nextAction: guidance("busy") };
    const removed = [...before].filter(a => !remaining.includes(a));
    return { status: "partial", session, removed: Object.freeze(removed) as readonly HostDeletedArtifact[], remaining: Object.freeze(remaining) as readonly HostDeletedArtifact[], nextAction: guidance("partial") };
  }

  let header: { workspaceRoot: string; extraRoots: readonly string[] };
  try {
    header = await readManagedHeader(directory, reference.id);
  } catch (error) {
    if ((error as { code?: string }).code === "missing") {
      const retired = await isManagedRetired(directory, reference.id).catch(() => false);
      if (!retired) return { status: "already-deleted", session, nextAction: guidance("already") };
      const remaining = await cleanRemaining(directory, home, workspaceRoot, reference.id, options.releaseLease);
      if (remaining.length === 0) return { status: "already-deleted", session, nextAction: guidance("already") };
      return { status: "partial", session, removed: Object.freeze([]) as readonly HostDeletedArtifact[], remaining: Object.freeze(remaining) as readonly HostDeletedArtifact[], nextAction: guidance("partial") };
    }
    options.releaseLease();
    return { status: "blocked", session, reason: "conflict", nextAction: guidance("conflict") };
  }
  if (header.workspaceRoot !== workspaceRoot || header.extraRoots.length !== 0) {
    options.releaseLease();
    throw new HostError("workspace-mismatch");
  }

  try {
    await deleteJsonlSession({ directory, home, id: reference.id });
  } catch (error) {
    if (isBusyStore(error)) {
      const after = await inventory(directory, home, workspaceRoot, reference.id).catch(() => before);
      const removed = [...before].filter(a => !after.has(a));
      if (removed.length === 0) {
        options.releaseLease();
        return { status: "blocked", session, reason: "busy", nextAction: guidance("busy") };
      }
      await markManagedRetired(directory, reference.id, workspaceRoot).catch(() => undefined);
      options.releaseLease();
      const remaining = [...after];
      return { status: "partial", session, removed: Object.freeze(removed) as readonly HostDeletedArtifact[], remaining: Object.freeze(remaining) as readonly HostDeletedArtifact[], nextAction: guidance("partial") };
    }
    await markManagedRetired(directory, reference.id, workspaceRoot).catch(() => undefined);
    options.releaseLease();
    const after = await inventory(directory, home, workspaceRoot, reference.id).catch(() => new Set<HostDeletedArtifact>());
    const removed = [...before].filter(a => !after.has(a));
    const remaining = [...after];
    if (remaining.length === 0) {
      return { status: "deleted", session, removed: Object.freeze(removed.length ? removed : [...before]) as readonly HostDeletedArtifact[], nextAction: guidance("deleted") };
    }
    return { status: "partial", session, removed: Object.freeze(removed) as readonly HostDeletedArtifact[], remaining: Object.freeze(remaining) as readonly HostDeletedArtifact[], nextAction: guidance("partial") };
  }

  await markManagedRetired(directory, reference.id, workspaceRoot).catch(() => undefined);
  options.releaseLease();
  const after = await inventory(directory, home, workspaceRoot, reference.id).catch(() => new Set<HostDeletedArtifact>());
  const removed = [...before].filter(a => !after.has(a));
  const remaining = [...after];
  if (remaining.length === 0) {
    return { status: "deleted", session, removed: Object.freeze(removed.length ? removed : [...before]) as readonly HostDeletedArtifact[], nextAction: guidance("deleted") };
  }
  return { status: "partial", session, removed: Object.freeze(removed) as readonly HostDeletedArtifact[], remaining: Object.freeze(remaining) as readonly HostDeletedArtifact[], nextAction: guidance("partial") };
}

/** Whether remaining artifacts indicate lock contention rather than partial writes. */
function remainingBlocked(remaining: readonly HostDeletedArtifact[]): boolean {
  return remaining.includes("history") || remaining.includes("undo");
}

/** True for history/undo lock contention that leaves every artifact intact. */
function isBusyStore(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  if (code === HISTORY_STORE_BUSY || code === "UNDO_STORE_BUSY") return true;
  return /busy/i.test(error instanceof Error ? error.message : String(error ?? ""));
}

/** Clean sidecars that remain after the conversation file is already gone. */
async function cleanRemaining(directory: string, home: string, workspaceRoot: string, id: string, releaseLease: () => void): Promise<HostDeletedArtifact[]> {
  const remaining: HostDeletedArtifact[] = [];
  try {
    if (await exists(`${sessionPath(directory, id)}.meta`)) {
      try {
        await unlink(`${sessionPath(directory, id)}.meta`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") remaining.push("metadata");
      }
    }
  } catch {
    remaining.push("metadata");
  }
  try {
    await deleteHistorySession({ home, sessionId: id }, async () => undefined);
  } catch (error) {
    if (isBusyStore(error)) return ["history", "undo", "draft"];
    remaining.push("history");
  }
  try {
    await deleteUndoSession({ home, sessionId: id });
  } catch (error) {
    if (isBusyStore(error)) return [...new Set([...remaining, "history" as const, "undo" as const])];
    remaining.push("undo");
  }
  try {
    openDraftStore({ home, workspaceRoot, sessionId: id }).clear(Number.MAX_SAFE_INTEGER);
  } catch {
    remaining.push("draft");
  }
  try {
    releaseLease();
  } catch {
    remaining.push("lease");
  }
  try {
    if (await exists(sessionPath(directory, id))) remaining.push("conversation");
  } catch {
    remaining.push("conversation");
  }
  return Object.freeze(remaining) as unknown as HostDeletedArtifact[];
}

/** Remove one validated tombstone path without touching unrelated files. */
export async function removeRetiredMarker(directory: string, id: string): Promise<void> {
  validId(id);
  await unlink(join(directory, `${id}${RETIRED_SUFFIX}`)).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new HostError("storage");
  });
}
