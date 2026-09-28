import { preferenceRows, PREFERENCE_SCOPES, type PreferencesSnapshot } from "./preferences.ts";
import { runAgentLoop } from "../agent/loop.ts";
import type { AgentClock } from "../agent/retry.ts";
import { toolTarget } from "./presentation.ts";
import type { RuntimeEvent } from "../agent/events.ts";
import { MaskedCredentialEntry, removeStoredCredential } from "../auth/management.ts";
import { codexSubscriptionIdentity, credentialIdentity, credentialStoreError, type CredentialIdentity, type CredentialStore, type CredentialTarget } from "../auth/store.ts";
import { credentialEnvironmentVariable, isOpenAIAuthPreference } from "../auth/credentials.ts";
import { redactSecrets } from "../auth/secrets.ts";
import type { ContextManager } from "../context/manager.ts";
import type { SessionRecord } from "../conversation/types.ts";
import { lookupModel, type ModelCapability } from "../model/catalog.ts";
import type { Model } from "../model/model.ts";
import type { Session } from "../session/session.ts";
import type { SessionEntry } from "../session/branches.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { addWorkspaceRoots, type Workspace } from "../workspace/workspace.ts";
import type { ExtensionRuntime } from "../extensions/host.ts";
import { discoverSkills } from "../skills/skills.ts";
import type { ConfigLayer, ResolvedSettings } from "../config/config.ts";
import { DEFAULT_GIT_CHANGE_TRACKING, describeEffectiveThinking, type GitChangeTrackingMode } from "../config/config.ts";
import { EDITABLE_CONFIG_KEYS, type ConfigEditor, type ConfigScope, type ConfigTransaction } from "../config/editing.ts";
import { parseLoginTarget, parseModelArgs, parseThinkingArgs, LOGIN_USAGE } from "./commands.ts";
import {
  captureGitSnapshot,
  compareGitSnapshots,
  formatGitComparison,
  formatGitDiffPreview,
  formatGitStatus,
  getGitDiffPreview,
  inspectGitStatus,
  type GitSnapshot,
  type GitTurnComparison,
} from "../workspace/git.ts";
import { modelPickerEntries, modelPickerIdentity, type ModelPickerEntry, type ModelPickerSnapshot } from "./model-picker.ts";
import { loadModelPickerAccess, type ModelPickerAccess } from "./model-access.ts";

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
  cancellation: "none" | "requested" | "settling";
}

/** Tool execution state shown in the transcript. */
export type TuiToolStatus = "running" | "success" | "error" | "cancelled";

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
  kind: "user" | "assistant" | "tool" | "system" | "error";
  text: string;
  toolName?: string;
  toolCallId?: string;
  toolStatus?: TuiToolStatus;
  /** A streamed assistant preview whose attempt never became a session record. */
  incomplete?: boolean;
  /** Short path, search pattern, or command identifying this call. */
  toolSummary?: string;
}

/** Renderable controller state with a readonly transcript array; entries are not guaranteed to be deep copies. */
export interface TuiSnapshot {
  status: TuiStatus;
  /** Whether startup is still resolving the selected route, ready, or needs explicit setup. */
  readiness: "loading" | "ready" | "connect" | "choose-model" | "repair";
  /** A bounded known startup explanation; raw provider diagnostics remain behind recovery details. */
  readinessDetail?: string;
  /** Live phase and elapsed time while an operation is owned; absent once settled. */
  activity?: TuiActivity;
  transcript: readonly TuiTranscriptEntry[];
  sessionId: string;
  branchId: string;
  provider: string;
  modelId: string;
  /** Active named compatible profile, when a selection is live. */
  profile?: string;
  /** OpenAI credential preference shown with provider/model; auto prefers explicit keys over stored subscription. */
  openaiAuth?: string;
  /** Route bound to the active adapter, regardless of the saved automatic preference. */
  activeRoute?: string;
  /** Requested thinking level shown with provider/model; undefined leaves provider defaults untouched. */
  thinking?: string;
  /** Effective reasoning description shown alongside the requested value. */
  effectiveThinking?: string;
  preferences?: PreferencesSnapshot;
  modelPicker?: ModelPickerSnapshot;
  credentialEntry?: ReturnType<MaskedCredentialEntry["snapshot"]>;
  /** Available sign-in actions while the interactive chooser is open. */
  loginChooser?: { selectedIndex: number; choices: readonly string[] };
  /** Masked browser callback input, kept outside transcript and composer history. */
  loginCallbackEntry?: { masked: string };
  /** Ephemeral approval instruction; user codes never enter transcript notices. */
  loginApproval?: string;
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
  /** Secure credential management and forced adapter refresh for the current settings. */
  credentials?: {
    store: CredentialStore;
    env: Record<string, string | undefined>;
    runtimeApiKey?: string;
    rememberSecret?: (key: string) => void;
    reload: (settings?: ResolvedSettings) => Promise<{ model: Model; notice?: string } | { error: string }>;
    /** Explicit subscription login runner; production wires the verified OAuth flow. */
    codexLogin?: CodexLoginRunner;
    /** Resolve account-scoped model IDs using only the ChatGPT subscription transport. */
    listSubscriptionModels?: (signal: AbortSignal) => Promise<readonly string[]>;
    /** Discover verified model budgets and reasoning levels for this subscription identity. */
    listSubscriptionCatalog?: (signal: AbortSignal) => Promise<readonly ModelCapability[]>;
  };
  /** Construct the next adapter and matching context budget before committing any edit. */
  stageSettings?: (settings: ResolvedSettings, signal: AbortSignal, workspace?: Workspace, currentModel?: Model, activate?: boolean) => Promise<{ model?: Model; contextManager: ContextManager; modelCapability?: ModelCapability }>;
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

/** Explicit subscription login runner injected for tests; production wires the verified browser/device OAuth flow. */
export type CodexLoginRunner = (input: {
  device: boolean;
  code?: string;
  signal: AbortSignal;
  onProgress: (message: string) => void;
  onSaved?: () => void;
}) => Promise<{ ok: true; status: string } | { ok: false; message: string }>;

const LOGIN_CHOICES = [
  { label: "ChatGPT · Browser approval", action: { kind: "codex", device: false } },
  { label: "ChatGPT · Device approval", action: { kind: "codex", device: true } },
  { label: "ChatGPT · Paste browser callback", action: { kind: "callback" } },
  { label: "OpenAI API key", action: { kind: "api-key", provider: "openai" } },
  { label: "Anthropic API key", action: { kind: "api-key", provider: "anthropic" } },
  { label: "OpenAI-compatible API key", action: { kind: "api-key", provider: "openai-compatible" } },
] as const;
const BROWSER_LOGIN_INDEX = LOGIN_CHOICES.findIndex(choice => choice.action.kind === "codex" && !choice.action.device);
const DEVICE_LOGIN_INDEX = LOGIN_CHOICES.findIndex(choice => choice.action.kind === "codex" && choice.action.device);

/** Bound on displayed tool-result characters; session data stays complete. */
export const MAX_TOOL_DISPLAY_CHARS = 2000;

/** Maximum tree nodes rendered in one snapshot; older nodes are pinned around root, heads and selection. */
export const MAX_BRANCH_TREE_NODES = 200;

/** Maximum characters kept in one tree preview; session data stays complete. */
export const MAX_BRANCH_TREE_PREVIEW_CHARS = 120;

/** Maximum branches listed in one tree snapshot, matching the textual /branch list cap. */
export const MAX_BRANCH_TREE_BRANCHES = 50;

/** Maximum transcript rows shown in a branch preview pane; durable history stays complete. */
export const MAX_BRANCH_TREE_PREVIEW_ENTRIES = 8;

/** Durable entry kind shown in the interactive branch tree. */
export type BranchTreeEntryKind = "root" | "user" | "assistant" | "tool_result" | "compaction";

/** One parent/child conversation node with stable-ID selection and bounded preview. */
export interface BranchTreeNode {
  /** Stable entry ID or conversation root ID; selection never resolves labels or prefixes. */
  id: string;
  parentId?: string;
  depth: number;
  kind: BranchTreeEntryKind;
  /** Bounded one-line preview of the entry; never the full durable content. */
  preview: string;
  /** True when the node is a complete-turn boundary eligible for forking. */
  isForkPoint: boolean;
  /** True when at least one saved branch head points here. */
  isHead: boolean;
  /** Stable branch IDs whose head is this node, in branch-list order. */
  headBranchIds: readonly string[];
  /** True when this node is the durable active branch head. */
  isActiveHead: boolean;
  childCount: number;
}

/** One saved branch row with stable-ID selector and bounded head preview. */
export interface BranchTreeBranchRow {
  /** Stable branch selector; labels are never selectors. */
  id: string;
  name?: string;
  active: boolean;
  headId: string;
  entryCount: number;
  /** Bounded preview of the head entry or root. */
  preview: string;
}

/** Renderer-free branch-tree snapshot with preview-only selection separate from the durable head. */
export interface BranchTreeSnapshot {
  rootId: string;
  activeBranchId: string;
  branches: readonly BranchTreeBranchRow[];
  /** Bounded depth-first nodes; see truncated and totalNodeCount for scale. */
  nodes: readonly BranchTreeNode[];
  /** True when nodes were capped and totalNodeCount exceeds nodes.length. */
  truncated: boolean;
  /** Preview-only selection; changing it never changes model context or persistence. */
  selectedId: string;
  /** Reachable node count (root plus durable entries) before capping. */
  totalNodeCount: number;
}

/** Build a bounded one-line preview for one durable record or the empty root. */
export function branchTreePreviewForRecord(item: SessionRecord | undefined, limit: number = MAX_BRANCH_TREE_PREVIEW_CHARS): string {
  const bound = Math.max(1, Math.floor(limit));
  if (!item) {
    const root = "(empty conversation root)";
    return root.length <= bound ? root : `${root.slice(0, bound)}…`;
  }
  const oneLine = (text: string): string => {
    const collapsed = text.replace(/\s+/g, " ").trim();
    if (!collapsed) return "(empty)";
    return collapsed.length <= bound ? collapsed : `${collapsed.slice(0, bound)}…`;
  };
  if (item.type === "user") return oneLine(item.content.map(block => block.text).join(" ")) || "(empty)";
  if (item.type === "assistant") {
    const text = item.content.filter(block => block.type === "text").map(block => (block as { text: string }).text).join(" ");
    if (text.trim()) return oneLine(text);
    const calls = item.content.filter(block => block.type === "tool_call");
    if (calls.length) {
      const names = calls.map(block => (block as { name: string }).name).join(", ");
      return oneLine(`tool call ${names}`);
    }
    return "(reasoning)";
  }
  if (item.type === "tool_result") return oneLine(item.content);
  return oneLine(`Compacted: ${item.summary}`);
}

/** Walk one entry to the root through durable parents, rejecting missing links without choosing another path. */
export function branchTreeAncestryRecords(session: Session, entryId: string): SessionRecord[] {
  if (entryId === session.rootId) return [];
  const byId = new Map(session.entries.map(entry => [entry.item.id, entry]));
  const reversed: SessionRecord[] = [];
  const seen = new Set<string>();
  let id = entryId;
  while (id !== session.rootId) {
    if (seen.has(id)) throw new Error(`Session ancestry cycle at ${id}`);
    seen.add(id);
    const entry = byId.get(id);
    if (!entry) throw new Error(`Missing session parent or head: ${id}`);
    reversed.push(entry.item);
    id = entry.parentId;
  }
  return reversed.reverse();
}

/** Build a bounded depth-first tree with stable IDs, pinning root, heads and selection when capped. */
export function buildBranchTreeSnapshot(session: Session, selectedId?: string, limits?: { maxNodes?: number; previewChars?: number; maxBranches?: number }): BranchTreeSnapshot {
  const maxNodes = Math.max(1, Math.floor(limits?.maxNodes ?? MAX_BRANCH_TREE_NODES));
  const previewChars = Math.max(1, Math.floor(limits?.previewChars ?? MAX_BRANCH_TREE_PREVIEW_CHARS));
  const maxBranches = Math.max(1, Math.floor(limits?.maxBranches ?? MAX_BRANCH_TREE_BRANCHES));
  const branches = session.listBranches();
  const entries = session.entries;
  const byId = new Map(entries.map(entry => [entry.item.id, entry]));
  const itemById = new Map(entries.map(entry => [entry.item.id, entry.item] as const));
  const active = branches.find(branch => branch.id === session.activeBranchId);
  if (!active) throw new Error(`Missing session parent or head: ${session.activeBranchId}`);
  const activeHeadId = active.headId;
  const forkPoints = new Set<string>();
  for (const branch of branches) for (const point of branch.forkPoints) forkPoints.add(point);
  const heads = new Map<string, string[]>();
  for (const branch of branches) {
    const list = heads.get(branch.headId);
    if (list) list.push(branch.id);
    else heads.set(branch.headId, [branch.id]);
  }
  const children = new Map<string, SessionEntry[]>();
  for (const entry of entries) {
    const list = children.get(entry.parentId);
    if (list) list.push(entry);
    else children.set(entry.parentId, [entry]);
  }
  const kindOf = (id: string): BranchTreeEntryKind => {
    if (id === session.rootId) return "root";
    const item = itemById.get(id);
    if (!item) return "user";
    if (item.type === "user") return "user";
    if (item.type === "assistant") return "assistant";
    if (item.type === "tool_result") return "tool_result";
    return "compaction";
  };
  const full: BranchTreeNode[] = [];
  const stack: Array<{ id: string; parentId?: string; depth: number }> = [{ id: session.rootId, depth: 0 }];
  const visited = new Set<string>();
  while (stack.length) {
    const next = stack.pop()!;
    if (visited.has(next.id)) continue;
    visited.add(next.id);
    const kids = children.get(next.id) ?? [];
    const headIds = heads.get(next.id) ?? [];
    full.push({
      id: next.id,
      ...(next.parentId === undefined ? {} : { parentId: next.parentId }),
      depth: next.depth,
      kind: kindOf(next.id),
      preview: branchTreePreviewForRecord(next.id === session.rootId ? undefined : itemById.get(next.id), previewChars),
      isForkPoint: forkPoints.has(next.id),
      isHead: headIds.length > 0,
      headBranchIds: [...headIds],
      isActiveHead: next.id === activeHeadId,
      childCount: kids.length,
    });
    for (let i = kids.length - 1; i >= 0; i--) {
      const kid = kids[i]!;
      stack.push({ id: kid.item.id, parentId: next.id, depth: next.depth + 1 });
    }
  }
  const totalNodeCount = entries.length + 1;
  const known = (id: string): boolean => id === session.rootId || byId.has(id);
  const fallback = known(activeHeadId) ? activeHeadId : session.rootId;
  const selected = selectedId !== undefined && known(selectedId) ? selectedId : fallback;
  let nodes: BranchTreeNode[] = full;
  let truncated = full.length > maxNodes || totalNodeCount > maxNodes;
  if (full.length > maxNodes) {
    const byOrder = new Map(full.map((node, index) => [node.id, index] as const));
    const keep = new Set<string>();
    for (const id of [session.rootId, activeHeadId, selected]) {
      if (keep.size >= maxNodes) break;
      if (byOrder.has(id)) keep.add(id);
    }
    for (const id of heads.keys()) {
      if (keep.size >= maxNodes) break;
      if (byOrder.has(id)) keep.add(id);
    }
    const headRoom = Math.min(full.length, Math.max(0, maxNodes - keep.size));
    const tailStart = Math.max(0, full.length - headRoom);
    for (let i = tailStart; i < full.length && keep.size < maxNodes; i++) keep.add(full[i]!.id);
    for (let i = 0; i < full.length && keep.size < maxNodes; i++) keep.add(full[i]!.id);
    nodes = full.filter(node => keep.has(node.id));
    truncated = true;
  } else if (totalNodeCount > maxNodes) truncated = true;
  const rows: BranchTreeBranchRow[] = branches.slice(0, maxBranches).map(branch => ({
    id: branch.id,
    ...(branch.name === undefined ? {} : { name: branch.name }),
    active: branch.id === session.activeBranchId,
    headId: branch.headId,
    entryCount: branch.entryCount,
    preview: branchTreePreviewForRecord(branch.headId === session.rootId ? undefined : itemById.get(branch.headId) ?? undefined, previewChars),
  }));
  return { rootId: session.rootId, activeBranchId: session.activeBranchId, branches: rows, nodes, truncated, selectedId: selected, totalNodeCount };
}

/**
 * Own interactive transcript state around the shared agent loop.
 * The renderer stays thin: it renders snapshots and forwards input.
 * No OpenTUI import here; this module is unit-testable with a scripted model.
 */
export class TuiController {
  private session: Session;
  private model?: Model;
  private contextManager: ContextManager;
  private tools?: ToolRegistry;
  private workspace?: Workspace;
  private secrets: string[];
  private provider: string;
  private modelId: string;
  private sessionId: string;
  private startupRecoveryCategory: "auth" | "credential-store" | "model" | "provider" = "auth";
  private startupDiagnostic?: string;
  private startupAbort?: AbortController;
  private sessionWriteBlocked = false;
  private maxTurns?: number;
  private maxConcurrentTools?: number;
  private explicitContextWindow?: number;
  private explicitMaxOutput?: number;
  private baseUrl?: string;
  private auth?: string;
  private openaiAuth?: string;
  private profile?: string;
  private thinking?: string;
  private configEditor?: ConfigEditor;
  private readonly stageSettings?: TuiControllerOptions["stageSettings"];
  private readonly onSettingsCommitted?: TuiControllerOptions["onSettingsCommitted"];
  private readonly onModelActivated?: TuiControllerOptions["onModelActivated"];
  private readonly onRuntimeEvent?: TuiControllerOptions["onRuntimeEvent"];
  private preferences?: PreferencesSnapshot;
  private preferenceTransaction?: ConfigTransaction;
  private preferenceGeneration = 0;
  private settingsFailure?: string;
  private modelPicker?: ModelPickerSnapshot;
  private subscriptionModels?: readonly string[];
  private modelPickerAccess?: ModelPickerAccess;
  private pickerReturn?: { query: string; identity: string };
  private pickerPreferredIdentity?: string;
  private pickerSelectionTouched = false;
  private subscriptionCapabilities?: readonly ModelCapability[];
  private subscriptionPending = false;
  private subscriptionReactivationRequired = false;
  private modelCatalogAbort?: AbortController;
  private branchTreeOpen = false;
  private branchTreeSelectedId?: string;
  private branchTreeCache?: BranchTreeSnapshot;
  private transcript: TuiTranscriptEntry[] = [];
  private status: TuiStatus = "idle";
  private readonly activityClock: () => number;
  private readonly agentClock?: AgentClock;
  private activity?: { id: number; phase: TuiActivityPhase; startedAt: number; elapsedMs: number; activeTools: Map<string, string>; retry?: { failedAttempt: number; maxAttempts: number; until: number }; cancellation: "none" | "requested" | "settling" };
  private operationSequence = 0;
  private activeAbort?: AbortController;
  private activeTurn?: Promise<void>;
  private counter = 0;
  private currentAssistantId?: string;
  private modelAttemptBaseAssistantId?: string;
  private modelAttemptStarted = false;
  private retryNoticeId?: string;
  private recovery?: TuiRecovery & { sessionId: string; branchId: string; userId?: string; details?: string; model?: Model;
    provider: string; modelId: string; profile?: string; openaiAuth?: string };
  private recoveryRepair = false;
  private toolEntryByCallId = new Map<string, TuiTranscriptEntry>();
  private extensions?: ExtensionRuntime;
  private readonly home?: string;
  private detachDiagnostics?: () => void;
  private readonly loadWorkspaceExtensions?: TuiControllerOptions["loadWorkspaceExtensions"];
  private disposed = false;
  private readonly credentials?: TuiControllerOptions["credentials"];
  private credentialEntry?: MaskedCredentialEntry;
  private credentialTarget?: CredentialTarget;
  private credentialMutation = false;
  private loginChooserIndex?: number;
  private loginCallbackValue?: string;
  private loginApproval?: string;
  /** Active subscription sign-in abort; unlike submitted OS writes, the OAuth wait stays cancellable. */
  private codexLoginAbort?: AbortController;
  private explicitChangeTracking?: GitChangeTrackingMode;
  private gitBaseline?: GitSnapshot;
  private gitAfter?: GitSnapshot;
  private gitComparison?: GitTurnComparison;
  private gitSnapshotError?: string;

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
    this.profile = options.profile ?? options.configEditor?.settings.profile;
    this.thinking = options.thinking ?? options.configEditor?.settings.thinking;
    this.secrets = options.secrets ?? [];
    this.extensions = options.extensions;
    this.home = options.home;
    this.configEditor = options.configEditor;
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
    if (options.startupError) {
      const category = this.startupRecoveryCategory;
      this.offerRecovery(category, false, startupRecoveryMessage(category), options.startupError);
    }
  }

