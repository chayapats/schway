import type { ToolApproval } from "./tool-approval.ts";
import type { ApprovalMode } from "../agent/approval.ts";
import type { SessionDiscovery } from "../session/jsonl.ts";
import type { PreferencesSnapshot } from "./preferences.ts";
import type { AgentClock } from "../agent/retry.ts";
import type { RuntimeEvent } from "../agent/events.ts";
import { MaskedCredentialEntry } from "../auth/management.ts";
import type { CredentialStore } from "../auth/store.ts";
import type { CompactionOutcome, ContextManager } from "../context/manager.ts";
import type { ModelCapability } from "../model/catalog.ts";
import type { Model, ModelUsage } from "../model/model.ts";
import type { Session } from "../session/session.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { Workspace } from "../workspace/workspace.ts";
import type { ExtensionRuntime } from "../extensions/host.ts";
import type { ResolvedSettings, GitChangeTrackingMode } from "../config/config.ts";
import type { ConfigEditor } from "../config/editing.ts";
import type { ModelPickerSnapshot } from "./model-picker.ts";
import type { BranchTreeSnapshot } from "./branch-tree.ts";
import type { DiffRow, GitDiffRow } from "../text/diff.ts";
import type { ReviewScope, WorkspaceReviewFile } from "./review-scope.ts";

/** Visible turn state for the status bar. Error persists until the next submit. */
export type TuiStatus = "idle" | "running" | "error";

/** Current operation phase derived from runtime events, never inferred from silence. */
export type TuiActivityPhase = "preparing" | "waiting" | "streaming" | "tools" | "retry" | "compacting" | "stopping";

/** Volatile progress for the operation that currently owns the controller. */
export interface TuiActivity {
  operationId: number;
  phase: TuiActivityPhase;
  elapsedMs: number;
  activeTools: number;
  toolNames: readonly string[];
  retry?: { failedAttempt: number; maxAttempts: number; remainingMs: number };
  compactionReason?: "pressure" | "overflow" | "manual";
  compactionOutcome?: CompactionOutcome;
  cancellation: "none" | "requested" | "settling";
}

/** Tool execution state shown in the transcript. */
export type TuiToolStatus = "running" | "success" | "error" | "cancelled";

/** Validated, volatile shell evidence; absence means no observed exit, including resumed legacy results. */
export type TuiShellOutcome = { kind: "exit"; code: number } | { kind: "stopped" | "timed-out" };

/** Recovery choices bound to one failed operation and its current conversation identity. */
export interface TuiRecovery {
  operationId: number;
  entryId: string;
  category: "auth" | "credential-store" | "model" | "offline" | "rate-limit" | "provider" | "tool" | "session-write";
  accepted: boolean;
  actions: readonly ("connect" | "retry-credentials" | "choose-model" | "continue" | "details" | "keep-editing")[];
}

/** One renderable row in the TUI transcript. */
export interface TuiTranscriptEntry {
  id: string;
  sessionRecordId?: string;
  kind: "user" | "assistant" | "tool" | "system" | "error";
  text: string;
  toolName?: string;
  toolCallId?: string;
  toolStatus?: TuiToolStatus;
  /** A streamed assistant preview whose attempt never became a session record. */
  incomplete?: boolean;
  /** Short path, search pattern, or command identifying this call. */
  toolSummary?: string;
  /** Short observed result summary, separate from the call target. */
  resultSummary?: string;
  /** Structured shell evidence kept separate from tool execution status and model-facing records. */
  shellOutcome?: TuiShellOutcome;
  /** Original deletion and edited addition rows derived from successful runtime details. */
  diffRows?: DiffRow[];
}

/** Plain-data duration, observed file changes, and command evidence for the latest accepted turn. */
export interface TurnOutcome {
  reason: "completed" | "failed" | "cancelled" | "limit";
  commands: { callId: string; command: string; exitCode: number | null; status: TuiToolStatus }[];
  /** Counts cover the entire turn even when the retained command evidence list is truncated. */
  commandCounts: { exitZero: number; nonzero: number; unknown: number };
  toolResults: number;
  failedTools: number;
  elapsedMs: number;
  files: { path: string; added?: number; removed?: number; source: "tool" | "shell" }[];
}

/** Bounded read-only working-tree review; file contents are current, never a rollback preview. */
export interface ChangeReview {
  heading: string;
  files: (TurnOutcome["files"][number] | WorkspaceReviewFile)[];
  selected: number;
  detail: string;
  rows: GitDiffRow[];
  details: string;
  showingDetails: boolean;
  loading: boolean;
  /** Evidence that supplied `files`: a live turn record or current Git status. */
  scope?: ReviewScope;
  /** Listed path whose current Git content `rows` show, set together with `selected`. */
  currentPath?: string;
  /** Paths came from the undo panel, not one turn's record; the list shows no source badges and `scope` stays unset. */
  fromUndo?: true;
}

