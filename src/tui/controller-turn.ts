import { runAgentLoop } from "../agent/loop.ts";
import { relative } from "node:path";
import { toolTarget } from "./presentation.ts";
import type { RuntimeEvent } from "../agent/events.ts";
import { credentialStoreError } from "../auth/store.ts";
import { redactSecrets } from "../auth/secrets.ts";
import type { TuiRecovery, TuiTranscriptEntry, TuiControllerOptions } from "./controller-types.ts";
import { MAX_TOOL_DISPLAY_CHARS, asEditDetails, boundDisplay, formatToolFinishedText, formatNumberedEditDiff, summarizeToolResult } from "./transcript-format.ts";
import { buildEditDiff, countLines, type DiffRow } from "../text/diff.ts";
import { recoveryMessage, startupFailureCategory, startupRecoveryMessage, redactRecoveryDetails } from "./controller-support.ts";
import { CompactionLayer } from "./controller-compaction.ts";


/** Turn runner, runtime-event reducer, cancellation and recovery offers. */
export abstract class TurnLayer extends CompactionLayer {
  private readonly toolStartedAt = new Map<string, number>();
  /**
   * Signal cancellation of the active operation without waiting; idle calls do nothing.
   * Applies to both submitted turns and manual compaction.
   */
  cancel(): void {
    this.signInListAbort?.abort();
    if (this.startupAbort) { this.startupAbort.abort(); return; }
    if (this.loginSaving) { this.loginAbort?.abort(); this.notice("Waiting for the OS credential operation to finish; it cannot be cancelled after submission."); return; }
    if (this.loginCallbackValue !== undefined) {
      this.loginCallbackValue = undefined; this.recoveryRepair = false;
      this.restoreLoginOrigin();
      if (this.pickerReturn) this.restorePickerAfterConnection(false);
      this.notice("Callback entry cancelled; no credential was changed."); return;
    }
    if (this.loginAbort && !this.loginAbort.signal.aborted) {
      const abort = this.loginAbort;
      if (!this.pickerReturn) { this.recoveryRepair = false; this.restoreLoginOrigin(); abort.abort(); return; }
      this.abortPickerLogin();
      this.recoveryRepair = false;
      this.restoreLoginOrigin();
      if (this.pickerReturn) this.restorePickerAfterConnection(false);
      return;
    }
    if (this.loginChooserState) {
      if (this.pickerReturn) { this.loginChooserState = undefined; this.restorePickerAfterConnection(false); return; }
      this.loginChooserState = this.loginChooserState.level === "main" ? undefined : { level: "main", selectedId: this.loginChooserState.level };
      this.recoveryRepair = false; return;
    }
    if (this.credentialMutation) { this.notice("Waiting for the OS credential operation to finish; it cannot be cancelled after submission."); return; }
    if (this.endpointUrlEntry) {
      this.endpointUrlEntry = undefined; this.endpointInputUrl = undefined;
      this.restoreLoginOrigin(); this.recoveryRepair = false;
      if (this.pickerReturn) this.restorePickerAfterConnection(false);
      return;
    }
    if (this.credentialEntry) {
      this.credentialEntry.cancel();
      this.credentialEntry = undefined;
      this.credentialTarget = undefined;
      this.recoveryRepair = false;
      if (this.endpointInputUrl !== undefined) {
        this.endpointUrlEntry = { value: this.endpointInputUrl };
        this.endpointInputUrl = undefined;
      } else { this.restoreLoginOrigin(); if (this.pickerReturn) this.restorePickerAfterConnection(false); }
      this.notice("Credential entry cancelled; nothing saved.");
      return;
    }
    if (this.activeAbort && !this.activeAbort.signal.aborted) {
      if (this.activity) {
        this.activity.phase = "stopping";
        this.activity.cancellation = "requested";
        this.activity.retry = undefined;
      }
      this.activeAbort.abort();
    }
  }

