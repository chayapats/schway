import { APPROVAL_MODES, DEFAULT_APPROVAL_MODE, type ApprovalMode, type ApprovalRequest, type ApprovalDecision } from "../agent/approval.ts";
import { approvalPreview, type ToolApproval } from "./tool-approval.ts";
import { ignoredProjectApprovalNotice, projectConfigPath } from "../config/config.ts";
import type { resolveThinkingSelection } from "../model/thinking.ts";
import { isGrokModel } from "../model/loader.ts";
import type { SessionDiscovery } from "../session/jsonl.ts";
import type { PreferencesSnapshot } from "./preferences.ts";
import type { AgentClock } from "../agent/retry.ts";
import type { ModelRetryCause, RuntimeEvent } from "../agent/events.ts";
import { MaskedCredentialEntry } from "../auth/management.ts";
import type { CredentialTarget } from "../auth/store.ts";
import { redactSecrets } from "../auth/secrets.ts";
import type { CompactionOutcome, ContextManager } from "../context/manager.ts";
import type { SessionRecord } from "../conversation/types.ts";
import type { ModelCapability } from "../model/catalog.ts";
import type { Model, ModelUsage } from "../model/model.ts";
import type { Session } from "../session/session.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { Workspace } from "../workspace/workspace.ts";
import type { ExtensionRuntime } from "../extensions/host.ts";
import type { SkillDiscovery } from "../skills/skills.ts";
import type { ResolvedSettings, GitChangeTrackingMode } from "../config/config.ts";
import type { ConfigEditor, ConfigTransaction } from "../config/editing.ts";
import type { GitSnapshot, GitTurnComparison } from "../workspace/git.ts";
import type { ModelPickerEntry, ModelPickerSnapshot } from "./model-picker.ts";
import type { ModelPickerAccess } from "./model-access.ts";
import type { TuiStatus, TuiActivityPhase, TuiActivity, TuiRecovery, TuiTranscriptEntry, TurnOutcome, ChangeReview, TuiSnapshot, TuiControllerOptions } from "./controller-types.ts";
import type { BranchTreeSnapshot } from "./branch-tree.ts";
import { buildTranscriptFromSession } from "./transcript-format.ts";
import { startupFailureCategory, startupRecoveryMessage } from "./controller-support.ts";

/**
 * Shared conversation state and helpers for the TUI controller layers.
 * Later layers add behavior; declarations below name members implemented by them.
 */
