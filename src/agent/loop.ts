import type { ApprovalPolicy } from "./approval.ts";
import type { UndoStore, UndoTurn } from "../undo/store.ts";
import type { AssistantMessage, ToolCallContent } from "../conversation/types.ts";
import { DEFAULT_MAX_TURNS } from "../config/defaults.ts";
import type { ContextManager, ContextSection, PreparedContext } from "../context/manager.ts";
import type { HostedTool, Model, ModelCallOptions, ModelRequest, ModelTool } from "../model/model.ts";
import { resolveHostedTools, type WebSearchSetting } from "../model/hosted-tools.ts";
import { isGrokModel } from "../model/loader.ts";
import { promptCacheKey } from "../model/prompt-cache-key.ts";
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
  /** Override the environment inherited by shell tools without changing the parent process. */
  toolEnv?: NodeJS.ProcessEnv;
  clock?: AgentClock;
  extensions?: ExtensionRuntime;
  /** Consult the live approval mode after tool hooks; omission preserves automatic execution. */
  approval?: ApprovalPolicy;
  undo?: UndoStore;
  /** Configured hosted web search preference; absent sends no hosted tools, as evals and smoke runs expect. */
  webSearch?: WebSearchSetting;
}

/** Stream context, model and tool events while persisting accepted outcomes and settling calls before cancellation finishes. */
export async function* runAgentLoop(
  options: AgentLoopOptions,
): AsyncGenerator<RuntimeEvent> {
  const release = options.session.acquireOperation();
  try {
    const publish = options.extensions?.eventPublisher();
    for await (const event of runAgentLoopInternal(options)) {
      publish?.(event);
      yield event;
    }
  } finally { release(); }
}

