import { getEffectiveConversation, getEffectiveSummary, getLatestCompaction } from "../context/compaction.ts";
import { estimateSessionTokens, estimateTextTokens } from "../context/tokens.ts";
import type { RuntimeEvent } from "../agent/events.ts";
import { redactSecrets } from "../auth/secrets.ts";
import type { CompactionOutcome, ContextManager } from "../context/manager.ts";
import { listCatalog, lookupModel } from "../model/catalog.ts";
import type { Session } from "../session/session.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { Workspace } from "../workspace/workspace.ts";
import type { ExtensionRuntime } from "../extensions/host.ts";
import type { TuiSnapshot } from "./controller-types.ts";
import { buildTranscriptFromSession, boundDisplay } from "./transcript-format.ts";
import { SettingsLayer } from "./controller-settings.ts";


/** Context accounting, compaction and staged session switching. */
export abstract class CompactionLayer extends SettingsLayer {
  /** Return the active context manager for explicit skill invocations after runtime changes. */
  activeContextManager(): ContextManager { return this.contextManager; }

  protected contextSnapshot(): TuiSnapshot["context"] {
    const items = this.session.items;
    const last = items.at(-1);
    if (!this.contextEstimate || this.contextEstimate.session !== this.session || this.contextEstimate.branch !== this.session.activeBranchId || this.contextEstimate.last !== last) {
      const boundary = getLatestCompaction(items);
      this.contextEstimate = {
        session: this.session, branch: this.session.activeBranchId, last,
        tokens: estimateSessionTokens(getEffectiveConversation(items)) + estimateTextTokens(getEffectiveSummary(items) ?? ""),
        ...(boundary ? { summaryId: boundary.id, firstKeptId: boundary.firstKeptId } : {}),
      };
    }
    const settings = this.configEditor?.settings;
    const capability = this.configEditor?.modelCapability(this.modelId);
    const known = this.explicitContextWindow !== undefined || listCatalog().some(model => model.provider === this.provider && model.id === this.modelId)
      || (settings?.provider === this.provider && settings.model === this.modelId && settings.openaiAuth === "codex" && capability?.contextWindow !== undefined);
    return {
      estimatedTokens: this.contextEstimate.tokens,
      capacity: known ? this.effectiveBudgets().contextWindow : null,
      providerUsage: this.reportedUsage?.identity === this.contextIdentity() ? { ...this.reportedUsage.usage } : null,
      ...(this.contextEstimate.summaryId ? { summaryId: this.contextEstimate.summaryId, firstKeptId: this.contextEstimate.firstKeptId } : {}),
    };
  }

  /** Inspect selected-branch context and its active summary without preparing or changing conversation state. */
  describeContext(): string {
    const context = this.contextSnapshot();
    const usage = context.providerUsage;
    return [
      `Selected model context: ${this.provider}/${this.modelId}`,
      `Estimated conversation + summary: ~${context.estimatedTokens} tokens (excludes system prompt, instructions, tools and provider overhead).`,
      `Context capacity: ${context.capacity ?? "unknown (runtime fallback is not verified capacity)"}.`,
      `Last reported provider usage (turn request): input ${usage?.inputTokens ?? "unknown"}, output ${usage?.outputTokens ?? "unknown"}. Not a billing total or task progress.`,
      context.summaryId ? `Active summary ${context.summaryId}; recent conversation starts at ${context.firstKeptId}. Original history remains available above and in /branch tree.` : "No active summary on this branch. Original history is retained.",
      ...(context.summaryId ? [`Summary: ${boundDisplay(getEffectiveSummary(this.session.items) ?? "", 4000)}`] : []),
    ].join("\n");
  }

