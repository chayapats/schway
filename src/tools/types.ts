import type { Workspace } from "../workspace/workspace.ts";

/** JSON Schema object used as a public tool input contract. */
export type JsonSchema = Record<string, unknown>;

/**
 * How a tool may be scheduled relative to siblings.
 * Consecutive `parallel` calls may run together later; `exclusive` is a barrier.
 */
export type ToolExecutionMode = "parallel" | "exclusive";

/** Result of a single tool `execute` call, before it is stored on the session. */
export interface ToolExecutionResult {
  /** Bounded model-facing text. */
  content: string;
  /** Structured extras for TUI, JSON events, and debugging. */
  details?: unknown;
  /** When true, the model should treat this as a tool error. */
  isError?: boolean;
}

/** A stdout or stderr chunk emitted while a tool is running. */
export interface ToolOutputChunk {
  stream: "stdout" | "stderr";
  text: string;
}

/** Per-invocation context passed into every tool. */
export interface ToolContext {
  workspace: Workspace;
  signal?: AbortSignal;
  /** Live output for runtime events. Tools may call this as chunks arrive. */
  onOutput?: (chunk: ToolOutputChunk) => void;
}

/** Public tool contract: schema for the model, execute for the harness. */
export interface ToolDefinition<TInput = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execution: ToolExecutionMode;
  execute(input: TInput, ctx: ToolContext): Promise<ToolExecutionResult>;
}

/** Outcome recorded for an accepted tool call. */
export type ToolCallStatus = "success" | "error" | "cancelled";
