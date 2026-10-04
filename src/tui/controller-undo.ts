import { unlink } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type { TurnUndoRecord } from "../conversation/types.ts";
import { formatCount } from "../text/format.ts";
import { diffLines, parseGitDiff, type GitDiffRow } from "../text/diff.ts";
import { redactSecrets } from "../auth/secrets.ts";
import { getGitDiffPreview, inspectGitStatus } from "../workspace/git.ts";
import { assertFileUnchanged, FileChangedError, writeFileAtomically, type FileObservation } from "../tools/fs.ts";
import { displayToolPath } from "../tools/path.ts";
import { undoFailureReason } from "../undo/errors.ts";
import { collectUndoEvidence, describeUndoLimits, observeUndoFile, undoTargetVerdict, type UndoEvidence, type UndoLimits } from "../undo/evidence.ts";
import { buildUndoNote, formatUndoResult } from "../undo/record.ts";
import { equalUndoHash, hashUndoBytes, openUndoStore, type UndoManifest, type UndoStore } from "../undo/store.ts";
import { ChangesLayer } from "./controller-changes.ts";
import type { ChangeReview, UndoPreview, UndoPreviewFile } from "./controller-types.ts";
import { CURRENT_DIFF_FAILED, LOADING_CURRENT_DIFF, pathStateNote } from "./review-scope.ts";
import { UNDO_REVIEW_OUTSIDE } from "./undo-view.ts";
import { SESSION_BLOCKED_HINT } from "./running-hints.ts";

/** Review opened from the undo panel: its paths, Git query paths and the identity it began in. */
interface UndoReviewContext {
  review: ChangeReview;
  /** Canonical path per listed file, kept for reload. */
  absolute: string[];
  /** Literal Git query path per listed file, relative to `gitRoot` or absolute when outside it. */
  queries: string[];
  /** False until the Git availability check settles; selection waits so paths pair with the right root. */
  ready: boolean;
  gitRoot?: string;
  /** Explanation shown for every file when current Git content cannot be read. */
  unavailable?: string;
  identity: string;
}

/** Preview and apply the latest eligible accepted turn's file undo without rewinding history. */
export abstract class UndoLayer extends ChangesLayer {
  protected undoPreview?: UndoPreview;
  protected undoBusy = false;
  private undoObservations = new WeakMap<UndoPreviewFile, FileObservation>();
  /** The undo panel that review replaced, restored when that review closes. */
  private undoReturn?: UndoPreview;
  /** Git query state for a review opened from the undo panel; turn review keeps its own context. */
  private undoReview?: UndoReviewContext;

  /** Open an undo preview from durable data on the active ancestry, refusing arguments and busy execution. */
  async undoCommand(args: string): Promise<boolean> {
    if (this.disposed || this.running) return false;
    if (args.trim()) { this.fail("Usage: /undo"); return false; }
    if (this.sessionWriteBlocked) { this.fail(`Session storage blocked · ${SESSION_BLOCKED_HINT}`); return false; }
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
      // Skipped rows other than CHANGED_SINCE carry an unavailable reason; the shared verdict keeps /history's line in step.
      const verdict = undoTargetVerdict(files.map(file => ({ eligible: file.action !== "skip", unavailable: file.action === "skip" && file.status !== CHANGED_SINCE ? file.status : undefined })), unsaved.length);
      const nothing = verdict !== "preview";
      // Without known paths left in place, an all-conflict turn keeps the established one-line explanation.
      if (verdict === "changed-since") { this.notice("Nothing to undo · every file changed since"); return true; }
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
    this.undoReview = undefined;
    const back = this.undoReturn;
    this.undoReturn = undefined;
    if (back && !this.disposed) this.undoPreview = back;
  }

