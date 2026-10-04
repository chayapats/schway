import { unlink } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type { TurnUndoRecord } from "../conversation/types.ts";
import { formatCount } from "../text/format.ts";
import { diffLines } from "../text/diff.ts";
import { assertFileUnchanged, FileChangedError, isErrno, observeFile, writeFileAtomically, type FileObservation } from "../tools/fs.ts";
import { displayToolPath } from "../tools/path.ts";
import { undoFailureReason } from "../undo/errors.ts";
import { collectUndoEvidence, describeUndoLimits, type UndoEvidence, type UndoLimits } from "../undo/evidence.ts";
import { buildUndoNote, formatUndoResult } from "../undo/record.ts";
import { equalUndoHash, hashUndoBytes, openUndoStore, type UndoManifest, type UndoStore } from "../undo/store.ts";
import { ChangesLayer } from "./controller-changes.ts";
import type { ChangeReview, UndoPreview, UndoPreviewFile } from "./controller-types.ts";

/** Preview and apply the latest eligible accepted turn's file undo without rewinding history. */
export abstract class UndoLayer extends ChangesLayer {
  protected undoPreview?: UndoPreview;
  protected undoBusy = false;
  private undoObservations = new WeakMap<UndoPreviewFile, FileObservation>();
  /** The undo panel that review replaced, restored when that review closes. */
  private undoReturn?: UndoPreview;

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
      const evidence = await this.undoEvidence(store), target = evidence.target;
      if (this.disposed || this.session !== session || session.activeBranchId !== branch) return false;
      const limits = describeUndoLimits(evidence);
      const unsaved = this.unsavedUndoRows(limits, target?.turnId);
      if (!target) return this.explainNothingToUndo(limits, unsaved);
      const files = await Promise.all(target.files.map(file => this.previewUndoFile(store, target, file.path)));
      if (this.disposed || this.session !== session || session.activeBranchId !== branch) return false;
      const legacy = target.files.filter(file => (file.before !== null && file.beforeMode === undefined) || (file.after != null && file.afterMode === undefined));
      if (legacy.length) this.retainNoticeDetails(`Original permissions were unavailable for: ${legacy.map(file => displayToolPath(this.workspace!.root, file.path)).join(", ")}. Undo preserves permissions observed at this preview. Permission changes before this preview cannot be verified; changes after preview are checked where POSIX permissions are supported.`);
      const notes = [
        ...(unsaved.length ? [`${formatCount(unsaved.length, "change")} without saved undo ${unsaved.length === 1 ? "stays" : "stay"}`] : []),
        ...(limits.undetected.length ? ["Later changes can't be detected here"] : []),
        ...(limits.missing.length ? [`No saved undo data for ${turnList(limits.missing)}`] : []),
      ];
      const nothing = files.every(file => file.action === "skip");
      // Without known paths left in place, an all-conflict turn keeps the established one-line explanation.
      if (nothing && !unsaved.length && files.every(file => file.status === CHANGED_SINCE)) { this.notice("Nothing to undo · every file changed since"); return true; }
      this.undoReturn = undefined;
      this.closeChangeReview();
      this.undoPreview = { shellUnavailable: target.shell.detection === "unavailable", turnId: target.turnId, turnNumber: target.turnNumber, files: [...files, ...unsaved], selected: 0, result: false,
        older: limits.targetOrdinal !== undefined && limits.targetOrdinal < limits.latestOrdinal, notes, ...(nothing ? { readOnlyStatus: `Nothing to undo in turn ${target.turnNumber}` } : {}) };
      return true;
    } catch (error) { this.fail("Undo unavailable · /undo retry", messageOf(error)); return false; }
    finally { this.undoBusy = false; }
  }

  /** Move selection through file-tool and shell rows without touching durable state. */
  selectUndoFile(delta: number): void {
    const preview = this.undoPreview;
    if (preview?.files.length) preview.selected = (preview.selected + delta + preview.files.length) % preview.files.length;
  }

  /** Close preview or results without writing undo data, workspace files or session history. */
  closeUndoPreview(): void {
    this.undoReturn = undefined;
    if (!this.undoBusy) this.undoPreview = undefined;
  }

  /** Close review and return to the undo panel that opened it, if any, without rereading or writing anything. */
  override closeChangeReview(): void {
    super.closeChangeReview();
    const back = this.undoReturn;
    this.undoReturn = undefined;
    if (back && !this.disposed) this.undoPreview = back;
  }

  /** Replace the undo panel with read-only current diffs for its workspace paths; Esc returns to the same panel. */
  async reviewUndoChanges(): Promise<boolean> {
    const preview = this.undoPreview;
    if (!preview || preview.result || this.undoBusy || this.running || this.disposed || !this.workspace) return false;
    const root = this.workspace.root, seen = new Set<string>();
    const files: ChangeReview["files"] = [];
    for (const row of preview.files) {
      const path = relative(root, row.absolutePath);
      if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path) || seen.has(path)) continue;
      // Read-only rows are observations, so review shows no shell attribution for them.
      seen.add(path); files.push({ path, source: row.action === "shell" ? "observed" : "tool" });
    }
    this.closeChangeReview();
    this.undoPreview = undefined;
    this.undoReturn = preview;
    const review: ChangeReview = { heading: "Review · current changes", files, selected: 0, detail: "", rows: [], showingDetails: false, loading: false,
      details: "Review shows current working-tree diffs for paths in the undo panel. Undo restores only edit and write changes with saved copies; other paths stay as they are. Changes seen during a turn may include edits made outside Schway." };
    this.changeReview = review;
    const unavailable = this.gitChangeTracking() === "off" ? "Change tracking off. No Git state read." : !files.length ? "No workspace files to review." : "";
    if (unavailable) { review.detail = unavailable; review.rows = [{ sign: " ", text: unavailable }]; return true; }
    await this.selectReviewFile(0);
    return true;
  }

  /** Recheck each post-image and apply one durable undo outcome under the session's operation lease. */
  async applyUndo(): Promise<void> {
    const preview = this.undoPreview;
    if (!preview || preview.result || preview.readOnlyStatus || !preview.files.some(row => row.action === "restore" || row.action === "delete")
      || this.running || this.disposed || !this.home || !this.workspace || this.sessionWriteBlocked) return;
    this.undoBusy = true;
    const release = this.session.acquireOperation();
    const reverted: TurnUndoRecord["reverted"] = [], skipped: TurnUndoRecord["skipped"] = [];
    let restoreFailed = false;
    try {
      const store = openUndoStore({ home: this.home });
      const target = (await this.undoEvidence(store)).target;
      if (!target || target.turnId !== preview.turnId) { this.undoPreview = undefined; this.notice("Nothing to undo"); return; }
      for (const row of preview.files) {
        if (row.action === "shell") continue;
        const file = target.files.find(file => file.path === row.absolutePath);
        // The durable schema has only changed/failed; a missing, incomplete or unreadable copy is recorded as
        // failed so the model note says it "could not be reverted" rather than claiming the file changed.
        if (!file || row.action === "skip") { skipped.push({ path: row.path, reason: !file || row.status === CHANGED_SINCE ? "changed" : "failed" }); continue; }
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
            row.status = `could not restore · ${undoFailureReason(error)}`; skipped.push({ path: row.path, reason: "failed" }); restoreFailed = true;
            this.retainNoticeDetails(`${row.path}: ${messageOf(error)}`);
          }
        }
      }
      const failed = restoreFailed;
      preview.result = true;
      if (!reverted.length) {
        const allChanged = skipped.every(file => file.reason === "changed");
        // Keep per-file reasons visible when they differ or paths without saved undo remain; no row counts as reverted.
        if (!failed && allChanged && !preview.files.some(row => row.action === "shell")) this.undoPreview = undefined;
        this.notice(failed ? "Undo failed · Esc close" : allChanged ? "Nothing to undo · every file changed since" : `Nothing to undo in turn ${target.turnNumber} · Esc close`);
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

  /** Select the latest changed turn on this ancestry unless any branch already recorded its undo, keeping per-turn evidence. */
  private async undoEvidence(store: UndoStore): Promise<UndoEvidence> {
    const users = this.session.items.filter(item => item.type === "user").map(item => item.id);
    const undone = new Set(this.session.entries.flatMap(entry => entry.item.type === "turn_undo" ? [entry.item.turnId] : []));
    return collectUndoEvidence(await store.list(this.session.rootId), users, undone);
  }

  /** Build read-only rows for paths without saved undo: the target's own first, then other turns newest first. */
  private unsavedUndoRows(limits: UndoLimits, targetId: string | undefined): UndoPreviewFile[] {
    const root = this.workspace!.root, groups = new Map<string, Map<string, UndoPreviewFile>>();
    for (const entry of limits.unsaved) {
      const group = groups.get(entry.turnId) ?? new Map<string, UndoPreviewFile>(), observed = entry.kind === "observed";
      groups.set(entry.turnId, group);
      if (group.has(entry.path)) continue;
      group.set(entry.path, { path: displayToolPath(root, entry.path), absolutePath: entry.path, action: "shell", binary: false,
        status: `${entry.turnId === targetId ? "" : `turn ${entry.ordinal} · `}${observed ? "no saved undo" : "undo data incomplete"}`,
        rows: [{ sign: " ", text: observed ? `Seen during turn ${entry.ordinal} · no saved undo` : `Turn ${entry.ordinal} undo data is incomplete` },
          { sign: " ", text: "Undo leaves this file as it is · Alt+R review" }] });
    }
    return [...groups.values()].flatMap(group => [...group.values()].sort((a, b) => a.path.localeCompare(b.path)));
  }

  /** Explain why no file-tool undo applies, opening a read-only list only for known paths without saved undo. */
  private explainNothingToUndo(limits: UndoLimits, unsaved: UndoPreviewFile[]): boolean {
    if (unsaved.length) {
      this.undoReturn = undefined;
      this.closeChangeReview();
      this.undoPreview = { turnId: "", turnNumber: limits.unsaved[0]!.ordinal, files: unsaved, selected: 0, result: false, readOnlyStatus: "No saved undo for these changes",
        notes: [...(limits.undetected.length ? ["Some changes can't be detected here"] : []), ...(limits.missing.length ? [`No saved undo data for ${turnList(limits.missing)}`] : [])] };
      return true;
    }
    if (limits.undetected.length) {
      const off = this.gitChangeTracking() === "off";
      this.notice("Change detection unavailable · F2 details", `Undo saves edit and write changes only, and none can be undone on this branch. Change detection was unavailable for ${turnList(limits.undetected)}, so files changed in other ways can't be listed. They may still have changed.${limits.missing.length ? ` No undo data is saved for ${turnList(limits.missing)}.` : ""} ${off ? 'Change tracking is off; turn it on with /config set git {"changeTracking":"on-demand"}.' : "Detection needs a Git workspace and a completed status capture."}`);
      return true;
    }
    if (limits.missing.length) {
      this.notice("No saved undo data · F2 details", `No undo data is saved for ${turnList(limits.missing)}. Retention may have removed it, or it was never saved. Undo can't tell which, and files are left as they are.`);
      return true;
    }
    this.notice("Nothing to undo");
    return true;
  }

  /** Describe durable pre-images against current bytes without modifying files or session history. */
  private async previewUndoFile(store: UndoStore, manifest: UndoManifest, path: string): Promise<UndoPreviewFile> {
    const file = manifest.files.find(file => file.path === path)!;
    let current: Buffer | null = null, before: Buffer | null = null;
    let observed: FileObservation | null = null, unavailable: "incomplete" | "missing" | "unreadable" | undefined = file.after === undefined ? "incomplete" : undefined;
    try { observed = await observeFile(path, undefined, { regularOnly: true }); current = observed?.bytes ?? null; }
    catch (error) {
      // Replacement by a directory, link or other entry is a later change; only real read failures are unreadable.
      if (!(error instanceof FileChangedError) && !["ENOENT", "EISDIR", "EINVAL"].some(code => isErrno(error, code))) unavailable ??= "unreadable";
    }
    try { if (!unavailable && file.before) before = await store.blob(manifest.sessionId, file.before.sha256); }
    catch { unavailable = "missing"; }
    const eligible = !unavailable && observed?.entry.isFile() && file.after !== undefined && equalUndoHash(hashUndoBytes(current), file.after)
      && (file.afterMode === undefined || observed.mode === undefined || file.afterMode === observed.mode);
    const action = eligible ? file.before === null ? "delete" : "restore" : "skip";
    if (unavailable) return { path: displayToolPath(this.workspace!.root, path), absolutePath: path, action: "skip", binary: false,
      status: { incomplete: "undo data incomplete · skip", missing: "no saved copy · skip", unreadable: "can't read · skip" }[unavailable],
      rows: [{ sign: " ", text: { incomplete: `Turn ${manifest.turnNumber} undo data is incomplete · undo leaves this file as it is`,
        missing: "Saved copy is missing · undo leaves this file as it is", unreadable: "Can't read this file · undo leaves it as it is" }[unavailable] }] };
    /** Decode absent files as empty text and reject binary or invalid UTF-8 content. */
    const decode = (bytes: Buffer | null) => bytes === null ? "" : bytes.includes(0) ? undefined : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    let oldText: string | undefined, newText: string | undefined;
    try { oldText = decode(current); newText = decode(before); } catch { /* Binary or invalid UTF-8 has no textual diff. */ }
    const binary = oldText === undefined || newText === undefined;
    const diff = binary ? { rows: [], added: 0, removed: 0 } : diffLines(oldText!, newText!);
    const row: UndoPreviewFile = { path: displayToolPath(this.workspace!.root, path), absolutePath: path, action,
      status: action === "skip" ? CHANGED_SINCE : action === "delete" ? "new     delete" : binary ? "restore" : `+${diff.added} −${diff.removed}   restore`,
      rows: binary ? [{ sign: " ", text: "Binary file · restore only" }] : diff.rows, binary };
    if (eligible && observed) this.undoObservations.set(row, observed);
    return row;
  }
}

/** Name up to ten turn ordinals, counting the rest. */
function turnList(ordinals: readonly number[]): string {
  return `${ordinals.length === 1 ? "turn" : "turns"} ${ordinals.slice(0, 10).join(", ")}${ordinals.length > 10 ? ` and ${ordinals.length - 10} more` : ""}`;
}

/** Skip badge for a post-image that no longer matches current bytes or permissions. */
const CHANGED_SINCE = "changed since · skip";

/** Preserve raw failure diagnostics for the existing details surface. */
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
