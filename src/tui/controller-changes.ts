import { formatCount } from "../text/format.ts";
import { redactSecrets } from "../auth/secrets.ts";
import { relative } from "node:path";
import { DEFAULT_GIT_CHANGE_TRACKING, type GitChangeTrackingMode } from "../config/config.ts";
import { captureGitSnapshot, compareGitSnapshots, formatGitComparison, formatGitDiffPreview, formatGitStatus, getGitDiffPreview, inspectGitStatus } from "../workspace/git.ts";
import type { TurnOutcome } from "./controller-types.ts";
import { parseGitDiff } from "../text/diff.ts";
import { buildOutcomeDetails } from "./outcome-details.ts";
import { BranchesLayer } from "./controller-branches.ts";


/** Working-tree change review and per-turn outcome capture. */
export abstract class ChangesLayer extends BranchesLayer {
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
      this.notice(`Change tracking: ${mode} · /changes review · Ctrl+I details`, `${origin ? `Configuration source:${origin}.\n` : ""}Off disables inspection; on-demand and snapshot capture paths and hashes before and after each turn, never file content. Snapshot also shows the comparison in /changes status. Diffs load only when requested.`);
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
      const rows = parseGitDiff(preview, { includePaths: !path, includeSections: true }).map(row => row.line === undefined ? row.text : `${row.line} ${row.sign} ${row.text}`);
      this.notice(redactSecrets(["Review diff · Ctrl+I details · Enter continue", ...(path ? [path] : []), ...rows].join("\n"), this.secrets).slice(0, 50_000), formatGitDiffPreview(preview));
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
      ? [`${formatCount(status.totalFiles, "changed file")} · /changes diff inspect · Ctrl+I details`, ...(status.branch ? [`Branch: ${status.branch}`] : ["Detached HEAD"]), ...status.files.map(file => file.path)]
      : ["Not a Git workspace · Enter continue"];
    if (this.gitSnapshotError) primary.unshift("Snapshot unavailable · Ctrl+I details");
    this.notice(redactSecrets(primary.join("\n"), this.secrets), lines.join("\n"));
    return true;
  }

  /** Open read-only review of the retained turn, loading current content only on request. */
  async openChangeReview(): Promise<boolean> {
    if (this.disposed || this.running) return false;
    const generation = ++this.reviewGeneration;
    const outcome = this.snapshot().outcome;
    const ordinal = this.session.items.filter(item => item.type === "user").findIndex(item => item.id === this.outcomeUserId) + 1;
    const review = { heading: outcome ? `Review · turn ${ordinal}` : "No turn to review yet", files: [] as TurnOutcome["files"], selected: 0, detail: "", rows: [] as import("../text/diff.ts").GitDiffRow[], details: outcome ? this.turnDetails() : "", showingDetails: false, loading: !!outcome };
    this.changeReview = review;
    if (!outcome) return true;
    const mode = this.gitChangeTracking();
    let unavailable = mode === "off" ? "Change tracking off. No Git state read; attribution unavailable." : !this.workspace ? "No workspace; changes unavailable." : "";
    if (!unavailable && this.workspace) {
      const status = await inspectGitStatus(this.workspace.root);
      if (generation !== this.reviewGeneration || this.disposed) return false;
      if ("error" in status) unavailable = `Changes unavailable: ${status.error}`;
      else if (!status.isGit) unavailable = "Non-Git workspace. Git changes and attribution unavailable.";
      else {
        review.files = outcome.files.map(file => {
          const resolvedPath = file.source === "tool" ? this.successfulToolPaths.get(file.path) : undefined;
          return { ...file, path: resolvedPath === undefined ? file.path : relative(status.root, resolvedPath) };
        });
        if (!review.files.length) review.detail = status.dirty ? "No files changed during this turn." : "No working-tree changes.";
      }
    }
    if (generation !== this.reviewGeneration || this.disposed) return false;
    if (unavailable) review.detail = redactSecrets(unavailable, this.secrets);
    review.rows = review.detail ? [{ sign: " ", text: review.detail }] : [];
    review.loading = false;
    await this.selectReviewFile(0);
    return true;
  }

  /** Toggle the shared turn evidence in place without closing review or changing its file selection. */
  toggleReviewDetails(): boolean {
    if (!this.changeReview || !this.snapshot().outcome) return false;
    this.changeReview.showingDetails = !this.changeReview.showingDetails;
    return true;
  }

  /** Build one redacted evidence view for review and the failed-turn transcript notice. */
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
    const review = this.changeReview;
    if (!review || !review.files.length || !this.workspace) return;
    review.selected = (review.selected + delta + review.files.length) % review.files.length;
    const file = review.files[review.selected]!;
    const generation = ++this.reviewGeneration;
    review.loading = true;
    review.detail = "Loading diff…";
    review.rows = [{ sign: " ", text: review.detail }];
    const preview = await getGitDiffPreview(this.workspace.root, file.path);
    if (this.changeReview !== review || generation !== this.reviewGeneration || this.disposed) return;
    review.rows = "error" in preview ? [{ sign: " ", text: preview.error }] : parseGitDiff(preview);
    if (file.source === "shell") review.rows.unshift({ sign: " ", text: "changed by shell · not undoable" });
    review.rows = review.rows.map(row => ({ ...row, text: redactSecrets(row.text, this.secrets) }));
    review.detail = review.rows.map(row => row.line === undefined ? row.text : `${row.line} ${row.sign} ${row.text}`).join("\n");
    review.loading = false;
  }

  /** Close review while leaving the conversation, draft, files, and Git state untouched. */
  closeChangeReview(): void {
    this.reviewGeneration++;
    this.changeReview = undefined;
  }

  /** Settle duration, retained diagnostics, and observed file evidence for the latest accepted turn. */
  protected finishOutcome(reason?: TurnOutcome["reason"]): void {
    this.compactionNotice = undefined;
    if (!this.outcome || this.disposed) return;
    if (reason) this.outcome.reason = reason;
    this.outcomeDiagnostics = this.outcome.reason === "failed" && this.recovery?.accepted ? this.recovery.details : undefined;
    this.outcome.elapsedMs = this.activity ? Math.max(0, this.activityClock() - this.activity.startedAt) : 0;
    this.outcome.files = this.outcome.files.filter(file => file.source === "tool");
    this.outcome.files.push(...this.gitShellPaths.map(path => ({ path, source: "shell" as const })));
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
