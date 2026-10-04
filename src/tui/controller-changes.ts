import { formatCount } from "../text/format.ts";
import { redactSecrets } from "../auth/secrets.ts";
import { openUndoStore } from "../undo/store.ts";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { DEFAULT_GIT_CHANGE_TRACKING, type GitChangeTrackingMode } from "../config/config.ts";
import { captureGitSnapshot, compareGitSnapshots, formatGitComparison, formatGitDiffPreview, formatGitStatus, getGitDiffPreview, inspectGitStatus } from "../workspace/git.ts";
import type { ChangeReview, TurnOutcome } from "./controller-types.ts";
import { parseGitDiff, type GitDiffRow } from "../text/diff.ts";
import { CURRENT_DIFF_FAILED, DETECTED_FILE_NOTE, LOADING_CURRENT_DIFF, pathStateNote, reviewScopeDetails, type ReviewScope } from "./review-scope.ts";
import { buildOutcomeDetails } from "./outcome-details.ts";
import { BranchesLayer } from "./controller-branches.ts";


/** Controller-private ownership of one open review: Git query paths, availability and the identity it began in. */
interface ReviewContext {
  review: ChangeReview;
  /** False until the Git availability check settles; selection waits so paths pair with the right root. */
  ready: boolean;
  /** Literal Git query path per listed file, relative to `gitRoot` or absolute when outside it. */
  queries: string[];
  gitRoot?: string;
  /** Explanation shown for every file when current Git content cannot be read. */
  unavailable?: string;
  identity: string;
}

/** Working-tree change review and per-turn outcome capture. */
export abstract class ChangesLayer extends BranchesLayer {
  private reviewContext?: ReviewContext;

  /** Return the effective observational change-tracking mode with on-demand as the default. */
  gitChangeTracking(): GitChangeTrackingMode {
    return this.configEditor?.settings.gitChangeTracking ?? this.explicitChangeTracking ?? DEFAULT_GIT_CHANGE_TRACKING;
  }

  /** Show Git branch, HEAD, dirty state, and bounded changes without managing commits or branches. */
  async changesCommand(args: string): Promise<boolean> {
    if (this.disposed) return false;
    if (args.trim() === "review") return this.openChangeReview();
    const mode = this.gitChangeTracking();
    if (mode === "off") {
      this.notice("Change tracking is off · /config set git {\"changeTracking\":\"on-demand\"} enable");
      return true;
    }
    if (!this.workspace) {
      this.fail("No workspace active · Restart Schway in a workspace");
      return false;
    }
    const trimmed = args.trim();
    const [sub, ...rest] = trimmed.split(/\s+/);
    const action = !sub ? "status" : sub.toLowerCase();
    if (action === "mode") {
      const origin = this.configEditor?.origins.git ? ` [${this.configEditor.origins.git}]` : "";
      this.notice(`Change tracking: ${mode} · /changes review · F2 details`, `${origin ? `Configuration source:${origin}.\n` : ""}Off disables inspection; on-demand and snapshot capture paths and hashes before and after each turn, never file content. Snapshot also shows the comparison in /changes status. Diffs load only when requested.`);
      return true;
    }
    if (action === "diff") {
      const path = rest.join(" ").replace(/^(--\s+)?/, "").trim() || undefined;
      const preview = await getGitDiffPreview(this.workspace.root, path);
      if ("error" in preview) {
        if (preview.error.startsWith("Not a Git workspace")) {
          this.notice(`${preview.error} Coding continues; Git inspection is unavailable here.`);
          return true;
        }
        this.fail(preview.error);
        return false;
      }
      if (path && preview.pathState) {
        // A path with no comparison was never diffed; say why instead of implying it is unchanged.
        const note = preview.pathState === "unavailable" ? "Diff unavailable · /changes status" : pathStateNote(preview.pathState);
        this.notice(redactSecrets(`${note}\n${path}`, this.secrets), formatGitDiffPreview(preview));
        return true;
      }
      const rows = parseGitDiff(preview, { includePaths: !path, includeSections: true }).map(row => row.line === undefined ? row.text : `${row.line} ${row.sign} ${row.text}`);
      this.notice(redactSecrets(["Review diff · F2 details · Enter continue", ...(path ? [path] : []), ...rows].join("\n"), this.secrets).slice(0, 50_000), formatGitDiffPreview(preview));
      return true;
    }
    if (action !== "status" && trimmed.length > 0) {
      this.fail("Choose a changes view · /changes [review|status|diff [-- <path>]]");
      return false;
    }
    const status = await inspectGitStatus(this.workspace.root);
    if ("error" in status) {
      this.fail(status.error);
      return false;
    }
    const lines = [`Change tracking: ${mode}.`, formatGitStatus(status)];
    if (mode === "snapshot") {
      if (this.gitSnapshotError) {
        lines.push(`Snapshot unavailable: ${this.gitSnapshotError}`);
      } else if (this.gitBaseline && this.gitAfter && this.gitComparison && this.gitBaseline.root === this.gitAfter.root) {
        lines.push("", formatGitComparison(this.gitBaseline, this.gitAfter, this.gitComparison));
      } else if (this.gitBaseline) {
        lines.push("", `Baseline ${this.gitBaseline.id} captured at ${this.gitBaseline.capturedAt}. Run a turn to compare, or use /changes diff for content.`);
      } else {
        lines.push("", "No retained snapshot for this workspace yet. The next turn captures a baseline before it runs.");
      }
      lines.push("Snapshots cover the current session/run only and cannot restore files.");
    }
    const primary = status.isGit
      ? [`${formatCount(status.totalFiles, "changed file")} · /changes diff inspect · F2 details`, ...(status.branch ? [`Branch: ${status.branch}`] : ["Detached HEAD"]), ...status.files.map(file => file.path)]
      : ["Not a Git workspace · Enter continue"];
    if (this.gitSnapshotError) primary.unshift("Snapshot unavailable · F2 details");
    this.notice(redactSecrets(primary.join("\n"), this.secrets), lines.join("\n"));
    return true;
  }