/** One file-tool diff, or a read-only `shell` row for a path without saved undo, with its action badge. */
export interface UndoPreviewFile {
  path: string;
  absolutePath: string;
  action: "restore" | "delete" | "skip" | "shell";
  status: string;
  rows: GitDiffRow[];
  binary: boolean;
}
/** Renderer-independent undo preview or final per-file results. */
export interface UndoPreview {
  shellUnavailable?: boolean;
  turnId: string;
  turnNumber: number;
  files: UndoPreviewFile[];
  selected: number;
  result: boolean;
  /** The target precedes the latest accepted turn on this branch. */
  older?: boolean;
  /** Read-only state with no applicable undo; Enter does nothing while present. */
  readOnlyStatus?: string;
  /** Short explanations shown above the selected file. */
  notes?: string[];
}

/** Renderable controller state with a readonly transcript array; entries are not guaranteed to be deep copies. */
export interface TuiSnapshot {
  status: TuiStatus;
  context: { estimatedTokens: number; capacity: number | null; providerUsage: ModelUsage | null; summaryId?: string; firstKeptId?: string };
  compactionNotice?: string;
  /** Whether unconsumed notice diagnostics belong to this conversation; input ownership still controls routing. */
  noticeDetailsAvailable: boolean;
  outcome?: TurnOutcome;
  changeReview?: ChangeReview;
  undoPreview?: UndoPreview;
  /** Distinguish an unconfigured connection from startup checks, usable models and setup failures. */
  readiness: "loading" | "ready" | "not-connected" | "connect" | "choose-model" | "repair";
  /** A bounded known startup explanation; raw provider diagnostics remain behind recovery details. */
  readinessDetail?: string;
  /** Live phase and elapsed time while an operation is owned; absent once settled. */
  activity?: TuiActivity;
  transcript: readonly TuiTranscriptEntry[];
  /** Identify the nonempty assistant preview still accepting deltas, excluding completed or abandoned attempts. */
  streamingAssistantId?: string;
  sessionId: string;
  branchId: string;
  /** Live process approval mode retained across session and model switches. */
  approvalMode: ApprovalMode;
  /** Pending tool request retained while another panel owns input. */
  toolApproval?: ToolApproval;
  provider: string;
  modelId: string;
  /** Active named compatible profile, when a selection is live. */
  profile?: string;
  /** OpenAI credential preference shown with provider/model; auto prefers explicit keys over stored subscription. */
  openaiAuth?: string;
  xaiAuth?: string;
  /** Route bound to the active adapter, regardless of the saved automatic preference. */
  activeRoute?: string;
  /** Requested thinking level shown with provider/model; undefined leaves provider defaults untouched. */
  thinking?: string;
  /** Effective reasoning description shown alongside the requested value. */
  effectiveThinking?: string;
  preferences?: PreferencesSnapshot;
  recentSession?: SessionDiscovery;
  /** Whether the current conversation was explicitly restored. */
  restored?: boolean;
  sessionPicker?: { query: string; allWorkspaces: boolean; entries: SessionDiscovery[]; selectedIndex: number; offset: number; total: number; loading: boolean; hasMore: boolean; error?: string };
  modelPicker?: ModelPickerSnapshot;
  credentialEntry?: ReturnType<MaskedCredentialEntry["snapshot"]>;
  /** Available sign-in actions while the interactive chooser is open. */
  loginChooser?: LoginChooserSnapshot;
  /** Ephemeral plain endpoint input and its field-local validation message, excluded from conversation persistence. */
  endpointUrlEntry?: { value: string; error?: string };
  /** Masked browser callback input, kept outside transcript and composer history. */
  loginCallbackEntry?: { masked: string };
  /** Ephemeral approval instruction; user codes never enter transcript notices. */
  loginApproval?: string;
  /** Structured device address and code kept only in the ephemeral sign-in panel. */
  loginApprovalData?: LoginApproval;
  /** Interactive branch-tree browser state; undefined while the tree is closed. */
  branchTree?: BranchTreeSnapshot;
  /** Renderer-free branch-tree build failure shown instead of a tree. */
  branchTreeError?: string;
  /** Available actions for the most recent failure, omitted after its session or branch changes. */
  recovery?: TuiRecovery;
}

