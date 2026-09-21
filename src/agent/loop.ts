import type { AssistantMessage, ToolCallContent } from "../conversation/types.ts";
import { DEFAULT_MAX_TURNS } from "../config/defaults.ts";
import type { ContextManager, PreparedContext } from "../context/manager.ts";
import type { Model, ModelTool } from "../model/model.ts";
import type { Session } from "../session/session.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { toPlainJsonSchema } from "../tools/schema.ts";
import type { Workspace } from "../workspace/workspace.ts";
import type { RuntimeEvent } from "./events.ts";
import {
  streamModelTurn,
  systemClock,
  type AgentClock,
  type ModelTurnOutcome,
} from "./retry.ts";
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

  /** Force one compaction and retry the overflowed turn once; null when terminated. */
  async function* recoverFromOverflow(): AsyncGenerator<
    RuntimeEvent,
    {
      outcome: Exclude<ModelTurnOutcome, { kind: "overflow" }>;
      prepared: PreparedContext;
    } | null
  > {
    if (options.signal?.aborted) {
      yield { type: "agent.finished", reason: "cancelled" };
      return null;
    }
    yield { type: "compaction.started", reason: "overflow" };
    const record = await options.contextManager.compact(options.session, options.model, {
      reason: "overflow",
      signal: options.signal,
    });
    if (options.signal?.aborted) {
      yield { type: "compaction.finished", reason: "overflow", status: "noop" };
      yield { type: "agent.finished", reason: "cancelled" };
      return null;
    }
    if (!record) {
      yield {
        type: "compaction.finished",
        reason: "overflow",
        status: "failed",
        message: "compaction did not produce a record",
      };
      yield {
        type: "error",
        message:
          "Context overflow: compaction did not free context. The session is unchanged; compact manually or shorten the history and retry.",
      };
      yield { type: "agent.finished", reason: "error" };
      return null;
    }
    yield {
      type: "compaction.finished",
      reason: "overflow",
      status: "completed",
      recordId: record.id,
      firstKeptId: record.firstKeptId,
    };
    const prepared = await options.contextManager.prepare(
      options.session,
      options.model,
      { signal: options.signal },
    );
    if (prepared.compaction) {
      yield { type: "compaction.started", reason: "pressure" };
      yield {
        type: "compaction.finished",
        reason: "pressure",
        status: "completed",
        recordId: prepared.compaction.id,
        firstKeptId: prepared.compaction.firstKeptId,
      };
    }
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
    if (outcome.kind === "overflow") {
      yield {
        type: "error",
        message:
          "Repeated context overflow after compaction. The session is unchanged; compact manually or shorten the history and retry.",
      };
      yield { type: "agent.finished", reason: "error" };
      return null;
    }
    return { outcome, prepared };
  }

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (options.signal?.aborted) {
        yield { type: "agent.finished", reason: "cancelled" };
        return;
      }

      let prepared = await options.contextManager.prepare(
        options.session,
        options.model,
        { signal: options.signal },
      );
      if (prepared.compaction) {
        yield { type: "compaction.started", reason: "pressure" };
        yield {
          type: "compaction.finished",
          reason: "pressure",
          status: "completed",
          recordId: prepared.compaction.id,
          firstKeptId: prepared.compaction.firstKeptId,
        };
      }
      let outcome = yield* streamModelTurn({
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
      if (outcome.kind === "overflow") {
        const recovered = yield* recoverFromOverflow();
        if (!recovered) {
          return;
        }
        outcome = recovered.outcome;
        prepared = recovered.prepared;
      }
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