  /** Effective context and output budgets for the current model with overrides. */
  effectiveBudgets(): { contextWindow: number; maxOutput: number } {
    const resolved = this.configEditor?.settings;
    if (resolved?.provider === this.provider && resolved.model === this.modelId && resolved.supportedThinking !== undefined) {
      return { contextWindow: resolved.contextWindow, maxOutput: resolved.maxOutput };
    }
    const info = lookupModel(this.provider, this.modelId, {
      ...(this.explicitContextWindow !== undefined
        ? { contextWindow: this.explicitContextWindow }
        : {}),
      ...(this.explicitMaxOutput !== undefined
        ? { maxOutput: this.explicitMaxOutput }
        : {}),
    });
    return { contextWindow: info.contextWindow, maxOutput: info.maxOutput };
  }

  /** Start manual compaction after model checks and notify acceptance before it settles. */
  async compact(accepted: () => void = () => {}): Promise<boolean> {
    if (this.running) {
      this.notice("Wait for this turn · Esc stop");
      return false;
    }
    if (!this.model) {
      this.fail(
        "Sign in to compact · Alt+L sign in",
      );
      return false;
    }
    this.status = "running";
    const operationId = this.beginActivity("compacting");
    const abort = new AbortController();
    this.activeAbort = abort;
    try { accepted(); } catch { /* Presentation cannot cancel an accepted compaction. */ }
    const publish = (event: RuntimeEvent) => { this.applyEvent(event, operationId); this.observeRuntimeEvent(event); };
    publish({ type: "compaction.started", reason: "manual" });
    const result: { outcome: CompactionOutcome } = { outcome: "noop" };
    const task = Promise.resolve().then(() => this.contextManager.compact(this.session, this.model!, {
      reason: "manual", signal: abort.signal, onOutcome: value => { result.outcome = value; },
    }));
    const tracked = task.then(() => undefined, () => undefined);
    this.activeTurn = tracked;
    try {
      const record = await task;
      if (this.activeAbort !== abort) return false;
      publish(record
        ? { type: "compaction.finished", reason: "manual", status: "completed", recordId: record.id, firstKeptId: record.firstKeptId }
        : { type: "compaction.finished", reason: "manual", status: abort.signal.aborted ? "cancelled" : result.outcome === "failed" ? "failed" : "noop" });
      this.invalidateBranchTreeCache();
      return !!record;
    } catch {
      if (this.activeAbort === abort) publish({ type: "compaction.finished", reason: "manual", status: abort.signal.aborted ? "cancelled" : "failed" });
      return false;
    } finally {
      for (const entry of this.contextManager.takeUsage()) this.observeRuntimeEvent({ type: "model.usage", phase: "compaction", ...entry });
      if (this.activeAbort === abort) { this.activeAbort = undefined; this.status = "idle"; }
      if (this.activeTurn === tracked) this.activeTurn = undefined;
      this.settleActivity(operationId);
    }
  }

  /** Stage workspace capabilities and atomically switch sessions, preserving the current runtime on failure or cancellation. */
  async switchSession(session: Session, sessionId: string, options: { workspace: Workspace; contextManager: ContextManager }): Promise<boolean> {
    if (this.disposed) return false;
    if (this.running) {
      this.notice("Wait for this turn · Esc stop");
      return false;
    }
    const abort = new AbortController();
    this.activeAbort = abort;
    this.status = "running";
    const task = this.stageSession(session, sessionId, options, abort);
    const tracked = task.then(() => {});
    this.activeTurn = tracked;
    try { return await task; } finally {
      if (this.activeAbort === abort) this.activeAbort = undefined;
      if (this.activeTurn === tracked) this.activeTurn = undefined;
    }
  }