  /** Mark a cancellation as settling only after its requested state was painted for this operation. */
  acknowledgeCancellationFrame(operationId: number): void {
    if (this.activity?.id === operationId && this.activity.cancellation === "requested") {
      this.activity.cancellation = "settling";
    }
  }

  /** Wait for the tracked submitted turn or manual compaction to settle during tests or terminal cleanup. */
  async waitForIdle(): Promise<void> {
    await this.activeTurn;
  }

  /** Accept a prompt only after durable append, then run its turn and report acceptance. */
  async submit(prompt: string, accepted: () => void = () => {}): Promise<boolean> {
    const text = prompt;
    if (text.trim().length === 0 || this.running || this.disposed) {
      return false;
    }
    if (this.sessionWriteBlocked) {
      this.notice("This session cannot safely save another turn. Open a new or repaired session before sending this draft.");
      return false;
    }
    if (!this.model) {
      if (this.isNotConnected()) return false;
      const category = (this.subscriptionReactivationRequired || this.grokReactivationRequired) ? "model" : this.startupRecoveryCategory;
      this.offerRecovery(category, false,
        startupRecoveryMessage(category), this.startupDiagnostic);
      return false;
    }
    const userEntry: TuiTranscriptEntry = {
      sessionRecordId: crypto.randomUUID(),
      id: this.nextId("user"),
      kind: "user",
      text,
    };
    try {
      this.session.append({
        type: "user",
        id: userEntry.sessionRecordId!,
        content: [{ type: "text", text }],
      });
    } catch {
      this.offerRecovery("session-write", false, "Could not save your prompt. Your draft is still in the editor and nothing was sent. Open a new or repaired session before sending it.");
      return false;
    }
    this.recovery = undefined;
    this.transcript.push(userEntry);
    this.status = "running";
    return this.startAcceptedTurn(accepted);
  }

  /** Continue an accepted failed turn from its durable session head without appending the user's task again. */
  async continueRecovery(): Promise<boolean> {
    const recovery = this.currentRecovery();
    if (!recovery || !recovery.accepted || !recovery.actions.includes("continue") || this.running || this.disposed || !this.model) return false;
    this.recovery = undefined;
    this.status = "running";
    return this.startAcceptedTurn();
  }

  /** Open the valid repair surface for the current failure without accepting a draft. */
  openRecoveryRepair(action: "connect" | "choose-model"): boolean {
    const recovery = this.currentRecovery();
    if (!recovery || !recovery.actions.includes(action) || this.running) return false;
    if (action === "choose-model") {
      const opened = this.openModelPicker();
      this.recoveryRepair = opened;
      return opened;
    }
    this.recoveryRepair = true;
    void this.login("");
    return true;
  }

  /** Retry a failed secure-store read without accepting or replaying the editor draft. */
  async retryCredentialRecovery(): Promise<boolean> {
    const recovery = this.currentRecovery();
    if (!recovery || recovery.category !== "credential-store" || !recovery.actions.includes("retry-credentials") ||
      !this.credentials || this.running || this.disposed) return false;
    const session = this.session;
    const sessionId = this.sessionId;
    const abort = new AbortController();
    this.activeAbort = abort;
    this.status = "running";
    const task = (async () => {
      let loaded: Awaited<ReturnType<NonNullable<TuiControllerOptions["credentials"]>["reload"]>>;
      try { loaded = await this.credentials!.reload(this.configEditor?.settings); }
      catch { loaded = { error: credentialStoreError("read") }; }
      if (abort.signal.aborted || this.disposed || this.activeAbort !== abort || this.session !== session ||
        this.sessionId !== sessionId || this.recovery?.entryId !== recovery.entryId) return false;
      if ("error" in loaded) {
        const failure = startupFailureCategory(loaded.error);
        const category = failure === "provider" ? "credential-store" : failure;
        this.startupRecoveryCategory = category;
        this.startupDiagnostic = loaded.error;
        this.offerRecovery(category, recovery.accepted,
          recovery.accepted ? recoveryMessage(category) : startupRecoveryMessage(category), loaded.error);
        return false;
      }
      this.model = loaded.model;
      this.status = "idle";
      if (recovery.accepted && this.recovery) {
        this.recovery.model = loaded.model;
        this.recovery.actions = ["continue", ...(this.recovery.details ? ["details" as const] : []), "keep-editing"];
        const entry = this.transcript.find(item => item.id === this.recovery?.entryId);
        if (entry) entry.text = `Credential access restored. Continue the saved turn when ready.\nCtrl+R continue · ${this.recovery.details ? "Ctrl+I details · " : ""}Esc keep editing`;
      } else {
        this.recovery = undefined;
        this.notice("Credential access restored. Your draft is ready to send when you press Enter.");
      }
      return true;
    })();
    const tracked = task.then(() => {});
    this.activeTurn = tracked;
    try { return await task; } finally {
      if (this.activeAbort === abort && abort.signal.aborted) {
        this.status = "idle";
        this.notice("Credential retry cancelled. The draft and earlier recovery remain available.");
      }
      if (this.activeAbort === abort) this.activeAbort = undefined;
      if (this.activeTurn === tracked) this.activeTurn = undefined;
    }
  }

