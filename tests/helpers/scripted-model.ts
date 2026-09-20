import type {
  AssistantContent,
  AssistantMessage,
} from "../../src/conversation/types.ts";
import type { Model, ModelRequest, ModelStreamEvent } from "../../src/model/model.ts";

export interface ScriptedTurn {
  chunks?: string[];
  text?: string;
  thinkingChunks?: string[];
  error?: string;
  message?: AssistantMessage;
  toolCalls?: Array<{ id: string; name: string; arguments: unknown }>;
}

export type ScriptedTurnFactory =
  | ScriptedTurn
  | ((request: ModelRequest) => ScriptedTurn);

export interface ScriptedModelOptions extends ScriptedTurn {
  provider?: string;
  id?: string;
  responses?: ScriptedTurnFactory[];
}

export function createScriptedModel(options: ScriptedModelOptions = {}): Model {
  const id = options.id ?? "scripted";
  const provider = options.provider ?? "scripted";
  const turns: ScriptedTurnFactory[] = options.responses ?? [options];
  let turnIndex = 0;

  return {
    provider,
    id,
    async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
      if (turnIndex >= turns.length) {
        throw new Error("scripted model has no more responses");
      }
      const factory = turns[turnIndex]!;
      turnIndex += 1;
      const turn = typeof factory === "function" ? factory(request) : factory;
      if (turn.error) {
        throw new Error(turn.error);
      }
      for (const thinking of turn.thinkingChunks ?? []) {
        yield { type: "thinking_delta", text: thinking };
      }
      const chunks = chunksOf(turn);
      for (const text of chunks) {
        yield { type: "text_delta", text };
      }
      yield {
        type: "message_complete",
        message: assistantMessage(turn, chunks),
      };
    },
  };
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

function chunksOf(turn: ScriptedTurn): string[] {
  if (turn.chunks) {
    return turn.chunks;
  }
  if (turn.text !== undefined) {
    return [turn.text];
  }
  if (turn.toolCalls || turn.message) {
    return [];
  }
  return ["ok"];
}

function assistantMessage(turn: ScriptedTurn, chunks: string[]): AssistantMessage {
  if (turn.message) {
    return turn.message;
  }
  const content: AssistantContent[] = [];
  if (turn.thinkingChunks && turn.thinkingChunks.length > 0) {
    content.push({ type: "thinking", text: turn.thinkingChunks.join("") });
  }
  if (chunks.length > 0) {
    content.push({ type: "text", text: chunks.join("") });
  }
  for (const call of turn.toolCalls ?? []) {
    content.push({
      type: "tool_call",
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    });
  }
  return {
    type: "assistant",
    id: "asst-scripted",
    content,
  };
}
