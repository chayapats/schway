import type { AssistantMessage } from "../conversation/types.ts";
import type { ContextManager } from "../context/manager.ts";
import type { Model } from "../model/model.ts";
import type { Session } from "../session/session.ts";
import type { RuntimeEvent } from "./events.ts";

export interface AgentLoopOptions {
  session: Session;
  model: Model;
  contextManager: ContextManager;
  signal?: AbortSignal;
}

export async function* runAgentLoop(
  options: AgentLoopOptions,
): AsyncGenerator<RuntimeEvent> {
  yield { type: "agent.started" };

  try {
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
    yield { type: "agent.finished", reason: "completed" };
  } catch (error) {
    yield { type: "error", message: errorMessage(error) };
    yield { type: "agent.finished", reason: "error" };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
