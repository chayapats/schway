import { redactSecrets } from "../auth/secrets.ts";
import type { Model } from "../model/model.ts";
import { resolveEffectiveThinking } from "../model/thinking.ts";
import type { TuiSnapshot } from "./controller-types.ts";
import { startupFailureCategory, startupRecoveryMessage } from "./controller-support.ts";
import { TurnLayer } from "./controller-turn.ts";
import { HistoryLayer } from "./controller-history.ts";

export type * from "./controller-types.ts";
export * from "./branch-tree.ts";
export * from "./transcript-format.ts";

/** Own interactive transcript state around the shared agent loop without loading the renderer. */
export class TuiController extends HistoryLayer {
  /** Replace the active conversation and expire its unconsumed notice diagnostics. */
  override replaceSession(...args: Parameters<TurnLayer["replaceSession"]>): void {
    super.replaceSession(...args);
    this.noticeDetails = undefined;
  }

  /** Return redacted current state and the active assistant preview independently of transcript order. */
  snapshot(): TuiSnapshot {
    const thinking = this.configEditor ? this.configEditor.settings.thinking : this.thinking;
    // One shared policy gives /thinking its description and the footer its chip.
    const effective = resolveEffectiveThinking(this.provider, thinking as never, this.modelId, this.thinkingContext());
    const branchTree = this.branchTreeForSnapshot();
    const activeRoute = this.model
      ? this.model.provider === "codex-subscription" ? "ChatGPT subscription" : this.model.provider === "openai" ? "OpenAI API key" : "OpenAI route"
      : this.openaiAuth === "codex" ? "ChatGPT subscription" : this.openaiAuth === "api-key" ? "OpenAI API key" : "OpenAI route";
    const recovery = this.currentRecovery();
    const context = this.contextSnapshot();
    return {
      status: this.status,
      approvalMode: this.currentApprovalMode,
      toolApproval: this.toolApproval ? { ...structuredClone(this.toolApproval),
        request: { ...this.toolApproval.request, toolName: redactSecrets(this.toolApproval.request.toolName, this.secrets) },
        content: redactSecrets(this.toolApproval.content, this.secrets),
        path: this.toolApproval.path ? redactSecrets(this.toolApproval.path, this.secrets) : undefined,
        diff: this.toolApproval.diff ? { ...this.toolApproval.diff, rows: this.toolApproval.diff.rows.map(row => ({ ...row, text: redactSecrets(row.text, this.secrets) })) } : undefined,
      } : undefined,
      streamingAssistantId: this.transcript.find(entry => entry.id === this.currentAssistantId && entry.text.length > 0 && !entry.incomplete)?.id,
      context,
      noticeDetailsAvailable: this.currentNoticeDetails() !== undefined,
      outcome: !this.activeAbort && this.outcomeIdentity === `${this.sessionId}/${this.session.activeBranchId}` && this.outcome ? structuredClone(this.outcome) : undefined,
      undoPreview: this.undoPreview ? structuredClone(this.undoPreview) : undefined,
      changeReview: this.changeReview ? structuredClone(this.changeReview) : undefined,
      ...this.historySnapshotField(),
      readiness: this.startupAbort ? "loading" : this.isNotConnected() ? "not-connected" : this.model ? "ready" : this.startupRecoveryCategory === "auth" ? "connect" : this.startupRecoveryCategory === "model" ? "choose-model" : "repair",
      ...(!this.model && this.startupDiagnostic ? { readinessDetail:
        /Missing OpenAI API key/.test(this.startupDiagnostic) ? "Missing OpenAI API key."
          : /no longer available/.test(this.startupDiagnostic) ? "Remembered model is no longer available in this account."
            : /Selected model is not available/.test(this.startupDiagnostic) ? "Selected model is not available in this account."
              : undefined } : {}),
      ...(this.activity ? { activity: this.activitySnapshot() } : {}),
      transcript: this.transcript.flatMap(entry => context.summaryId && context.firstKeptId === entry.sessionRecordId
        ? [{ id: `boundary-${context.summaryId}`, kind: "system" as const, text: "Active summary boundary · earlier rows remain history; recent model context starts below · /context" }, entry]
        : [entry]).map((entry) =>
        this.secrets.length === 0
          ? entry
          : { ...entry, text: redactSecrets(entry.text, this.secrets), toolSummary: entry.toolSummary ? redactSecrets(entry.toolSummary, this.secrets) : undefined,
              resultSummary: entry.resultSummary ? redactSecrets(entry.resultSummary, this.secrets) : undefined,
              diffRows: entry.diffRows?.map(row => ({ ...row, text: redactSecrets(row.text, this.secrets) })),
            },
      ),
      sessionId: this.sessionId,
      branchId: this.session.activeBranchId,
      provider: this.provider,
      modelId: this.modelId,
      ...(this.profile !== undefined ? { profile: this.profile } : {}),
      ...(this.xaiAuth !== undefined ? { xaiAuth: this.xaiAuth } : {}),
      ...(this.loginApprovalData ? { loginApprovalData: this.loginApprovalData } : {}),
      ...(this.openaiAuth !== undefined ? { openaiAuth: this.openaiAuth } : {}),
      ...(this.provider === "xai" ? { activeRoute: `${this.grokSelected() ? "Grok subscription" : "xAI API key"}${this.model ? "" : " (unavailable)"}` } : {}),
      ...(this.provider === "openai" ? { activeRoute: `${activeRoute}${this.model ? "" : " (unavailable)"}` } : {}),
      ...(thinking !== undefined ? { thinking } : {}), effectiveThinking: effective.label, ...(this.modelId ? { thinkingChip: effective.chip } : {}),
      preferences: this.preferences ? structuredClone(this.preferences) : undefined,
      recentSession: this.session.items.length === 0 ? this.recentSession : undefined,
      restored: this.restored,
      sessionPicker: this.sessionPicker ? structuredClone(this.sessionPicker) : undefined,
      modelPicker: this.modelPicker ? structuredClone(this.modelPicker) : undefined,
      credentialEntry: this.credentialEntrySnapshot(),
      ...(this.loginChooserState ? { loginChooser: this.loginChooserSnapshot() } : {}),
      ...(this.endpointUrlEntry ? { endpointUrlEntry: { ...this.endpointUrlEntry } } : {}),
      ...(this.loginCallbackValue !== undefined ? { loginCallbackEntry: { masked: "•".repeat(Math.min(this.loginCallbackValue.length, 64)) } } : {}),
      ...(this.loginApproval !== undefined ? { loginApproval: this.loginApproval } : {}),
      ...(this.loginApproval !== undefined && this.loginProvider ? { loginWait: { provider: this.loginProvider, ...(this.loginSaving ? { saving: true as const } : {}), ...(this.loginAbort?.signal.aborted ? { cancelling: true as const } : {}) } } : {}),
      ...(branchTree.tree !== undefined ? { branchTree: branchTree.tree } : {}),
      ...(branchTree.error !== undefined ? { branchTreeError: branchTree.error } : {}),
      ...(recovery ? { recovery } : {}),
      ...(this.sessionWriteBlocked ? { sessionWriteBlocked: true as const } : {}),
    };
  }

