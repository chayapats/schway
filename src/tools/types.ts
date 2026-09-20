import type { Workspace } from "../workspace/workspace.ts";

export type JsonSchema = Record<string, unknown>;

export type ToolExecutionMode = "parallel" | "exclusive";

export interface ToolExecutionResult {
  content: string;
  details?: unknown;
  isError?: boolean;
}

export interface ToolContext {
  workspace: Workspace;
  signal?: AbortSignal;
}

export interface ToolDefinition<TInput = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execution: ToolExecutionMode;
  execute(input: TInput, ctx: ToolContext): Promise<ToolExecutionResult>;
}

export type ToolCallStatus = "success" | "error" | "cancelled";