  /** Dismiss controls while retaining the editor and durable accepted records. */
  keepEditingRecovery(): boolean {
    if (!this.currentRecovery()) return false;
    this.recovery = undefined;
    return true;
  }

  /** Inspect current unaccepted recovery first, otherwise the retained failed turn or accepted recovery. */
  inspectRecovery(): boolean {
    const recovery = this.currentRecovery();
    const unacceptedDetails = recovery?.accepted === false && recovery.actions.includes("details");
    if (!unacceptedDetails && this.snapshot().outcome?.reason === "failed") {
      this.notice(this.turnDetails());
      return true;
    }
    if (!recovery || !recovery.actions.includes("details")) return false;
    this.notice(`Failure details: ${this.recovery?.details ?? "No additional diagnostics are available."}`);
    return true;
  }

  /** Replace retained outcome evidence and start one accepted turn with its own cancellation signal. */
  protected async startAcceptedTurn(accepted: () => void = () => {}): Promise<boolean> {
    this.toolStartedAt.clear();
    this.closeChangeReview();
    this.outcomeIdentity = `${this.sessionId}/${this.session.activeBranchId}`;
    this.outcomeUserId = this.session.items.findLast(item => item.type === "user")?.id;
    this.outcomeDiagnostics = undefined;
    this.successfulToolPaths.clear();
    this.outcome = { reason: "completed", commands: [], commandCounts: { exitZero: 0, nonzero: 0, unknown: 0 }, toolResults: 0, failedTools: 0, files: [], elapsedMs: 0 };
    const operationId = this.beginActivity("preparing");
    const abort = new AbortController();
    this.activeAbort = abort;
    this.currentAssistantId = undefined;
    this.modelAttemptStarted = false;
    this.retryNoticeId = undefined;
    try { accepted(); } catch { /* A presentation callback cannot undo an accepted record. */ }
    // The baseline capture runs inside the tracked turn so a spawn failure still clears ownership below.
    const turn = (async () => {
      try {
        await this.captureTurnBaseline(abort.signal);
      } catch (error) {
        if (this.activeAbort?.signal === abort.signal) {
          this.gitSnapshotError = error instanceof Error ? error.message : String(error);
        }
      }
      await this.runTurn(abort.signal, operationId);
    })();
    this.activeTurn = turn;
    try {
      await turn;
    } finally {
      if (this.activeAbort === abort) {
        this.activeAbort = undefined;
      }
      if (this.activeTurn === turn) {
        this.activeTurn = undefined;
      }
      this.settleActivity(operationId);
      this.invalidateBranchTreeCache();
      this.toolStartedAt.clear();
    }
    return true;
  }

