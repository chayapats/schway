import { runAgentLoop } from "../agent/loop.ts";
import type { RuntimeEvent } from "../agent/events.ts";
import { redactSecrets } from "../auth/secrets.ts";
import type { ContextManager } from "../context/manager.ts";
import type {
  SessionRecord,
  ToolResult,
} from "../conversation/types.ts";
import { lookupModel } from "../model/catalog.ts";
import type { Model } from "../model/model.ts";
import type { Session } from "../session/session.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { Workspace } from "../workspace/workspace.ts";
import type { ExtensionRuntime } from "../extensions/host.ts";
import { discoverSkills } from "../skills/skills.ts";

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
  provider: string;
  modelId: string;
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
  startupError?: string;
  /** Known values to mask in displayed transcript text and configuration output. */
  secrets?: readonly string[];
  extensions?: ExtensionRuntime;
  /** Stage fresh enabled modules for a workspace before publishing a session switch. */
  loadWorkspaceExtensions?: (workspace: Workspace, signal: AbortSignal) => Promise<{ tools: ToolRegistry; runtime: ExtensionRuntime }>;
  home?: string;
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
  private secrets: readonly string[];
  private provider: string;
  private modelId: string;
  private sessionId: string;
  private readonly maxTurns?: number;
  private readonly maxConcurrentTools?: number;
  private readonly explicitContextWindow?: number;
  private readonly explicitMaxOutput?: number;
  private readonly baseUrl?: string;
  private readonly auth?: string;
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
    this.secrets = options.secrets ?? [];
    this.extensions = options.extensions;
    this.home = options.home;
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
    return {
      status: this.status,
      transcript: this.transcript.map((entry) =>
        this.secrets.length === 0
          ? entry
          : { ...entry, text: redactSecrets(entry.text, this.secrets) },
      ),
      sessionId: this.sessionId,
      provider: this.provider,
      modelId: this.modelId,
    };
  }

  /** True while a submitted turn or manual compaction owns the shared cancellation signal. */
  get running(): boolean {
    return this.activeAbort !== undefined;
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
        const skills = await discoverSkills({ workspaceRoot: this.workspace.root, home: this.home, signal: abort.signal });
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
  setModel(model: Model | undefined, provider: string, modelId: string): void {
    this.model = model;
    this.provider = provider;
    this.modelId = modelId;
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

  /** Render effective basic settings for `/config`, masking supplied known secrets and sanitizing the base URL. */
  describeConfig(): string {
    const budgets = this.effectiveBudgets();
    const lines = [
      `Provider: ${this.provider}`,
      `Model: ${this.modelId}`,
      `Context window: ${budgets.contextWindow}`,
      `Max output: ${budgets.maxOutput}`,
    ];
    if (this.maxTurns !== undefined) {
      lines.push(`Max turns: ${this.maxTurns}`);
    }
    if (this.maxConcurrentTools !== undefined) {
      lines.push(`Max concurrent tools: ${this.maxConcurrentTools}`);
    }
    if (this.provider === "openai-compatible") {
      if (this.baseUrl !== undefined) {
        lines.push(`Base URL: ${sanitizeBaseUrl(this.baseUrl)}`);
      }
      if (this.auth !== undefined) {
        lines.push(`Auth: ${this.auth}`);
      }
    }
    lines.push(`Session: ${this.sessionId}`);
    lines.push("Model overrides apply to this session only and are never written to config files.");
    return redactSecrets(lines.join("\n"), this.secrets);
  }

  /**
   * Return whether manual compaction created a record, or false when busy, unavailable, cancelled, or unchanged.
   * @throws Propagates rejection of the compaction promise after clearing its active operation tracking.
   */
  async compact(): Promise<boolean> {
    if (this.activeAbort) {
      this.notice("Already running. Press Esc to cancel first.");
      return false;
    }
    if (!this.model) {
      this.fail(
        "Missing credentials. Set ANTHROPIC_API_KEY or OPENAI_API_KEY and restart schway. Subscription login is not supported in v0.1.",
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

  private async stageSession(session: Session, sessionId: string, options: { workspace: Workspace; contextManager: ContextManager }, abort: AbortController): Promise<boolean> {
    let staged: { tools: ToolRegistry; runtime: ExtensionRuntime } | undefined;
    try {
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
      this.replaceSession(session, sessionId, options);
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
    if (!this.activeAbort) {
      return;
    }
    this.activeAbort.abort();
  }

  /**
   * Clear active cancellation state and abort the active operation without awaiting it.
   * Applies to both submitted turns and manual compaction during terminal cleanup.
   */
  dispose(): void {
    this.disposed = true;
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
    if (text.length === 0 || this.activeAbort || this.disposed) {
      return;
    }
    if (!this.model) {
      this.fail(
        "Missing credentials. Set ANTHROPIC_API_KEY or OPENAI_API_KEY and restart schway. Subscription login is not supported in v0.1.",
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
        return;
      }
      if (this.status === "running") {
        this.status = "idle";
      }
    } catch (error) {
      if (this.activeAbort?.signal !== signal) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.fail(actionableError(message));
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

/**
 * Rebuild display history from durable records without replaying tool effects.
 * Tool results are matched to their calls and shown bounded; compaction becomes
 * a short system line.
 */
export function buildTranscriptFromSession(items: readonly SessionRecord[]): TuiTranscriptEntry[] {
  const transcript: TuiTranscriptEntry[] = [];
  const results = new Map<string, ToolResult>();
  for (const item of items) {
    if (item.type === "tool_result") {
      results.set(item.toolCallId, item);
    }
  }
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
          const result = results.get(block.id);
          transcript.push({
            id: nextId("tool"),
            kind: "tool",
            text: result ? boundDisplay(result.content) : "Tool call interrupted before a result was persisted",
            toolName: block.name,
            toolCallId: block.id,
            toolStatus: !result ? "cancelled" : result.isError ? "error" : "success",
          });
        }
      }
      const text = textParts.join("");
      if (text.length > 0) {
        transcript.push({ id: nextId("asst"), kind: "assistant", text });
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

/** Keep provider errors actionable and never suggest an interactive login flow. */
function actionableError(message: string): string {
  const lowered = message.toLowerCase();
  if (
    lowered.includes("missing anthropic api key") ||
    lowered.includes("missing openai api key") ||
    lowered.includes("missing api key")
  ) {
    return `${message} Set the key via --api-key or the environment and restart schway. Subscription login is not supported in v0.1.`;
  }
  if (lowered.includes("login")) {
    return message;
  }
  return message;
}
