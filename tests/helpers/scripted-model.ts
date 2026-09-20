import type { AssistantMessage } from "../../src/conversation/types.ts";
import type { Model, ModelStreamEvent } from "../../src/model/model.ts";

export interface ScriptedModelOptions {
  provider?: string;
  id?: string;
  text?: string;
  chunks?: string[];
  thinkingChunks?: string[];
  error?: string;
  message?: AssistantMessage;
}

export function createScriptedModel(options: ScriptedModelOptions = {}): Model {
  const id = options.id ?? "scripted";
  const provider = options.provider ?? "scripted";
  const chunks = options.chunks ?? (options.text !== undefined ? [options.text] : ["ok"]);

  return {
    provider,
    id,
    async *stream(): AsyncIterable<ModelStreamEvent> {
      if (options.error) {
        throw new Error(options.error);
      }
      for (const thinking of options.thinkingChunks ?? []) {
        yield { type: "thinking_delta", text: thinking };
      }
      for (const text of chunks) {
        yield { type: "text_delta", text };
      }
      yield {
        type: "message_complete",
        message:
          options.message ??
          ({
            type: "assistant",
            id: "asst-scripted",
            content: [
              ...(options.thinkingChunks
                ? [
                    {
                      type: "thinking" as const,
                      text: options.thinkingChunks.join(""),
                    },
                  ]
                : []),
              { type: "text", text: chunks.join("") },
            ],
          } satisfies AssistantMessage),
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