  /** Run the owned accepted turn and settle its outcome without publishing stale operation results. */
  protected async runTurn(signal: AbortSignal, operationId: number): Promise<void> {
    if (this.disposed || this.activeAbort?.signal !== signal) return;
    try {
      for await (const event of runAgentLoop({
        session: this.session,
        // Checked in submit(); kept non-null here for the loop call.
        model: this.model!,
        contextManager: this.contextManager,
        tools: this.tools,
        workspace: this.workspace,
        signal,
        maxTurns: this.maxTurns,
        maxConcurrentTools: this.maxConcurrentTools,
        extensions: this.extensions,
        clock: this.agentClock,
      })) {
        // Drain accepted calls on cancellation; replaced sessions ignore stale display events.
        if (this.activeAbort?.signal === signal) {
          this.observeRuntimeEvent(event);
          this.applyEvent(event, operationId);
        }
      }
      if (this.activeAbort?.signal !== signal) {
        return;
      }
      if (signal.aborted) {
        this.markProvisionalIncomplete();
        this.clearRetryNotice();
        this.transcript.push(this.systemEntry("Cancelled."));
        await this.captureTurnResult(signal);
        if (this.disposed || this.activeAbort?.signal !== signal) return;
        this.finishOutcome("cancelled");
        this.status = "idle";
        this.offerRecovery("provider", true, "The saved turn was stopped. Completed results remain available; continue when ready.", undefined, operationId, false);
        return;
      }
      await this.captureTurnResult(signal);
      if (this.disposed || this.activeAbort?.signal !== signal) return;
      this.finishOutcome();
      if (this.status === "running") {
        this.status = "idle";
      }
    } catch (error) {
      if (this.activeAbort?.signal !== signal) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.markProvisionalIncomplete();
      this.clearRetryNotice();
      this.fail(redactSecrets(message, this.secrets));
      await this.captureTurnResult(signal);
      if (this.disposed || this.activeAbort?.signal !== signal) return;
      this.finishOutcome(signal.aborted ? "cancelled" : "failed");
    }
  }

  /** Deliver native or manual-compaction events without letting observers affect the conversation. */
  protected observeRuntimeEvent(event: RuntimeEvent): void {
    if (!this.onRuntimeEvent) return;
    try {
      const pending = this.onRuntimeEvent(event, this.sessionId);
      if (pending) void Promise.resolve(pending).catch(() => {});
    } catch { /* Diagnostic failures never change the conversation. */ }
  }