  /** Return current state with a new transcript array, masking supplied known secrets in entry text. */
  snapshot(): TuiSnapshot {
    const thinking = this.configEditor?.settings.thinking ?? this.thinking;
    const effective = describeEffectiveThinking(this.provider, thinking as never, this.modelId);
    const branchTree = this.branchTreeForSnapshot();
    const activeRoute = this.model
      ? this.model.provider === "codex-subscription" ? "ChatGPT subscription" : this.model.provider === "openai" ? "OpenAI API key" : "OpenAI route"
      : this.openaiAuth === "codex" ? "ChatGPT subscription" : this.openaiAuth === "api-key" ? "OpenAI API key" : "OpenAI route";
    const recovery = this.currentRecovery();
    return {
      status: this.status,
      readiness: this.startupAbort ? "loading" : this.model ? "ready" : this.startupRecoveryCategory === "auth" ? "connect" : this.startupRecoveryCategory === "model" ? "choose-model" : "repair",
      ...(!this.model && this.startupDiagnostic ? { readinessDetail:
        /Missing OpenAI API key/.test(this.startupDiagnostic) ? "Missing OpenAI API key."
          : /no longer available/.test(this.startupDiagnostic) ? "Remembered model is no longer available in this account."
            : /Selected model is not available/.test(this.startupDiagnostic) ? "Selected model is not available in this account."
              : undefined } : {}),
      ...(this.activity ? { activity: this.activitySnapshot() } : {}),
      transcript: this.transcript.map((entry) =>
        this.secrets.length === 0
          ? entry
          : { ...entry, text: redactSecrets(entry.text, this.secrets), toolSummary: entry.toolSummary ? redactSecrets(entry.toolSummary, this.secrets) : undefined },
      ),
      sessionId: this.sessionId,
      branchId: this.session.activeBranchId,
      provider: this.provider,
      modelId: this.modelId,
      ...(this.profile !== undefined ? { profile: this.profile } : {}),
      ...(this.openaiAuth !== undefined ? { openaiAuth: this.openaiAuth } : {}),
      ...(this.provider === "openai" ? { activeRoute: `${activeRoute}${this.model ? "" : " (unavailable)"}` } : {}),
      ...(thinking !== undefined ? { thinking, effectiveThinking: effective } : {}),
      preferences: this.preferences ? structuredClone(this.preferences) : undefined,
      modelPicker: this.modelPicker ? structuredClone(this.modelPicker) : undefined,
      credentialEntry: this.credentialEntry?.snapshot(),
      ...(this.loginChooserIndex !== undefined ? { loginChooser: { selectedIndex: this.loginChooserIndex, choices: LOGIN_CHOICES.map(choice => choice.label) } } : {}),
      ...(this.loginCallbackValue !== undefined ? { loginCallbackEntry: { masked: "•".repeat(Math.min(this.loginCallbackValue.length, 64)) } } : {}),
      ...(this.loginApproval !== undefined ? { loginApproval: this.loginApproval } : {}),
      ...(branchTree.tree !== undefined ? { branchTree: branchTree.tree } : {}),
      ...(branchTree.error !== undefined ? { branchTreeError: branchTree.error } : {}),
      ...(recovery ? { recovery } : {}),
    };
  }