/** Dependencies for one interactive conversation; mirrors headless loop inputs. */
export interface TuiControllerOptions {
  session: Session;
  model?: Model;
  contextManager: ContextManager;
  tools?: ToolRegistry;
  workspace?: Workspace;
  provider: string;
  modelId: string;
  sessionId: string;
  maxTurns?: number;
  maxConcurrentTools?: number;
  /** Explicit budget overrides that persist across model switches. */
  explicitContextWindow?: number;
  /** Explicit output limit that persists across model switches. */
  explicitMaxOutput?: number;
  /** Connection settings shown by /config for compatible endpoints. */
  baseUrl?: string;
  /** Auth mode shown by /config for compatible endpoints. */
  auth?: string;
  /** Active named compatible profile shown in status and /config. */
  profile?: string;
  /** OpenAI credential preference shown in status and /config. */
  openaiAuth?: string;
  xaiAuth?: string;
  /** Requested thinking level shown in status and /config; undefined leaves provider defaults untouched. */
  thinking?: string;
  startupError?: string;
  /** Known values to mask in displayed transcript text and configuration output. */
  secrets?: string[];
  extensions?: ExtensionRuntime;
  /** Stage fresh enabled modules for a workspace before publishing a session switch. */
  loadWorkspaceExtensions?: (workspace: Workspace, signal: AbortSignal) => Promise<{ tools: ToolRegistry; runtime: ExtensionRuntime }>;
  home?: string;
  configEditor?: ConfigEditor;
  /** Explicit launch appearance overrides saved TUI appearance. */
  appearanceEnvironment?: "dark" | "light";
  /** Secure credential management and forced adapter refresh for the current settings. */
  credentials?: {
    store: CredentialStore;
    env: Record<string, string | undefined>;
    runtimeApiKey?: string;
    /** Provider the process runtime key belongs to. Other routes must not receive it. */
    runtimeProvider?: string;
    rememberSecret?: (key: string) => void;
    reload: (settings?: ResolvedSettings) => Promise<{ model: Model; notice?: string } | { error: string }>;
    /** Explicit subscription login runner; production wires the verified OAuth flow. */
    codexLogin?: CodexLoginRunner;
    /** Explicit Grok approval runner; it never handles API keys. */
    grokLogin?: GrokLoginRunner;
    /** Discover only the saved Grok account models. */
    listGrokModels?: (signal: AbortSignal) => Promise<readonly import("../model/model-list.ts").ListedModel[]>;
    /** Resolve account-scoped model IDs using only the ChatGPT subscription transport. */
    listSubscriptionModels?: (signal: AbortSignal) => Promise<readonly string[]>;
    /** Discover verified model budgets and reasoning levels for this subscription identity. */
    listSubscriptionCatalog?: (signal: AbortSignal) => Promise<readonly ModelCapability[]>;
    /** List connected OpenAI, xAI or compatible models; standalone=true uses the independently configured primary connection instead of a selected profile. */
    listRouteModels?: (route: "api-key" | "compatible" | "xai", signal: AbortSignal, endpoint?: { baseUrl?: string; standalone?: boolean }) => Promise<readonly import("../model/model-list.ts").ListedModel[]>;
  };
  /** Construct the next adapter and matching context budget before committing any edit. */
  stageSettings?: (settings: ResolvedSettings, signal: AbortSignal, workspace?: Workspace, currentModel?: Model, activate?: boolean, budgets?: { contextWindow?: number; maxOutput?: number }) => Promise<{ model?: Model; contextManager: ContextManager; modelCapability?: ModelCapability }>;
  /** Publish renderer-owned context references after a successful settings commit. */
  onSettingsCommitted?: (settings: ResolvedSettings, manager: ContextManager) => void;
  /** Receive a choice only after its model and route are active. */
  onModelActivated?: (choice: { provider: string; modelId: string; authRoute: string; profile?: string }) => void;
  /** Observe current-turn events and their active session ID before display folding without blocking the loop. */
  onRuntimeEvent?: (event: RuntimeEvent, sessionId: string) => void | Promise<void>;
  /** Injectable monotonic time source for deterministic activity snapshots. */
  activityClock?: () => number;
  /** Injectable loop clock for deterministic provider retry waits. */
  agentClock?: AgentClock;
  /** Explicit change-tracking fallback when no config editor supplies effective settings. */
  changeTracking?: GitChangeTrackingMode;
}

/** Run explicit ChatGPT browser/device approval with secure-store write-start and commit notifications. */
export type CodexLoginRunner = (input: {
  device: boolean;
  code?: string;
  signal: AbortSignal;
  onProgress: (message: string) => void;
  /** Mark the start of a secure-store write that must settle before another credential mutation. */
  onSaving?: () => void;
  onSaved?: () => void;
}) => Promise<{ ok: true; status: string } | { ok: false; message: string }>;

/** Browser or device approval data that stays outside conversation and draft persistence. */
export type LoginApproval = { kind: "browser" } | { kind: "device"; verificationUri: string; userCode: string };
/** Run explicit Grok approval with separate panel progress and secure-store write-start and commit notifications. */
export type GrokLoginRunner = (input: {
  device: boolean;
  signal: AbortSignal;
  onProgress: (message: string) => void;
  onApproval: (approval: LoginApproval) => void;
  /** Mark the start of a secure-store write that must settle before another credential mutation. */
  onSaving?: () => void;
  onSaved?: () => void;
}) => Promise<{ ok: true; status: string } | { ok: false; message: string }>;

/** Chooser levels distinguish primary routes from a subscription's alternate sign-in methods. */
export type LoginChooserLevel = "main" | "chatgpt" | "grok";
/** Ordered chooser rows separate nonselectable group headers from stable selectable actions. */
export type LoginChooserRow = { kind: "group"; label: string } | { kind: "choice"; id: string; label: string; detail?: string; hasMore: boolean };
/** A sign-in panel exposes its current level, ordered rows and selected action identity. */
export interface LoginChooserSnapshot { level: LoginChooserLevel; rows: readonly LoginChooserRow[]; selectedId: string }