  /** Fold one runtime event into transcript rows and status. */
  applyEvent(event: RuntimeEvent, operationId?: number): void {
    if (operationId !== undefined && this.activity?.id !== operationId) return;
    const activity = this.activity;
    if (activity && activity.cancellation === "none") {
      switch (event.type) {
        case "agent.started": activity.phase = "preparing"; break;
        case "model.started": activity.phase = "waiting"; activity.retry = undefined; break;
        case "model.delta": activity.phase = "streaming"; break;
        case "model.finished": activity.phase = "preparing"; break;
        case "model.retry": activity.phase = "retry"; activity.retry = { failedAttempt: event.attempt, maxAttempts: event.maxAttempts, until: this.activityClock() + event.delayMs }; break;
        case "tool.started": activity.activeTools.set(event.toolCallId, event.name); activity.phase = "tools"; break;
        case "tool.finished": activity.activeTools.delete(event.toolCallId); activity.phase = activity.activeTools.size ? "tools" : "preparing"; break;
        case "compaction.started": activity.phase = "compacting"; activity.compactionReason = event.reason; activity.compactionOutcome = undefined; break;
        case "compaction.finished": activity.phase = "preparing"; activity.compactionOutcome = event.status; break;
      }
    } else if (activity && event.type === "tool.finished") {
      activity.activeTools.delete(event.toolCallId);
    }
    switch (event.type) {
      case "model.usage":
        if (event.phase === "turn") this.reportedUsage = { identity: this.contextIdentity(), usage: { ...event.usage } };
        return;
      case "agent.started":
        return;
      case "model.started": {
        this.reportedUsage = undefined;
        this.discardProvisionalAssistant();
        this.modelAttemptBaseAssistantId = this.session.items.findLast(item => item.type === "assistant")?.id;
        this.modelAttemptStarted = true;
        return;
      }
      case "model.delta": {
        if (event.content.type !== "text") {
          return;
        }
        const current = this.currentAssistant();
        current.text += event.content.text;
        return;
      }
      case "model.finished": {
        const accepted = this.session.items.findLast(item => item.type === "assistant");
        if (this.modelAttemptStarted && accepted?.type === "assistant" && accepted.id !== this.modelAttemptBaseAssistantId) {
          const text = accepted.content.filter(block => block.type === "text").map(block => block.text).join("");
          if (text) {
            const current = this.currentAssistant();
            current.text = text;
            current.incomplete = false;
          } else {
            this.discardProvisionalAssistant();
          }
        }
        this.currentAssistantId = undefined;
        this.modelAttemptStarted = false;
        this.clearRetryNotice();
        return;
      }
      case "model.retry": {
        this.markProvisionalIncomplete();
        this.showRetryNotice(`Retrying provider connection (attempt ${event.attempt + 1}/${event.maxAttempts}).`);
        return;
      }
      case "tool.started": {
        this.toolStartedAt.set(event.toolCallId, this.activityClock());
        const assistant = this.session.items.findLast(item => item.type === "assistant");
        const call = assistant?.type === "assistant" ? assistant.content.find(block => block.type === "tool_call" && block.id === event.toolCallId) : undefined;
        const entry: TuiTranscriptEntry = {
          id: this.nextId("tool"),
          kind: "tool",
          text: "",
          toolName: event.name,
          toolCallId: event.toolCallId,
          toolStatus: "running",
          toolSummary: call?.type === "tool_call" ? toolTarget(event.name, call.arguments) : undefined,
        };
        this.toolEntryByCallId.set(event.toolCallId, entry);
        this.transcript.push(entry);
        return;
      }
      case "tool.delta": {
        const entry = this.toolEntryByCallId.get(event.toolCallId);
        if (entry) {
          entry.text += event.text;
        }
        return;
      }
      case "tool.finished": {
        if (this.outcome) {
          this.outcome.toolResults++;
          if (event.status === "error") this.outcome.failedTools++;
          if (event.status === "success" && (event.name === "edit" || event.name === "write") && event.details && typeof event.details === "object") {
            const details = event.details as { resolvedPath?: unknown; created?: unknown; lineCount?: unknown };
            if (typeof details.resolvedPath === "string") {
              const path = relative(this.gitBaseline?.root ?? this.workspace?.root ?? "", details.resolvedPath);
              this.successfulToolPaths.set(path, details.resolvedPath);
              let file = this.outcome.files.find(file => file.path === path);
              if (!file) { file = { path, source: "tool" }; this.outcome.files.push(file); }
              const edit = event.name === "edit" ? asEditDetails(event.details) : undefined;
              const counts = edit?.hunks ? buildEditDiff(edit.hunks)
                : event.name === "write" && details.created === true && typeof details.lineCount === "number" && Number.isInteger(details.lineCount) && details.lineCount >= 0
                  ? { added: details.lineCount, removed: 0 } : undefined;
              if (counts) { file.added = (file.added ?? 0) + counts.added; file.removed = (file.removed ?? 0) + counts.removed; }
            }
          }
          if (event.name === "bash") {
            const details = event.details as { command?: unknown; exitCode?: unknown } | undefined;
            const exitCode = typeof details?.exitCode === "number" && Number.isInteger(details.exitCode) ? details.exitCode : null;
            this.outcome.commandCounts[exitCode === null ? "unknown" : exitCode === 0 ? "exitZero" : "nonzero"]++;
            this.outcome.commands.push({ callId: redactSecrets(event.toolCallId, this.secrets).slice(0, 80), command: redactSecrets(typeof details?.command === "string" ? details.command : "bash", this.secrets).slice(0, 200), exitCode, status: event.status === "success" ? "success" : event.status === "cancelled" ? "cancelled" : "error" });
            if (this.outcome.commands.length > 50) this.outcome.commands.shift();
          }
        }
        const entry = this.toolEntryByCallId.get(event.toolCallId);
        const startedAt = this.toolStartedAt.get(event.toolCallId);
        const durationMs = startedAt === undefined ? undefined : Math.max(0, this.activityClock() - startedAt);
        this.toolStartedAt.delete(event.toolCallId);
        const resultSummary = summarizeToolResult(event.name, event.status, event.details, durationMs);
        const edit = event.name === "edit" && event.status === "success" ? asEditDetails(event.details) : undefined;
        let diffRows: DiffRow[] | undefined;
        if (resultSummary && edit?.hunks) diffRows = buildEditDiff(edit.hunks).rows;
        let display = formatToolFinishedText(
          event.name,
          redactSecrets(event.content, this.secrets),
          event.details,
          event.status,
          text => redactSecrets(text, this.secrets),
        );
        if (event.name === "write" && resultSummary && typeof event.details === "object" && event.details !== null) {
          const details = event.details as { created: boolean; lineCount: number };
          const assistant = this.session.items.findLast(item => item.type === "assistant" && item.content.some(block => block.type === "tool_call" && block.id === event.toolCallId));
          const call = assistant?.type === "assistant" ? assistant.content.find(block => block.type === "tool_call" && block.id === event.toolCallId) : undefined;
          const args = call?.type === "tool_call" && typeof call.arguments === "object" && call.arguments !== null && !Array.isArray(call.arguments) ? call.arguments as Record<string, unknown> : undefined;
          if (details.created && typeof args?.content === "string" && countLines(args.content) === details.lineCount) {
            const hunk = { startLine: 1, oldText: "", newText: args.content };
            diffRows = buildEditDiff([hunk]).rows;
            display = boundDisplay(formatNumberedEditDiff([hunk], redactSecrets(event.content, this.secrets), text => redactSecrets(text, this.secrets)));
          }
        }
        const text = event.status === "error" ? `${display}\nTool failed. Inspect this result before continuing.` : display;
        if (entry) {
          entry.text = text;
          entry.toolStatus =
            event.status === "success" ? "success" : event.status === "cancelled" ? "cancelled" : "error";
          entry.resultSummary = resultSummary;
          entry.diffRows = diffRows;
        } else {
          this.transcript.push({
            id: this.nextId("tool"),
            kind: "tool",
            text,
            toolName: event.name,
            toolCallId: event.toolCallId,
            toolStatus: event.status === "success" ? "success" : event.status === "cancelled" ? "cancelled" : "error",
            resultSummary,
            diffRows,
          });
        }
        return;
      }
      case "compaction.started": {
        if (event.reason === "overflow") {
          this.markProvisionalIncomplete();
          this.clearRetryNotice();
        }
        this.transcript.push(
          this.systemEntry(
            event.reason === "overflow"
              ? "Context overflow. Compacting…"
              : event.reason === "manual" ? "Manual compaction. Compacting older turns…" : "Context pressure. Compacting…",
          ),
        );
        return;
      }
      case "compaction.finished": {
        const text = event.status === "completed"
          ? "Context compacted. Original history remains inspectable; /context shows the active summary boundary."
          : event.status === "cancelled"
            ? "Compaction cancelled. History unchanged; /compact retries when ready."
            : event.status === "failed"
              ? `Compaction failed. History unchanged. For a model failure, check connection then /compact or /model. After a storage failure, repair storage and /resume ${this.sessionId} to reload before retrying /compact.`
              : "Compaction no-op: no older turns or usable summary. History unchanged; try /compact after more turns.";
        this.compactionNotice = { identity: this.contextIdentity(), text: redactSecrets(text, this.secrets) };
        this.transcript.push(this.systemEntry(text));
        return;
      }
      case "error": {
        this.markProvisionalIncomplete();
        this.clearRetryNotice();
        if (event.message === "Your Grok plan doesn't include API access. Use an xAI API key instead.") { this.fail(event.message); return; }
        if (event.origin === "harness" && event.category !== "session-write") {
          this.fail(redactSecrets(event.message, this.secrets));
        } else {
          this.offerRecovery(event.category ?? "provider", true,
            recoveryMessage(event.category ?? "provider"), event.message, operationId);
        }
        return;
      }
      case "agent.finished": {
        if (this.outcome) this.outcome.reason = event.reason === "error" ? "failed" : event.reason === "max_turns" ? "limit" : event.reason;
        if (event.reason === "cancelled" || event.reason === "error") {
          this.markProvisionalIncomplete();
          this.clearRetryNotice();
        }
        if (event.reason === "error") {
          if (this.status === "running") {
            this.status = "error";
          }
        } else if (event.reason === "cancelled") {
          // runTurn adds the Cancelled notice once the loop settles.
        } else if (event.reason === "max_turns") {
          this.transcript.push(
            this.systemEntry("Stopped at the turn limit. Refine the prompt and continue."),
          );
          if (this.status === "running") {
            this.status = "idle";
          }
        }
        return;
      }
      default:
        return;
    }
  }