export abstract class ControllerCore {
  protected session: Session;
  protected model?: Model;
  protected contextManager: ContextManager;
  protected tools?: ToolRegistry;
  protected workspace?: Workspace;
  protected secrets: string[];
  protected provider: string;
  protected modelId: string;
  protected sessionId: string;
  protected startupRecoveryCategory: "auth" | "credential-store" | "model" | "provider" = "auth";
  protected startupDiagnostic?: string;
  protected startupAbort?: AbortController;
  protected sessionWriteBlocked = false;
  protected maxTurns?: number;
  protected maxConcurrentTools?: number;
  protected explicitContextWindow?: number;
  protected explicitMaxOutput?: number;
  protected baseUrl?: string;
  protected auth?: string;
  protected openaiAuth?: string;
  protected xaiAuth?: string;
  protected grokModels?: readonly import("../model/model-list.ts").ListedModel[];
  protected grokPending = false;
  protected grokReactivationRequired = false;
  protected grokModelsUnavailable = false;
  protected grokSelected(): boolean { return isGrokModel(this.model) || (this.provider === "xai" && this.xaiAuth === "grok"); }
  protected profile?: string;
  protected thinking?: string;
  protected configEditor?: ConfigEditor;
  protected currentApprovalMode: ApprovalMode = DEFAULT_APPROVAL_MODE;
  protected toolApproval?: ToolApproval;
  protected readonly allowedTools = new Set<string>();
  private settleToolApproval?: (decision: ApprovalDecision) => void;
  private readonly noticedApprovalPaths = new Set<string>();
  protected readonly appearanceEnvironment?: "dark" | "light";
  protected readonly stageSettings?: TuiControllerOptions["stageSettings"];
  protected readonly onSettingsCommitted?: TuiControllerOptions["onSettingsCommitted"];
  protected readonly onModelActivated?: TuiControllerOptions["onModelActivated"];
  protected readonly onRuntimeEvent?: TuiControllerOptions["onRuntimeEvent"];
  protected preferences?: PreferencesSnapshot;
  protected preferenceTransaction?: ConfigTransaction;
  protected preferenceGeneration = 0;
  protected settingsFailure?: string;
  protected recentSession?: SessionDiscovery;
  protected restored = false;
  protected recentDiscoveryGeneration = 0;
  protected sessionPicker?: NonNullable<TuiSnapshot["sessionPicker"]>;
  protected sessionRows: SessionDiscovery[] = [];
  protected sessionMatches: SessionDiscovery[] = [];
  protected loadMoreSessions?: () => Promise<boolean>;
  protected resumePickedSession?: (id: string, signal: AbortSignal) => Promise<boolean>;
  protected sessionResumeAbort?: AbortController;
  protected modelPicker?: ModelPickerSnapshot;
  protected subscriptionModels?: readonly string[];
  protected modelPickerAccess?: ModelPickerAccess;
  protected pickerReturn?: { query: string; identity: string; route: Pick<ModelPickerEntry, "provider" | "authRoute" | "profile">; access?: ModelPickerAccess };
  protected pickerPreferredRoute?: Pick<ModelPickerEntry, "provider" | "authRoute" | "profile">;
  protected pickerPreferredIdentity?: string;
  protected pickerSelectionTouched = false;
  protected subscriptionCapabilities?: readonly ModelCapability[];
  protected subscriptionPending = false;
  protected subscriptionReactivationRequired = false;
  protected modelCatalogAbort?: AbortController;
  protected branchTreeOpen = false;
  protected branchTreeSelectedId?: string;
  protected branchTreeSelectedBranchId?: string;
  protected branchTreeCache?: BranchTreeSnapshot;
  protected transcript: TuiTranscriptEntry[] = [];
  protected status: TuiStatus = "idle";
  protected readonly activityClock: () => number;
  protected readonly agentClock?: AgentClock;
  protected contextEstimate?: { session: Session; branch: string; last?: SessionRecord; tokens: number; summaryId?: string; firstKeptId?: string };
  protected reportedUsage?: { identity: string; usage: ModelUsage };
  protected activity?: { compactionOutcome?: CompactionOutcome; compactionReason?: "pressure" | "overflow" | "manual"; id: number; phase: TuiActivityPhase; startedAt: number; elapsedMs: number; activeTools: Map<string, string>; retry?: { failedAttempt: number; maxAttempts: number; until: number; cause?: ModelRetryCause }; cancellation: "none" | "requested" | "settling" };
  protected operationSequence = 0;
  protected activeAbort?: AbortController;
  protected activeTurn?: Promise<void>;
  protected counter = 0;
  protected currentAssistantId?: string;
  protected modelAttemptBaseAssistantId?: string;
  protected modelAttemptStarted = false;
  protected retryNoticeId?: string;
  protected recovery?: TuiRecovery & { sessionId: string; branchId: string; userId?: string; details?: string; model?: Model;
    provider: string; modelId: string; profile?: string; openaiAuth?: string; xaiAuth?: string };
  protected recoveryRepair = false;
  protected toolDenialByCallId = new Map<string, string>();
  protected toolEntryByCallId = new Map<string, TuiTranscriptEntry>();
  protected extensions?: ExtensionRuntime;
  protected readonly home?: string;
  protected detachDiagnostics?: () => void;
  protected readonly loadWorkspaceExtensions?: TuiControllerOptions["loadWorkspaceExtensions"];
  protected disposed = false;
  protected readonly credentials?: TuiControllerOptions["credentials"];
  protected credentialEntry?: MaskedCredentialEntry;
  protected credentialTarget?: CredentialTarget;
  protected credentialMutation = false;
  protected loginChooserState?: { level: import("./controller-types.ts").LoginChooserLevel; selectedId: string };
  protected loginReturn?: { level: import("./controller-types.ts").LoginChooserLevel; selectedId: string };
  protected endpointUrlEntry?: { value: string; error?: string };
  /** Retain exact endpoint input for key-step cancellation; the credential target holds its routing URL. */
  protected endpointInputUrl?: string;
  protected loginCallbackValue?: string;
  protected loginApproval?: string;
  protected loginApprovalData?: import("./controller-types.ts").LoginApproval;
  /** Active subscription sign-in abort; unlike submitted OS writes, the OAuth wait stays cancellable. */
  protected loginAbort?: AbortController;
  /** A started OAuth credential write retains operation ownership until the secure store settles. */
  protected loginSaving = false;
  protected loginGeneration = 0;
  /** Abort for the post-sign-in model listing; Esc and dispose cancel it without blocking the picker. */
  protected signInListAbort?: AbortController;
  /** Advances when the active provider, model, or profile changes so a stale sign-in cannot overwrite it. */
  protected selectionGeneration = 0;
  protected explicitChangeTracking?: GitChangeTrackingMode;
  protected outcome?: TurnOutcome;
  protected outcomeIdentity?: string;
  protected outcomeUserId?: string;
  protected outcomeDiagnostics?: string;
  protected noticeDetails?: { identity: string; text: string };
  /** Preserve each outcome display path's resolved tool identity until the outcome is cleared. */
  protected successfulToolPaths = new Map<string, string>();
  protected changeReview?: ChangeReview;
  protected reviewGeneration = 0;
  protected gitBaseline?: GitSnapshot;
  protected gitAfter?: GitSnapshot;
  protected gitComparison?: GitTurnComparison;
  protected gitSnapshotError?: string;
  protected gitShellPaths: string[] = [];
  /** Initialize display history from the supplied session and dependencies without starting a model turn. */
  constructor(options: TuiControllerOptions) {
    this.session = options.session;
    this.model = options.model;
    this.contextManager = options.contextManager;
    this.tools = options.tools;
    this.workspace = options.workspace;
    this.provider = options.provider;
    this.modelId = options.modelId;
    this.sessionId = options.sessionId;
    this.startupDiagnostic = options.startupError;
    if (options.startupError) this.startupRecoveryCategory = startupFailureCategory(options.startupError);
    this.maxTurns = options.maxTurns;
    this.maxConcurrentTools = options.maxConcurrentTools;
    this.explicitContextWindow = options.explicitContextWindow;
    this.explicitMaxOutput = options.explicitMaxOutput;
    this.baseUrl = options.baseUrl;
    this.auth = options.auth;
    this.openaiAuth = options.openaiAuth ?? options.configEditor?.settings.openaiAuth;
    this.xaiAuth = options.xaiAuth ?? options.configEditor?.settings.xaiAuth;
    this.profile = options.profile ?? options.configEditor?.settings.profile;
    this.thinking = options.thinking ?? options.configEditor?.settings.thinking;
    this.secrets = options.secrets ?? [];
    this.extensions = options.extensions;
    this.home = options.home;
    this.configEditor = options.configEditor;
    this.currentApprovalMode = options.configEditor?.settings.approvalMode ?? DEFAULT_APPROVAL_MODE;
    this.appearanceEnvironment = options.appearanceEnvironment;
    this.credentials = options.credentials;
    this.explicitChangeTracking = options.changeTracking;
    this.stageSettings = options.stageSettings;
    this.onSettingsCommitted = options.onSettingsCommitted;
    this.onModelActivated = options.onModelActivated;
    this.onRuntimeEvent = options.onRuntimeEvent;
    this.activityClock = options.activityClock ?? (() => performance.now());
    this.agentClock = options.agentClock;
    this.loadWorkspaceExtensions = options.loadWorkspaceExtensions;
    this.detachDiagnostics = this.extensions?.attachDiagnostics((message) => this.notice(message));
    this.transcript = buildTranscriptFromSession(options.session.items);
    this.noticeIgnoredProjectApproval();
    if (options.startupError) {
      const category = this.startupRecoveryCategory;
      this.offerRecovery(category, false, startupRecoveryMessage(category), options.startupError);
    }
  }
  /** Cycle the live approval mode unless a tool request is pending, without saving configuration. */
  cycleApprovalMode(): void {
    if (this.toolApproval) return;
    this.currentApprovalMode = APPROVAL_MODES[(APPROVAL_MODES.indexOf(this.currentApprovalMode) + 1) % APPROVAL_MODES.length]!;
  }

