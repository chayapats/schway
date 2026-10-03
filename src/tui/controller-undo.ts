import { unlink } from "node:fs/promises";
import type { TurnUndoRecord } from "../conversation/types.ts";
import { diffLines } from "../text/diff.ts";
import { assertFileUnchanged, FileChangedError, observeFile, writeFileAtomically, type FileObservation } from "../tools/fs.ts";
import { displayToolPath } from "../tools/path.ts";
import { undoFailureReason } from "../undo/errors.ts";
import { buildUndoNote, formatUndoResult } from "../undo/record.ts";
import { equalUndoHash, hashUndoBytes, openUndoStore, unchangedUndoFile, type UndoManifest, type UndoStore } from "../undo/store.ts";
import { ChangesLayer } from "./controller-changes.ts";
import type { UndoPreview, UndoPreviewFile } from "./controller-types.ts";

/** Preview and apply the latest eligible accepted turn's file undo without rewinding history. */
export abstract class UndoLayer extends ChangesLayer {
  protected undoPreview?: UndoPreview;
  protected undoBusy = false;
  private undoObservations = new WeakMap<UndoPreviewFile, FileObservation>();

  /** Open an undo preview from durable data on the active ancestry, refusing arguments and busy execution. */
  async undoCommand(args: string): Promise<boolean> {
    if (this.disposed || this.running) return false;
    if (args.trim()) { this.fail("Usage: /undo"); return false; }
    if (this.sessionWriteBlocked) { this.fail("Session storage blocked · /resume reload saved work"); return false; }
    if (!this.home || !this.workspace) { this.notice("Nothing to undo"); return true; }
    this.undoBusy = true;
    const session = this.session, branch = session.activeBranchId;
    try {
      const store = openUndoStore({ home: this.home });
      const target = await this.undoTarget(store);
      if (this.disposed || this.session !== session || session.activeBranchId !== branch) return false;
      if (!target) { this.notice("Nothing to undo"); return true; }
      const files = await Promise.all(target.files.map(file => this.previewUndoFile(store, target, file.path)));
      if (this.disposed || this.session !== session || session.activeBranchId !== branch) return false;
      const legacy = target.files.filter(file => (file.before !== null && file.beforeMode === undefined) || (file.after != null && file.afterMode === undefined));
      if (legacy.length) this.retainNoticeDetails(`Original permissions were unavailable for: ${legacy.map(file => displayToolPath(this.workspace!.root, file.path)).join(", ")}. Undo preserves permissions observed at this preview. Permission changes before this preview cannot be verified; changes after preview are checked where POSIX permissions are supported.`);
      if (files.every(file => file.action === "skip")) { this.notice("Nothing to undo · every file changed since"); return true; }
      this.closeChangeReview();
      const shellFiles: UndoPreviewFile[] = target.shell.detection === "git" ? target.shell.paths.map(path => ({
        path: displayToolPath(this.workspace!.root, path), absolutePath: path, action: "shell" as const, status: "changed by shell · not undoable", rows: [], binary: false,
      })).sort((a, b) => a.path.localeCompare(b.path)) : [];
      this.undoPreview = { shellUnavailable: target.shell.detection === "unavailable", turnId: target.turnId, turnNumber: target.turnNumber, files: [...files, ...shellFiles], selected: 0, result: false };
      return true;
    } catch (error) { this.fail("Undo unavailable · /undo retry", messageOf(error)); return false; }
    finally { this.undoBusy = false; }
  }

  /** Move selection through file-tool and shell rows without touching durable state. */
  selectUndoFile(delta: number): void {
    const preview = this.undoPreview;
    if (preview) preview.selected = (preview.selected + delta + preview.files.length) % preview.files.length;
  }

  /** Close preview or results without writing undo data, workspace files or session history. */
  closeUndoPreview(): void {
    if (!this.undoBusy) this.undoPreview = undefined;
  }