  protected currentAssistant(): TuiTranscriptEntry {
    if (this.currentAssistantId) {
      const found = this.transcript.find((entry) => entry.id === this.currentAssistantId);
      if (found) {
        return found;
      }
    }
    const entry: TuiTranscriptEntry = {
      id: this.nextId("asst"),
      kind: "assistant",
      text: "",
    };
    this.currentAssistantId = entry.id;
    this.transcript.push(entry);
    return entry;
  }

  /** Mark the current stream preview as abandoned without changing session history. */
  protected markProvisionalIncomplete(): void {
    const entry = this.transcript.find(item => item.id === this.currentAssistantId);
    if (entry?.text) entry.incomplete = true;
  }

  /** Remove an abandoned stream preview before the next model attempt begins. */
  protected discardProvisionalAssistant(): void {
    if (!this.currentAssistantId) return;
    const index = this.transcript.findIndex(item => item.id === this.currentAssistantId);
    if (index >= 0) this.transcript.splice(index, 1);
    this.currentAssistantId = undefined;
  }

  /** Reuse one transient retry row for all attempts in a model turn. */
  protected showRetryNotice(text: string): void {
    const entry = this.transcript.find(item => item.id === this.retryNoticeId);
    if (entry) { entry.text = text; return; }
    const next = this.systemEntry(text);
    this.retryNoticeId = next.id;
    this.transcript.push(next);
  }