  /** Replace the undo panel with read-only current diffs for its workspace paths; Esc returns to the same panel. */
  async reviewUndoChanges(): Promise<boolean> {
    const preview = this.undoPreview;
    if (!preview || preview.result || this.undoBusy || this.running || this.disposed || !this.workspace) return false;
    const root = this.workspace.root, seen = new Set<string>();
    const files: ChangeReview["files"] = [], absolute: string[] = [];
    for (const row of preview.files) {
      const path = relative(root, row.absolutePath);
      if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path) || seen.has(path)) continue;
      // Rows keep the undo panel's own split; an undo-panel review never shows a source badge or source note.
      seen.add(path); files.push({ path, source: row.action === "shell" ? "shell" : "tool" }); absolute.push(row.absolutePath);
    }
    this.closeChangeReview();
    this.undoPreview = undefined;
    this.undoReturn = preview;
    return this.loadUndoReview(files, absolute);
  }

  /** Move through an undo-panel review's paths, or defer to turn review when that is open. */
  override async selectReviewFile(delta: number): Promise<void> {
    const context = this.undoReview, review = this.changeReview;
    if (!context || context.review !== review) return super.selectReviewFile(delta);
    if (!review.files.length || !context.ready || this.disposed) return;
    review.selected = (review.selected + delta + review.files.length) % review.files.length;
    await this.loadUndoReviewFile(context, ++this.reviewGeneration);
  }

  /** Reread Git state for an undo-panel review, keeping its paths and selection, or defer to turn review. */
  override async refreshChangeReview(): Promise<boolean> {
    const context = this.undoReview;
    if (!context || context.review !== this.changeReview) return super.refreshChangeReview();
    if (this.disposed || this.running) return false;
    return this.loadUndoReview(context.review.files, context.absolute, context.review);
  }

  /** Open or reload the undo-panel review, fencing every Git read to this review, generation and identity. */
  private async loadUndoReview(files: ChangeReview["files"], absolute: string[], prior?: ChangeReview): Promise<boolean> {
    const generation = ++this.reviewGeneration;
    const review: ChangeReview = { heading: "Review · current changes", fromUndo: true, files: files.map(file => ({ ...file })),
      selected: prior && prior.selected < files.length ? prior.selected : 0, detail: "", rows: [], showingDetails: prior?.showingDetails ?? false, loading: true,
      details: undoReviewDetails("loading") };
    const context: UndoReviewContext = { review, absolute, queries: [...absolute], ready: false, identity: this.undoReviewIdentity() };
    this.changeReview = review;
    this.undoReview = context;
    if (!files.length) context.unavailable = UNDO_REVIEW_OUTSIDE;
    else if (this.gitChangeTracking() === "off") context.unavailable = "Change tracking off. No Git state read.";
    else {
      const status = await inspectGitStatus(this.workspace!.root);
      if (!this.undoReviewCurrent(context, generation)) return false;
      if ("error" in status) context.unavailable = `${CURRENT_DIFF_FAILED}\n${status.error}`;
      else if (!status.isGit) context.unavailable = "Non-Git workspace. Current Git diff unavailable.";
      else {
        context.gitRoot = status.root;
        context.queries = absolute.map(path => {
          const inside = relative(status.root, path);
          return inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside) ? path : inside;
        });
      }
    }
    context.ready = true;
    review.loading = false;
    review.details = undoReviewDetails(!files.length ? "outside" : this.gitChangeTracking() === "off" ? "off" : context.gitRoot !== undefined ? "read" : context.unavailable?.startsWith(CURRENT_DIFF_FAILED) ? "failed" : "non-git");
    if (!files.length) {
      review.detail = redactSecrets(context.unavailable ?? "", this.secrets);
      review.rows = [{ sign: " ", text: review.detail }];
      return true;
    }
    await this.loadUndoReviewFile(context, generation);
    return true;
  }

  /** Load the selected path's current diff, discarding the result once selection, review or identity moves on. */
  private async loadUndoReviewFile(context: UndoReviewContext, generation: number): Promise<void> {
    const review = context.review, index = review.selected, file = review.files[index]!;
    const show = (rows: GitDiffRow[], loading = false) => {
      review.rows = rows.map(row => ({ ...row, text: redactSecrets(row.text, this.secrets) }));
      review.detail = review.rows.map(row => row.line === undefined ? row.text : `${row.line} ${row.sign} ${row.text}`).join("\n");
      review.loading = loading;
    };
    review.currentPath = file.path;
    if (context.unavailable !== undefined || context.gitRoot === undefined) {
      show((context.unavailable ?? "").split("\n").map(text => ({ sign: " " as const, text })));
      return;
    }
    // Clear earlier rows before awaiting so a pending reload never presents older content as current.
    show([{ sign: " ", text: LOADING_CURRENT_DIFF }], true);
    const preview = await getGitDiffPreview(context.gitRoot, context.queries[index]!);
    if (!this.undoReviewCurrent(context, generation) || review.selected !== index || review.currentPath !== file.path) return;
    if ("error" in preview) show([{ sign: " ", text: CURRENT_DIFF_FAILED }, { sign: " ", text: preview.error }]);
    else if (preview.pathState) show([{ sign: " ", text: pathStateNote(preview.pathState) }]);
    else show(parseGitDiff(preview, { includeComparisons: true }));
  }

  /** Whether an async undo-review step still owns the open review, its generation and the conversation it began in. */
  private undoReviewCurrent(context: UndoReviewContext, generation: number): boolean {
    return !this.disposed && this.changeReview === context.review && this.undoReview === context && generation === this.reviewGeneration
      && context.identity === this.undoReviewIdentity();
  }

  /** Conversation and workspace identity that a pending undo-review read must still match. */
  private undoReviewIdentity(): string {
    return JSON.stringify([this.sessionId, this.session.rootId, this.session.activeBranchId, this.workspace?.root ?? null]);
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
    // The shared observation keeps history's undo eligibility identical to this preview.
    const { observed, current, before, eligible, unavailable } = await observeUndoFile(store, manifest, file);
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

/** F2 details for an undo-panel review; only a review that read Git says when Git is read. */
export function undoReviewDetails(state: "loading" | "outside" | "off" | "non-git" | "failed" | "read"): string {
  const scope = "Review shows current working-tree diffs for paths in the undo panel. Undo restores only edit and write changes with saved copies; other paths stay as they are. Changes seen during a turn may include edits made outside Schway.";
  const read = {
    loading: "Reading current Git status for this workspace.",
    outside: "No listed path is inside this workspace, so review read no Git state.",
    off: 'Change tracking is off (git.changeTracking="off"), so review read no Git state. Set it to on-demand or snapshot to see current diffs.',
    "non-git": "Git found no repository enclosing this workspace, so no current Git diff is shown. Undo still works.",
    failed: "Git could not read this workspace. The diff pane shows Git's reason; press Ctrl+R to reload.",
    read: "Current diff is read from Git when review opens, when you select a file and when Ctrl+R reloads.",
  }[state];
  return `${scope} ${read}`;
}

/** Preserve raw failure diagnostics for the existing details surface. */
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