  /** Recheck each post-image and apply one durable undo outcome under the session's operation lease. */
  async applyUndo(): Promise<void> {
    const preview = this.undoPreview;
    if (!preview || preview.result || this.running || this.disposed || !this.home || !this.workspace || this.sessionWriteBlocked) return;
    this.undoBusy = true;
    const release = this.session.acquireOperation();
    const reverted: TurnUndoRecord["reverted"] = [], skipped: TurnUndoRecord["skipped"] = [];
    try {
      const store = openUndoStore({ home: this.home });
      const target = await this.undoTarget(store);
      if (!target || target.turnId !== preview.turnId) { this.undoPreview = undefined; this.notice("Nothing to undo"); return; }
      for (const row of preview.files) {
        if (row.action === "shell") continue;
        const file = target.files.find(file => file.path === row.absolutePath);
        if (!file || row.action === "skip") { skipped.push({ path: row.path, reason: "changed" }); continue; }
        try {
          const observed = this.undoObservations.get(row);
          if (!observed) throw new FileChangedError(file.path);
          const bytes = file.before ? await store.blob(target.sessionId, file.before.sha256) : null;
          /** Reject later saves immediately before the restore or deletion touches the destination. */
          const checkCurrent = async () => {
            if (file.after === undefined || !equalUndoHash(hashUndoBytes(observed.bytes), file.after)
              || (file.afterMode !== undefined && observed.mode !== undefined && file.afterMode !== observed.mode)) throw new FileChangedError(file.path);
            await assertFileUnchanged(file.path, observed);
          };
          // Prepare replacement bytes first; the final check is immediately before rename or unlink.
          if (bytes === null) { await checkCurrent(); await unlink(file.path); }
          else await writeFileAtomically(file.path, bytes, undefined, checkCurrent, { mode: file.beforeMode ?? observed.mode, observed });
          const action = bytes === null ? "deleted" : "restored";
          reverted.push({ path: row.path, action }); row.status = bytes === null ? "Deleted" : "Restored";
        } catch (error) {
          if (error instanceof FileChangedError) {
            row.action = "skip"; row.status = "changed since · skip"; skipped.push({ path: row.path, reason: "changed" });
          } else {
            row.status = `could not restore · ${undoFailureReason(error)}`; skipped.push({ path: row.path, reason: "failed" });
            this.retainNoticeDetails(`${row.path}: ${messageOf(error)}`);
          }
        }
      }
      const failed = skipped.some(file => file.reason === "failed");
      preview.result = true;
      if (!reverted.length) {
        if (!failed) this.undoPreview = undefined;
        this.notice(failed ? "Undo failed · Esc close" : "Nothing to undo · every file changed since");
        return;
      }
      const record: TurnUndoRecord = { type: "turn_undo", id: crypto.randomUUID(), turnId: target.turnId, turnNumber: target.turnNumber,
        reverted, skipped, note: buildUndoNote(reverted, skipped, target.turnNumber, this.session.items.findLast(item => item.type === "user")?.id === target.turnId) };
      try {
        this.session.append(record);
        this.transcript.push({ ...this.systemEntry(formatUndoResult(record)), sessionRecordId: record.id });
      } catch (error) {
        this.sessionWriteBlocked = true;
        this.fail("Files restored, but the session could not record the undo. The model will not be told.", messageOf(error));
      }
      if (!failed) this.undoPreview = undefined;
    } catch (error) { this.fail("Undo unavailable · Esc close · /undo retry", messageOf(error)); preview.result = true; }
    finally { release(); this.undoBusy = false; }
  }

  /** Select the latest changed turn on this ancestry unless any branch already recorded its undo. */
  private async undoTarget(store: UndoStore): Promise<UndoManifest | undefined> {
    const users = new Set(this.session.items.filter(item => item.type === "user").map(item => item.id));
    const undone = new Set(this.session.entries.flatMap(entry => entry.item.type === "turn_undo" ? [entry.item.turnId] : []));
    const target = (await store.list(this.session.rootId)).filter(manifest => users.has(manifest.turnId) && !undone.has(manifest.turnId)
      && manifest.files.some(file => file.after !== undefined && !unchangedUndoFile(file)))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.turnNumber - a.turnNumber)[0];
    return target;
  }

  /** Describe durable pre-images against current bytes without modifying files or session history. */
  private async previewUndoFile(store: UndoStore, manifest: UndoManifest, path: string): Promise<UndoPreviewFile> {
    const file = manifest.files.find(file => file.path === path)!;
    let current: Buffer | null = null, before: Buffer | null = null, readable = true;
    let observed: FileObservation | null = null;
    try { observed = await observeFile(path); current = observed?.bytes ?? null; if (file.before) before = await store.blob(manifest.sessionId, file.before.sha256); }
    catch { readable = false; }
    const eligible = readable && observed?.entry.isFile() && file.after !== undefined && equalUndoHash(hashUndoBytes(current), file.after)
      && (file.afterMode === undefined || observed.mode === undefined || file.afterMode === observed.mode);
    const action = eligible ? file.before === null ? "delete" : "restore" : "skip";
    /** Decode absent files as empty text and reject binary or invalid UTF-8 content. */
    const decode = (bytes: Buffer | null) => bytes === null ? "" : bytes.includes(0) ? undefined : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    let oldText: string | undefined, newText: string | undefined;
    try { oldText = decode(current); newText = decode(before); } catch { /* Binary or invalid UTF-8 has no textual diff. */ }
    const binary = oldText === undefined || newText === undefined;
    const diff = binary ? { rows: [], added: 0, removed: 0 } : diffLines(oldText!, newText!);
    const row: UndoPreviewFile = { path: displayToolPath(this.workspace!.root, path), absolutePath: path, action,
      status: action === "skip" ? "changed since · skip" : action === "delete" ? "new     delete" : binary ? "restore" : `+${diff.added} −${diff.removed}   restore`,
      rows: binary ? [{ sign: " ", text: "Binary file · restore only" }] : diff.rows, binary };
    if (eligible && observed) this.undoObservations.set(row, observed);
    return row;
  }
}

/** Preserve raw failure diagnostics for the existing details surface. */
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