  /** Clear transient retry status once the turn settles. */
  protected clearRetryNotice(): void {
    if (!this.retryNoticeId) return;
    const index = this.transcript.findIndex(item => item.id === this.retryNoticeId);
    if (index >= 0) this.transcript.splice(index, 1);
    this.retryNoticeId = undefined;
  }

  protected currentRecovery(): TuiRecovery | undefined {
    const recovery = this.recovery;
    if (recovery && this.recoveryRepair && this.recoveryIdentityChanged(recovery) && this.model &&
      !this.modelPicker && this.loginChooserState === undefined && !this.credentialMutation) {
      recovery.model = this.model;
      recovery.provider = this.provider;
      recovery.modelId = this.modelId;
      recovery.profile = this.profile;
      recovery.openaiAuth = this.openaiAuth; recovery.xaiAuth = this.xaiAuth;
      if (recovery.accepted && (recovery.category === "auth" || recovery.category === "model")) {
        recovery.actions = ["continue", ...(recovery.details ? ["details" as const] : []), "keep-editing"];
        const entry = this.transcript.find(item => item.id === recovery.entryId);
        if (entry) entry.text = `${recoveryMessage(recovery.category)}\nCtrl+R continue · ${recovery.details ? "Ctrl+I details · " : ""}Esc keep editing`;
      }
      this.recoveryRepair = false;
    }
    if (!recovery || recovery.sessionId !== this.sessionId || recovery.branchId !== this.session.activeBranchId ||
      recovery.userId !== this.session.items.findLast(item => item.type === "user")?.id ||
      (!this.recoveryRepair && this.recoveryIdentityChanged(recovery))) return undefined;
    const { sessionId: _sessionId, branchId: _branchId, userId: _userId, details: _details, model: _model,
      provider: _provider, modelId: _modelId, profile: _profile, openaiAuth: _openaiAuth, xaiAuth: _xaiAuth, ...publicRecovery } = recovery;
    return publicRecovery;
  }