  /** True while startup, a turn, compaction or credential input owns interactive execution. */
  get running(): boolean {
    return this.undoBusy || this.startupAbort !== undefined || this.activeAbort !== undefined || this.credentialEntry !== undefined || this.endpointUrlEntry !== undefined || this.loginCallbackValue !== undefined || this.credentialMutation;
  }

  /** Resolve the selected startup adapter without blocking editing or implicitly submitting a task. */
  async initializeStartup(load: (signal: AbortSignal) => Promise<{ model: Model; activate?: () => void } | { error: string }>): Promise<void> {
    if (this.disposed || this.running || this.model) return;
    const abort = new AbortController();
    this.startupAbort = abort;
    const session = this.session;
    const branchId = session.activeBranchId;
    const provider = this.provider;
    const modelId = this.modelId;
    const current = () => !this.disposed && this.startupAbort === abort && !this.model &&
      this.session === session && this.session.activeBranchId === branchId && this.provider === provider && this.modelId === modelId;
    try {
      const result = await Promise.race([
        load(abort.signal),
        new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => reject(new Error("Startup connection check cancelled. Choose a model to retry.")), { once: true })),
      ]);
      if (!current()) return;
      abort.signal.throwIfAborted();
      if ("error" in result) throw new Error(result.error);
      result.activate?.();
      this.setModel(result.model, this.provider, this.modelId);
      this.status = "idle";
    } catch (error) {
      if (!current()) return;
      const message = error instanceof Error ? error.message : String(error);
      this.startupDiagnostic = message;
      this.startupRecoveryCategory = startupFailureCategory(message);
      this.offerRecovery(this.startupRecoveryCategory, false, startupRecoveryMessage(this.startupRecoveryCategory), message);
    } finally {
      if (this.startupAbort === abort) this.startupAbort = undefined;
    }
  }

  /** Abort a post-sign-in model listing. Esc uses this when no other panel owns the key. */
  cancelPendingSignInListing(): boolean {
    if (!this.signInListAbort || this.signInListAbort.signal.aborted) return false;
    this.signInListAbort.abort();
    return true;
  }

  /** Abort owned work and discard transient review evidence without waiting for terminal cleanup. */
  dispose(): void {
    this.closeSessionPicker();
    this.startupAbort?.abort();
    this.signInListAbort?.abort();
    this.disposed = true;
    this.noticeDetails = undefined;
    this.outcome = undefined;
    this.outcomeDiagnostics = undefined;
    this.gitBaseline = undefined;
    this.gitAfter = undefined;
    this.gitComparison = undefined;
    this.gitShellPaths = [];
    this.successfulToolPaths.clear();
    this.closeUndoPreview();
    this.closeChangeReview();
    this.closeHistory();
    this.closeModelPicker();
    if (!this.credentialMutation) { this.credentialEntry?.cancel(); this.credentialEntry = undefined; this.credentialTarget = undefined; this.endpointUrlEntry = undefined; this.endpointInputUrl = undefined; this.loginReturn = undefined; }
    this.abortActiveTurn();
    this.contextManager.clearActiveSkill();
    this.detachDiagnostics?.();
    this.extensions?.dispose();
  }
}
