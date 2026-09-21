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

/** Immutable view of controller state for the renderer. */
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
  /** Runtime secrets redacted from every displayed transcript line. */
  secrets?: readonly string[];
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
  private readonly tools?: ToolRegistry;
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
    this.transcript = buildTranscriptFromSession(options.session.items);
    if (options.startupError) {
      this.transcript.push(this.systemEntry(options.startupError));
      this.status = "error";
    }
  }

  /** Current renderable state; transcript is a scrubbed copy so renderers cannot mutate or leak secrets. */
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

  /** True while a loop turn owns the shared cancellation signal. */
  get running(): boolean {
    return this.activeAbort !== undefined;
  }

  /** Update the model after a successful credential or model switch. */
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

  /** Render effective basic settings with secrets redacted for `/config`. */
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

  /** Run one manual compaction and keep the conversation usable on failure. */
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
    this.session = session;
    this.sessionId = sessionId;
    if (options.workspace !== undefined) {
      this.workspace = options.workspace;
    }
    if (options.contextManager !== undefined) {
      this.contextManager = options.contextManager;
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

  /** Stop the active turn through the shared AbortSignal path. */
  cancel(): void {
    if (!this.activeAbort) {
      return;
    }
    this.activeAbort.abort();
  }

  /** Abort any active turn; used when switching sessions or tearing down the TUI. */
  dispose(): void {
    this.abortActiveTurn();
  }

  /** Wait for the active turn to settle; used by tests and terminal cleanup. */
  async waitForIdle(): Promise<void> {
    await this.activeTurn;
  }

  /**
   * Submit one user prompt through the real agent loop.
   * Appends the user record first so a cancelled turn still leaves resumable history.
   */
  async submit(prompt: string): Promise<void> {
    const text = prompt.trim();
    if (text.length === 0 || this.activeAbort) {
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
      })) {
        this.applyEvent(event);
        if (signal.aborted) {
          break;
        }
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

/** Strip credentials from a base URL for display; unparseable values show presence only. */
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
