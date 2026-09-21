import type { AssistantMessage, ToolCallContent } from "../conversation/types.ts";
import { DEFAULT_MAX_TURNS } from "../config/defaults.ts";
import type { ContextManager } from "../context/manager.ts";
import type { Model, ModelTool } from "../model/model.ts";
import type { Session } from "../session/session.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { toPlainJsonSchema } from "../tools/schema.ts";
import type { Workspace } from "../workspace/workspace.ts";
import type { RuntimeEvent } from "./events.ts";
import { streamModelTurn, systemClock, type AgentClock } from "./retry.ts";
import { scheduleToolCalls } from "./scheduler.ts";

/** Safety bound on model rounds per `runAgentLoop` invocation. */
export { DEFAULT_MAX_TURNS };

/** Inputs for one agent run. Tools and workspace are required to execute calls. */
export interface AgentLoopOptions {
  session: Session;
  model: Model;
  contextManager: ContextManager;
  tools?: ToolRegistry;
  workspace?: Workspace;
  signal?: AbortSignal;
  maxTurns?: number;
  maxConcurrentTools?: number;
  clock?: AgentClock;
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
  const clock = options.clock ?? systemClock();

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (options.signal?.aborted) {
        yield { type: "agent.finished", reason: "cancelled" };
        return;
      }

      const prepared = await options.contextManager.prepare(options.session);
      const outcome = yield* streamModelTurn({
        model: options.model,
        request: {
          systemPrompt: prepared.systemPrompt,
          context: prepared.context,
          items: prepared.items,
          tools: toModelTools(options.tools),
          signal: options.signal,
        },
        clock,
        signal: options.signal,
      });
      if (outcome.kind === "cancelled") {
        yield { type: "agent.finished", reason: "cancelled" };
        return;
      }
      if (outcome.kind === "error") {
        yield { type: "error", message: outcome.message };
        yield { type: "agent.finished", reason: "error" };
        return;
      }

      options.session.append(outcome.message);
      yield { type: "model.finished" };

      const calls = toolCallsOf(outcome.message);
      if (calls.length === 0) {
        yield { type: "agent.finished", reason: "completed" };
        return;
      }

      const executed = yield* scheduleToolCalls({
        calls,
        registry: options.tools,
        workspace: options.workspace,
        signal: options.signal,
        maxConcurrentTools: options.maxConcurrentTools,
      });
      for (const item of executed) {
        options.session.append(item.result);
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
