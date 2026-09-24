import { runAgentLoop } from "../agent/loop.ts";
import type { RuntimeEvent } from "../agent/events.ts";
import { MaskedCredentialEntry, removeStoredCredential } from "../auth/management.ts";
import { credentialIdentity, type CredentialIdentity, type CredentialStore, type CredentialTarget } from "../auth/store.ts";
import { credentialEnvironmentVariable } from "../auth/credentials.ts";
import { redactSecrets } from "../auth/secrets.ts";
import type { ContextManager } from "../context/manager.ts";
import type { SessionRecord } from "../conversation/types.ts";
import { lookupModel } from "../model/catalog.ts";
import type { Model } from "../model/model.ts";
import type { Session } from "../session/session.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { addWorkspaceRoots, type Workspace } from "../workspace/workspace.ts";
import type { ExtensionRuntime } from "../extensions/host.ts";
import { discoverSkills } from "../skills/skills.ts";
import type { ConfigLayer, ResolvedSettings } from "../config/config.ts";
import { DEFAULT_GIT_CHANGE_TRACKING, describeEffectiveThinking, type GitChangeTrackingMode } from "../config/config.ts";
import { EDITABLE_CONFIG_KEYS, type ConfigEditor, type ConfigScope, type ConfigTransaction } from "../config/editing.ts";
import { parseModelArgs, parseThinkingArgs } from "./commands.ts";
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
import { modelPickerEntries, type ModelPickerSnapshot } from "./model-picker.ts";

/** Visible turn state for the status bar. Error persists until the next submit. */
export type TuiStatus = "idle" | "running" | "error";

/** Tool execution state shown in the transcript. */
export type TuiToolStatus = "running" | "success" | "error" | "cancelled";

/** One renderable row in the TUI transcript. */
export interface TuiTranscriptEntry {
  id: string;
  kind: "user" | "assistant" | "tool" | "system" | "error";
  text: string;
  toolName?: string;
  toolCallId?: string;
  toolStatus?: TuiToolStatus;
}

/** Renderable controller state with a readonly transcript array; entries are not guaranteed to be deep copies. */
export interface TuiSnapshot {
  status: TuiStatus;
  transcript: readonly TuiTranscriptEntry[];
  sessionId: string;
  branchId: string;
  provider: string;
  modelId: string;
  /** Active named compatible profile, when a selection is live. */
  profile?: string;
  /** Requested thinking level shown with provider/model; undefined leaves provider defaults untouched. */
  thinking?: string;
  /** Effective reasoning description shown alongside the requested value. */
  effectiveThinking?: string;
  modelPicker?: ModelPickerSnapshot;
  credentialEntry?: ReturnType<MaskedCredentialEntry["snapshot"]>;
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
    reload: () => Promise<{ model: Model } | { error: string }>;
  };
  /** Construct the next adapter and matching context budget before committing any edit. */
  stageSettings?: (settings: ResolvedSettings, signal: AbortSignal, workspace?: Workspace, currentModel?: Model) => Promise<{ model?: Model; contextManager: ContextManager }>;
  /** Publish renderer-owned context references after a successful settings commit. */
  onSettingsCommitted?: (settings: ResolvedSettings, manager: ContextManager) => void;
  /** Explicit change-tracking fallback when no config editor supplies effective settings. */
  changeTracking?: GitChangeTrackingMode;
}

