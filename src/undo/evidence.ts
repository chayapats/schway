import { equalUndoHash, hashUndoBytes, unchangedUndoFile, type UndoFile, type UndoManifest, type UndoStore } from "./store.ts";
import { FileChangedError, isErrno, observeFile, type FileObservation } from "../tools/fs.ts";

/** One active turn's retained evidence or missing data, without inferring expiry or current applicability. */
export type UndoTurnEvidence = {
  turnId: string;
  /** One-based position on the supplied active ancestry, independent of stored turn numbering. */
  ordinal: number;
  alreadyUndone: boolean;
} & ({ kind: "missing" } | {
  kind: "retained";
  manifest: UndoManifest;
  /** Observed paths are not shell attribution; undefined means detection was unavailable, unlike an empty list. */
  observedPaths: readonly string[] | undefined;
});

/** Saved-file target selection and independent active-turn evidence; a target still requires preview and apply checks. */
export interface UndoEvidence {
  target?: UndoManifest;
  turns: UndoTurnEvidence[];
}

/** Describe validated manifests from one session using captured active user order and globally recorded undo IDs. */
export function collectUndoEvidence(
  manifests: readonly UndoManifest[],
  activeTurnIds: readonly string[],
  undoneTurnIds: ReadonlySet<string>,
): UndoEvidence {
  const users = new Set(activeTurnIds);
  const target = manifests.filter(manifest => users.has(manifest.turnId) && !undoneTurnIds.has(manifest.turnId)
    && manifest.files.some(file => file.after !== undefined && !unchangedUndoFile(file)))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.turnNumber - a.turnNumber)[0];
  const byTurn = new Map(manifests.map(manifest => [manifest.turnId, manifest]));
  const turns = activeTurnIds.map<UndoTurnEvidence>((turnId, index) => {
    const identity = { turnId, ordinal: index + 1, alreadyUndone: undoneTurnIds.has(turnId) };
    const manifest = byTurn.get(turnId);
    return manifest ? { ...identity, kind: "retained", manifest,
      observedPaths: manifest.shell.detection === "git" ? manifest.shell.paths : undefined }
      : { ...identity, kind: "missing" };
  });
  return { target, turns };
}

/** A path on one active turn with no usable saved pre-image; observation never proves which tool changed it. */
export interface UndoUnsavedPath {
  turnId: string;
  ordinal: number;
  path: string;
  /** observed: seen by change detection without a file-tool entry; incomplete: a file-tool entry whose post-image was never settled. */
  kind: "observed" | "incomplete";
}

/** What undo cannot restore relative to the selected target, without inferring expiry, current dirt or attribution. */
export interface UndoLimits {
  /** One-based active position of the selected target, when one exists. */
  targetOrdinal?: number;
  /** Number of active accepted turns, so a target before it is visibly older than the latest task. */
  latestOrdinal: number;
  /** Target observed paths first, then newer non-undone turns newest first; every non-undone turn when no target exists. */
  unsaved: UndoUnsavedPath[];
  /** Considered non-target, non-undone turns whose saved change detection was unavailable, newest first. */
  undetected: number[];
  /** Considered non-target, non-undone turns without a retained manifest, newest first. */
  missing: number[];
}

/** Summarize unsaved, undetected and missing evidence for the target and newer turns, or all turns without a target. */
export function describeUndoLimits(evidence: UndoEvidence): UndoLimits {
  const target = evidence.target && evidence.turns.find(turn => turn.turnId === evidence.target!.turnId);
  const considered = evidence.turns.filter(turn => !turn.alreadyUndone && (!target || turn.ordinal >= target.ordinal))
    .sort((a, b) => (a === target ? -1 : b === target ? 1 : b.ordinal - a.ordinal));
  const unsaved: UndoUnsavedPath[] = [], undetected: number[] = [], missing: number[] = [];
  for (const turn of considered) {
    const identity = { turnId: turn.turnId, ordinal: turn.ordinal };
    if (turn.kind === "missing") { missing.push(turn.ordinal); continue; }
    if (turn !== target) unsaved.push(...turn.manifest.files.filter(file => file.after === undefined)
      .map(file => ({ ...identity, path: file.path, kind: "incomplete" as const })));
    if (turn.observedPaths) unsaved.push(...turn.observedPaths.map(path => ({ ...identity, path, kind: "observed" as const })));
    else if (turn !== target) undetected.push(turn.ordinal);
  }
  return { targetOrdinal: target?.ordinal, latestOrdinal: evidence.turns.length, unsaved, undetected, missing };
}

/** Current bytes, the saved pre-image and whether `/undo` would restore or delete one target file now. */
export interface UndoFileObservation {
  /** Why undo cannot act on this file at all: incomplete saved data, a missing pre-image or an unreadable current file. */
  unavailable?: "incomplete" | "missing" | "unreadable";
  observed: FileObservation | null;
  current: Buffer | null;
  before: Buffer | null;
  /** The current file still matches the saved post-image, so undo would act on it. */
  eligible: boolean;
}

/** Read one target file and its pre-image the way `/undo` previews it, without writing anything. */
export async function observeUndoFile(store: UndoStore, manifest: UndoManifest, file: UndoFile): Promise<UndoFileObservation> {
  let current: Buffer | null = null, before: Buffer | null = null;
  let observed: FileObservation | null = null, unavailable: UndoFileObservation["unavailable"] = file.after === undefined ? "incomplete" : undefined;
  try { observed = await observeFile(file.path, undefined, { regularOnly: true }); current = observed?.bytes ?? null; }
  catch (error) {
    // Replacement by a directory, link or other entry is a later change; only real read failures are unreadable.
    if (!(error instanceof FileChangedError) && !["ENOENT", "EISDIR", "EINVAL"].some(code => isErrno(error, code))) unavailable ??= "unreadable";
  }
  try { if (!unavailable && file.before) before = await store.blob(manifest.sessionId, file.before.sha256); }
  catch { unavailable = "missing"; }
  const eligible = !unavailable && !!observed?.entry.isFile() && file.after !== undefined && equalUndoHash(hashUndoBytes(current), file.after)
    && (file.afterMode === undefined || observed!.mode === undefined || file.afterMode === observed!.mode);
  return { unavailable, observed, current, before, eligible };
}
