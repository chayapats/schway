import OpenAI from "openai";
import type {
  ResponseFunctionToolCall,
  ResponseInput,
  ResponseOutputItem,
  ResponseReasoningItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import type {
  AssistantContent,
  AssistantMessage,
  ConversationItem,
  ProviderMetadata,
} from "../../conversation/types.ts";
import { DEFAULT_MODEL_IDS } from "../catalog.ts";
import type {
  Model,
  ModelRequest,
  ModelStreamEvent,
  ModelTool,
} from "../model.ts";

/** Default OpenAI model when the caller does not specify one. */
export const DEFAULT_OPENAI_MODEL = DEFAULT_MODEL_IDS.openai;
/** Default max_output_tokens for OpenAI Responses requests. */
export const DEFAULT_OPENAI_MAX_OUTPUT_TOKENS = 16_384;

/** Optional fetch override used by protocol tests. */
type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * OpenAI Responses adapter. Converts Schway requests and stream events,
 * disables SDK retries, and assembles function-call JSON before exposing a call.
 */
export function createOpenAIModel(options: {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  fetch?: FetchLike;
}): Model {
  const modelId = options.model?.trim() || DEFAULT_OPENAI_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_OPENAI_MAX_OUTPUT_TOKENS;
  const client = new OpenAI({
    apiKey: options.apiKey,
    maxRetries: 0,
    logLevel: "off",
    fetch: options.fetch,
  });

  return {
    provider: "openai",
    id: modelId,
    /** Stream Schway events; function-call JSON is assembled before message_complete. */
    async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
      const stream = await client.responses.create(
        {
          model: modelId,
          stream: true,
          store: false,
          instructions: toOpenAIInstructions(request),
          input: toOpenAIInput(request.items),
          max_output_tokens: maxTokens,
          include: ["reasoning.encrypted_content"],
          ...(request.tools && request.tools.length > 0
            ? { tools: toOpenAITools(request.tools) }
            : {}),
        },
        { signal: request.signal },
      );
      const builder = createStreamBuilder();
      for await (const event of stream) {
        if (event.type === "response.failed") {
          throw new Error(failedMessage(event));
        }
        if (event.type === "error") {
          throw new Error(event.message);
        }
        const deltas = builder.accept(event);
        for (const delta of deltas) {
          yield delta;
        }
      }
      yield { type: "message_complete", message: builder.complete() };
    },
  };
}

/** Stable system prompt plus dynamic context as OpenAI instructions. */
function toOpenAIInstructions(request: ModelRequest): string {
  const sections = request.context.map(
    (section) => `<${section.name}>\n${section.content}\n</${section.name}>`,
  );
  return [request.systemPrompt, ...sections].join("\n\n");
}

/** Map Schway tool definitions onto OpenAI function tools. */
function toOpenAITools(tools: readonly ModelTool[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
  }));
}

/**
 * Convert Schway conversation items to OpenAI Responses input.
 * Assistant content is flattened into reasoning, message, and function_call items.
 */
function toOpenAIInput(items: readonly ConversationItem[]): ResponseInput {
  const input: ResponseInput = [];
  for (const item of items) {
    if (item.type === "user") {
      input.push({
        role: "user",
        content: item.content.map((block) => ({
          type: "input_text" as const,
          text: block.text,
        })),
      });
      continue;
    }
    if (item.type === "tool_result") {
      input.push({
        type: "function_call_output",
        call_id: item.toolCallId,
        output: item.content,
      });
      continue;
    }
    for (const block of item.content) {
      if (block.type === "thinking") {
        const reasoning = openaiField(block.providerMetadata, "item");
        if (
          reasoning &&
          typeof reasoning === "object" &&
          !Array.isArray(reasoning)
        ) {
          input.push(reasoning as ResponseInput[number]);
        }
        continue;
      }
      if (block.type === "text") {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: block.text }],
        } as ResponseInput[number]);
        continue;
      }
      const itemId = openaiField(block.providerMetadata, "item_id");
      input.push({
        type: "function_call",
        call_id: block.id,
        name: block.name,
        arguments: toOpenAIToolArguments(block.arguments),
        ...(typeof itemId === "string" && itemId.length > 0 ? { id: itemId } : {}),
      });
    }
  }
  return input;
}

/** JSON-stringify tool arguments. Strings are sent unchanged. */
function toOpenAIToolArguments(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

/** Read an opaque field from `providerMetadata.openai`. */
function openaiField(
  metadata: ProviderMetadata | undefined,
  key: string,
): unknown {
  const openai = metadata?.openai;
  if (!openai || typeof openai !== "object" || Array.isArray(openai)) {
    return undefined;
  }
  return (openai as Record<string, unknown>)[key];
}

/** In-progress output item while assembling an OpenAI Responses stream. */
type StreamBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; item?: unknown }
  | { type: "tool_call"; id: string; name: string; json: string; itemId?: string };

