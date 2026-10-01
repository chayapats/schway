import type { JsonSchema, ToolCallStatus, ToolDefinition, ToolExecutionMode, ToolExecutionResult } from "../tools/types.ts";
import type { RuntimeEvent } from "../agent/events.ts";
import type { ContextSection } from "../context/manager.ts";
import type { UserMessage } from "../conversation/types.ts";
import type { ModelRequest } from "../model/model.ts";

/** Named native dynamic context retained separately from the stable system prompt. */
export type { ContextSection } from "../context/manager.ts";
/** Native conversation and tool descriptions accepted by request hooks, without provider wire types. */
export type { ConversationItem, UserMessage } from "../conversation/types.ts";
/** Executable-free descriptions that request hooks may select without changing their definitions. */
export type { ModelTool } from "../model/model.ts";

/** Deny an agent turn or model request with a nonempty explanation shown to the user. */
export interface ExtensionDenial { deny: string }

/** Detached user input and accumulated turn-only context, supplied once per submitted turn. */
export interface BeforeAgentInput {
  message: UserMessage;
  context: readonly ContextSection[];
  readonly signal: AbortSignal;
}

/** Append turn-only sections, deny the turn, or leave the preceding hook's result unchanged. */
export type BeforeAgentHook = (input: BeforeAgentInput) => void | { context: readonly ContextSection[] } | ExtensionDenial |
  Promise<void | { context: readonly ContextSection[] } | ExtensionDenial>;

/** Transform prepared dynamic sections in order while preserving each existing section's name. */
export type ContextHook = (input: { context: readonly ContextSection[]; readonly signal: AbortSignal }) =>
  void | readonly ContextSection[] | Promise<void | readonly ContextSection[]>;

/** Detached provider-independent request with a cancellation signal owned by Schway. */
export interface ExtensionModelRequest extends ModelRequest { readonly signal: AbortSignal }

/** Replace ephemeral request data, deny the request, or retain the preceding hook's result. */
export type BeforeModelHook = (request: ExtensionModelRequest) =>
  void | ExtensionModelRequest | ExtensionDenial | Promise<void | ExtensionModelRequest | ExtensionDenial>;

/** Detached validated invocation metadata; only an explicit arguments return may change execution input. */
export interface BeforeToolInput {
  readonly id: string;
  readonly name: string;
  arguments: unknown;
  readonly inputSchema: JsonSchema;
  readonly execution: ToolExecutionMode;
  readonly signal: AbortSignal;
}

/** Replace tool arguments in load order, deny with an explanation, or leave the invocation unchanged. */
export type BeforeToolHook = (input: BeforeToolInput) =>
  void | { arguments: unknown } | ExtensionDenial | Promise<void | { arguments: unknown } | ExtensionDenial>;

/** Settled execution status with the current model-facing presentation, copied for each afterTool handler. */
export interface AfterToolInput extends BeforeToolInput {
  readonly outcome: ToolExecutionResult & { readonly status: ToolCallStatus };
}

/** Transform settled output; returned isError sets terminal status, outcome.status stays original, and execution is never replayed. */
export type AfterToolHook = (input: AfterToolInput) => void | ToolExecutionResult | Promise<void | ToolExecutionResult>;

/** Public JSON Schema and invocation contracts shared with native tools. */
export type {
  JsonSchema, ToolContext, ToolDefinition, ToolEffect, ToolExecutionMode,
  ToolExecutionResult, ToolOutputChunk,
} from "../tools/types.ts";
/** Canonical primary workspace and launch paths supplied to tool invocations. */
export type { Workspace } from "../workspace/workspace.ts";

/** Recursively readonly event data, detached from authoritative runtime and session objects. */
export type ExtensionEvent = DeepReadonly<RuntimeEvent>;

type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

/** Observe native runtime events sequentially, using the signal to stop work on unsubscribe or session disposal. */
export type ExtensionEventListener = (event: ExtensionEvent, context: { readonly signal: AbortSignal }) => void | Promise<void>;

/** Limited capabilities for an idle interactive command; a queued prompt runs after successful completion. */
export interface ExtensionCommandContext {
  readonly signal: AbortSignal;
  /** Queue one nonempty normal user prompt; cancellation, failure, or disposal discards it. */
  submitPrompt(prompt: string): void;
}

/** Declare an interactive slash command with a raw trailing-argument handler and optional help usage. */
export interface ExtensionCommand {
  name: string;
  description: string;
  arguments?: string;
  execute(args: string, context: ExtensionCommandContext): string | void | Promise<string | void>;
}

/** Capabilities available while an explicitly enabled extension initializes, owned until runtime disposal. */
export interface ExtensionContext {
  readonly signal: AbortSignal;
  /** Add one named dynamic prompt section to every ordinary request, never to internal summaries. */
  registerPrompt(section: ContextSection): void;
  /** Register an ordered hook that adds context or denies once per submitted user turn. */
  beforeAgent(hook: BeforeAgentHook): void;
  /** Register an ordered waterfall after structural and extension context has been assembled. */
  context(hook: ContextHook): void;
  /** Register an ordered native-request waterfall before each logical model request, excluding retries. */
  beforeModel(hook: BeforeModelHook): void;
  /** Register an ordered argument-rewrite or denial waterfall inside each tool's scheduling slot. */
  beforeTool(hook: BeforeToolHook): void;
  /** Register an ordered presentation waterfall after an executed tool settles, without replaying it. */
  afterTool(hook: AfterToolHook): void;
  /** Register a custom tool atomically with this module's other tools before initialization finishes. */
  registerTool<TInput = unknown>(tool: ToolDefinition<TInput>): void;
  /** Register an idle-only interactive slash command, rejecting core, skill, and extension collisions. */
  registerCommand(command: ExtensionCommand): void;
  /** Subscribe to copied native events without delaying the agent; the returned function unsubscribes once. */
  onRuntimeEvent(listener: ExtensionEventListener): () => void;
  /** Register cleanup invoked once on failed initialization or runtime disposal; async failures are diagnosed. */
  onDispose(cleanup: () => void | Promise<void>): void;
}

/** Default module initializer that registers capabilities without replacing harness infrastructure. */
export type Extension = (context: ExtensionContext) => void | Promise<void>;

/** Type-check and return an extension initializer without running it. */
export function defineExtension(extension: Extension): Extension {
  return extension;
}
