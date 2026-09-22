import type { ToolDefinition } from "../tools/types.ts";
import type { RuntimeEvent } from "../agent/events.ts";

/** Public JSON Schema and invocation contracts shared with native tools. */
export type {
  JsonSchema, ToolContext, ToolDefinition, ToolExecutionMode,
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
