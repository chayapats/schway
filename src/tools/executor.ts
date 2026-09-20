import type { ToolCallContent, ToolResult } from "../conversation/types.ts";
import type { Workspace } from "../workspace/workspace.ts";
import type { ToolRegistry } from "./registry.ts";
import type { ToolCallStatus } from "./types.ts";

const CANCELLED_CONTENT = "Tool call cancelled";

export interface ExecutedToolCall {
  result: ToolResult;
  status: ToolCallStatus;
  details?: unknown;
}

export async function executeToolCall(options: {
  registry?: ToolRegistry;
  call: ToolCallContent;
  workspace?: Workspace;
  signal?: AbortSignal;
}): Promise<ExecutedToolCall> {
  if (options.signal?.aborted) {
    return cancelled(options.call);
  }

  const registered = options.registry?.get(options.call.name);
  if (!registered) {
    return failure(options.call, `Unknown tool: ${options.call.name}`);
  }

  const validated = registered.validate(options.call.arguments);
  if (!validated.ok) {
    return failure(
      options.call,
      `Invalid arguments for tool ${options.call.name}: ${validated.message}`,
    );
  }

  if (!options.workspace) {
    return failure(options.call, "Workspace is not available");
  }

  try {
    const output = await registered.definition.execute(validated.value, {
      workspace: options.workspace,
      signal: options.signal,
    });
    return {
      result: toolResult(options.call, output.content, output.isError === true),
      status: output.isError === true ? "error" : "success",
      details: output.details,
    };
  } catch (error) {
    if (
      options.signal?.aborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      return cancelled(options.call);
    }
    return failure(
      options.call,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function cancelled(call: ToolCallContent): ExecutedToolCall {
  return {
    result: toolResult(call, CANCELLED_CONTENT, true),
    status: "cancelled",
  };
}

function failure(call: ToolCallContent, content: string): ExecutedToolCall {
  return {
    result: toolResult(call, content, true),
    status: "error",
  };
}

function toolResult(
  call: ToolCallContent,
  content: string,
  isError: boolean,
): ToolResult {
  return {
    type: "tool_result",
    id: crypto.randomUUID(),
    toolCallId: call.id,
    content,
    isError,
  };
}