/** Keep authoritative execution independent of extension notification delivery. */
async function* runAgentLoopInternal(options: AgentLoopOptions): AsyncGenerator<RuntimeEvent> {
  const user = options.session.items.findLast(item => item.type === "user");
  const undoTurn: UndoTurn | undefined = user ? { sessionId: options.session.rootId, turnId: user.id,
    turnNumber: options.session.items.filter(item => item.type === "user").length } : undefined;
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const clock = options.clock ?? systemClock();
  let tools = options.tools;
  const hooks = options.extensions?.hooks.active ? options.extensions.hooks : undefined;
  const toolHooks = options.extensions?.toolHooks.active ? options.extensions.toolHooks : undefined;
  const signal = hooks
    ? AbortSignal.any([options.extensions!.signal, ...(options.signal ? [options.signal] : [])])
    : options.signal;
  let turnContext: ContextSection[] = [];
  let hostedTools: readonly HostedTool[] = [];
  // The operation lease holds the branch fixed, so every round, retry and recovery shares one key.
  // It travels beside the request, never through it, so extension hooks cannot see, drop or change it.
  const call: ModelCallOptions = { promptCacheKey: promptCacheKey(options.session) };
  const finishTurn = options.contextManager.beginTurn();
  function* compactionUsage(): Generator<RuntimeEvent> {
    for (const entry of options.contextManager.takeUsage()) {
      yield { type: "model.usage", phase: "compaction", ...entry };
    }
  }

  /** Yield pressure start while prepare is still compacting, then report its actual result. */
  async function* prepareContext(): AsyncGenerator<RuntimeEvent, PreparedContext> {
    let announce!: () => void;
    const started = new Promise<"started">(resolve => { announce = () => resolve("started"); });
    const pending = options.contextManager.prepare(options.session, options.model, {
      signal,
      onCompactionStart: announce,
    });
    const first = await Promise.race([started, pending.then(() => "prepared" as const, () => "prepared" as const)]);
    const pressure = first === "started";
    if (pressure) yield { type: "compaction.started", reason: "pressure" };
    try {
      const prepared = await pending;
      if (pressure) {
        yield prepared.compaction
          ? { type: "compaction.finished", reason: "pressure", status: "completed", recordId: prepared.compaction.id, firstKeptId: prepared.compaction.firstKeptId }
          : { type: "compaction.finished", reason: "pressure", status: signal?.aborted ? "cancelled" : prepared.compactionOutcome === "failed" ? "failed" : "noop" };
      }
      return prepared;
    } catch (error) {
      if (pressure) yield { type: "compaction.finished", reason: "pressure", status: signal?.aborted ? "cancelled" : "failed" };
      throw error;
    }
  }

  /** Intercept ordinary requests after native context assembly, sharing the path used after overflow. */
  async function prepareRequest(prepared: PreparedContext): Promise<ModelRequest> {
    const request: ModelRequest = {
      systemPrompt: prepared.systemPrompt,
      context: prepared.context,
      items: prepared.items,
      tools: toModelTools(tools),
      signal,
    };
    const intercepted = hooks ? await hooks.prepare(request, turnContext, signal!) : request;
    // Hosted tools are attached after the hooks, so a beforeModel hook can neither see nor change them.
    return hostedTools.length > 0 ? { ...intercepted, hostedTools } : intercepted;
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
    let record;
    let compactionFailed = false;
    try {
      record = await options.contextManager.compact(options.session, options.model, {
        reason: "overflow", signal,
        onOutcome: outcome => { compactionFailed = outcome === "failed"; },
      });
    } catch (error) {
      yield { type: "compaction.finished", reason: "overflow", status: signal?.aborted ? "cancelled" : "failed" };
      throw error;
    }
    yield* compactionUsage();
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
        yield { type: "compaction.finished", reason: "overflow", status: "cancelled" };
      }
      yield { type: "agent.finished", reason: "cancelled" };
      return null;
    }
    if (!record) {
      yield {
        type: "compaction.finished",
        reason: "overflow",
        status: compactionFailed ? "failed" : "noop",
        message: "compaction did not produce a record",
      };
      yield {
        type: "error",
        message:
          "Context overflow: compaction did not free context. The session is unchanged; compact manually or shorten the history and retry.",
        origin: "model",
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
    const prepared = yield* prepareContext();
    yield* compactionUsage();
    const outcome = yield* streamModelTurn({
      model: options.model,
      request: await prepareRequest(prepared),
      call,
      clock,
      signal,
    });
    if (outcome.kind === "overflow") {
      yield {
        type: "error",
        message:
          "Repeated context overflow after compaction. The compaction record was kept; shorten the history or start a new session and retry.",
        origin: "model",
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
    hostedTools = hostedToolsFor(options.model, options.webSearch, tools);
    if (hooks && user?.type === "user") {
      turnContext = await hooks.beginTurn(user, signal!);
    }
    for (let turn = 0; turn < maxTurns; turn++) {
      if (signal?.aborted) {
        yield { type: "agent.finished", reason: "cancelled" };
        return;
      }

      let prepared = yield* prepareContext();
      yield* compactionUsage();
      let outcome = yield* streamModelTurn({
        model: options.model,
        request: await prepareRequest(prepared),
        call,
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
        yield classifiedError(outcome.message, "model", outcome.category);
        yield { type: "agent.finished", reason: "error" };
        return;
      }

      try { options.session.append(outcome.message); }
      catch (error) { yield classifiedError(errorMessage(error), "harness", "session-write"); yield { type: "agent.finished", reason: "error" }; return; }
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
        env: options.toolEnv,
        toolHooks,
        approval: options.approval,
        undo: options.undo,
        undoTurn,
        clock,
      });
      for (const item of executed) {
        try { options.session.append(item.result); }
        catch (error) { yield classifiedError(errorMessage(error), "harness", "session-write"); yield { type: "agent.finished", reason: "error" }; return; }
      }

      if (signal?.aborted || toolHooks?.signal.aborted) {
        yield { type: "agent.finished", reason: "cancelled" };
        return;
      }
    }

    yield { type: "agent.finished", reason: "max_turns" };
  } catch (error) {
    yield* compactionUsage();
    if (signal?.aborted) {
      yield { type: "agent.finished", reason: "cancelled" };
    } else {
      yield { type: "error", message: errorMessage(error), origin: "harness" };
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

/** Decide hosted tools from the session's model, its route, config and the registered function tools; fixed for every round. */
function hostedToolsFor(model: Model, webSearch: WebSearchSetting | undefined, registry: ToolRegistry | undefined): readonly HostedTool[] {
  return resolveHostedTools({
    provider: model.provider,
    route: model.provider === "xai" ? isGrokModel(model) ? "grok" : "api-key" : undefined,
    model: model.id,
    webSearch,
    functionToolNames: registry?.definitions().map(definition => definition.name) ?? [],
  });
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

/** Attach local recovery metadata without changing the serialized runtime event contract. */
function classifiedError(message: string, origin: "model" | "harness", category?: Extract<RuntimeEvent, { type: "error" }>["category"]): RuntimeEvent {
  const event: RuntimeEvent = { type: "error", message, origin };
  if (category) Object.defineProperty(event, "category", { value: category, enumerable: false });
  return event;
}
