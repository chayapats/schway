import type { Workspace } from "../workspace/workspace.ts";

/** JSON Schema object used as a public tool input contract. */
export type JsonSchema = Record<string, unknown>;

/**
 * Declare whether sibling calls may overlap or must run behind an exclusive barrier.
 * Consecutive `parallel` calls run up to the scheduler's concurrency limit;
 * an `exclusive` call waits for preceding calls and finishes before later calls start.
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
  /** Optional subprocess environment supplied by a restricted harness; ordinary tools inherit the process environment. */
  env?: NodeJS.ProcessEnv;
  /** Live output for runtime events. Tools may call this as chunks arrive. */
  onOutput?: (chunk: ToolOutputChunk) => void;
}

/** State-change declaration used by approval modes, independently of scheduling. */
export type ToolEffect = "read-only" | "mutating";

/** Public tool contract: schema for the model, execute for the harness. */
export interface ToolDefinition<TInput = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execution: ToolExecutionMode;
  /** Declare state changes; an undeclared effect means "mutating". */
  effect?: ToolEffect;
  /** Execute validated arguments in the supplied workspace; returned errors or rejections are normalized by the harness. */
  execute(input: TInput, ctx: ToolContext): Promise<ToolExecutionResult>;
}

/** Outcome recorded for an accepted tool call. */
export type ToolCallStatus = "success" | "error" | "cancelled";

/** Return the declared effect, treating undeclared tools as able to change state. */
export function toolEffect(definition: ToolDefinition): ToolEffect {
  const effect = definition.effect;
  return effect === undefined ? "mutating" : effect;
}
