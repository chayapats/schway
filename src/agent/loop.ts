import type { AssistantMessage, ToolCallContent } from "../conversation/types.ts";
import type { ContextManager } from "../context/manager.ts";
import type { Model, ModelTool } from "../model/model.ts";
import type { Session } from "../session/session.ts";
import { executeToolCall, type ExecutedToolCall } from "../tools/executor.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { toPlainJsonSchema } from "../tools/schema.ts";
import type { ToolOutputChunk } from "../tools/types.ts";
import type { Workspace } from "../workspace/workspace.ts";
import type { RuntimeEvent } from "./events.ts";

/** Safety bound on model rounds per `runAgentLoop` invocation. */
export const DEFAULT_MAX_TURNS = 32;

/** Inputs for one agent run. Tools and workspace are required to execute calls. */
export interface AgentLoopOptions {
  session: Session;
  model: Model;
  contextManager: ContextManager;
  tools?: ToolRegistry;
  workspace?: Workspace;
  signal?: AbortSignal;
  maxTurns?: number;
}

/**
 * Own the agent loop: prepare context, stream the model, execute tool calls,
 * append one result per accepted call, and repeat until a final answer, cancel,
 * or the turn bound.
 */
export async function* runAgentLoop(
  options: AgentLoopOptions,
): AsyncGenerator<RuntimeEvent> {
  yield { type: "agent.started" };

  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (options.signal?.aborted) {
        yield { type: "agent.finished", reason: "cancelled" };
        return;
      }

      const prepared = options.contextManager.prepare(options.session);
      yield {
        type: "model.started",
        provider: options.model.provider,
        model: options.model.id,
      };

      let complete: AssistantMessage | undefined;
      try {
        for await (const event of options.model.stream({
          systemPrompt: prepared.systemPrompt,
          context: prepared.context,
          items: prepared.items,
          tools: toModelTools(options.tools),
          signal: options.signal,
        })) {
          if (event.type === "text_delta") {
            yield {
              type: "model.delta",
              content: { type: "text", text: event.text },
            };
          } else if (event.type === "thinking_delta") {
            yield {
              type: "model.delta",
              content: { type: "thinking", text: event.text },
            };
          } else {
            complete = event.message;
          }
        }
      } catch (error) {
        if (options.signal?.aborted) {
          yield { type: "agent.finished", reason: "cancelled" };
          return;
        }
        yield { type: "error", message: errorMessage(error) };
        yield { type: "agent.finished", reason: "error" };
        return;
      }

      if (!complete) {
        yield {
          type: "error",
          message: "Model stream ended without a complete message",
        };
        yield { type: "agent.finished", reason: "error" };
        return;
      }

      options.session.append(complete);
      yield { type: "model.finished" };

      const calls = toolCallsOf(complete);
      if (calls.length === 0) {
        yield { type: "agent.finished", reason: "completed" };
        return;
      }

      for (const call of calls) {
        yield {
          type: "tool.started",
          toolCallId: call.id,
          name: call.name,
        };
        const executed = yield* streamToolOutput({
          registry: options.tools,
          call,
          workspace: options.workspace,
          signal: options.signal,
        });
        options.session.append(executed.result);
        yield {
          type: "tool.finished",
          toolCallId: call.id,
          name: call.name,
          status: executed.status,
          content: executed.result.content,
          ...(executed.details !== undefined
            ? { details: executed.details }
            : {}),
        };
      }

      if (options.signal?.aborted) {
        yield { type: "agent.finished", reason: "cancelled" };
        return;
      }
    }

    yield { type: "agent.finished", reason: "max_turns" };
  } catch (error) {
    yield { type: "error", message: errorMessage(error) };
    yield { type: "agent.finished", reason: "error" };
  }
}

/**
 * Run one tool call and yield stdout/stderr chunks as `tool.delta` while it runs.
 */
async function* streamToolOutput(options: {
  registry?: ToolRegistry;
  call: ToolCallContent;
  workspace?: Workspace;
  signal?: AbortSignal;
}): AsyncGenerator<RuntimeEvent, ExecutedToolCall> {
  const queue: RuntimeEvent[] = [];
  let wake: (() => void) | undefined;
  let settled = false;
  let result: ExecutedToolCall | undefined;
  let failure: unknown;

  const finished = executeToolCall({
    ...options,
    onOutput(chunk: ToolOutputChunk) {
      if (chunk.text.length === 0) {
        return;
      }
      queue.push({
        type: "tool.delta",
        toolCallId: options.call.id,
        name: options.call.name,
        stream: chunk.stream,
        text: chunk.text,
      });
      wake?.();
    },
  }).then(
    (value) => {
      result = value;
    },
    (error) => {
      failure = error;
    },
  ).finally(() => {
    settled = true;
    wake?.();
  });

  while (!settled || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
      continue;
    }
    yield queue.shift()!;
  }

  await finished;
  if (failure !== undefined) {
    throw failure;
  }
  if (!result) {
    throw new Error("Tool execution finished without a result");
  }
  return result;
}

/** Collect tool_call blocks from an assembled assistant message. */
function toolCallsOf(message: AssistantMessage): ToolCallContent[] {
  return message.content.filter(
    (block): block is ToolCallContent => block.type === "tool_call",
  );
}

/** Strip execute functions and TypeBox symbols before sending tools to a model. */
function toModelTools(registry: ToolRegistry | undefined): ModelTool[] | undefined {
  if (!registry) {
    return undefined;
  }
  return registry.definitions().map((definition) => ({
    name: definition.name,
    description: definition.description,
    inputSchema: toPlainJsonSchema(definition.inputSchema),
  }));
}

/** Normalize thrown values into a printable error string. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
