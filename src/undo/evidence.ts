import { unchangedUndoFile, type UndoManifest } from "./store.ts";

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
