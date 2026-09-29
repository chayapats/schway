import { redactSecrets } from "../auth/secrets.ts";
import { DEFAULT_GIT_CHANGE_TRACKING, type GitChangeTrackingMode } from "../config/config.ts";
import { captureGitSnapshot, compareGitSnapshots, formatGitComparison, formatGitDiffPreview, formatGitStatus, getGitDiffPreview, inspectGitStatus, type GitFileChange } from "../workspace/git.ts";
import type { TurnOutcome } from "./controller-types.ts";
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
      this.notice("Change tracking is off (git.changeTracking=\"off\"). No Git state was read. Set git.changeTracking to \"on-demand\" or \"snapshot\" to inspect changes.");
      return true;
    }
    if (!this.workspace) {
      this.fail("No workspace is active. Open a workspace before inspecting Git changes.");
      return false;
    }
    const trimmed = args.trim();
    const [sub, ...rest] = trimmed.split(/\s+/);
    const action = !sub ? "status" : sub.toLowerCase();
    if (action === "mode") {
      const origin = this.configEditor?.origins.git ? ` [${this.configEditor.origins.git}]` : "";
      this.notice(`Change tracking: ${mode}${origin}. Off disables inspection; on-demand reads only here; snapshot captures a baseline before each turn and compares after it settles.`);
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
      this.notice(redactSecrets(formatGitDiffPreview(preview), this.secrets).slice(0, 50_000));
      return true;
    }
    if (action !== "status" && trimmed.length > 0) {
      this.fail("Usage: /changes [review|status|diff [-- <path>]]. Change tracking itself is configured with git.changeTracking.");
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
    this.notice(redactSecrets(lines.join("\n"), this.secrets).slice(0, 50_000));
    return true;
  }

  /** Open explicit observational review without enabling snapshots or mutating repository state. */
  async openChangeReview(): Promise<boolean> {
    if (this.disposed || this.running) return false;
    const generation = ++this.reviewGeneration;
    this.changeReview = { heading: "Loading current working tree…", files: [], selected: 0, detail: "", loading: true };
    const mode = this.gitChangeTracking();
    const evidence = this.snapshot().outcome;
    const prefix = evidence ? `Turn ${evidence.reason}. ${evidence.toolResults} tool results; ${evidence.failedTools} failed tools.\nCommands: ${evidence.commandCounts.exitZero} exit 0 / ${evidence.commandCounts.nonzero} nonzero / ${evidence.commandCounts.unknown} unknown (entire turn).\nCommand results (latest 50; exit codes, not a test-suite guarantee):\n${evidence.commands.map(c => `${c.callId}: ${c.command} → ${c.exitCode === null ? "no exit observed" : `exit ${c.exitCode}`} (${c.status})`).join("\n") || "No command exit evidence."}\n\n` : "No retained turn outcome.\n";
    let heading = mode === "off" ? "Change tracking off. No Git state read; attribution unavailable." : !this.workspace ? "No workspace; changes unavailable." : "";
    let files: GitFileChange[] = [];
    if (!heading && this.workspace) {
      const status = await inspectGitStatus(this.workspace.root);
      if (generation !== this.reviewGeneration || this.disposed) return false;
      if ("error" in status) heading = `Changes unavailable: ${status.error}`;
      else if (!status.isGit) heading = "Non-Git workspace. Git changes and attribution unavailable.";
      else {
        files = status.files.slice(0, 50);
        heading = status.dirty ? `Current working tree: ${status.totalFiles} changed paths${status.truncated || status.totalFiles > files.length ? " (list truncated)" : ""}.` : "No working-tree changes.";
        heading += "\nCurrent working-tree content is unattributed; external edits may be included.";
        if (mode === "snapshot" && evidence && this.gitBaseline && this.gitAfter && this.gitComparison) {
          heading += `\n${formatGitComparison(this.gitBaseline, this.gitAfter, this.gitComparison)}\nSnapshots show changes observed during the turn, not exclusive Schway authorship. Current diffs may include later edits.`;
        } else heading += `\nSnapshot attribution unavailable (${mode}${this.gitSnapshotError ? `: ${this.gitSnapshotError}` : ""}).`;
      }
    }
    if (generation !== this.reviewGeneration || this.disposed) return false;
    const explanation = redactSecrets(prefix + heading + "\nReview is read-only. Files remain changed after failure/cancellation; conversation branching does not restore files.", this.secrets);
    this.changeReview = { heading: explanation.length > 14000 ? `${explanation.slice(0, 13900)}\n… Review truncated; inspect individual results and git status for full evidence.` : explanation, files, selected: 0, detail: "", loading: false };
    await this.selectReviewFile(0);
    return true;
  }

  /** Select a current changed path and load its bounded textual or binary explanation. */
  async selectReviewFile(delta: number): Promise<void> {
    const review = this.changeReview;
    if (!review || !review.files.length || !this.workspace) return;
    review.selected = (review.selected + delta + review.files.length) % review.files.length;
    const path = review.files[review.selected]!.path;
    const generation = ++this.reviewGeneration;
    review.loading = true;
    review.detail = "Loading diff…";
    const preview = await getGitDiffPreview(this.workspace.root, path);
    if (this.changeReview !== review || generation !== this.reviewGeneration || this.disposed) return;
    review.detail = redactSecrets("error" in preview ? preview.error : formatGitDiffPreview(preview), this.secrets).slice(0, 12000);
    review.loading = false;
  }

  /** Close review while leaving the conversation, draft, files, and Git state untouched. */
  closeChangeReview(): void {
    this.reviewGeneration++;
    this.changeReview = undefined;
  }

  protected finishOutcome(reason?: TurnOutcome["reason"]): void {
    this.compactionNotice = undefined;
    if (!this.outcome) return;
    if (reason) this.outcome.reason = reason;
    const comparison = this.gitComparison;
    this.outcome.changes = comparison
      ? `${comparison.newChanges.length} new paths; ${comparison.updatedPreExisting.length} pre-existing paths changed further; ${comparison.preExistingUnchanged.length} pre-existing unchanged (observed snapshots; not exclusive authorship).`
      : this.gitSnapshotError ? `Attribution unavailable: ${this.gitSnapshotError}`
      : "Changes not inspected; snapshot attribution unavailable. Alt+R review.";
    this.outcome.changes = redactSecrets(this.outcome.changes, this.secrets);
  }

  /** Capture a snapshot baseline for the owning turn signal, dropping stale results after replacement. */
  protected async captureTurnBaseline(signal: AbortSignal): Promise<void> {
    this.gitSnapshotError = undefined;
    if (this.gitChangeTracking() !== "snapshot" || !this.workspace || this.disposed) {
      this.gitBaseline = undefined;
      this.gitAfter = undefined;
      this.gitComparison = undefined;
      return;
    }
    const snapshot = await captureGitSnapshot(this.workspace.root);
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
  protected async captureTurnResult(): Promise<void> {
    if (this.gitChangeTracking() !== "snapshot" || !this.workspace || this.disposed) return;
    const baseline = this.gitBaseline;
    if (!baseline) return;
    const after = await captureGitSnapshot(this.workspace.root);
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
  }
}