/** Accumulate OpenAI stream events into Schway deltas and a final message. */
function createStreamBuilder() {
  const id = crypto.randomUUID();
  let responseId: string | undefined;
  let status: string | undefined;
  const blocks: StreamBlock[] = [];

  return {
    /** Fold one SSE event into blocks and emit Schway deltas. */
    accept(event: ResponseStreamEvent): ModelStreamEvent[] {
      switch (event.type) {
        case "response.created":
          responseId = event.response.id;
          status = event.response.status;
          return [];
        case "response.output_item.added":
          startBlock(blocks, event.output_index, event.item);
          return [];
        case "response.output_text.delta":
          return appendText(blocks, event.output_index, event.delta);
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta":
          return appendThinking(blocks, event.output_index, event.delta);
        case "response.function_call_arguments.delta":
          appendToolJson(blocks, event.output_index, event.delta);
          return [];
        case "response.output_item.done":
          finishBlock(blocks, event.output_index, event.item);
          return [];
        case "response.completed":
        case "response.incomplete":
          responseId = event.response.id;
          status = event.response.status;
          return [];
        default:
          return [];
      }
    },
    /** Build the Schway assistant message after the stream ends. */
    complete(): AssistantMessage {
      const content: AssistantContent[] = [];
      for (const block of blocks) {
        if (!block) {
          continue;
        }
        if (block.type === "text") {
          content.push({ type: "text", text: block.text });
          continue;
        }
        if (block.type === "thinking") {
          if (!block.text && block.item === undefined) {
            continue;
          }
          content.push({
            type: "thinking",
            text: block.text,
            ...(block.item !== undefined
              ? { providerMetadata: { openai: { item: block.item } } }
              : {}),
          });
          continue;
        }
        content.push({
          type: "tool_call",
          id: block.id,
          name: block.name,
          arguments: parseToolArguments(block.json),
          ...(block.itemId
            ? { providerMetadata: { openai: { item_id: block.itemId } } }
            : {}),
        });
      }
      const openai: Record<string, unknown> = {};
      if (responseId) {
        openai.response_id = responseId;
      }
      if (status) {
        openai.status = status;
      }
      return {
        type: "assistant",
        id,
        content,
        ...(Object.keys(openai).length > 0
          ? { providerMetadata: { openai } }
          : {}),
      };
    },
  };
}

/** Open a stream block from an output_item.added payload. */
function startBlock(
  blocks: StreamBlock[],
  index: number,
  item: ResponseOutputItem,
): void {
  if (item.type === "message") {
    blocks[index] = { type: "text", text: "" };
    return;
  }
  if (item.type === "reasoning") {
    blocks[index] = { type: "thinking", text: "" };
    return;
  }
  if (item.type === "function_call") {
    blocks[index] = toolCallBlock(item);
  }
}

/** Finalize a block from output_item.done, capturing reasoning metadata. */
function finishBlock(
  blocks: StreamBlock[],
  index: number,
  item: ResponseOutputItem,
): void {
  if (item.type === "reasoning") {
    const current = blocks[index];
    const summary = reasoningSummaryText(item);
    if (!current || current.type !== "thinking") {
      blocks[index] = {
        type: "thinking",
        text: summary,
        item,
      };
      return;
    }
    if (current.text.length === 0 && summary.length > 0) {
      current.text = summary;
    }
    current.item = item;
    return;
  }
  if (item.type === "function_call") {
    const next = toolCallBlock(item);
    const current = blocks[index];
    if (!current || current.type !== "tool_call") {
      blocks[index] = next;
      return;
    }
    if (next.id) {
      current.id = next.id;
    }
    if (next.name) {
      current.name = next.name;
    }
    if (next.json.length > 0) {
      current.json = next.json;
    }
    if (next.itemId) {
      current.itemId = next.itemId;
    }
  }
}

/** Join reasoning summary parts when deltas never arrived. */
function reasoningSummaryText(item: ResponseReasoningItem): string {
  return item.summary
    .map((part) => part.text)
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/** Read call_id, name, and argument JSON from a function_call item. */
function toolCallBlock(
  item: ResponseFunctionToolCall,
): Extract<StreamBlock, { type: "tool_call" }> {
  return {
    type: "tool_call",
    id: item.call_id,
    name: item.name,
    json: item.arguments,
    ...(item.id ? { itemId: item.id } : {}),
  };
}

/** Append output_text and emit a text_delta. */
function appendText(
  blocks: StreamBlock[],
  index: number,
  text: string,
): ModelStreamEvent[] {
  const current = blocks[index];
  if (!current || current.type !== "text") {
    blocks[index] = { type: "text", text };
  } else {
    current.text += text;
  }
  return [{ type: "text_delta", text }];
}

/** Append reasoning text and emit a thinking_delta. */
function appendThinking(
  blocks: StreamBlock[],
  index: number,
  text: string,
): ModelStreamEvent[] {
  const current = blocks[index];
  if (!current || current.type !== "thinking") {
    blocks[index] = { type: "thinking", text };
  } else {
    current.text += text;
  }
  return [{ type: "thinking_delta", text }];
}

/** Append streamed function-call argument JSON. */
function appendToolJson(
  blocks: StreamBlock[],
  index: number,
  json: string,
): void {
  const current = blocks[index];
  if (current && current.type === "tool_call") {
    current.json += json;
  }
}

/** Parse assembled tool JSON. Malformed input is returned as the raw string. */
function parseToolArguments(json: string): unknown {
  if (json.length === 0) {
    return {};
  }
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

/** Human-readable message for a failed Responses stream. */
function failedMessage(
  event: Extract<ResponseStreamEvent, { type: "response.failed" }>,
): string {
  return event.response.error?.message || "OpenAI response failed";
}