  /** Ask once for final tool arguments, retaining session allowances until a successful session switch. */
  protected askTool(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    if (this.disposed || signal.aborted) return Promise.resolve({ kind: "deny" });
    if (this.allowedTools.has(request.toolName)) return Promise.resolve({ kind: "allow" });
    const state: ToolApproval = { request: { toolCallId: request.toolCallId, toolName: request.toolName, index: request.index }, selected: 0, enteringReason: false, loading: true, content: "Preparing preview…" };
    this.toolApproval = state;
    return new Promise(resolve => {
      const settle = (decision: ApprovalDecision) => {
        signal.removeEventListener("abort", abort);
        if (this.toolApproval === state) { this.toolApproval = undefined; this.settleToolApproval = undefined; }
        resolve(decision);
      };
      const abort = () => settle({ kind: "deny" });
      this.settleToolApproval = settle;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      void approvalPreview(request, this.workspace!.root, this.secrets).then(preview => {
        if (!this.disposed && !signal.aborted && this.toolApproval === state) Object.assign(state, preview, { loading: false });
      }, () => {
        if (!this.disposed && !signal.aborted && this.toolApproval === state) Object.assign(state, { content: "Preview unavailable", loading: false });
      });
    });
  }

  /** Move the active approval choice without changing the composer draft. */
  moveToolApproval(delta: number): void {
    if (this.toolApproval && !this.toolApproval.enteringReason) this.toolApproval.selected = (this.toolApproval.selected + delta + 3) % 3;
  }

