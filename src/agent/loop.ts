import type { AssistantMessage, ToolCallContent } from "../conversation/types.ts";
import { DEFAULT_MAX_TURNS } from "../config/defaults.ts";
import type { ContextManager, ContextSection, PreparedContext } from "../context/manager.ts";
import type { Model, ModelRequest, ModelTool } from "../model/model.ts";
import type { Session } from "../session/session.ts";
import { createActivateSkillTool } from "../skills/activate.ts";
import { createToolRegistry, type ToolRegistry } from "../tools/registry.ts";
import { toPlainJsonSchema } from "../tools/schema.ts";
import type { Workspace } from "../workspace/workspace.ts";
import type { RuntimeEvent } from "./events.ts";
import type { ExtensionRuntime } from "../extensions/host.ts";
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
  extensions?: ExtensionRuntime;
}

/**
 * Stream runtime events while preparing context, calling the model, and persisting assistant and tool results.
 * Repeats until a final answer, cancellation, failure, or the turn bound;
 * failures emit error events, and accepted tool calls settle before cancellation finishes.
 */
export async function* runAgentLoop(
  options: AgentLoopOptions,
): AsyncGenerator<RuntimeEvent> {
  const publish = options.extensions?.eventPublisher();
  for await (const event of runAgentLoopInternal(options)) {
    publish?.(event);
    yield event;
  }
}

/** Keep authoritative execution independent of extension notification delivery. */
async function* runAgentLoopInternal(options: AgentLoopOptions): AsyncGenerator<RuntimeEvent> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const clock = options.clock ?? systemClock();
  let tools = options.tools;
  const hooks = options.extensions?.hooks.active ? options.extensions.hooks : undefined;
  const toolHooks = options.extensions?.toolHooks.active ? options.extensions.toolHooks : undefined;
  const signal = hooks
    ? AbortSignal.any([options.extensions!.signal, ...(options.signal ? [options.signal] : [])])
    : options.signal;
  let turnContext: ContextSection[] = [];
  const finishTurn = options.contextManager.beginTurn();

  /** Intercept ordinary requests after native context assembly, sharing the path used after overflow. */
  async function prepareRequest(prepared: PreparedContext): Promise<ModelRequest> {
    const request: ModelRequest = {
      systemPrompt: prepared.systemPrompt,
      context: prepared.context,
      items: prepared.items,
      tools: toModelTools(tools),
      signal,
    };
    return hooks
      ? hooks.prepare(request, turnContext, signal!)
      : request;
  }

  /** Force one compaction and retry the overflowed turn once; null when terminated. */
  async function* recoverFromOverflow(): AsyncGenerator<
    RuntimeEvent,
    {
      outcome: Exclude<ModelTurnOutcome, { kind: "overflow" }>;
      prepared: PreparedContext;
    } | null
  > {
    if (signal?.aborted) {
      yield { type: "agent.finished", reason: "cancelled" };
      return null;
    }
    yield { type: "compaction.started", reason: "overflow" };
    const record = await options.contextManager.compact(options.session, options.model, {
      reason: "overflow",
      signal,
    });
    if (signal?.aborted) {
      if (record) {
        yield {
          type: "compaction.finished",
          reason: "overflow",
          status: "completed",
          recordId: record.id,
          firstKeptId: record.firstKeptId,
        };
      } else {
        yield { type: "compaction.finished", reason: "overflow", status: "noop" };
      }
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
      { signal },
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
      request: await prepareRequest(prepared),
      clock,
      signal,
    });
    if (outcome.kind === "overflow") {
      yield {
        type: "error",
        message:
          "Repeated context overflow after compaction. The compaction record was kept; shorten the history or start a new session and retry.",
      };
      yield { type: "agent.finished", reason: "error" };
      return null;
    }
    return { outcome, prepared };
  }

  try {
    yield { type: "agent.started" };
    if (options.workspace) {
      tools = createToolRegistry([
        ...(options.tools?.definitions() ?? []),
        createActivateSkillTool(options.contextManager),
      ]);
    }
    const user = options.session.items.findLast(item => item.type === "user");
    if (hooks && user?.type === "user") {
      turnContext = await hooks.beginTurn(user, signal!);
    }
    for (let turn = 0; turn < maxTurns; turn++) {
      if (signal?.aborted) {
        yield { type: "agent.finished", reason: "cancelled" };
        return;
      }

      let prepared = await options.contextManager.prepare(
        options.session,
        options.model,
        { signal },
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
        request: await prepareRequest(prepared),
        clock,
        signal,
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
        registry: tools,
        workspace: options.workspace,
        signal,
        maxConcurrentTools: options.maxConcurrentTools,
        toolHooks,
      });
      for (const item of executed) {
        options.session.append(item.result);
      }

      if (signal?.aborted || toolHooks?.signal.aborted) {
        yield { type: "agent.finished", reason: "cancelled" };
        return;
      }
    }

    yield { type: "agent.finished", reason: "max_turns" };
  } catch (error) {
    if (signal?.aborted) {
      yield { type: "agent.finished", reason: "cancelled" };
    } else {
      yield { type: "error", message: errorMessage(error) };
      yield { type: "agent.finished", reason: "error" };
    }
  } finally {
    finishTurn();
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