  /** Publish staged workspace capabilities only while this switch still owns the controller. */
  protected async stageSession(session: Session, sessionId: string, options: { workspace: Workspace; contextManager: ContextManager }, abort: AbortController): Promise<boolean> {
    let staged: { tools: ToolRegistry; runtime: ExtensionRuntime } | undefined;
    try {
      const editor = await this.configEditor?.forWorkspace(options.workspace.root);
      if (editor?.memoryActivationError) throw new Error(editor.memoryActivationError);
      let nextSettings = editor?.settings;
      const nextRuntime = nextSettings && this.stageSettings ? await this.stageSettings(nextSettings, abort.signal, options.workspace, this.model) : undefined;
      abort.signal.throwIfAborted();
      if (editor && nextRuntime?.modelCapability) {
        editor.setModelCapability(nextRuntime.modelCapability);
        nextSettings = editor.settings;
      }
      staged = await this.loadWorkspaceExtensions?.(options.workspace, abort.signal);
      abort.signal.throwIfAborted();
      if (this.disposed || this.activeAbort !== abort) return false;
      const previous = this.extensions;
      if (staged) {
        this.detachDiagnostics?.();
        this.extensions = staged.runtime;
        this.tools = staged.tools;
        this.detachDiagnostics = staged.runtime.attachDiagnostics(message => this.notice(message));
      }
      this.replaceSession(session, sessionId, { ...options, contextManager: nextRuntime?.contextManager ?? options.contextManager });
      if (editor && nextSettings && nextRuntime) {
        this.configEditor = editor;
        this.publishSettings(nextSettings, nextRuntime);
        if (editor.memoryNotice) this.notice(editor.memoryNotice);
      }
      if (staged) {
        staged = undefined;
        previous?.dispose();
      }
      return true;
    } catch (error) {
      if (!this.disposed && this.activeAbort === abort) {
        if (abort.signal.aborted) {
          this.notice("Session unchanged · /sessions choose another");
          this.status = "idle";
        } else this.fail(redactSecrets(error instanceof Error ? error.message : String(error), this.secrets));
      }
      return false;
    } finally {
      staged?.runtime.dispose();
    }
  }

  /**
   * Point the controller at a new or resumed session without replaying tools.
   * Pass the session's workspace and a matching context manager so later turns
   * execute tools and assemble context against the active session's workspace.
   */
  replaceSession(
    session: Session,
    sessionId: string,
    options: { workspace?: Workspace; contextManager?: ContextManager } = {},
  ): void {
    this.recentSession = undefined;
    this.restored = false;
    this.recentDiscoveryGeneration++;
    this.commandHelpOpen = false;
    this.discoveredCommands = undefined;
    this.commandDiscoveryGeneration++;
    if (session !== this.session) this.sessionWriteBlocked = false;
    this.closeModelPicker();
    this.abortActiveTurn();
    this.extensions?.replaceSession();
    this.contextManager.clearActiveSkill();
    this.session = session;
    this.sessionId = sessionId;
    if (options.workspace !== undefined) {
      this.workspace = options.workspace;
    }
    if (options.contextManager !== undefined) {
      this.contextManager = options.contextManager;
      this.contextManager.clearActiveSkill();
    }
    this.transcript = buildTranscriptFromSession(session.items);
    this.status = "idle";
    this.recovery = undefined;
    this.recoveryRepair = false;
    this.currentAssistantId = undefined;
    this.modelAttemptBaseAssistantId = undefined;
    this.modelAttemptStarted = false;
    this.retryNoticeId = undefined;
    this.toolEntryByCallId.clear();
    this.toolDenialByCallId.clear();
    this.invalidateBranchTreeCache();
    if (this.branchTreeOpen) {
      const head = this.activeHeadId() ?? this.session.rootId;
      if (this.branchTreeSelectedId === undefined) this.branchTreeSelectedId = head;
    }
    this.gitBaseline = undefined;
    this.gitAfter = undefined;
    this.gitComparison = undefined;
    this.gitSnapshotError = undefined;
    this.gitShellPaths = [];
    this.successfulToolPaths.clear();
    this.outcomeUserId = undefined;
    this.outcomeDiagnostics = undefined;
    this.outcome = undefined;
    this.closeUndoPreview();
    this.closeChangeReview();
  }
}