  /** Open read-only review of the retained turn, loading current content only on request. */
  async openChangeReview(): Promise<boolean> {
    return this.loadChangeReview();
  }

  /** Reread Git state and the selected file's current diff while keeping the retained turn list and selection. */
  async refreshChangeReview(): Promise<boolean> {
    const prior = this.changeReview;
    if (!prior?.scope || this.disposed || this.running) return false;
    return this.loadChangeReview(prior);
  }

  /** Build turn evidence before any Git read, then fence every async step to this review and identity. */
  private async loadChangeReview(prior?: ChangeReview): Promise<boolean> {
    if (this.disposed || this.running) return false;
    const generation = ++this.reviewGeneration;
    const outcome = this.snapshot().outcome;
    const ordinal = this.session.items.filter(item => item.type === "user").findIndex(item => item.id === this.outcomeUserId) + 1;
    if (!outcome) {
      this.reviewContext = undefined;
      this.changeReview = { heading: "No turn to review yet", files: [], selected: 0, detail: "", rows: [], details: "", showingDetails: false, loading: false };
      return true;
    }
    const scope: ReviewScope = { kind: "turn", turn: ordinal };
    // The observed turn record is the list; current Git state can explain each file but never replaces it.
    const files = outcome.files.map(file => ({ ...file }));
    const review: ChangeReview = { heading: `Review · turn ${ordinal}`, scope, files, selected: prior && prior.selected < files.length ? prior.selected : 0,
      detail: files.length ? LOADING_CURRENT_DIFF : "", rows: files.length ? [{ sign: " ", text: LOADING_CURRENT_DIFF }] : [], details: `${this.turnDetails()}\n\n${reviewScopeDetails(scope)}`, showingDetails: prior?.showingDetails ?? false, loading: true };
    const context: ReviewContext = { review, ready: false, queries: files.map(file => file.path), identity: this.reviewIdentity() };
    this.changeReview = review;
    this.reviewContext = context;
    const mode = this.gitChangeTracking();
    let dirty = false;
    if (mode === "off") context.unavailable = "Change tracking off. No Git state read.";
    else if (!this.workspace) context.unavailable = "No workspace · Restart Schway in a workspace";
    else {
      const status = await inspectGitStatus(this.workspace.root);
      if (!this.reviewCurrent(context, generation)) return false;
      if ("error" in status) context.unavailable = `${CURRENT_DIFF_FAILED}\n${status.error}`;
      else if (!status.isGit) context.unavailable = "Non-Git workspace. Current Git diff unavailable.";
      else {
        context.gitRoot = status.root;
        dirty = status.dirty;
        review.files = outcome.files.map((file, index) => {
          const resolvedPath = file.source === "tool" ? this.successfulToolPaths.get(file.path) : undefined;
          if (resolvedPath === undefined) return { ...file };
          const inside = relative(status.root, resolvedPath);
          // Keep the recorded name for a path outside the repository; Git reports it as outside, not as missing.
          if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) { context.queries[index] = resolvedPath; return { ...file }; }
          context.queries[index] = inside;
          return { ...file, path: inside };
        });
      }
    }
    context.ready = true;
    review.loading = false;
    if (!review.files.length) {
      review.detail = redactSecrets(context.unavailable ?? (dirty ? "No file changes observed · /changes status" : "No working-tree changes"), this.secrets);
      review.rows = [{ sign: " ", text: review.detail }];
      return true;
    }
    await this.loadReviewFile(context, generation);
    return true;
  }

  /** Toggle the shared turn evidence in place without closing review or changing its file selection. */
  toggleReviewDetails(): boolean {
    if (!this.changeReview || !this.snapshot().outcome) return false;
    this.changeReview.showingDetails = !this.changeReview.showingDetails;
    return true;
  }

  /** Build one redacted evidence view shared by failed-turn Details; review Details append the review scope notes. */
  protected turnDetails(): string {
    if (!this.outcome) return "No turn to review yet";
    const mode = this.gitChangeTracking();
    const shellUnavailable = mode === "off" ? 'change tracking is off (git.changeTracking="off").'
      : !this.workspace ? "no workspace is active."
      : this.gitSnapshotError ?? (!this.gitComparison ? `Snapshot attribution unavailable (${mode}); no completed capture.` : undefined);
    return redactSecrets(buildOutcomeDetails(this.outcome, {
      shellUnavailable,
      comparison: this.gitBaseline && this.gitAfter && this.gitComparison ? formatGitComparison(this.gitBaseline, this.gitAfter, this.gitComparison) : undefined,
      recovery: this.outcomeDiagnostics,
    }), this.secrets);
  }

  /** Select a retained turn path and load numbered current diff rows or a plain explanation. */
  async selectReviewFile(delta: number): Promise<void> {
    const review = this.changeReview, context = this.reviewContext;
    // Selection waits for the Git availability check so a path never pairs with the wrong query root.
    if (!review || !review.files.length || context?.review !== review || !context.ready || this.disposed) return;
    review.selected = (review.selected + delta + review.files.length) % review.files.length;
    await this.loadReviewFile(context, ++this.reviewGeneration);
  }

  /** Load the selected path's current content, discarding the result if selection, review or identity moved on. */
  private async loadReviewFile(context: ReviewContext, generation: number): Promise<void> {
    const review = context.review;
    const index = review.selected, file = review.files[index]!;
    const notes: GitDiffRow[] = file.source === "shell" ? [{ sign: " ", text: DETECTED_FILE_NOTE }] : [];
    const show = (rows: GitDiffRow[], loading = false) => {
      review.rows = [...notes, ...rows].map(row => ({ ...row, text: redactSecrets(row.text, this.secrets) }));
      review.detail = review.rows.map(row => row.line === undefined ? row.text : `${row.line} ${row.sign} ${row.text}`).join("\n");
      review.loading = loading;
    };
    review.currentPath = file.path;
    if (context.unavailable !== undefined || context.gitRoot === undefined) {
      show(context.unavailable === undefined ? [] : context.unavailable.split("\n").map(text => ({ sign: " " as const, text })));
      return;
    }
    // Clear earlier rows before awaiting so a pending reload never presents older content as current.
    show([{ sign: " ", text: LOADING_CURRENT_DIFF }], true);
    const preview = await getGitDiffPreview(context.gitRoot, context.queries[index]!);
    if (!this.reviewCurrent(context, generation) || review.selected !== index || review.currentPath !== file.path) return;
    if ("error" in preview) show([{ sign: " ", text: CURRENT_DIFF_FAILED }, { sign: " ", text: preview.error }]);
    else if (preview.pathState) show([{ sign: " ", text: pathStateNote(preview.pathState) }]);
    else show(parseGitDiff(preview, { includeComparisons: true }));
  }

  /** Whether an async review step still owns the open review, its generation and the session/workspace it began in. */
  private reviewCurrent(context: ReviewContext, generation: number): boolean {
    return !this.disposed && this.changeReview === context.review && this.reviewContext === context && generation === this.reviewGeneration && context.identity === this.reviewIdentity();
  }

  /** Conversation and workspace identity that a pending review read must still match. */
  private reviewIdentity(): string {
    return JSON.stringify([this.sessionId, this.session.rootId, this.session.activeBranchId, this.workspace?.root ?? null, this.outcomeUserId ?? null]);
  }

  /** Close review while leaving the conversation, draft, files, and Git state untouched. */
  closeChangeReview(): void {
    this.reviewGeneration++;
    this.changeReview = undefined;
    this.reviewContext = undefined;
  }

  /** Settle duration, retained diagnostics, and observed file evidence for the latest accepted turn. */
  protected async finishOutcome(reason?: TurnOutcome["reason"]): Promise<void> {
    const owner = this.activeAbort;
    this.compactionNotice = undefined;
    if (!this.outcome || this.disposed) return;
    if (reason) this.outcome.reason = reason;
    this.outcomeDiagnostics = this.outcome.reason === "failed" && this.recovery?.accepted ? this.recovery.details : undefined;
    this.outcome.elapsedMs = this.activity ? Math.max(0, this.activityClock() - this.activity.startedAt) : 0;
    this.outcome.files = this.outcome.files.filter(file => file.source === "tool");
    this.outcome.files.push(...this.gitShellPaths.map(path => ({ path, source: "shell" as const })));
    if (this.home && this.workspace && this.outcomeUserId) {
      try {
        await openUndoStore({ home: this.home }).recordShell({ sessionId: this.session.rootId, turnId: this.outcomeUserId,
          turnNumber: this.session.items.filter(item => item.type === "user").findIndex(item => item.id === this.outcomeUserId) + 1 },
        this.gitComparison ? { detection: "git", paths: this.outcome.files.filter(file => file.source === "shell").map(file => resolve(this.workspace!.root, file.path)) } : { detection: "unavailable" });
      } catch (error) { if (!this.disposed && this.activeAbort === owner) this.retainNoticeDetails(`Could not save undo shell detection: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }

  /** Capture a snapshot baseline for the owning turn signal, dropping stale results after replacement. */
  protected async captureTurnBaseline(signal: AbortSignal): Promise<void> {
    if (this.disposed || this.activeAbort?.signal !== signal) return;
    this.gitSnapshotError = undefined;
    this.gitBaseline = undefined;
    this.gitAfter = undefined;
    this.gitComparison = undefined;
    this.gitShellPaths = [];
    if (this.gitChangeTracking() === "off" || !this.workspace) return;
    const snapshot = await captureGitSnapshot(this.workspace.root).catch(error => ({ error: error instanceof Error ? error.message : String(error) }));
    if (this.disposed || this.activeAbort?.signal !== signal) return;
    if ("error" in snapshot) {
      this.gitBaseline = undefined;
      this.gitAfter = undefined;
      this.gitComparison = undefined;
      this.gitSnapshotError = snapshot.error;
      return;
    }
    this.gitBaseline = snapshot;
    this.gitAfter = undefined;
    this.gitComparison = undefined;
  }

  /** Capture final state after a settled turn and compare it against the baseline. */
  protected async captureTurnResult(signal: AbortSignal): Promise<void> {
    if (this.gitChangeTracking() === "off" || !this.workspace || this.disposed || this.activeAbort?.signal !== signal) return;
    const baseline = this.gitBaseline;
    if (!baseline) return;
    const after = await captureGitSnapshot(this.workspace.root).catch(error => ({ error: error instanceof Error ? error.message : String(error) }));
    if (this.disposed || this.activeAbort?.signal !== signal || this.gitBaseline !== baseline) return;
    if ("error" in after) {
      this.gitAfter = undefined;
      this.gitComparison = undefined;
      this.gitSnapshotError = after.error;
      return;
    }
    const comparison = compareGitSnapshots(baseline, after);
    if ("error" in comparison) {
      this.gitAfter = undefined;
      this.gitComparison = undefined;
      this.gitSnapshotError = comparison.error;
      return;
    }
    // Retain only the latest turn pair with a valid identity; older snapshots are dropped.
    this.gitAfter = after;
    this.gitComparison = comparison;
    this.gitSnapshotError = undefined;
    const toolPaths = new Set([...this.successfulToolPaths.values()].map(path => relative(baseline.root, path)));
    this.gitShellPaths = [...new Set([...comparison.newChanges, ...comparison.updatedPreExisting, ...(comparison.resolved ?? [])])]
      .filter(path => !toolPaths.has(path)).sort((a, b) => a.localeCompare(b));
  }
}