  protected recoveryIdentityChanged(recovery: NonNullable<typeof this.recovery>): boolean {
    return recovery.model !== this.model || recovery.provider !== this.provider || recovery.modelId !== this.modelId ||
      recovery.profile !== this.profile || recovery.openaiAuth !== this.openaiAuth || recovery.xaiAuth !== this.xaiAuth;
  }

  protected offerRecovery(category: TuiRecovery["category"], accepted: boolean, message: string, details?: string, operationId = this.operationSequence, markError = true): void {
    if (category === "session-write") {
      this.sessionWriteBlocked = true;
      if (accepted) this.markUnsavedToolResults();
    }
    const canContinue = accepted && category !== "session-write" && category !== "credential-store" && category !== "auth" && category !== "model" && this.model !== undefined;
    const actions: TuiRecovery["actions"] = [
      ...(category === "auth" ? ["connect" as const] : []),
      ...(category === "credential-store" && this.credentials ? ["retry-credentials" as const] : []),
      ...(category === "model" ? ["choose-model" as const] : []),
      ...(canContinue ? ["continue" as const] : []),
      ...(details ? ["details" as const] : []),
      "keep-editing",
    ];
    const controls = actions.map(action => ({ connect: "Alt+L connect", "retry-credentials": "Ctrl+R retry credential access", "choose-model": "Alt+M choose model", continue: "Ctrl+R continue", details: "Ctrl+I details", "keep-editing": "Esc keep editing" })[action]);
    const entry: TuiTranscriptEntry = { id: this.nextId("err"), kind: "error", text: `${message}\n${controls.join(" · ")}` };
    if (!accepted && this.recovery && !this.recovery.accepted) {
      this.transcript = this.transcript.filter(item => item.id !== this.recovery!.entryId);
    }
    this.transcript.push(entry);
    if (markError) this.status = "error";
    this.recovery = { operationId, entryId: entry.id, category, accepted, actions,
      sessionId: this.sessionId, branchId: this.session.activeBranchId,
      userId: this.session.items.findLast(item => item.type === "user")?.id,
      details: details ? redactRecoveryDetails(details, this.secrets) : undefined, model: this.model,
      provider: this.provider, modelId: this.modelId, profile: this.profile, openaiAuth: this.openaiAuth, xaiAuth: this.xaiAuth };
  }

  /** Label completed effects whose result could not be found after their latest durable call. */
  protected markUnsavedToolResults(): void {
    const items = this.session.items;
    for (const [callId, entry] of this.toolEntryByCallId) {
      const callIndex = items.findLastIndex(item => item.type === "assistant" &&
        item.content.some(block => block.type === "tool_call" && block.id === callId));
      if (callIndex < 0 || items.slice(callIndex + 1).some(item => item.type === "tool_result" && item.toolCallId === callId)) continue;
      entry.text = `${boundDisplay(entry.text, MAX_TOOL_DISPLAY_CHARS - 90)}\nThis tool may have completed, but its result was not saved to the session.`;
    }
  }

  protected abortActiveTurn(): void {
    const abort = this.activeAbort;
    this.activeAbort = undefined;
    if (abort) {
      abort.abort();
    }
  }
}