  /** Allow once, remember this tool for the session, or open ephemeral denial entry. */
  chooseToolApproval(): void {
    if (!this.toolApproval) return;
    if (this.toolApproval.selected === 2) { this.toolApproval.enteringReason = true; return; }
    if (this.toolApproval.loading) return;
    if (this.toolApproval.selected === 1) this.allowedTools.add(this.toolApproval.request.toolName);
    this.settleToolApproval?.({ kind: "allow" });
  }

  /** Deny the current call with the exact trimmed model-visible user explanation. */
  denyToolApproval(reason = ""): void {
    const text = reason.trim();
    this.settleToolApproval?.({ kind: "deny", reason: text ? `Denied by the user: ${text}` : "Denied by the user." });
  }

  /** Show a looser project approval warning at most once per config path in this process. */
  protected noticeIgnoredProjectApproval(): void {
    if (!this.configEditor || !this.workspace) return;
    const path = projectConfigPath(this.workspace.root);
    const notice = ignoredProjectApprovalNotice(this.configEditor.settings, path);
    if (notice && !this.noticedApprovalPaths.has(path)) { this.noticedApprovalPaths.add(path); this.notice(notice); }
  }

  /** Identify an unconfigured connection without an adapter, startup check or diagnostic. */
  protected isNotConnected(): boolean {
    return !this.startupAbort && !this.model && !this.modelId.trim() && !this.startupDiagnostic;
  }
  protected beginActivity(phase: TuiActivityPhase): number {
    const id = ++this.operationSequence;
    this.activity = { id, phase, startedAt: this.activityClock(), elapsedMs: 0, activeTools: new Map(), cancellation: "none" };
    return id;
  }
  protected activitySnapshot(): TuiActivity {
    const activity = this.activity!;
    const now = this.activityClock();
    activity.elapsedMs = Math.max(activity.elapsedMs, now - activity.startedAt, 0);
    return {
      operationId: activity.id,
      phase: activity.phase,
      elapsedMs: activity.elapsedMs,
      activeTools: activity.activeTools.size,
      toolNames: [...activity.activeTools.values()].map(name => redactSecrets(name, this.secrets)),
      ...(activity.retry ? { retry: { failedAttempt: activity.retry.failedAttempt, maxAttempts: activity.retry.maxAttempts, remainingMs: Math.max(0, activity.retry.until - now), ...(activity.retry.cause ? { cause: activity.retry.cause } : {}) } } : {}),
      cancellation: activity.cancellation,
      compactionReason: activity.compactionReason,
      compactionOutcome: activity.compactionOutcome,
    };
  }
  protected settleActivity(id: number): void {
    if (this.activity?.id === id) this.activity = undefined;
  }
  /** Whether the ephemeral command help surface owns the editor. */
  commandHelpOpen = false;
  protected discoveredCommands?: SkillDiscovery;
  protected commandDiscoveryGeneration = 0;
  protected contextIdentity(): string { return `${this.sessionId}/${this.session.activeBranchId}/${this.provider}/${this.modelId}`; }
  /** Append a system line without touching session history. */
  notice(text: string, details?: string): void {
    if (details) this.retainNoticeDetails(details);
    this.transcript.push(this.systemEntry(text));
  }
  protected retainNoticeDetails(details: string): void {
    if (this.disposed) return;
    this.noticeDetails = { identity: `${this.sessionId}/${this.session.activeBranchId}`, text: redactSecrets(details, this.secrets).slice(0, 50_000) };
  }
  /** Return unconsumed notice diagnostics only within their live original conversation. */
  protected currentNoticeDetails(): string | undefined {
    return !this.disposed && this.noticeDetails?.identity === `${this.sessionId}/${this.session.activeBranchId}` ? this.noticeDetails.text : undefined;
  }
  /** Reveal retained notice diagnostics only on request and within their original conversation. */
  inspectNoticeDetails(): boolean {
    const details = this.currentNoticeDetails();
    if (details === undefined) return false;
    this.noticeDetails = undefined;
    this.notice(`Details · Esc keep editing\n${details}`);
    return true;
  }
  /** Append an actionable error line and mark the status as error. */
  fail(text: string, details?: string): void {
    if (details) this.retainNoticeDetails(details);
    if (text === "Your Grok plan doesn't include API access. Use an xAI API key instead.") text = "Your Grok plan doesn't include API access. Use an xAI API key instead · Alt+L sign in";
    this.transcript.push({
      id: this.nextId("err"),
      kind: "error",
      text,
    });
    this.status = "error";
  }
  protected systemEntry(text: string): TuiTranscriptEntry {
    return { id: this.nextId("sys"), kind: "system", text };
  }
  protected nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }

  // Members implemented by later layers.
  protected abstract abortActiveTurn(): void;
  abstract applyEvent(event: RuntimeEvent, operationId?: number): void;
  abstract cancel(): void;
  protected abstract changeSettings(prepare: () => Promise<ConfigTransaction>, message: () => string | undefined, failureMessage?: string, activate?: boolean, presentationOnly?: false | "appearance" | "ui", budgets?: { contextWindow?: number; maxOutput?: number }): Promise<boolean>;
  abstract closeModelPicker(): void;
  abstract describeThinking(): string;
  protected abstract thinkingSelection(): ReturnType<typeof resolveThinkingSelection>;
  protected abstract thinkingContext(): ReturnType<typeof resolveThinkingSelection>["context"];
  abstract effectiveBudgets(): { contextWindow: number; maxOutput: number };
  protected abstract emitModelActivated(choice: Pick<ModelPickerEntry, "provider" | "modelId" | "authRoute" | "profile">, notifySuccess?: boolean): Promise<void>;
  protected abstract loadAccountCatalog(signal: AbortSignal): Promise<readonly ModelCapability[]>;
  protected abstract observeRuntimeEvent(event: RuntimeEvent): void;
  protected abstract offerRecovery(category: TuiRecovery["category"], accepted: boolean, message: string, details?: string, operationId?: number, markError?: boolean): void;
  protected abstract publishSettings(next: ResolvedSettings, staged: { model?: Model; contextManager: ContextManager }): void;
  protected abstract recoveryIdentityChanged(recovery: NonNullable<ControllerCore["recovery"]>): boolean;
  abstract replaceSession(
    session: Session,
    sessionId: string,
    options?: { workspace?: Workspace; contextManager?: ContextManager },
  ): void;
  protected abstract restorePickerAfterConnection(connected?: boolean): void;
  abstract get running(): boolean;
  /** Close the transient undo panel on session replacement or disposal. */
  abstract closeUndoPreview(): void;
  abstract snapshot(): TuiSnapshot;
  abstract submit(prompt: string, accepted?: () => void): Promise<boolean>;
}