  /** True while startup, a turn, compaction or credential input owns interactive execution. */
  get running(): boolean {
    return this.startupAbort !== undefined || this.activeAbort !== undefined || this.credentialEntry !== undefined || this.loginCallbackValue !== undefined || this.credentialMutation;
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

  private beginActivity(phase: TuiActivityPhase): number {
    const id = ++this.operationSequence;
    this.activity = { id, phase, startedAt: this.activityClock(), elapsedMs: 0, activeTools: new Map(), cancellation: "none" };
    return id;
  }

  private activitySnapshot(): TuiActivity {
    const activity = this.activity!;
    const now = this.activityClock();
    activity.elapsedMs = Math.max(activity.elapsedMs, now - activity.startedAt, 0);
    return {
      operationId: activity.id,
      phase: activity.phase,
      elapsedMs: activity.elapsedMs,
      activeTools: activity.activeTools.size,
      toolNames: [...activity.activeTools.values()].map(name => redactSecrets(name, this.secrets)),
      ...(activity.retry ? { retry: { failedAttempt: activity.retry.failedAttempt, maxAttempts: activity.retry.maxAttempts, remainingMs: Math.max(0, activity.retry.until - now) } } : {}),
      cancellation: activity.cancellation,
    };
  }

  private settleActivity(id: number): void {
    if (this.activity?.id === id) this.activity = undefined;
  }

  /** Route login input and notify when an explicit subscription sign-in starts. */
  async login(args: string, accepted: () => void = () => {}): Promise<boolean> {
    if (!args.trim()) return this.openLoginChooser();
    const routed = parseLoginTarget(args);
    if ("error" in routed) {
      this.fail(routed.error);
      return false;
    }
    if (routed.kind === "codex") {
      return this.runCodexLogin(routed, accepted);
    }
    return this.beginLogin(routed.provider);
  }

  /** Show provider and auth choices without consuming the ordinary composer draft. */
  openLoginChooser(): boolean {
    if (this.disposed || this.running) { this.notice("Busy: finish the current operation before signing in."); return false; }
    this.closeModelPicker();
    this.loginChooserIndex = 0;
    return true;
  }

  /** Move the highlighted sign-in action without changing credentials. */
  moveLoginChooser(delta: number): void {
    if (this.loginChooserIndex === undefined) return;
    this.loginChooserIndex = (this.loginChooserIndex + delta + LOGIN_CHOICES.length) % LOGIN_CHOICES.length;
  }

  /** Start the chosen sign-in path using the current provider or auth method. */
  async selectLoginChoice(): Promise<boolean> {
    const index = this.loginChooserIndex;
    if (index === undefined) return false;
    const choice = LOGIN_CHOICES[index];
    if (!choice) return false;
    this.loginChooserIndex = undefined;
    if (this.codexLoginAbort) {
      this.codexLoginAbort.abort();
      await this.activeTurn;
    }
    if (choice.action.kind === "callback") { this.loginCallbackValue = ""; return true; }
    if (choice.action.kind === "codex") return this.runCodexLogin({ device: choice.action.device });
    return this.beginLogin(choice.action.provider);
  }

  /** Append a pasted callback to masked input without entering history or a notice. */
  enterLoginCallbackText(text: string): void {
    if (this.loginCallbackValue === undefined) return;
    const value = text.replace(/[\r\n]+$/, "");
    if (/[\x00-\x1f\x7f]/.test(value) || this.loginCallbackValue.length + value.length > 16_384) {
      this.loginCallbackValue = "";
      this.fail("The callback contains invalid input. Paste the complete browser redirect again.");
      return;
    }
    this.loginCallbackValue += value;
  }

  /** Remove one character from masked callback input. */
  backspaceLoginCallback(): void {
    if (this.loginCallbackValue !== undefined) this.loginCallbackValue = [...this.loginCallbackValue].slice(0, -1).join("");
  }

  /** Exchange the masked callback without copying it into conversation state. */
  async submitLoginCallback(): Promise<boolean> {
    const code = this.loginCallbackValue?.trim();
    if (code === undefined) return false;
    this.loginCallbackValue = undefined;
    if (!code) { this.fail("Paste the browser callback URL or code before continuing."); return false; }
    return this.runCodexLogin({ device: false, code });
  }

  /** Start masked entry for one explicit provider only while the conversation is idle. */
  beginLogin(args: string): boolean {
    if (this.disposed || this.running) { this.notice("Busy: credential changes require an idle session."); return false; }
    const target = this.parseCredentialTarget(args);
    if (!target || !this.credentials) return false;
    return this.beginCredentialTarget(target);
  }

  /** Open masked entry for the route identity chosen by the picker. */
  private beginCredentialTarget(target: CredentialTarget): boolean {
    if (!this.credentials) return false;
    let identity: CredentialIdentity;
    try { identity = credentialIdentity(target); }
    catch { this.fail("Select a valid compatible base URL before /login openai-compatible."); return false; }
    this.closeModelPicker();
    this.loginChooserIndex = undefined;
    this.credentialTarget = target;
    this.credentialEntry = new MaskedCredentialEntry({ identity, store: this.credentials.store,
      rememberSecret: key => {
        if (!this.secrets.includes(key)) this.secrets.push(key);
        this.credentials?.rememberSecret?.(key);
      },
    });
    return true;
  }

  /** Route secret text directly to the masked buffer without creating a transcript or session item. */
  enterCredentialText(text: string): void { this.credentialEntry?.insert(text); }

  /** Remove the last secret character without involving normal editor undo or recall. */
  backspaceCredential(): void { this.credentialEntry?.backspace(); }

  /** Commit one submitted key and refresh the active adapter, waiting for non-abortable storage. */
  async submitCredential(): Promise<boolean> {
    const entry = this.credentialEntry;
    const target = this.credentialTarget;
    if (!entry || !target || this.credentialMutation) return false;
    this.credentialMutation = true;
    const task = (async () => {
      const result = await entry.submit();
      this.notice(result.message);
      if (!result.ok) { this.pickerReturn = undefined; this.status = "error"; return false; }
      const source = this.credentialOverrideNotice(target);
      if (source) this.notice(source);
      await this.refreshCredentialModel(credentialIdentity(target));
      return true;
    })();
    const tracked = task.then(() => {});
    this.activeTurn = tracked;
    let saved: boolean;
    try { saved = await task; } finally {
      this.credentialEntry = undefined;
      this.credentialTarget = undefined;
      this.credentialMutation = false;
      if (this.activeTurn === tracked) this.activeTurn = undefined;
    }
    if (saved) this.restorePickerAfterConnection();
    return saved;
  }

  /** Remove exactly one provider's saved credential without altering runtime or environment overrides. */
  async logout(args: string): Promise<boolean> {
    if (this.disposed || this.running) { this.notice("Busy: credential changes require an idle session."); return false; }
    const routed = parseLoginTarget(args);
    if ("error" in routed) {
      this.fail(routed.error);
      return false;
    }
    if (routed.kind === "codex") {
      if (routed.device || routed.code !== undefined) {
        this.fail("Usage: /logout codex takes no flags.");
        return false;
      }
      return this.runCodexLogout();
    }
    const target: CredentialTarget = {
      provider: routed.provider,
      baseUrl: this.configEditor?.settings.baseUrl ?? this.baseUrl,
      ...(routed.provider === "openai-compatible" && (this.configEditor?.settings.profile ?? this.profile) !== undefined
        ? { profile: this.configEditor?.settings.profile ?? this.profile }
        : {}),
      ...(routed.provider === "openai-compatible" && this.configEditor?.settings.credentialIdentity !== undefined
        ? { credentialIdentity: this.configEditor?.settings.credentialIdentity }
        : {}),
    };
    if (!this.credentials) { this.fail("Credential management is unavailable in this session."); return false; }
    this.closeModelPicker();
    this.credentialMutation = true;
    const task = (async () => {
      const result = await removeStoredCredential({ ...target, ...this.credentials!, credentialEnv: this.configEditor?.settings.credentialEnv });
      this.notice(result.message);
      if (!result.ok) { this.status = "error"; return false; }
      await this.refreshCredentialModel(credentialIdentity(target));
      return true;
    })();
    const tracked = task.then(() => {});
    this.activeTurn = tracked;
    try { return await task; } finally {
      this.credentialMutation = false;
      if (this.activeTurn === tracked) this.activeTurn = undefined;
    }
  }

  private parseCredentialTarget(args: string): CredentialTarget | undefined {
    const provider = args.trim().toLowerCase();
    if (!["anthropic", "openai", "openai-compatible"].includes(provider)) {
      this.fail(LOGIN_USAGE);
      return;
    }
    if (!this.credentials) { this.fail("Credential management is unavailable in this session."); return; }
    const settings = this.configEditor?.settings;
    return {
      provider: provider as CredentialTarget["provider"],
      baseUrl: settings?.baseUrl ?? this.baseUrl,
      ...(provider === "openai-compatible" && (settings?.profile ?? this.profile) !== undefined
        ? { profile: settings?.profile ?? this.profile }
        : {}),
      ...(provider === "openai-compatible" && settings?.credentialIdentity !== undefined
        ? { credentialIdentity: settings.credentialIdentity }
        : {}),
    };
  }

  private credentialOverrideNotice(target: CredentialTarget): string | undefined {
    if (this.credentials?.runtimeApiKey !== undefined) return "The runtime --api-key override still takes precedence over the saved key.";
    const settings = this.configEditor?.settings;
    if (target.provider === "openai-compatible" && settings?.credentialEnv) {
      if (this.credentials?.env[settings.credentialEnv]?.trim()) return `${settings.credentialEnv} still takes precedence over the saved key.`;
    } else {
      const variable = credentialEnvironmentVariable(target.provider);
      if (this.credentials?.env[variable]?.trim()) return `${variable} still takes precedence over the saved key.`;
    }
    if (target.provider === "openai-compatible" && this.auth === "none") return "Automatic authentication is disabled by auth none; the saved key is not sent.";
  }

  private async refreshCredentialModel(identity: CredentialIdentity): Promise<void> {
    if (this.disposed || !this.credentials) return;
    const settings = this.configEditor?.settings;
    const active = credentialIdentity({
      provider: this.provider as CredentialTarget["provider"],
      baseUrl: settings?.baseUrl ?? this.baseUrl,
      ...(this.provider === "openai-compatible" ? { profile: settings?.profile ?? this.profile } : {}),
      ...(this.provider === "openai-compatible" && settings?.credentialIdentity !== undefined
        ? { credentialIdentity: settings.credentialIdentity }
        : {}),
    });
    if (identity.account !== active.account) return;
    // A removed/replaced saved key must never survive in a previously constructed adapter.
    this.model = undefined;
    try {
      const loaded = await this.credentials.reload();
      if (this.disposed) return;
      if ("error" in loaded) { this.fail(loaded.error); return; }
      this.model = loaded.model;
      if (loaded.notice) {
        this.notice(loaded.notice);
      }
      this.status = "idle";
    } catch {
      this.fail("Credential storage changed, but the provider could not be refreshed. Retry /login or restart after checking provider settings.");
    }
  }

  /** Block an old subscription adapter and discard catalog data after a credential replacement. */
  private invalidateSubscriptionAdapter(): void {
    if (this.model?.provider === "codex-subscription") {
      this.model = undefined;
      this.subscriptionReactivationRequired = true;
    }
    this.subscriptionModels = undefined;
    this.subscriptionCapabilities = undefined;
    this.configEditor?.setModelCapabilities([]);
    this.subscriptionPending = true;
  }

  /** Run the explicit ChatGPT subscription sign-in, persisting only the subscription identity on success. */
  private async runCodexLogin(target: { device: boolean; code?: string }, accepted: () => void = () => {}): Promise<boolean> {
    if (this.disposed || this.running) { this.notice("Busy: credential changes require an idle session."); return false; }
    if (!this.credentials) { this.fail("Credential management is unavailable in this session."); return false; }
    const runner = this.credentials.codexLogin;
    if (!runner) { this.fail("ChatGPT subscription sign-in is unavailable in this session. Restart schway to enable it."); return false; }
    this.closeModelPicker();
    this.loginApproval = undefined;
    const abort = new AbortController();
    let credentialSaved = false;
    this.activeAbort = abort;
    this.codexLoginAbort = abort;
    this.credentialMutation = true;
    this.status = "running";
    this.notice(target.device ? "Starting ChatGPT subscription device sign-in. Press Esc to cancel." : "Starting ChatGPT subscription browser sign-in. Press Esc to cancel.");
    try { accepted(); } catch { /* Presentation cannot cancel an accepted sign-in. */ }
    const task = (async (): Promise<boolean> => {
      try {
        const result = await runner({
          device: target.device,
          ...(target.code !== undefined ? { code: target.code } : {}),
          signal: abort.signal,
          onSaved: () => {
            credentialSaved = true;
            this.invalidateSubscriptionAdapter();
          },
          onProgress: (message) => {
            if (message.startsWith("Enter this code at ")) this.loginApproval = message;
            else {
              this.notice(redactSecrets(message, this.secrets));
              if (message.startsWith("The browser could not be opened automatically")) this.loginChooserIndex = DEVICE_LOGIN_INDEX;
            }
          },
        });
        abort.signal.throwIfAborted();
        if (this.disposed || this.activeAbort !== abort) return false;
        if (!result.ok) {
          this.fail(result.message);
          if (!result.message.startsWith("Cannot save credential")) {
            this.loginChooserIndex = /callback|localhost|browser/i.test(result.message) ? DEVICE_LOGIN_INDEX : BROWSER_LOGIN_INDEX;
          }
          return false;
        }
        this.notice(redactSecrets(result.status, this.secrets));
        // Test runners may omit onSaved; production also invalidates at the store commit point.
        this.invalidateSubscriptionAdapter();
        if (this.configEditor && this.stageSettings && this.credentials?.listSubscriptionCatalog) {
          this.subscriptionPending = true;
          this.status = "idle";
          this.notice("Credential saved. Discovering available account models…");
          return true;
        }
        if (this.provider !== "openai") {
          this.status = "idle";
          this.notice("Credential saved but subscription is not active. Choose an account model with /model when ready.");
          return true;
        }
        this.model = undefined;
        const loaded = await this.credentials!.reload(this.configEditor?.settings);
        if (this.disposed || this.activeAbort !== abort) return false;
        if ("error" in loaded) {
          this.fail(loaded.error);
          return false;
        }
        this.model = loaded.model;
        if (loaded.notice) {
          this.notice(loaded.notice);
        }
        this.status = "idle";
        return true;
      } catch (error) {
        if (abort.signal.aborted) {
          this.notice(credentialSaved
            ? "Sign-in cancelled after the credential was saved. It remains in the OS secure store; choose an account model to activate it."
            : "ChatGPT sign-in cancelled before credential saving; nothing was saved.");
          this.status = "idle";
        } else {
          this.fail("ChatGPT sign-in could not complete. Retry from the sign-in chooser or check secure-store access.");
          this.loginChooserIndex = BROWSER_LOGIN_INDEX;
        }
        return false;
      }
    })();
    const tracked = task.then(() => {});
    this.activeTurn = tracked;
    let signedIn: boolean;
    try { signedIn = await task; } finally {
      this.credentialMutation = false;
      if (this.codexLoginAbort === abort) this.codexLoginAbort = undefined;
      if (this.activeAbort === abort) this.activeAbort = undefined;
      if (this.activeTurn === tracked) this.activeTurn = undefined;
      this.loginApproval = undefined;
    }
    if (signedIn && this.pickerReturn) {
      this.restorePickerAfterConnection();
      return true;
    }
    if (!signedIn) this.pickerReturn = undefined;
    if (signedIn && this.configEditor && this.stageSettings && this.credentials?.listSubscriptionCatalog && !this.disposed) {
      const discovery = new AbortController();
      this.activeAbort = discovery;
      this.status = "running";
      let preferred: string;
      try {
        const models = await this.loadAccountCatalog(AbortSignal.any([discovery.signal, AbortSignal.timeout(5_000)]));
        preferred = models.find(model => model.id === this.modelId)?.id ?? models[0]?.id ?? "";
        if (!preferred) throw new Error("No selectable models were returned for this ChatGPT subscription.");
        discovery.signal.throwIfAborted();
        this.notice(`Account model discovery succeeded (${models.length} models). Activating ${preferred}…`);
      } catch (error) {
        if (discovery.signal.aborted) this.notice(`Subscription activation cancelled; sign-in remains saved. ${this.subscriptionReactivationRequired ? "Previous Codex adapter is blocked; retry /model." : "Previous provider is still active; retry /model."}`);
        else this.fail(`Credential saved, but account model discovery failed temporarily. ${this.subscriptionReactivationRequired ? "Previous Codex adapter is blocked" : "Previous provider remains active"}; retry /model without signing in again.`);
        return false;
      } finally {
        if (this.activeAbort === discovery) this.activeAbort = undefined;
        if (this.status === "running") this.status = "idle";
      }
      const applied = await this.changeSettings(() => this.configEditor!.prepareSubscriptionModel(preferred),
        () => `ChatGPT subscription active for this session: openai/${this.modelId}. ${this.describeThinking()}`,
        "Credential saved and account model found, but activation could not complete. Retry /model after checking the selected provider settings.");
      if (applied) { this.subscriptionPending = false; await this.emitModelActivated({ provider: "openai", modelId: this.modelId, authRoute: "codex" }); }
      else this.notice(`Credential saved and account models found, but subscription activation failed. ${this.subscriptionReactivationRequired ? "Previous Codex adapter is blocked" : "Previous provider remains active"}; retry /model after checking the error.`);
      return applied;
    }
    return signedIn;
  }

  /** Remove only the selected subscription identity, refreshing the adapter when it served OpenAI. */
  private async runCodexLogout(): Promise<boolean> {
    if (!this.credentials) { this.fail("Credential management is unavailable in this session."); return false; }
    this.closeModelPicker();
    this.credentialMutation = true;
    const task = (async (): Promise<boolean> => {
      const wasActiveCodex = this.model?.provider === "codex-subscription" || this.openaiAuth === "codex";
      let deleted: boolean;
      try {
        deleted = await this.credentials!.store.delete(codexSubscriptionIdentity());
      } catch {
        this.fail(credentialStoreError("delete"));
        return false;
      }
      this.subscriptionPending = false;
      this.subscriptionReactivationRequired = false;
      if (deleted) {
        this.subscriptionCapabilities = undefined;
        this.subscriptionModels = undefined;
        this.configEditor?.setModelCapabilities([]);
      }
      this.notice(
        deleted
          ? "Removed the ChatGPT subscription (Codex OAuth) credential. The selected account can no longer run until sign-in and activation succeed again."
          : "No ChatGPT subscription login found; nothing was removed.",
      );
      const overrides: string[] = [];
      if (this.credentials!.runtimeApiKey !== undefined) overrides.push("--api-key");
      if (this.credentials!.env.OPENAI_API_KEY?.trim()) overrides.push("OPENAI_API_KEY");
      if (overrides.length) this.notice(`Explicit API-key overrides remain: ${overrides.join(", ")}. They were not changed by this logout.`);
      if (wasActiveCodex) {
        this.model = undefined;
        this.subscriptionReactivationRequired = true;
        this.notice("The removed active ChatGPT account is blocked; Schway will not switch this conversation to API-key billing.");
        this.status = "idle";
        return true;
      }
      if (this.provider !== "openai") return true;
      // A removed subscription must never survive in a previously constructed adapter.
      this.model = undefined;
      try {
        const loaded = await this.credentials!.reload(this.configEditor?.settings);
        if (this.disposed) return false;
        if ("error" in loaded) {
          this.fail(loaded.error);
          return false;
        }
        this.model = loaded.model;
        if (loaded.notice) {
          this.notice(loaded.notice);
        }
        this.status = "idle";
        return true;
      } catch {
        this.fail("Subscription storage changed, but the provider could not be refreshed. Retry /login codex or restart after checking provider settings.");
        return false;
      }
    })();
    const tracked = task.then(() => {});
    this.activeTurn = tracked;
    try { return await task; } finally {
      this.credentialMutation = false;
      if (this.activeTurn === tracked) this.activeTurn = undefined;
    }
  }

  /** List saved branch identities or change the selected ancestry while all controller work is idle. */
  branchCommand(args: string): boolean {
    const [action, id, ...label] = args.trim().split(/\s+/);
    if ((action === "tree" || action === "show") && id === undefined) {
      if (this.disposed) return false;
      this.openBranchTree();
      this.notice("Branch tree open. Up/Down browses, Enter switches or forks the highlighted complete turn, Esc closes without changing branches.");
      return true;
    }
    if (action === "list" && id === undefined) {
      let branches;
      try { branches = this.session.listBranches(); }
      catch (error) { this.fail(error instanceof Error ? error.message : String(error)); return false; }
      const lines = [`Conversation root: ${this.session.rootId}`, "Branches (IDs are selectors; names are labels):"];
      for (const branch of branches.slice(0, 50)) {
        lines.push(`${branch.active ? "*" : "-"} ${branch.id}${branch.name ? ` (${branch.name})` : ""}: head ${branch.headId}, ${branch.entryCount} entries`);
        lines.push(`  Recent complete-turn entries: ${branch.forkPoints.slice(-12).join(", ")}`);
      }
      if (branches.length > 50) lines.push("More branches are available through the session branch API.");
      this.notice(lines.join("\n").slice(0, 50_000));
      return true;
    }
    if (this.disposed) return false;
    if (this.running) { this.notice("Busy: wait for the active operation to settle before changing branches."); return false; }
    if (!id || (action !== "fork" && action !== "switch") || (action === "switch" && label.length)) {
      this.fail("Usage: /branch list | /branch tree | /branch fork <entry-id> [name] | /branch switch <branch-id>. Branches do not undo file changes.");
      return false;
    }
    try {
      if (action === "fork") this.session.forkBranch(id, label.length ? label.join(" ") : undefined);
      else this.session.selectBranch(id);
      this.replaceSession(this.session, this.sessionId);
      this.notice(`Active branch: ${this.session.activeBranchId}. Conversation branching does not undo file changes.`);
      return true;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /** Open the interactive branch tree with preview-only selection at the durable active head. */
  openBranchTree(): boolean {
    if (this.disposed) return false;
    if (!this.branchTreeOpen) {
      this.branchTreeOpen = true;
      this.branchTreeSelectedId = this.session.activeBranchId ? this.activeHeadId() ?? this.session.rootId : this.session.rootId;
      this.branchTreeCache = undefined;
    }
    return true;
  }

  /** Close the branch tree without changing the durable active branch. */
  closeBranchTree(): void {
    this.branchTreeOpen = false;
    this.branchTreeCache = undefined;
  }

  /** True while the branch-tree browser is open; previewing never changes model context. */
  isBranchTreeOpen(): boolean { return this.branchTreeOpen; }

  /** Drop the cached tree so the next snapshot rebuilds from durable branches. */
  refreshBranchTree(): void { this.branchTreeCache = undefined; }

  /** Return the bounded tree snapshot, rebuilding only after branch changes or selection moves. */
  branchTreeSnapshot(): BranchTreeSnapshot | undefined {
    if (!this.branchTreeOpen) return undefined;
    const built = this.buildBranchTree();
    if (typeof built === "string") throw new Error(built);
    return built;
  }

  /** Move preview selection within visible nodes, clamping at the ends without persisting. */
  moveBranchTreeSelection(delta: number): boolean {
    if (!this.branchTreeOpen || this.disposed || !Number.isFinite(delta) || delta === 0) return false;
    const tree = this.currentBranchTree();
    if (!tree || !tree.nodes.length) return false;
    const index = tree.nodes.findIndex(node => node.id === tree.selectedId);
    const current = index === -1 ? (delta > 0 ? -1 : tree.nodes.length) : index;
    const next = Math.min(tree.nodes.length - 1, Math.max(0, current + Math.trunc(delta)));
    if (next === index) return false;
    return this.selectBranchTreeNode(tree.nodes[next]!.id);
  }

  /** Jump preview selection to the next or previous complete-turn fork point without persisting. */
  focusBranchTreeForkPoint(direction: 1 | -1): boolean {
    if (!this.branchTreeOpen || this.disposed) return false;
    const tree = this.currentBranchTree();
    if (!tree || !tree.nodes.length) return false;
    const order = new Map(tree.nodes.map((node, index) => [node.id, index] as const));
    const forks = tree.nodes.map((node, index) => ({ node, index })).filter(entry => entry.node.isForkPoint);
    if (!forks.length) return false;
    const current = order.get(tree.selectedId) ?? (direction === 1 ? -1 : tree.nodes.length);
    const candidate = direction === 1 ? forks.find(entry => entry.index > current) ?? forks[0]! : [...forks].reverse().find(entry => entry.index < current) ?? forks.at(-1)!;
    if (candidate.node.id === tree.selectedId) return false;
    return this.selectBranchTreeNode(candidate.node.id);
  }

  /** Move preview selection to one stable branch head without persisting a switch. */
  focusBranchTreeBranch(branchId: string): boolean {
    if (!this.branchTreeOpen || this.disposed || !branchId) return false;
    let headId: string | undefined;
    try { headId = this.session.listBranches().find(branch => branch.id === branchId)?.headId; }
    catch { return false; }
    if (!headId) return false;
    return this.selectBranchTreeNode(headId);
  }

  /** Select one stable entry or root ID for preview, rejecting ancestry-broken IDs without moving selection. */
  selectBranchTreeNode(id: string): boolean {
    if (!this.branchTreeOpen || this.disposed || !id) return false;
    if (id !== this.session.rootId) {
      try { branchTreeAncestryRecords(this.session, id); }
      catch { return false; }
    }
    if (this.branchTreeSelectedId === id && this.branchTreeCache?.selectedId === id) return true;
    this.branchTreeSelectedId = id;
    this.branchTreeCache = undefined;
    return true;
  }

  /** Build the side-effect-free transcript that activating one entry would show, without replaying tools. */
  previewBranchTreeNode(id?: string): readonly TuiTranscriptEntry[] {
    const target = id ?? this.branchTreeSelectedId ?? this.activeHeadId() ?? this.session.rootId;
    const records = branchTreeAncestryRecords(this.session, target);
    const transcript = buildTranscriptFromSession(records);
    if (!this.secrets.length) return transcript;
    return transcript.map(entry => ({ ...entry, text: redactSecrets(entry.text, this.secrets), toolSummary: entry.toolSummary ? redactSecrets(entry.toolSummary, this.secrets) : undefined }));
  }

  /** Switch to one stable branch ID while idle and rebuild the transcript without replaying tools. */
  activateBranchTreeBranch(branchId: string): boolean {
    if (this.disposed) return false;
    if (this.running) { this.notice("Busy: wait for the active operation to settle before changing branches. Press Esc to cancel the turn first."); return false; }
    if (!branchId) { this.fail("Usage: select one stable branch ID from the tree. Labels and prefixes are not selectors."); return false; }
    try {
      this.session.selectBranch(branchId);
      this.replaceSession(this.session, this.sessionId);
      this.notice(`Active branch: ${this.session.activeBranchId}. Conversation branching does not undo file changes.`);
      return true;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /** Fork one complete-turn entry while idle, selecting the new head without touching files. */
  forkBranchTreeNode(entryId: string, name?: string): boolean {
    if (this.disposed) return false;
    if (this.running) { this.notice("Busy: wait for the active operation to settle before changing branches. Press Esc to cancel the turn first."); return false; }
    const trimmed = name?.trim() || undefined;
    try {
      this.session.forkBranch(entryId, trimmed);
      this.replaceSession(this.session, this.sessionId);
      this.notice(`Active branch: ${this.session.activeBranchId}. Conversation branching does not undo file changes.`);
      return true;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /** Confirm the preview selection: switch when it is a branch head, otherwise fork its complete turn. */
  confirmBranchTreeSelection(name?: string): boolean {
    if (!this.branchTreeOpen || this.disposed) return false;
    const tree = this.currentBranchTree();
    const selected = tree?.selectedId ?? this.branchTreeSelectedId ?? this.activeHeadId() ?? this.session.rootId;
    let branches: ReturnType<Session["listBranches"]>;
    try { branches = this.session.listBranches(); }
    catch (error) { this.fail(error instanceof Error ? error.message : String(error)); return false; }
    const matches = branches.filter(branch => branch.headId === selected);
    if (matches.length === 1) return this.activateBranchTreeBranch(matches[0]!.id);
    if (matches.length > 1) {
      const active = matches.find(branch => branch.active);
      if (active && selected === this.activeHeadId()) {
        this.notice(`Active branch: ${this.session.activeBranchId}. Conversation branching does not undo file changes.`);
        return true;
      }
      this.fail(`Several branches share head ${selected}. Use /branch switch <branch-id> with one stable ID: ${matches.map(branch => branch.id).join(", ")}.`);
      return false;
    }
    return this.forkBranchTreeNode(selected, name);
  }

  /** Read the durable active head without throwing when the graph is corrupt. */
  private activeHeadId(): string | undefined {
    try { return this.session.listBranches().find(branch => branch.id === this.session.activeBranchId)?.headId; }
    catch { return undefined; }
  }

  /** Return the cached tree, returning to the durable head when preview state is stale. */
  private currentBranchTree(): BranchTreeSnapshot | undefined {
    if (!this.branchTreeOpen) return undefined;
    const built = this.buildBranchTree();
    return typeof built === "string" ? undefined : built;
  }

  /** Build or reuse the bounded tree, keeping selection separate from the durable head. */
  private buildBranchTree(): BranchTreeSnapshot | string {
    if (this.branchTreeCache) return this.branchTreeCache;
    try {
      const tree = buildBranchTreeSnapshot(this.session, this.branchTreeSelectedId ?? this.activeHeadId() ?? this.session.rootId);
      this.branchTreeSelectedId = tree.selectedId;
      this.branchTreeCache = tree;
      return tree;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** Expose the tree for snapshots with redacted previews and a stable error string. */
  private branchTreeForSnapshot(): { tree?: BranchTreeSnapshot; error?: string } {
    if (!this.branchTreeOpen) return {};
    // While a turn streams text deltas, keep the settled tree instead of rebuilding a huge graph per delta.
    if (this.running && this.branchTreeCache) return { tree: this.redactedBranchTree(this.branchTreeCache) };
    const built = this.buildBranchTree();
    if (typeof built === "string") return { error: built };
    return { tree: this.redactedBranchTree(built) };
  }

  /** Mask known secrets in tree previews without changing durable branch data. */
  private redactedBranchTree(tree: BranchTreeSnapshot): BranchTreeSnapshot {
    if (!this.secrets.length) return tree;
    return {
      ...tree,
      branches: tree.branches.map(branch => ({ ...branch, preview: redactSecrets(branch.preview, this.secrets) })),
      nodes: tree.nodes.map(node => ({ ...node, preview: redactSecrets(node.preview, this.secrets) })),
    };
  }

  /** Clear the cached tree after settled turns and successful branch operations. */
  private invalidateBranchTreeCache(): void { this.branchTreeCache = undefined; }

  /** Return the effective observational change-tracking mode with on-demand as the default. */
  gitChangeTracking(): GitChangeTrackingMode {
    return this.configEditor?.settings.gitChangeTracking ?? this.explicitChangeTracking ?? DEFAULT_GIT_CHANGE_TRACKING;
  }

  /** Show Git branch, HEAD, dirty state, and bounded changes without managing commits or branches. */
  async changesCommand(args: string): Promise<boolean> {
    if (this.disposed) return false;
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
      this.fail("Usage: /changes [status|diff [-- <path>]]. Change tracking itself is configured with git.changeTracking.");
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

  /** Capture a snapshot baseline for the owning turn signal, dropping stale results after replacement. */
  private async captureTurnBaseline(signal: AbortSignal): Promise<void> {
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
  private async captureTurnResult(): Promise<void> {
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

  /** Return a copy of the currently usable root identities for discovery and status. */
  workspaceIdentity(): Workspace | undefined {
    return this.workspace ? { ...this.workspace, extraRoots: [...this.workspace.extraRoots] } : undefined;
  }

  /** Return the active context manager for explicit skill invocations after runtime changes. */
  activeContextManager(): ContextManager { return this.contextManager; }

  /** Validate and persist attachments while owning the idle boundary, publishing nothing on failure or cancellation. */
  async addDirectories(directories: readonly string[]): Promise<boolean> {
    if (this.disposed) return false;
    if (this.running) {
      this.notice("Busy: /add-dir was not run. Press Esc to cancel the active operation, then retry.");
      return false;
    }
    if (!this.workspace || directories.length === 0) {
      this.fail("Usage: /add-dir <directory>. Relative paths use the primary workspace root.");
      return false;
    }
    const workspace = this.workspace;
    const session = this.session;
    const abort = new AbortController();
    this.activeAbort = abort;
    this.status = "running";
    const task = (async () => {
      try {
        const next = await addWorkspaceRoots(workspace, directories, abort.signal);
        abort.signal.throwIfAborted();
        if (this.disposed || this.activeAbort !== abort || this.session !== session) return false;
        // Saved unavailable roots remain metadata even though the runtime excludes them.
        session.setExtraRoots([...new Set([...session.metadata.extraRoots, ...next.extraRoots])]);
        workspace.extraRoots = next.extraRoots;
        this.contextManager.clearActiveSkill();
        this.notice(`Workspace root: ${workspace.root}\nAttached roots: ${workspace.extraRoots.join(", ") || "none"}`);
        this.status = "idle";
        return true;
      } catch (error) {
        if (!this.disposed && this.activeAbort === abort) {
          if (abort.signal.aborted) {
            this.notice("Directory attachment cancelled. Roots are unchanged.");
            this.status = "idle";
          } else this.fail(redactSecrets(error instanceof Error ? error.message : String(error), this.secrets));
        }
        return false;
      }
    })();
    const tracked = task.then(() => {});
    this.activeTurn = tracked;
    try { return await task; } finally {
      if (this.activeAbort === abort) this.activeAbort = undefined;
      if (this.activeTurn === tracked) this.activeTurn = undefined;
    }
  }

  /** Return active extension command metadata for help and editor dispatch. */
  extensionCommands() { return this.extensions?.commandList() ?? []; }

  /** Start an idle extension command after preparation and notify when its input is accepted. */
  async runExtensionCommand(name: string, args: string, accepted: () => void = () => {}): Promise<boolean> {
    const command = this.extensions?.command(name);
    if (!command || this.disposed) return false;
    if (this.running) {
      this.notice(`Busy: /${name} was not run. Press Esc to cancel the active operation, then retry.`);
      return false;
    }
    const abort = new AbortController();
    this.activeAbort = abort;
    this.status = "running";
    const task = this.executeExtensionCommand(command, args, abort, accepted);
    const tracked = task.then(() => {});
    this.activeTurn = tracked;
    try { return await task; } finally {
      if (this.activeTurn === tracked) this.activeTurn = undefined;
    }
  }

  private async executeExtensionCommand(
    command: { name: string; source: string; description: string }, args: string, abort: AbortController, accepted: () => void,
  ): Promise<boolean> {
    let prompt: string | undefined;
    let accepting = true;
    let executed = false;
    let succeeded = false;
    const current = () => this.activeAbort === abort && !this.disposed;
    try {
      if (this.workspace) {
        const skills = await discoverSkills({ workspaceRoot: this.workspace.root, extraRoots: this.workspace.extraRoots, home: this.home, signal: abort.signal });
        this.extensions!.assertNoSkillCollision(command, skills);
      }
      abort.signal.throwIfAborted();
      if (!current()) return false;
      executed = true;
      try { accepted(); } catch { /* Presentation cannot cancel an accepted command. */ }
      const result = await this.extensions!.executeCommand(command.name, args, {
        signal: abort.signal,
        submitPrompt: (text) => {
          if (!accepting || !current() || abort.signal.aborted || this.extensions!.signal.aborted) throw new Error("Command prompt capability is closed");
          if (typeof text !== "string" || !text.trim()) throw new Error("Command prompt must be nonempty text");
          if (prompt !== undefined) throw new Error("A command may submit only one prompt");
          prompt = text;
        },
      });
      if (current() && !abort.signal.aborted) {
        if (result) this.notice(result);
        this.status = "idle";
        succeeded = true;
      }
    } catch (error) {
      if (current()) {
        const detail = abort.signal.aborted ? "Cancelled. Retry the command when ready." : error instanceof Error ? error.message : String(error);
        const prefix = `Extension "${command.source}" command /${command.name}: `;
        this.notice(redactSecrets(detail.startsWith(prefix) ? detail : `${prefix}${detail}`, this.secrets).slice(0, 50_000));
        this.status = "idle";
      }
    } finally {
      accepting = false;
      if (this.activeAbort === abort) this.activeAbort = undefined;
    }
    if (succeeded && prompt !== undefined && !this.disposed && !abort.signal.aborted) await this.submit(prompt);
    return executed;
  }

  /** Replace the adapter and displayed provider/model ids without changing session history. */
  setModel(model: Model | undefined, provider: string, modelId: string, profile?: string): void {
    if (!this.recoveryRepair && (this.model !== model || this.provider !== provider || this.modelId !== modelId ||
      profile !== undefined && this.profile !== profile)) this.recovery = undefined;
    this.model = model;
    this.provider = provider;
    this.modelId = modelId;
    if (profile !== undefined) {
      this.profile = profile;
    }
  }

  /** Open model search while idle, selecting the currently active entry. */
  openModelPicker(): boolean {
    if (this.running || this.disposed) { this.notice("Busy: model selection requires an idle session."); return false; }
    this.preferences = undefined; this.preferenceTransaction = undefined; this.preferenceGeneration++;
    this.closeModelPicker();
    this.pickerSelectionTouched = false;
    this.modelPicker = { query: "", selectedIndex: 0, entries: [], ...(this.subscriptionSelected() || this.credentials ? { loading: true, catalogState: "loading" } : {}),
      ...(this.credentials ? { accessLoading: true } : {}) };
    this.searchModels("");
    if (this.subscriptionSelected() || this.credentials) {
      const picker = this.modelPicker;
      const abort = new AbortController();
      this.modelCatalogAbort = abort;
      void this.refreshModelPicker(picker, abort);
    }
    return true;
  }

  /** Resolve configured access and account models for only the current picker instance. */
  private async refreshModelPicker(picker: ModelPickerSnapshot, abort: AbortController): Promise<void> {
    const current = () => !this.disposed && !abort.signal.aborted && this.modelPicker === picker;
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]);
    let discoveryStage: "access" | "catalog" = "access";
    try {
      if (this.credentials) {
        const settings = this.configEditor?.settings;
        const preference = settings?.openaiAuth ?? this.openaiAuth;
        const auth = settings?.auth ?? this.auth;
        const access = await this.boundedPickerTask(signal, loadModelPickerAccess({ ...this.credentials,
          openaiAuth: isOpenAIAuthPreference(preference) ? preference : undefined,
          baseUrl: settings?.baseUrl ?? this.baseUrl, auth: auth === "none" || auth === "optional" || auth === "required" ? auth : undefined,
          credentialEnv: settings?.credentialEnv, credentialIdentity: settings?.credentialIdentity,
          activeProfile: settings?.profile ?? this.profile, profiles: this.configEditor?.profiles,
        }));
        if (!current()) return;
        this.modelPickerAccess = access;
        picker.accessLoading = false;
        this.searchModels(picker.query, true);
      }
      discoveryStage = "catalog";
      if (this.subscriptionSelected() || this.modelPickerAccess?.subscription === "ChatGPT") {
        if (!this.credentials?.listSubscriptionCatalog && !this.credentials?.listSubscriptionModels) {
          throw new Error("ChatGPT model discovery is unavailable. Restart Schway.");
        }
        const models = await this.boundedPickerTask(signal, this.loadAccountCatalog(signal));
        if (!current()) return;
        this.subscriptionModels = models.map(model => model.id);
        picker.catalogState = models.length ? "ready" : "empty";
        if (!models.length) picker.error = "No ChatGPT models were returned for this account. Press Ctrl+R to retry or Esc to cancel.";
      } else {
        picker.catalogState = "empty";
      }
    } catch (error) {
      if (current()) {
        picker.accessLoading = false;
        const message = redactSecrets(error instanceof Error ? error.message : String(error), this.secrets).slice(0, 350);
        picker.catalogState = /offline|network|fetch|timeout|aborted/i.test(message) ? "offline" : "failed";
        picker.error = `${discoveryStage === "access" ? "Model access discovery" : "ChatGPT catalog"} ${picker.catalogState}: ${message}. Press Ctrl+R to retry or Esc to cancel.`;
      }
    } finally {
      if (current()) {
        picker.loading = false;
        this.searchModels(picker.query, true);
      }
    }
  }

  /** Enforce the picker deadline even when a credential store or catalog ignores cancellation. */
  private async boundedPickerTask<T>(signal: AbortSignal, task: Promise<T>): Promise<T> {
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? new Error("Model discovery timed out"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try { return await Promise.race([task, cancelled]); }
    finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
  }

  /** Retry account discovery without losing the search or highlighted route. */
  retryModelPickerCatalog(): boolean {
    const picker = this.modelPicker;
    if (!picker || picker.loading || !this.credentials) return false;
    this.modelCatalogAbort?.abort();
    const abort = new AbortController();
    this.modelCatalogAbort = abort;
    picker.loading = true;
    picker.error = undefined;
    picker.catalogState = "loading";
    void this.refreshModelPicker(picker, abort);
    return true;
  }

  /** Read account metadata once and retain it only in this controller and its session config. */
  private async loadAccountCatalog(signal: AbortSignal): Promise<readonly ModelCapability[]> {
    const load = this.credentials?.listSubscriptionCatalog;
    if (load) {
      const models = await load(signal);
      signal.throwIfAborted();
      this.configEditor?.setModelCapabilities(models);
      this.subscriptionCapabilities = models;
      this.subscriptionModels = models.map(model => model.id);
      return models;
    }
    const slugs = await this.credentials?.listSubscriptionModels?.(signal);
    signal.throwIfAborted();
    if (!slugs) throw new Error("ChatGPT model discovery is unavailable. Restart Schway.");
    return slugs.map(id => ({ id, supportedThinking: [] }));
  }

  /** Use account models when the active route or explicit preference selects a subscription. */
  private subscriptionSelected(): boolean {
    return this.subscriptionPending || (this.provider === "openai" && this.model?.provider === "codex-subscription") || (this.configEditor?.settings.openaiAuth ?? this.openaiAuth) === "codex";
  }

  /** Use Codex thinking only for its adapter or a Codex session awaiting an adapter. */
  private codexThinkingSelected(): boolean {
    return this.model?.provider === "codex-subscription" || (!this.model && this.provider === "openai" &&
      (this.subscriptionReactivationRequired || (this.configEditor?.settings.openaiAuth ?? this.openaiAuth) === "codex"));
  }

  /** Filter catalog and profile choices with fallback budgets for typed ids. */
  searchModels(query: string, refresh = false): void {
    if (!this.modelPicker || this.running) return;
    const picker = this.modelPicker;
    const selectedIdentity = this.pickerPreferredIdentity ?? (this.pickerSelectionTouched ? picker.entries[picker.selectedIndex]?.identity : undefined);
    if (!refresh && picker.query !== query) this.pickerSelectionTouched = true;
    picker.query = query;
    const settings = this.configEditor?.settings;
    picker.entries = modelPickerEntries(query, this.provider, this.modelId, { contextWindow: this.explicitContextWindow, maxOutput: this.explicitMaxOutput }, {
      profiles: this.configEditor?.profiles, activeProfile: settings?.profile ?? this.profile,
      activeRoute: this.model?.provider === "codex-subscription" || this.openaiAuth === "codex" ? "codex" : "api-key",
      baseUrl: settings?.baseUrl ?? this.baseUrl, credentialIdentity: settings?.credentialIdentity,
      subscriptionMode: this.subscriptionSelected(), subscriptionModels: this.subscriptionModels, subscriptionCapabilities: this.subscriptionCapabilities, access: this.modelPickerAccess,
    });
    if (this.modelPickerAccess?.subscription === "Login required" && !this.subscriptionModels?.length &&
      "openai ChatGPT subscription connect".toLowerCase().includes(query.toLowerCase())) {
      picker.entries.push({ identity: modelPickerIdentity({ provider: "openai", authRoute: "codex", modelId: "" }), provider: "openai", modelId: "", authRoute: "codex",
        contextWindow: 0, maxOutput: 0, active: false, custom: false, access: "Login required", connect: true });
    }
    picker.selectedIndex = selectedIdentity ? Math.max(0, picker.entries.findIndex(entry => entry.identity === selectedIdentity)) : 0;
    if (this.pickerPreferredIdentity && picker.entries.some(entry => entry.identity === this.pickerPreferredIdentity)) this.pickerPreferredIdentity = undefined;
  }

  /** Move the highlighted model with wraparound over the filtered choices. */
  moveModelPicker(delta: number): void {
    if (!this.modelPicker || this.running || !this.modelPicker.entries.length) return;
    this.pickerPreferredIdentity = undefined;
    this.pickerSelectionTouched = true;
    const count = this.modelPicker.entries.length;
    this.modelPicker.selectedIndex = ((this.modelPicker.selectedIndex + delta) % count + count) % count;
  }

  /** Start the selected route's sign-in while retaining its query and identity. */
  private async connectPickerRoute(selection: ModelPickerEntry): Promise<boolean> {
    const picker = this.modelPicker;
    if (!picker || !this.credentials) { this.fail("Sign-in is unavailable in this session."); return false; }
    this.pickerReturn = { query: picker.query, identity: selection.identity };
    let started: boolean;
    if (selection.authRoute === "codex") {
      started = await this.login("codex");
      if (!started) this.pickerReturn = undefined;
      return started;
    }
    if (selection.profile) {
      const profile = this.configEditor?.profiles[selection.profile];
      started = !!profile && this.beginCredentialTarget({ provider: "openai-compatible", profile: selection.profile,
        baseUrl: profile.baseUrl, credentialIdentity: profile.credentialIdentity });
    } else started = this.beginLogin(selection.provider);
    if (!started) this.pickerReturn = undefined;
    return started;
  }

  /** Reopen search after a saved credential without activating a model. */
  private restorePickerAfterConnection(): void {
    const returning = this.pickerReturn;
    this.pickerReturn = undefined;
    if (!returning || this.disposed) return;
    this.openModelPicker();
    this.pickerPreferredIdentity = returning.identity;
    this.searchModels(returning.query);
  }

  /** Close the picker without changing the active model or settings. */
  closeModelPicker(): void {
    this.modelCatalogAbort?.abort();
    this.modelCatalogAbort = undefined;
    this.modelPickerAccess = undefined;
    this.subscriptionModels = undefined;
    this.modelPicker = undefined;
    this.pickerPreferredIdentity = undefined;
    this.pickerSelectionTouched = false;
    if (this.recoveryRepair && this.recovery && !this.recoveryIdentityChanged(this.recovery)) this.recoveryRepair = false;
  }

  /** Stage and commit the highlighted model or profile, leaving the picker open on failure. */
  async selectPickerModel(): Promise<boolean> {
    if (this.modelPicker?.accessLoading) { this.notice("Checking configured credentials. Try again shortly."); return false; }
    const selection = this.modelPicker?.entries[this.modelPicker.selectedIndex];
    if (!selection) return false;
    if (selection.access === "Login required" || selection.connect) {
      return this.connectPickerRoute(selection);
    }
    let applied: boolean;
    if (selection.profile !== undefined) applied = await this.selectProfile(selection.profile);
    else if (selection.authRoute === "codex") {
      if (!this.subscriptionModels?.includes(selection.modelId)) {
        this.fail("This ChatGPT model is not in the current account catalog. Press Ctrl+R to retry discovery.");
        return false;
      }
      applied = await this.changeSettings(() => this.configEditor!.prepareSubscriptionModel(selection.modelId),
        () => `Switched to openai/${this.modelId} via ChatGPT subscription.`, undefined, true);
    } else if (selection.authRoute === "api-key") {
      applied = await this.changeSettings(() => this.configEditor!.prepareOpenAIApiModel(selection.modelId),
        () => `Switched to openai/${this.modelId} via OpenAI API key.`, undefined, true);
    } else applied = await this.selectModel(`${selection.provider}/${selection.modelId}`);
    if (applied && (selection.authRoute === "codex" || selection.authRoute === "api-key")) await this.emitModelActivated(selection);
    return applied;
  }

  /** Notify persistence consumers only after the selected route has activated. */
  private async emitModelActivated(choice: Pick<ModelPickerEntry, "provider" | "modelId" | "authRoute" | "profile">): Promise<void> {
    if (!this.model) return;
    try {
      if (await this.configEditor?.rememberChoice(choice.authRoute)) this.notice("Choice remembered for this workspace. Explicit config and CLI settings take precedence on restart; /model forget resets memory.");
      this.onModelActivated?.({ provider: choice.provider, modelId: choice.modelId, authRoute: choice.authRoute,
      ...(choice.profile ? { profile: choice.profile } : {}) }); }
    catch (error) { this.notice(`Model activated and usable, but its preference was not remembered. ${redactSecrets(error instanceof Error ? error.message : String(error), this.secrets)} No additional login is needed.`); }
  }

  /** Switch the named compatible profile as one staged change, retaining previous on failure. */
  async selectProfile(name: string): Promise<boolean> {
    if (this.running) { this.notice("Busy: model selection requires an idle session."); return false; }
    const trimmed = name.trim();
    if (!trimmed) { this.fail("Usage: /model profile:<name>."); return false; }
    const applied = await this.changeSettings(() => this.configEditor!.prepareProfile(trimmed), () => {
      const active = this.configEditor!.settings.profile ?? trimmed;
      return `Switched to profile "${active}" (${this.provider}/${this.modelId}, ${this.effectiveBudgets().contextWindow} ctx, thinking ${this.describeThinking()}).`;
    }, undefined, true);
    if (applied) await this.emitModelActivated({ provider: this.provider, modelId: this.modelId, authRoute: "provider", profile: trimmed });
    return applied;
  }

  /** Forget workspace memory and expose inherited configuration even when its credentials need repair. */
  async forgetModelChoice(): Promise<boolean> {
    if (this.running || !this.configEditor || !this.stageSettings) { this.notice("Memory reset requires an idle configured session."); return false; }
    this.status = "running";
    try {
      const editor = await this.configEditor.forgetChoice();
      const next = editor.settings;
      this.configEditor = editor;
      const signal = new AbortController().signal;
      let staged: { model?: Model; contextManager: ContextManager };
      try { staged = await this.stageSettings(next, signal, this.workspace, this.model); }
      catch { staged = { model: undefined, contextManager: this.contextManager }; }
      this.publishSettings(next, staged);
      this.recovery = undefined;
      this.notice(`Forgot interactive memory for this workspace. Inherited configuration is active.${staged.model ? "" : " Configure access with /model or /login before submitting."}`);
      return true;
    } catch (error) { this.notice(`Could not forget interactive memory: ${redactSecrets(error instanceof Error ? error.message : String(error), this.secrets)}`); return false; }
    finally { this.status = "idle"; }
  }

  /** Apply the textual model or profile form through the same atomic session settings path as the picker. */
  async selectModel(args: string): Promise<boolean> {
    if (this.running) { this.notice("Busy: model selection requires an idle session."); return false; }
    if (["forget", "reset"].includes(args.trim())) return this.forgetModelChoice();
    const selection = parseModelArgs(args, this.provider);
    if ("error" in selection) { this.fail(selection.error); return false; }
    if (selection.profile !== undefined) {
      return this.selectProfile(selection.profile);
    }
    if (this.subscriptionSelected() && selection.provider === "openai") {
      try {
        const available = this.subscriptionModels ?? (await this.loadAccountCatalog(AbortSignal.timeout(5_000))).map(model => model.id);
        if (!available?.includes(selection.modelId)) {
          this.fail(`Model "${selection.modelId}" is not in the ChatGPT subscription model catalog. Open /model to see available choices.`);
          return false;
        }
      } catch (error) {
        this.fail(redactSecrets(error instanceof Error ? error.message : String(error), this.secrets).slice(0, 500));
        return false;
      }
    }
    const applied = await this.changeSettings(() => selection.provider === "openai" && this.subscriptionSelected()
      ? this.configEditor!.prepareSubscriptionModel(selection.modelId)
      : this.configEditor!.prepareModel(selection.provider, selection.modelId),
      () => `Switched to ${this.provider}/${this.modelId} (${this.effectiveBudgets().contextWindow} ctx, ${this.describeThinking()}).`, undefined, true);
    if (applied) await this.emitModelActivated({ provider: this.provider, modelId: this.modelId,
      authRoute: this.model?.provider === "codex-subscription" ? "codex" : this.provider === "openai" ? "api-key" : "provider" });
    return applied;
  }

  /** Show or switch the reasoning level for future requests without rewriting history. */
  async thinkingCommand(args: string): Promise<boolean> {
    const selection = parseThinkingArgs(args);
    if (typeof selection === "object") { this.fail(selection.error); return false; }
    if (selection !== "reset" && this.codexThinkingSelected() &&
      (this.configEditor?.settings.supportedThinking === undefined || this.model?.provider === "codex-subscription" && this.configEditor?.settings.openaiAuth !== "codex")) {
      try {
        const models = this.subscriptionCapabilities ?? await this.loadAccountCatalog(AbortSignal.timeout(5_000));
        if (!models.some(model => model.id === this.modelId)) {
          this.fail(`Model "${this.modelId}" is not available for this ChatGPT subscription. Open /model to choose an account-visible model.`);
          return false;
        }
        // Auto-selected Codex is an active subscription, but saved auth remains "auto".
        // Bind the verified choice to this session so config validation and the adapter agree.
        if (this.model?.provider === "codex-subscription" && this.configEditor?.settings.openaiAuth !== "codex" &&
          !(await this.changeSettings(() => this.configEditor!.prepareSubscriptionModel(this.modelId), () => `Verified subscription model ${this.modelId} for this session.`))) return false;
      } catch (error) {
        this.fail(redactSecrets(error instanceof Error ? error.message : String(error), this.secrets).slice(0, 500));
        return false;
      }
    }
    if (selection === "show") { this.notice(this.describeThinking()); return true; }
    let applied: boolean;
    if (selection === "reset") {
      applied = await this.changeSettings(() => this.configEditor!.prepare({ scope: "session", key: "thinking", value: this.codexThinkingSelected() ? null : undefined }), () => `Thinking reset. ${this.describeThinking()}.`);
    }
    else applied = await this.changeSettings(() => this.configEditor!.prepare({ scope: "session", key: "thinking", value: selection }), () => `Thinking ${selection}. ${this.describeThinking()}.`, undefined, true);
    if (applied) await this.emitModelActivated({ provider: this.provider, modelId: this.modelId, authRoute: this.model?.provider === "codex-subscription" ? "codex" : this.provider === "openai" ? "api-key" : "provider" });
    return applied;
  }

  /** Requested and effective reasoning with provider/model for truthful display. */
  describeThinking(): string {
    const requested = this.configEditor?.settings.thinking ?? this.thinking;
    const effective = this.configEditor?.settings.effectiveThinking ?? (requested as never);
    const origin = this.configEditor?.origins.thinking;
    const capability = this.codexThinkingSelected() ? this.configEditor?.settings : undefined;
    if (capability?.supportedThinking !== undefined) {
      const supported = capability.supportedThinking.join("/") || "none advertised";
      const defaultLevel = capability.defaultThinking ?? "unspecified";
      return requested === undefined
        ? `Thinking: provider default (${defaultLevel}; no explicit control sent). Supported: ${supported} with ${this.provider}/${this.modelId}`
        : `Thinking: ${requested}${origin ? ` [${origin}]` : ""} (supported: ${supported}; provider default: ${defaultLevel}) with ${this.provider}/${this.modelId}`;
    }
    if (this.codexThinkingSelected()) {
      return `Thinking: ${requested ?? "unset"} (subscription capability not yet verified; open /model) with ${this.provider}/${this.modelId}`;
    }
    const effectiveDesc = describeEffectiveThinking(this.provider, (effective ?? requested) as never, this.modelId);
    if (requested === undefined) {
      return `Thinking: unset (effective: ${effectiveDesc}) with ${this.provider}/${this.modelId}`;
    }
    return `Thinking: ${requested}${origin ? ` [${origin}]` : ""} (effective: ${effectiveDesc}) with ${this.provider}/${this.modelId}`;
  }

  /** Open bounded preferences without changing the composer or any configuration layer. */
  openPreferences(): boolean {
    if (this.running || this.disposed || !this.configEditor) return false;
    this.closeModelPicker();
    this.preferences = { scope: "session", selectedIndex: 0, choiceIndex: 0, rows: preferenceRows(this.configEditor, "session", this.secrets) };
    return true;
  }

  /** Cancel a pending preview or close preferences without committing it. */
  closePreferences(): void {
    this.preferenceGeneration++;
    if (this.running) this.cancel();
    this.preferenceTransaction = undefined;
    if (this.preferences?.preview) this.preferences.preview = undefined;
    else this.preferences = undefined;
  }

  /** Move a bounded preference, value or explicit persistence scope and discard stale previews. */
  movePreference(delta: number, kind: "row" | "choice" | "scope" = "row"): void {
    const panel = this.preferences;
    if (!panel || this.running || !this.configEditor) return;
    this.preferenceGeneration++;
    this.preferenceTransaction = undefined; panel.preview = undefined; panel.error = undefined;
    const wrap = (index: number, count: number) => (index + delta + count) % count;
    if (kind === "scope") {
      const scopes = Object.keys(PREFERENCE_SCOPES) as PreferencesSnapshot["scope"][];
      panel.scope = scopes[wrap(scopes.indexOf(panel.scope), scopes.length)]!;
      panel.rows = preferenceRows(this.configEditor, panel.scope, this.secrets);
      panel.selectedIndex = 0; panel.choiceIndex = 0;
    } else if (kind === "row") {
      panel.selectedIndex = wrap(panel.selectedIndex, panel.rows.length); panel.choiceIndex = 0;
    } else panel.choiceIndex = wrap(panel.choiceIndex, panel.rows[panel.selectedIndex]!.choices.length);
  }

  /** Stage the selected action for confirmation, then apply that exact validated transaction atomically. */
  async selectPreference(): Promise<boolean> {
    const panel = this.preferences;
    if (!panel || this.running || !this.configEditor || !this.stageSettings) return false;
    const row = panel.rows[panel.selectedIndex]!;
    const choice = row.choices[panel.choiceIndex];
    if (panel.scope !== "memory" && typeof choice === "string" && choice.startsWith("open model")) {
      this.preferences = undefined;
      this.notice("Model + route picker activates and remembers a successful choice for this workspace; it does not write user or project config.");
      return this.openModelPicker();
    }
    if (this.preferenceTransaction && panel.preview) {
      const transaction = this.preferenceTransaction;
      const message = panel.preview.replace("Enter confirms; Esc cancels.", "Applied.");
      const applied = await this.changeSettings(async () => transaction, () => message, undefined, true);
      if (this.preferences === panel) {
        if (applied) { panel.preview = undefined; this.preferenceTransaction = undefined; panel.rows = preferenceRows(this.configEditor, panel.scope, this.secrets); }
        else panel.error = `Not applied: ${this.settingsFailure ?? "previous settings retained"} Change selection to stage again, or Esc to cancel.`;
      }
      return applied;
    }
    const generation = ++this.preferenceGeneration;
    const abort = new AbortController();
    this.activeAbort = abort; this.status = "running";
    const task = (async () => {
      try {
        let transaction: ConfigTransaction;
        if (panel.scope === "memory") {
          const settings = this.configEditor!.settings;
          if (panel.choiceIndex === 0 && !this.model) throw new Error("Activate a model successfully before remembering its choice.");
          const choice = panel.choiceIndex === 0 ? { provider: settings.provider, model: settings.model,
            ...(settings.provider === "openai" ? { openaiAuth: this.model?.provider === "codex-subscription" ? "codex" as const : "api-key" as const } : {}),
            ...(settings.profile ? { profile: settings.profile } : {}), ...(settings.thinking ? { thinking: settings.thinking } : {}) } : undefined;
          transaction = await this.configEditor!.prepareMemory(choice);
        } else transaction = await this.configEditor!.prepare({ scope: panel.scope, key: row.key, value: row.key === "git" && choice !== undefined ? { changeTracking: choice } : choice });
        abort.signal.throwIfAborted();
        const staged = await this.stageSettings!(transaction.settings, abort.signal, this.workspace, this.model, true);
        abort.signal.throwIfAborted();
        if (!staged.model) throw new Error("The selected model is unavailable; previous settings remain active.");
        if (this.disposed || this.preferences !== panel || generation !== this.preferenceGeneration) return false;
        this.preferenceTransaction = transaction;
        const origin = transaction.origins[row.key as keyof ConfigLayer] ?? transaction.origins.model;
        const effective = panel.scope === "memory" ? `${transaction.settings.provider}/${transaction.settings.model} (${transaction.settings.openaiAuth ?? transaction.settings.auth}); thinking ${transaction.settings.thinking ?? "default"}` : row.key === "git" ? transaction.settings.gitChangeTracking : transaction.settings[row.key as keyof ResolvedSettings];
        const expectedOrigin = { session: "current-session override", memory: "interactive memory", user: "user-global", project: "project" }[panel.scope];
        const shadowing = (panel.scope === "memory" ? panel.choiceIndex === 0 : choice !== undefined) && expectedOrigin !== origin ? ` Saved but not effective: shadowed by ${origin}.` : "";
        panel.preview = redactSecrets(`${PREFERENCE_SCOPES[panel.scope]} ${row.key}: ${choice === undefined ? "reset override" : String(choice)}. Effective after save: ${displaySetting(row.key, effective)} [${origin}].${shadowing} Enter confirms; Esc cancels.`, this.secrets);
        panel.error = undefined;
        return true;
      } catch (error) {
        if (this.preferences === panel) panel.error = abort.signal.aborted ? "Cancelled; nothing changed." : redactSecrets(error instanceof Error ? error.message : String(error), this.secrets);
        return false;
      } finally { if (this.activeAbort === abort) this.activeAbort = undefined; this.status = "idle"; }
    })();
    const tracked = task.then(() => {}); this.activeTurn = tracked;
    try { return await task; } finally { if (this.activeTurn === tracked) this.activeTurn = undefined; }
  }

  /** Inspect settings or apply one validated session or explicitly scoped persisted edit. */
  async configCommand(args: string): Promise<boolean> {
    if (args.trim() === "show") { this.notice(this.describeConfig()); return true; }
    if (!args.trim()) { if (this.configEditor) return this.openPreferences(); this.notice(this.describeConfig()); return true; }
    if (this.running) { this.notice("Busy: settings edits require an idle session. Press Esc to cancel first."); return false; }
    const scoped = args.trim().match(/\s+--scope\s+(\S+)$/);
    const scopeValue = scoped?.[1];
    if (scopeValue && !["user", "project", "session"].includes(scopeValue)) { this.fail("Config scope must be user, project or session."); return false; }
    const command = scoped ? args.trim().slice(0, scoped.index) : args.trim();
    const match = command.match(/^(set|reset)\s+(\S+)(?:\s+([\s\S]+))?$/);
    if (!match) { this.fail("Usage: /config set <key> <value> [--scope user|project] or /config reset <key> [--scope user|project]."); return false; }
    const [, action, key, raw] = match;
    if ((action === "set" && !raw?.trim()) || (action === "reset" && raw?.trim()) || raw?.includes("--scope")) { this.fail("Usage: /config set <key> <value> or /config reset <key>, optionally followed by --scope user|project."); return false; }
    const scope = (scopeValue ?? "session") as ConfigScope;
    let value: unknown = raw;
    if (action === "reset") value = undefined;
    else if (["maxTurns", "maxConcurrentTools", "contextWindow", "maxOutput"].includes(key!)) value = Number(raw);
    else if (key === "git" && raw?.trim()) { try { value = JSON.parse(raw); } catch { this.fail('Invalid git value. Use JSON like {"changeTracking":"snapshot"}.'); return false; } }
    else if (raw?.startsWith('"')) { try { value = JSON.parse(raw); } catch { this.fail("Invalid quoted config value."); return false; } }
    return this.changeSettings(() => this.configEditor!.prepare({ scope, key: key!, value }), () => {
      const origin = this.configEditor!.origins[key as keyof ConfigLayer];
      const effective = key === "git" ? this.configEditor!.settings.gitChangeTracking : this.configEditor!.settings[key as keyof ResolvedSettings];
      const saved = action === "reset" ? "removed override" : `saved ${displaySetting(key!, value)}`;
      const source = scope === "session" ? "current-session override" : scope === "user" ? "user-global" : "project";
      const providerSource = key === "model" ? this.configEditor!.modelFallbackSource : undefined;
      const shadowingSource = providerSource ? `${providerSource} provider selection` : origin;
      const shadowed = action === "set" && source !== origin ? `; shadowed by ${shadowingSource}`
        : action === "reset" && providerSource ? `; ${providerSource} provider selection uses its default model` : "";
      return `${key} (${scope}): ${saved}. Effective: ${displaySetting(key!, effective)} [${origin}]${shadowed}.`;
    });
  }

  private async changeSettings(prepare: () => Promise<ConfigTransaction>, message: () => string, failureMessage?: string, activate = false): Promise<boolean> {
    if (this.disposed) return false;
    if (this.running) { this.notice("Busy: settings edits require an idle session. Press Esc to cancel first."); return false; }
    if (!this.configEditor || !this.stageSettings) { this.fail("Interactive settings are unavailable in this session."); return false; }
    this.settingsFailure = undefined;
    const abort = new AbortController();
    this.activeAbort = abort;
    this.status = "running";
    const task = (async () => {
      try {
        const transaction = await prepare();
        abort.signal.throwIfAborted();
        const staged = await this.stageSettings!(transaction.settings, abort.signal, this.workspace, this.model, activate);
        abort.signal.throwIfAborted();
        if (activate && !staged.model) throw new Error("The selected provider is unavailable. Configure access with /login or choose another model.");
        if (this.disposed || this.activeAbort !== abort) return false;
        await transaction.commit(abort.signal);
        // Once the transaction commits, publish the matching runtime even if cancellation arrives at that boundary.
        this.publishSettings(transaction.settings, staged);
        this.closeModelPicker();
        this.status = "idle";
        this.notice(redactSecrets(message(), this.secrets));
        return true;
      } catch (error) {
        this.settingsFailure = abort.signal.aborted ? "Settings change cancelled. Previous settings remain active." : failureMessage ?? redactSecrets(error instanceof Error ? error.message : String(error), this.secrets);
        if (abort.signal.aborted) { this.notice("Settings change cancelled. Previous settings remain active."); this.status = "idle"; }
        else this.fail(failureMessage ?? redactSecrets(error instanceof Error ? error.message : String(error), this.secrets));
        return false;
      }
    })();
    const tracked = task.then(() => {});
    this.activeTurn = tracked;
    try { return await task; } finally {
      if (this.activeAbort === abort) this.activeAbort = undefined;
      if (this.activeTurn === tracked) this.activeTurn = undefined;
    }
  }

  private publishSettings(next: ResolvedSettings, staged: { model?: Model; contextManager: ContextManager }): void {
    this.model = staged.model;
    this.contextManager.clearActiveSkill();
    this.contextManager = staged.contextManager;
    this.provider = next.provider; this.modelId = next.model;
    this.maxTurns = next.maxTurns; this.maxConcurrentTools = next.maxConcurrentTools;
    this.explicitContextWindow = next.explicitContextWindow; this.explicitMaxOutput = next.explicitMaxOutput;
    this.baseUrl = next.baseUrl; this.auth = next.auth; this.openaiAuth = next.openaiAuth; this.profile = next.profile;
    this.thinking = next.thinking;
    this.subscriptionReactivationRequired = false;
    if (next.openaiAuth !== "codex" || staged.model?.provider === "codex-subscription") this.subscriptionPending = false;
    this.onSettingsCommitted?.(next, staged.contextManager);
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

  /** Render effective settings with active profile for `/config`, masking secrets and sanitizing URLs. */
  describeConfig(): string {
    const budgets = this.effectiveBudgets();
    const activeProfile = this.configEditor?.settings.profile ?? this.profile;
    const lines = [
      ...(activeProfile !== undefined ? [`Profile: ${activeProfile}`] : []),
      `Provider: ${this.provider}`,
      `Model: ${this.modelId}`,
      `Context window: ${budgets.contextWindow}`,
      `Max output: ${budgets.maxOutput}`,
    ];
    if (this.configEditor) {
      const settings = this.configEditor.settings;
      const origins = this.configEditor.origins;
      lines.splice(0, lines.length, ...EDITABLE_CONFIG_KEYS.filter(key => (settings as unknown as Record<string, unknown>)[key] !== undefined).map(key => {
        if (key === "thinking") {
          const requested = (settings as unknown as Record<string, unknown>)[key];
          const effective = this.codexThinkingSelected() ? this.describeThinking() : describeEffectiveThinking(this.provider, requested as never, settings.model);
          return `${key}: ${displaySetting(key, requested)} [${origins[key as keyof ConfigLayer]}] (effective: ${effective})`;
        }
        return `${key}: ${displaySetting(key, (settings as unknown as Record<string, unknown>)[key])} [${origins[key as keyof ConfigLayer]}${(key === "contextWindow" || key === "maxOutput") && origins[key as keyof ConfigLayer] !== "catalog" ? "; explicit limit" : ""}]`;
      }));
      const gitMode = settings.gitChangeTracking;
      const gitOrigin = origins.git !== undefined ? ` [${origins.git}]` : "";
      if (!lines.some((line) => line.startsWith("git:"))) {
        lines.push(`git: {"changeTracking":"${gitMode}"}${gitOrigin}`);
      }
      if (settings.thinking === undefined) {
        lines.push(`thinking: unset (effective: ${this.codexThinkingSelected() ? this.describeThinking() : describeEffectiveThinking(this.provider, undefined)})`);
      }
      if (settings.headers) lines.push(`headers: configured (values hidden) [${origins.headers}]`);
      if (settings.extraBody) lines.push(`extraBody: configured (values hidden) [${origins.extraBody}]`);
      if (settings.credentialEnv) lines.push(`credentialEnv: ${settings.credentialEnv} [profile "${settings.profile}"]`);
      if (settings.credentialIdentity) lines.push(`credentialIdentity: ${settings.credentialIdentity} [profile "${settings.profile}"]`);
    }
    if (!this.configEditor) {
      const thinking = this.thinking;
      lines.push(thinking !== undefined ? `Thinking: ${thinking} (effective: ${describeEffectiveThinking(this.provider, thinking as never, this.modelId)})` : `Thinking: unset (effective: ${describeEffectiveThinking(this.provider, undefined)})`);
      lines.push(`git: {"changeTracking":"${this.gitChangeTracking()}"}`);
    }
    if (!this.configEditor && this.maxTurns !== undefined) {
      lines.push(`Max turns: ${this.maxTurns}`);
    }
    if (!this.configEditor && this.maxConcurrentTools !== undefined) {
      lines.push(`Max concurrent tools: ${this.maxConcurrentTools}`);
    }
    if (!this.configEditor && this.provider === "openai-compatible") {
      if (this.baseUrl !== undefined) {
        lines.push(`Base URL: ${sanitizeBaseUrl(this.baseUrl)}`);
      }
      if (this.auth !== undefined) {
        lines.push(`Auth: ${this.auth}`);
      }
    }
    lines.push(`Session: ${this.sessionId}`);
    lines.push(`Branch: ${this.session.activeBranchId}`);
    if (this.workspace) {
      lines.push(`Workspace root: ${this.workspace.root}`, `Launch directory: ${this.workspace.launchCwd}`);
      lines.push(`Attached roots: ${this.workspace.extraRoots.join(", ") || "none"}`);
      const unavailable = this.session.metadata.extraRoots.filter(root => !this.workspace!.extraRoots.includes(root));
      if (unavailable.length) lines.push(`Unavailable saved roots: ${unavailable.join(", ")}`);
    }
    lines.push("Edits apply to this session only by default. Use --scope user or --scope project to save; /config reset removes that scope's override.");
    return redactSecrets(lines.join("\n"), this.secrets);
  }

  /** Start manual compaction after model checks and notify acceptance before it settles. */
  async compact(accepted: () => void = () => {}): Promise<boolean> {
    if (this.running) {
      this.notice("Already running. Press Esc to cancel first.");
      return false;
    }
    if (!this.model) {
      this.fail(
        "Missing credentials. Use /login <provider> to save an API key, or set the provider API-key environment variable and restart schway.",
      );
      return false;
    }
    this.transcript.push(this.systemEntry("Compacting…"));
    this.status = "running";
    const operationId = this.beginActivity("compacting");
    const abort = new AbortController();
    this.activeAbort = abort;
    try { accepted(); } catch { /* Presentation cannot cancel an accepted compaction. */ }
    this.observeRuntimeEvent({ type: "compaction.started", reason: "manual" });
    const task = this.contextManager.compact(this.session, this.model, {
      reason: "manual",
      signal: abort.signal,
    });
    const tracked = task.then(
      () => undefined,
      () => undefined,
    );
    this.activeTurn = tracked;
    let record: Awaited<typeof task>;
    try {
      record = await task;
      if (this.activeAbort === abort) {
        this.observeRuntimeEvent(record && !abort.signal.aborted
          ? { type: "compaction.finished", reason: "manual", status: "completed", recordId: record.id, firstKeptId: record.firstKeptId }
          : { type: "compaction.finished", reason: "manual", status: "noop" });
      }
    } catch (error) {
      if (this.activeAbort === abort) this.observeRuntimeEvent({ type: "compaction.finished", reason: "manual", status: "failed" });
      throw error;
    } finally {
      for (const entry of this.contextManager.takeUsage()) {
        this.observeRuntimeEvent({ type: "model.usage", phase: "compaction", ...entry });
      }
      if (this.activeAbort === abort) {
        this.activeAbort = undefined;
      }
      if (this.activeTurn === tracked) {
        this.activeTurn = undefined;
      }
      this.settleActivity(operationId);
    }
    this.invalidateBranchTreeCache();
    if (abort.signal.aborted) {
      this.transcript.push(this.systemEntry("Cancelled."));
      this.status = "idle";
      return false;
    }
    if (record) {
      this.transcript.push(this.systemEntry("Context compacted."));
      this.status = "idle";
      return true;
    }
    this.transcript.push(
      this.systemEntry(
        "Compaction did not produce a record. The conversation is unchanged; try again after more turns.",
      ),
    );
    this.status = "idle";
    return false;
  }

  /** Stage workspace capabilities and atomically switch sessions, preserving the current runtime on failure or cancellation. */
  async switchSession(session: Session, sessionId: string, options: { workspace: Workspace; contextManager: ContextManager }): Promise<boolean> {
    if (this.disposed) return false;
    if (this.running) {
      this.notice("Already running. Press Esc to cancel first.");
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
  private async stageSession(session: Session, sessionId: string, options: { workspace: Workspace; contextManager: ContextManager }, abort: AbortController): Promise<boolean> {
    let staged: { tools: ToolRegistry; runtime: ExtensionRuntime } | undefined;
    try {
      const editor = await this.configEditor?.forWorkspace(options.workspace.root);
      if (editor?.memoryActivationError) throw new Error(editor.memoryActivationError);
      let nextSettings = editor?.settings;
      const nextRuntime = nextSettings && this.stageSettings ? await this.stageSettings(nextSettings, abort.signal, options.workspace, this.model) : undefined;
      abort.signal.throwIfAborted();
      if (editor && nextRuntime?.modelCapability) {
        editor.setModelCapabilities([nextRuntime.modelCapability]);
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
          this.notice("Session switch cancelled. The previous session remains active.");
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
    this.invalidateBranchTreeCache();
    if (this.branchTreeOpen) {
      const head = this.activeHeadId() ?? this.session.rootId;
      if (this.branchTreeSelectedId === undefined) this.branchTreeSelectedId = head;
    }
    this.gitBaseline = undefined;
    this.gitAfter = undefined;
    this.gitComparison = undefined;
    this.gitSnapshotError = undefined;
  }

  /** Append a system line without touching session history. */
  notice(text: string): void {
    this.transcript.push(this.systemEntry(text));
  }

  /** Append an actionable error line and mark the status as error. */
  fail(text: string): void {
    this.transcript.push({
      id: this.nextId("err"),
      kind: "error",
      text,
    });
    this.status = "error";
  }

  /**
   * Signal cancellation of the active operation without waiting; idle calls do nothing.
   * Applies to both submitted turns and manual compaction.
   */
  cancel(): void {
    if (this.startupAbort) { this.startupAbort.abort(); return; }
    if (this.loginCallbackValue !== undefined) { this.loginCallbackValue = undefined; this.pickerReturn = undefined; this.recoveryRepair = false; this.notice("Callback entry cancelled; no credential was changed."); return; }
    if (this.codexLoginAbort) { this.loginChooserIndex = undefined; this.pickerReturn = undefined; this.recoveryRepair = false; this.codexLoginAbort.abort(); return; }
    if (this.loginChooserIndex !== undefined) { this.loginChooserIndex = undefined; this.recoveryRepair = false; return; }
    if (this.credentialMutation) { this.notice("Waiting for the OS credential operation to finish; it cannot be cancelled after submission."); return; }
    if (this.credentialEntry) {
      this.credentialEntry.cancel();
      this.credentialEntry = undefined;
      this.credentialTarget = undefined;
      this.pickerReturn = undefined;
      this.recoveryRepair = false;
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

  /**
   * Clear active cancellation state and abort the active operation without awaiting it.
   * Applies to both submitted turns and manual compaction during terminal cleanup.
   */
  dispose(): void {
    this.startupAbort?.abort();
    this.disposed = true;
    this.closeModelPicker();
    if (!this.credentialMutation) { this.credentialEntry?.cancel(); this.credentialEntry = undefined; this.credentialTarget = undefined; }
    this.abortActiveTurn();
    this.contextManager.clearActiveSkill();
    this.detachDiagnostics?.();
    this.extensions?.dispose();
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
      const category = this.subscriptionReactivationRequired ? "model" : this.startupRecoveryCategory;
      this.offerRecovery(category, false,
        startupRecoveryMessage(category), this.startupDiagnostic);
      return false;
    }
    const userEntry: TuiTranscriptEntry = {
      id: this.nextId("user"),
      kind: "user",
      text,
    };
    try {
      this.session.append({
        type: "user",
        id: crypto.randomUUID(),
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

  /** Show optional redacted diagnostics for the current failed operation. */
  inspectRecovery(): boolean {
    const recovery = this.currentRecovery();
    if (!recovery || !recovery.actions.includes("details")) return false;
    this.notice(`Failure details: ${this.recovery?.details ?? "No additional diagnostics are available."}`);
    return true;
  }

  private async startAcceptedTurn(accepted: () => void = () => {}): Promise<boolean> {
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
    }
    return true;
  }

  private async runTurn(signal: AbortSignal, operationId: number): Promise<void> {
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
        await this.captureTurnResult();
        this.status = "idle";
        this.offerRecovery("provider", true, "The saved turn was stopped. Completed results remain available; continue when ready.", undefined, operationId, false);
        return;
      }
      await this.captureTurnResult();
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
      await this.captureTurnResult();
    }
  }

  /** Deliver native or manual-compaction events without letting observers affect the conversation. */
  private observeRuntimeEvent(event: RuntimeEvent): void {
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
        case "compaction.started": activity.phase = "compacting"; break;
        case "compaction.finished": activity.phase = "preparing"; break;
      }
    } else if (activity && event.type === "tool.finished") {
      activity.activeTools.delete(event.toolCallId);
    }
    switch (event.type) {
      case "agent.started":
        return;
      case "model.started": {
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
        const entry = this.toolEntryByCallId.get(event.toolCallId);
        const display = formatToolFinishedText(
          event.name,
          event.content,
          event.details,
          event.status,
        );
        const text = event.status === "error" ? `${display}\nTool failed. Inspect this result before continuing.` : display;
        if (entry) {
          entry.text = text;
          entry.toolStatus =
            event.status === "success" ? "success" : event.status === "cancelled" ? "cancelled" : "error";
        } else {
          this.transcript.push({
            id: this.nextId("tool"),
            kind: "tool",
            text,
            toolName: event.name,
            toolCallId: event.toolCallId,
            toolStatus: event.status === "success" ? "success" : event.status === "cancelled" ? "cancelled" : "error",
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
              : "Context pressure. Compacting…",
          ),
        );
        return;
      }
      case "compaction.finished": {
        if (event.status === "completed") {
          this.transcript.push(this.systemEntry("Context compacted."));
        } else {
          this.transcript.push(
            this.systemEntry(
              `Compaction ${event.status}: ${event.message ?? "no summary produced"}`,
            ),
          );
        }
        return;
      }
      case "error": {
        this.markProvisionalIncomplete();
        this.clearRetryNotice();
        if (event.origin === "harness" && event.category !== "session-write") {
          this.fail(redactSecrets(event.message, this.secrets));
        } else {
          this.offerRecovery(event.category ?? "provider", true,
            recoveryMessage(event.category ?? "provider"), event.message, operationId);
        }
        return;
      }
      case "agent.finished": {
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

  private currentAssistant(): TuiTranscriptEntry {
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
  private markProvisionalIncomplete(): void {
    const entry = this.transcript.find(item => item.id === this.currentAssistantId);
    if (entry?.text) entry.incomplete = true;
  }

  /** Remove an abandoned stream preview before the next model attempt begins. */
  private discardProvisionalAssistant(): void {
    if (!this.currentAssistantId) return;
    const index = this.transcript.findIndex(item => item.id === this.currentAssistantId);
    if (index >= 0) this.transcript.splice(index, 1);
    this.currentAssistantId = undefined;
  }

  /** Reuse one transient retry row for all attempts in a model turn. */
  private showRetryNotice(text: string): void {
    const entry = this.transcript.find(item => item.id === this.retryNoticeId);
    if (entry) { entry.text = text; return; }
    const next = this.systemEntry(text);
    this.retryNoticeId = next.id;
    this.transcript.push(next);
  }

  /** Clear transient retry status once the turn settles. */
  private clearRetryNotice(): void {
    if (!this.retryNoticeId) return;
    const index = this.transcript.findIndex(item => item.id === this.retryNoticeId);
    if (index >= 0) this.transcript.splice(index, 1);
    this.retryNoticeId = undefined;
  }

  private systemEntry(text: string): TuiTranscriptEntry {
    return { id: this.nextId("sys"), kind: "system", text };
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }

  private currentRecovery(): TuiRecovery | undefined {
    const recovery = this.recovery;
    if (recovery && this.recoveryRepair && this.recoveryIdentityChanged(recovery) && this.model &&
      !this.modelPicker && this.loginChooserIndex === undefined && !this.credentialMutation) {
      recovery.model = this.model;
      recovery.provider = this.provider;
      recovery.modelId = this.modelId;
      recovery.profile = this.profile;
      recovery.openaiAuth = this.openaiAuth;
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
      provider: _provider, modelId: _modelId, profile: _profile, openaiAuth: _openaiAuth, ...publicRecovery } = recovery;
    return publicRecovery;
  }

  private recoveryIdentityChanged(recovery: NonNullable<typeof this.recovery>): boolean {
    return recovery.model !== this.model || recovery.provider !== this.provider || recovery.modelId !== this.modelId ||
      recovery.profile !== this.profile || recovery.openaiAuth !== this.openaiAuth;
  }

  private offerRecovery(category: TuiRecovery["category"], accepted: boolean, message: string, details?: string, operationId = this.operationSequence, markError = true): void {
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
      provider: this.provider, modelId: this.modelId, profile: this.profile, openaiAuth: this.openaiAuth };
  }

  /** Label completed effects whose result could not be found after their latest durable call. */
  private markUnsavedToolResults(): void {
    const items = this.session.items;
    for (const [callId, entry] of this.toolEntryByCallId) {
      const callIndex = items.findLastIndex(item => item.type === "assistant" &&
        item.content.some(block => block.type === "tool_call" && block.id === callId));
      if (callIndex < 0 || items.slice(callIndex + 1).some(item => item.type === "tool_result" && item.toolCallId === callId)) continue;
      entry.text = `${boundDisplay(entry.text, MAX_TOOL_DISPLAY_CHARS - 90)}\nThis tool may have completed, but its result was not saved to the session.`;
    }
  }

  private abortActiveTurn(): void {
    const abort = this.activeAbort;
    this.activeAbort = undefined;
    if (abort) {
      abort.abort();
    }
  }
}

/** Rebuild bounded display history without replaying tools, pairing results chronologically within each accepted call group. */
export function buildTranscriptFromSession(items: readonly SessionRecord[]): TuiTranscriptEntry[] {
  const transcript: TuiTranscriptEntry[] = [];
  const pending = new Map<string, TuiTranscriptEntry>();
  let counter = 0;
  const nextId = (prefix: string): string => {
    counter += 1;
    return `hist-${prefix}-${counter}`;
  };
  for (const item of items) {
    if (item.type === "user") {
      const text = item.content.map((block) => block.text).join("");
      if (text.length > 0) {
        transcript.push({ id: nextId("user"), kind: "user", text });
      }
    } else if (item.type === "assistant") {
      const textParts: string[] = [];
      for (const block of item.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "thinking") {
          // Thinking is runtime context, not resumed display history.
        } else if (block.type === "tool_call") {
          const entry: TuiTranscriptEntry = {
            id: nextId("tool"),
            kind: "tool",
            text: "Tool call interrupted before a result was persisted",
            toolName: block.name,
            toolCallId: block.id,
            toolStatus: "cancelled",
            toolSummary: toolTarget(block.name, block.arguments),
          };
          pending.set(block.id, entry);
          transcript.push(entry);
        }
      }
      const text = textParts.join("");
      if (text.length > 0) {
        transcript.push({ id: nextId("asst"), kind: "assistant", text });
      }
    } else if (item.type === "tool_result") {
      const entry = pending.get(item.toolCallId);
      if (entry) {
        entry.text = boundDisplay(item.content);
        entry.toolStatus = item.isError ? "error" : "success";
        pending.delete(item.toolCallId);
      }
    } else if (item.type === "compaction") {
      transcript.push({
        id: nextId("sys"),
        kind: "system",
        text: `Context compacted: ${boundDisplay(item.summary, 500)}`,
      });
    }
  }
  return transcript;
}

/** Bound displayed tool output so one result cannot flood the terminal. */
export function boundDisplay(text: string, limit: number = MAX_TOOL_DISPLAY_CHARS): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n… truncated. Full output is in the session file.`;
}

/** Remove userinfo, query, and fragment from a displayed URL, or return `configured` if parsing fails. */
export function sanitizeBaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "configured";
  }
}

/** One structured replacement from a successful edit, kept out of model content. */
export interface EditHunkDisplay {
  startLine: number;
  oldText: string;
  newText: string;
}

/** Structured edit extras attached to tool.finished runtime events. */
export interface EditDetailsDisplay {
  path: string;
  hunks?: EditHunkDisplay[];
}

/** Render tool completion from structured details while model content stays bounded. */
export function formatToolFinishedText(
  name: string,
  content: string,
  details: unknown,
  status: "success" | "error" | "cancelled",
): string {
  if (status === "cancelled") {
    return boundDisplay(content);
  }
  if (name === "edit") {
    const edit = asEditDetails(details);
    if (edit && status === "success" && edit.hunks && edit.hunks.length > 0) {
      return boundDisplay(formatEditDiff(edit.path, edit.hunks, content));
    }
    if (edit && status === "error") {
      return boundDisplay(`Edit failed for ${edit.path}: ${content}`);
    }
    if (status === "error") {
      return boundDisplay(`Edit failed: ${content}`);
    }
  }
  return boundDisplay(content);
}

/** Format applied edit hunks as a bounded unified-style diff for the transcript. */
export function formatEditDiff(path: string, hunks: readonly EditHunkDisplay[], summary: string): string {
  const lines = [summary];
  const shown = hunks.slice(0, 8);
  for (const hunk of shown) {
    lines.push(`--- ${path}:${hunk.startLine}`);
    for (const line of hunk.oldText.split("\n").slice(0, 12)) {
      lines.push(`- ${line}`.slice(0, 300));
    }
    for (const line of hunk.newText.split("\n").slice(0, 12)) {
      lines.push(`+ ${line}`.slice(0, 300));
    }
  }
  if (hunks.length > shown.length) {
    lines.push(`… ${hunks.length - shown.length} more replacements. Full diff is in the session file.`);
  }
  return lines.join("\n");
}

/** Narrow unknown tool details to the edit shape without coupling to tool internals. */
function asEditDetails(details: unknown): EditDetailsDisplay | undefined {
  if (typeof details !== "object" || details === null || Array.isArray(details)) {
    return undefined;
  }
  const record = details as Record<string, unknown>;
  if (typeof record.path !== "string") {
    return undefined;
  }
  if (record.hunks === undefined) {
    return { path: record.path };
  }
  if (!Array.isArray(record.hunks)) {
    return undefined;
  }
  const hunks: EditHunkDisplay[] = [];
  for (const hunk of record.hunks) {
    if (typeof hunk !== "object" || hunk === null || Array.isArray(hunk)) {
      return undefined;
    }
    const entry = hunk as Record<string, unknown>;
    if (
      typeof entry.startLine !== "number" ||
      typeof entry.oldText !== "string" ||
      typeof entry.newText !== "string"
    ) {
      return undefined;
    }
    hunks.push({ startLine: entry.startLine, oldText: entry.oldText, newText: entry.newText });
  }
  return { path: record.path, hunks };
}

/** Plain-language recovery guidance never includes provider diagnostic text. */
function recoveryMessage(category: TuiRecovery["category"]): string {
  switch (category) {
    case "auth": return "The selected provider rejected its sign-in. Connect again, then continue this saved turn. Completed results remain available.";
    case "credential-store": return "Credential storage is locked or unavailable. Restore OS secure-store access, then retry credential access. Saved task progress remains available.";
    case "model": return "The selected model is unavailable. Choose a model, then continue this saved turn. Completed results remain available.";
    case "offline": return "The provider connection timed out or is offline. Check the connection, then continue this saved turn.";
    case "rate-limit": return "The provider rate limit is still exhausted after retries. Wait for access, then continue this saved turn.";
    case "session-write": return "Could not save progress to this session. Further tool execution stopped. Inspect the visible output and repair storage before starting new work.";
    case "tool": return "A tool failed. Inspect its result before deciding how to proceed; completed effects remain in this session.";
    default: return "The provider could not finish this step. Inspect details or continue this session when ready.";
  }
}

/** Classify startup adapter failures before showing any provider or OS diagnostic text. */
function startupFailureCategory(message: string): "auth" | "credential-store" | "model" | "provider" {
  if (/Cannot (read|save|delete) credential in the OS secure store|secure store|Secret Service|libsecret/i.test(message)) return "credential-store";
  if (/\b(model|deployment)\b.*\b(unavailable|no longer available|not available|not found|unknown|invalid)|\b(unavailable|unknown|invalid)\s+model\b/i.test(message)) return "model";
  if (/missing.*(api key|credential)|no .*login found|unauthorized|authentication required/i.test(message)) return "auth";
  return "provider";
}

/** Explain a startup failure while keeping its diagnostic out of the primary row. */
function startupRecoveryMessage(category: "auth" | "credential-store" | "model" | "provider"): string {
  switch (category) {
    case "auth": return "Missing credentials. Use /login or connect to the selected provider. Your draft is still in the editor.";
    case "credential-store": return "Credential storage is locked or unavailable. Restore OS secure-store access, then retry credential access. Your draft is still in the editor.";
    case "model": return "The selected model is unavailable. Choose an available model; your draft is still in the editor.";
    case "provider": return "The selected provider could not be loaded. Inspect details and repair its settings; your draft is still in the editor.";
  }
}

/** Bound and mask provider diagnostics before optional display. */
function redactRecoveryDetails(message: string, secrets: readonly string[]): string {
  return redactSecrets(message, secrets)
    .split(/\r?\n/)
    .map(line => /\b(?:payload|body|data)\b["']?\s*[:=]/i.test(line) ? "[provider payload redacted]" : line)
    .join("\n")
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 ***")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[opusr]_[A-Za-z0-9_]{8,})\b/g, "***")
    .replace(/\b(authorization|x-api-key|api-key|api_key|access_token|refresh_token|client_secret|password|session_token|secret|token)\s*[:=]\s*[^\s,;]+/gi, "$1: ***")
    .slice(0, 2000);
}

/** Render one resolved setting with secrets masked and structured values summarized. */
function displaySetting(key: string, value: unknown): string {
  if (key === "baseUrl" && typeof value === "string") return sanitizeBaseUrl(value);
  if (key === "git" && typeof value === "object" && value !== null) return JSON.stringify(value);
  return value === undefined ? "unset" : String(value);
}