/** Bound on displayed tool-result characters; session data stays complete. */
export const MAX_TOOL_DISPLAY_CHARS = 2000;

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
  private maxTurns?: number;
  private maxConcurrentTools?: number;
  private explicitContextWindow?: number;
  private explicitMaxOutput?: number;
  private baseUrl?: string;
  private auth?: string;
  private profile?: string;
  private thinking?: string;
  private configEditor?: ConfigEditor;
  private readonly stageSettings?: TuiControllerOptions["stageSettings"];
  private readonly onSettingsCommitted?: TuiControllerOptions["onSettingsCommitted"];
  private modelPicker?: ModelPickerSnapshot;
  private transcript: TuiTranscriptEntry[] = [];
  private status: TuiStatus = "idle";
  private activeAbort?: AbortController;
  private activeTurn?: Promise<void>;
  private counter = 0;
  private currentAssistantId?: string;
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
    this.maxTurns = options.maxTurns;
    this.maxConcurrentTools = options.maxConcurrentTools;
    this.explicitContextWindow = options.explicitContextWindow;
    this.explicitMaxOutput = options.explicitMaxOutput;
    this.baseUrl = options.baseUrl;
    this.auth = options.auth;
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
    this.loadWorkspaceExtensions = options.loadWorkspaceExtensions;
    this.detachDiagnostics = this.extensions?.attachDiagnostics((message) => this.notice(message));
    this.transcript = buildTranscriptFromSession(options.session.items);
    if (options.startupError) {
      this.transcript.push(this.systemEntry(options.startupError));
      this.status = "error";
    }
  }

  /** Return current state with a new transcript array, masking supplied known secrets in entry text. */
  snapshot(): TuiSnapshot {
    const thinking = this.configEditor?.settings.thinking ?? this.thinking;
    const effective = describeEffectiveThinking(this.provider, thinking as never, this.modelId);
    return {
      status: this.status,
      transcript: this.transcript.map((entry) =>
        this.secrets.length === 0
          ? entry
          : { ...entry, text: redactSecrets(entry.text, this.secrets) },
      ),
      sessionId: this.sessionId,
      branchId: this.session.activeBranchId,
      provider: this.provider,
      modelId: this.modelId,
      ...(this.profile !== undefined ? { profile: this.profile } : {}),
      ...(thinking !== undefined ? { thinking, effectiveThinking: effective } : {}),
      modelPicker: this.modelPicker ? structuredClone(this.modelPicker) : undefined,
      credentialEntry: this.credentialEntry?.snapshot(),
    };
  }

  /** True while a submitted turn or manual compaction owns the shared cancellation signal. */
  get running(): boolean {
    return this.activeAbort !== undefined || this.credentialEntry !== undefined || this.credentialMutation;
  }

  /** Start masked entry for one explicit provider only while the conversation is idle. */
  beginLogin(args: string): boolean {
    if (this.disposed || this.running) { this.notice("Busy: credential changes require an idle session."); return false; }
    const target = this.parseCredentialTarget(args);
    if (!target || !this.credentials) return false;
    let identity: CredentialIdentity;
    try { identity = credentialIdentity(target); }
    catch { this.fail("Select a valid compatible base URL before /login openai-compatible."); return false; }
    this.closeModelPicker();
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
      if (!result.ok) { this.status = "error"; return false; }
      const source = this.credentialOverrideNotice(target);
      if (source) this.notice(source);
      await this.refreshCredentialModel(credentialIdentity(target));
      return true;
    })();
    const tracked = task.then(() => {});
    this.activeTurn = tracked;
    try { return await task; } finally {
      this.credentialEntry = undefined;
      this.credentialTarget = undefined;
      this.credentialMutation = false;
      if (this.activeTurn === tracked) this.activeTurn = undefined;
    }
  }

  /** Remove exactly one provider's saved credential without altering runtime or environment overrides. */
  async logout(args: string): Promise<boolean> {
    if (this.disposed || this.running) { this.notice("Busy: credential changes require an idle session."); return false; }
    const target = this.parseCredentialTarget(args);
    if (!target || !this.credentials) return false;
    this.closeModelPicker();
    this.credentialMutation = true;
    const task = (async () => {
      const result = await removeStoredCredential({ ...target, ...this.credentials! });
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
      this.fail("Usage: /login <anthropic|openai|openai-compatible> or /logout <provider>. Enter keys only in the masked prompt.");
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
      this.status = "idle";
    } catch {
      this.fail("Credential storage changed, but the provider could not be refreshed. Retry /login or restart after checking provider settings.");
    }
  }

  /** List saved branch identities or change the selected ancestry while all controller work is idle. */
  branchCommand(args: string): boolean {
    const [action, id, ...label] = args.trim().split(/\s+/);
    if (action === "list" && id === undefined) {
      const branches = this.session.listBranches();
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
      this.fail("Usage: /branch list | /branch fork <entry-id> [name] | /branch switch <branch-id>. Branches do not undo file changes.");
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

  /** Capture a snapshot baseline immediately before a turn when snapshot mode is active. */
  private async captureTurnBaseline(): Promise<void> {
    this.gitSnapshotError = undefined;
    if (this.gitChangeTracking() !== "snapshot" || !this.workspace || this.disposed) {
      this.gitBaseline = undefined;
      this.gitAfter = undefined;
      this.gitComparison = undefined;
      return;
    }
    const snapshot = await captureGitSnapshot(this.workspace.root);
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

  /** Run an extension command only while idle, preserving normal loop ownership for any requested prompt. */
  async runExtensionCommand(name: string, args: string): Promise<boolean> {
    const command = this.extensions?.command(name);
    if (!command || this.disposed) return false;
    if (this.running) {
      this.notice(`Busy: /${name} was not run. Press Esc to cancel the active operation, then retry.`);
      return true;
    }
    const abort = new AbortController();
    this.activeAbort = abort;
    this.status = "running";
    const task = this.executeExtensionCommand(command, args, abort);
    this.activeTurn = task;
    try { await task; } finally {
      if (this.activeTurn === task) this.activeTurn = undefined;
    }
    return true;
  }

  private async executeExtensionCommand(
    command: { name: string; source: string; description: string }, args: string, abort: AbortController,
  ): Promise<void> {
    let prompt: string | undefined;
    let accepting = true;
    let succeeded = false;
    const current = () => this.activeAbort === abort && !this.disposed;
    try {
      if (this.workspace) {
        const skills = await discoverSkills({ workspaceRoot: this.workspace.root, extraRoots: this.workspace.extraRoots, home: this.home, signal: abort.signal });
        this.extensions!.assertNoSkillCollision(command, skills);
      }
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
  }

  /** Replace the adapter and displayed provider/model ids without changing session history. */
  setModel(model: Model | undefined, provider: string, modelId: string, profile?: string): void {
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
    this.modelPicker = { query: "", selectedIndex: 0, entries: [] };
    this.searchModels("");
    return true;
  }

  /** Filter catalog and profile choices with fallback budgets for typed ids. */
  searchModels(query: string): void {
    if (!this.modelPicker || this.running) return;
    this.modelPicker = { query, selectedIndex: 0, entries: modelPickerEntries(query, this.provider, this.modelId, { contextWindow: this.explicitContextWindow, maxOutput: this.explicitMaxOutput }, { profiles: this.configEditor?.profiles, activeProfile: this.configEditor?.settings.profile ?? this.profile }) };
  }

  /** Move the highlighted model with wraparound over the filtered choices. */
  moveModelPicker(delta: number): void {
    if (!this.modelPicker || this.running || !this.modelPicker.entries.length) return;
    const count = this.modelPicker.entries.length;
    this.modelPicker.selectedIndex = ((this.modelPicker.selectedIndex + delta) % count + count) % count;
  }

  /** Close the picker without changing the active model or settings. */
  closeModelPicker(): void { this.modelPicker = undefined; }

  /** Stage and commit the highlighted model or profile, leaving the picker open on failure. */
  async selectPickerModel(): Promise<boolean> {
    const selection = this.modelPicker?.entries[this.modelPicker.selectedIndex];
    if (!selection) return false;
    if (selection.profile !== undefined) {
      return this.selectProfile(selection.profile);
    }
    return this.selectModel(`${selection.provider}/${selection.modelId}`);
  }

  /** Switch the named compatible profile as one staged change, retaining previous on failure. */
  async selectProfile(name: string): Promise<boolean> {
    if (this.running) { this.notice("Busy: model selection requires an idle session."); return false; }
    const trimmed = name.trim();
    if (!trimmed) { this.fail("Usage: /model profile:<name>."); return false; }
    return this.changeSettings(() => this.configEditor!.prepareProfile(trimmed), () => {
      const active = this.configEditor!.settings.profile ?? trimmed;
      return `Switched to profile "${active}" (${this.provider}/${this.modelId}, ${this.effectiveBudgets().contextWindow} ctx, thinking ${this.describeThinking()}). Applies to this session only.`;
    });
  }

  /** Apply the textual model or profile form through the same atomic session settings path as the picker. */
  async selectModel(args: string): Promise<boolean> {
    if (this.running) { this.notice("Busy: model selection requires an idle session."); return false; }
    const selection = parseModelArgs(args, this.provider);
    if ("error" in selection) { this.fail(selection.error); return false; }
    if (selection.profile !== undefined) {
      return this.selectProfile(selection.profile);
    }
    return this.changeSettings(() => this.configEditor!.prepareModel(selection.provider, selection.modelId), () => `Switched to ${this.provider}/${this.modelId} (${this.effectiveBudgets().contextWindow} ctx, thinking ${this.describeThinking()}). Applies to this session only.`);
  }

  /** Show or switch the reasoning level for future requests without rewriting history. */
  async thinkingCommand(args: string): Promise<boolean> {
    const selection = parseThinkingArgs(args);
    if (typeof selection === "object") { this.fail(selection.error); return false; }
    if (selection === "show") { this.notice(this.describeThinking()); return true; }
    if (selection === "reset") {
      return this.changeSettings(() => this.configEditor!.prepare({ scope: "session", key: "thinking", value: undefined }), () => `Thinking reset. ${this.describeThinking()}. Applies to this session only.`);
    }
    return this.changeSettings(() => this.configEditor!.prepare({ scope: "session", key: "thinking", value: selection }), () => `Thinking ${selection}. ${this.describeThinking()}. Applies to this session only.`);
  }

  /** Requested and effective reasoning with provider/model for truthful display. */
  describeThinking(): string {
    const requested = this.configEditor?.settings.thinking ?? this.thinking;
    const effective = this.configEditor?.settings.effectiveThinking ?? (requested as never);
    const origin = this.configEditor?.origins.thinking;
    const effectiveDesc = describeEffectiveThinking(this.provider, (effective ?? requested) as never, this.modelId);
    if (requested === undefined) {
      return `Thinking: unset (effective: ${effectiveDesc}) with ${this.provider}/${this.modelId}`;
    }
    return `Thinking: ${requested}${origin ? ` [${origin}]` : ""} (effective: ${effectiveDesc}) with ${this.provider}/${this.modelId}`;
  }

  /** Inspect settings or apply one validated session or explicitly scoped persisted edit. */
  async configCommand(args: string): Promise<boolean> {
    if (!args.trim()) { this.notice(this.describeConfig()); return true; }
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

  private async changeSettings(prepare: () => Promise<ConfigTransaction>, message: () => string): Promise<boolean> {
    if (this.disposed) return false;
    if (this.running) { this.notice("Busy: settings edits require an idle session. Press Esc to cancel first."); return false; }
    if (!this.configEditor || !this.stageSettings) { this.fail("Interactive settings are unavailable in this session."); return false; }
    const abort = new AbortController();
    this.activeAbort = abort;
    this.status = "running";
    const task = (async () => {
      try {
        const transaction = await prepare();
        abort.signal.throwIfAborted();
        const staged = await this.stageSettings!(transaction.settings, abort.signal, this.workspace, this.model);
        abort.signal.throwIfAborted();
        if (this.disposed || this.activeAbort !== abort) return false;
        await transaction.commit(abort.signal);
        // Once the transaction commits, publish the matching runtime even if cancellation arrives at that boundary.
        this.publishSettings(transaction.settings, staged);
        this.modelPicker = undefined;
        this.status = "idle";
        this.notice(redactSecrets(message(), this.secrets));
        return true;
      } catch (error) {
        if (abort.signal.aborted) { this.notice("Settings change cancelled. Previous settings remain active."); this.status = "idle"; }
        else this.fail(redactSecrets(error instanceof Error ? error.message : String(error), this.secrets));
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
    this.baseUrl = next.baseUrl; this.auth = next.auth; this.profile = next.profile;
    this.thinking = next.thinking;
    this.onSettingsCommitted?.(next, staged.contextManager);
  }

  /** Effective context and output budgets for the current model with overrides. */
  effectiveBudgets(): { contextWindow: number; maxOutput: number } {
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
          const effective = describeEffectiveThinking(this.provider, requested as never, (settings as unknown as Record<string, unknown>).model as string | undefined ?? this.modelId);
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
        lines.push(`thinking: unset (effective: ${describeEffectiveThinking(this.provider, undefined)})`);
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

  /**
   * Return whether manual compaction created a record, or false when busy, unavailable, cancelled, or unchanged.
   * @throws Propagates rejection of the compaction promise after clearing its active operation tracking.
   */
  async compact(): Promise<boolean> {
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
    const abort = new AbortController();
    this.activeAbort = abort;
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
    } finally {
      if (this.activeAbort === abort) {
        this.activeAbort = undefined;
      }
      if (this.activeTurn === tracked) {
        this.activeTurn = undefined;
      }
    }
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
      const nextSettings = editor?.settings;
      const nextRuntime = nextSettings && this.stageSettings ? await this.stageSettings(nextSettings, abort.signal, options.workspace, this.model) : undefined;
      abort.signal.throwIfAborted();
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
    this.currentAssistantId = undefined;
    this.toolEntryByCallId.clear();
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
    if (this.credentialMutation) { this.notice("Waiting for the OS credential operation to finish; it cannot be cancelled after submission."); return; }
    if (this.credentialEntry) {
      this.credentialEntry.cancel();
      this.credentialEntry = undefined;
      this.credentialTarget = undefined;
      this.notice("Credential entry cancelled; nothing saved.");
      return;
    }
    this.activeAbort?.abort();
  }

  /**
   * Clear active cancellation state and abort the active operation without awaiting it.
   * Applies to both submitted turns and manual compaction during terminal cleanup.
   */
  dispose(): void {
    this.disposed = true;
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

  /**
   * Append a nonempty prompt and run the shared agent loop when a model is available, ignoring submissions while busy.
   * Without a model, displays an error and returns without appending a user record or starting the loop.
   * Appends the user record first so a cancelled turn still leaves resumable history.
   */
  async submit(prompt: string): Promise<void> {
    const text = prompt.trim();
    if (text.length === 0 || this.running || this.disposed) {
      return;
    }
    if (!this.model) {
      this.fail(
        "Missing credentials. Use /login <provider> to save an API key, or set the provider API-key environment variable and restart schway.",
      );
      return;
    }
    const userEntry: TuiTranscriptEntry = {
      id: this.nextId("user"),
      kind: "user",
      text,
    };
    this.transcript.push(userEntry);
    this.session.append({
      type: "user",
      id: crypto.randomUUID(),
      content: [{ type: "text", text }],
    });
    this.status = "running";
    const abort = new AbortController();
    this.activeAbort = abort;
    this.currentAssistantId = undefined;
    await this.captureTurnBaseline();
    const turn = this.runTurn(abort.signal);
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
    }
  }

  private async runTurn(signal: AbortSignal): Promise<void> {
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
      })) {
        // Drain accepted calls on cancellation; replaced sessions ignore stale display events.
        if (this.activeAbort?.signal === signal) {
          this.applyEvent(event);
        }
      }
      if (this.activeAbort?.signal !== signal) {
        return;
      }
      if (signal.aborted) {
        this.transcript.push(this.systemEntry("Cancelled."));
        this.status = "idle";
        await this.captureTurnResult();
        return;
      }
      if (this.status === "running") {
        this.status = "idle";
      }
      await this.captureTurnResult();
    } catch (error) {
      if (this.activeAbort?.signal !== signal) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.fail(actionableError(message));
      await this.captureTurnResult();
    }
  }

  /** Fold one runtime event into transcript rows and status. */
  applyEvent(event: RuntimeEvent): void {
    switch (event.type) {
      case "agent.started":
        return;
      case "model.delta": {
        if (event.content.type !== "text") {
          return;
        }
        const current = this.currentAssistant();
        current.text += event.content.text;
        return;
      }
      case "model.finished": {
        this.currentAssistantId = undefined;
        return;
      }
      case "model.retry": {
        this.transcript.push(
          this.systemEntry(
            `Retrying provider request (${event.attempt}/${event.maxAttempts}): ${event.message}`,
          ),
        );
        return;
      }
      case "tool.started": {
        const entry: TuiTranscriptEntry = {
          id: this.nextId("tool"),
          kind: "tool",
          text: "",
          toolName: event.name,
          toolCallId: event.toolCallId,
          toolStatus: "running",
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
        if (entry) {
          entry.text = display;
          entry.toolStatus =
            event.status === "success" ? "success" : event.status === "cancelled" ? "cancelled" : "error";
        } else {
          this.transcript.push({
            id: this.nextId("tool"),
            kind: "tool",
            text: display,
            toolName: event.name,
            toolCallId: event.toolCallId,
            toolStatus: event.status === "success" ? "success" : event.status === "cancelled" ? "cancelled" : "error",
          });
        }
        return;
      }
      case "compaction.started": {
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
        this.fail(actionableError(event.message));
        return;
      }
      case "agent.finished": {
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

  private systemEntry(text: string): TuiTranscriptEntry {
    return { id: this.nextId("sys"), kind: "system", text };
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
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

/** Explain API-key recovery for interactive provider failures. */
function actionableError(message: string): string {
  const lowered = message.toLowerCase();
  if (
    lowered.includes("missing anthropic api key") ||
    lowered.includes("missing openai api key") ||
    lowered.includes("missing api key")
  ) {
    return `${message} Use /login <provider> to save an API key, or set --api-key or the provider environment variable and restart schway.`;
  }
  if (lowered.includes("login")) {
    return message;
  }
  return message;
}

function displaySetting(key: string, value: unknown): string {
  if (key === "baseUrl" && typeof value === "string") return sanitizeBaseUrl(value);
  if (key === "git" && typeof value === "object" && value !== null) return JSON.stringify(value);
  return value === undefined ? "unset" : String(value);
}
