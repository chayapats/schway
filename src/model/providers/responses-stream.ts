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
import { reportedTokens } from "../model.ts";
import { HOSTED_ITEMS_KEY, MAX_HOSTED_ITEM_BYTES, MAX_HOSTED_ITEMS, keptHostedItems, serializedBytes, type KeptHostedItem } from "../hosted-tools.ts";
import type {
  HostedTool,
  ModelRequest,
  ModelStreamEvent,
  ModelTool,
  ModelUsage,
} from "../model.ts";

/** Provider metadata namespace a Responses adapter stores and replays. */
export type ResponsesNamespace = "openai" | "xai";

/** Reasoning control already resolved by the calling adapter. */
export type ResponsesReasoning =
  | { effort: "none"; summary?: "auto" }
  | { effort: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"; summary: "auto" };

/** Build one Responses request that stores nothing and asks for encrypted reasoning; hosted tools follow the function tools. */
export function buildResponsesRequest<Reasoning extends ResponsesReasoning | undefined>(input: {
  model: string;
  maxOutputTokens: number;
  reasoning?: Reasoning;
  request: ModelRequest;
  namespace: ResponsesNamespace;
  /** Hosted tools this adapter honors; the caller passes only entries its route accepts. */
  hostedTools?: readonly HostedTool[];
  /** Replay kept hosted items from this namespace at their original positions; off leaves them stored but unsent. */
  replayHostedItems?: boolean;
}) {
  const tools = [
    ...(input.request.tools && input.request.tools.length > 0 ? toResponsesTools(input.request.tools) : []),
    ...toHostedTools(input.hostedTools),
  ];
  return {
    model: input.model,
    stream: true as const,
    store: false as const,
    ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
    instructions: toInstructions(input.request),
    input: toResponsesInput(input.request.items, input.namespace, input.replayHostedItems === true),
    max_output_tokens: input.maxOutputTokens,
    include: ["reasoning.encrypted_content"] as ["reasoning.encrypted_content"],
    ...(tools.length > 0 ? { tools } : {}),
  };
}

/** Fold a Responses SSE stream into Schway events, naming the provider on adapter failures. */
export async function* assembleResponsesStream(input: {
  stream: AsyncIterable<ResponseStreamEvent>;
  namespace: ResponsesNamespace;
  label: string;
}): AsyncIterable<ModelStreamEvent> {
  const builder = createStreamBuilder(input.namespace);
  let sawTerminal = false;
  for await (const event of input.stream) {
    if (event.type === "response.completed" || event.type === "response.incomplete" || event.type === "response.failed") {
      sawTerminal = true;
      const usage = event.response.usage;
      // Searches are counted only from items Schway kept; nothing is inferred when none arrived.
      const searches = builder.hosted().filter(kept => kept.item.type === "web_search_call").length;
      if (usage) yield { type: "usage", usage: { ...responsesUsage(usage), ...(searches > 0 ? { hostedSearchCalls: searches } : {}) } };
    }
    if (event.type === "response.incomplete") {
      throw new Error(`${input.label} response incomplete`);
    }
    if (event.type === "response.failed") {
      throw new Error(event.response.error?.message || `${input.label} response failed`);
    }
    if (event.type === "error") {
      throw new Error(event.message);
    }
    for (const delta of builder.accept(event)) yield delta;
  }
  // A body that ends without a terminal frame is truncated, never complete:
  // emitting message_complete here would certify partial evidence as success.
  if (!sawTerminal) throw new Error(`${input.label} response ended before completion`);
  yield { type: "message_complete", message: builder.complete() };
}

/** Normalize a Responses `usage` object, including cached-input and reasoning subsets; unreported or invalid counters become null. */
export function responsesUsage(usage: unknown): ModelUsage {
  const record = isRecord(usage) ? usage : {};
  const inputDetails = isRecord(record.input_tokens_details) ? record.input_tokens_details : {};
  const outputDetails = isRecord(record.output_tokens_details) ? record.output_tokens_details : {};
  // xAI reports executed server-side tools per kind; a missing counter is left out rather than read as zero.
  const toolDetails = isRecord(record.server_side_tool_usage_details) ? record.server_side_tool_usage_details : {};
  const reportedSearches = reportedTokens(toolDetails.web_search_calls);
  return {
    inputTokens: reportedTokens(record.input_tokens),
    outputTokens: reportedTokens(record.output_tokens),
    cachedInputTokens: reportedTokens(inputDetails.cached_tokens),
    reasoningTokens: reportedTokens(outputDetails.reasoning_tokens),
    ...(reportedSearches !== null ? { reportedHostedSearchCalls: reportedSearches } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stable system prompt plus dynamic context as Responses instructions. */
function toInstructions(request: ModelRequest): string {
  const sections = request.context.map(
    (section) => `<${section.name}>\n${section.content}\n</${section.name}>`,
  );
  return [request.systemPrompt, ...sections].join("\n\n");
}

/** Map Schway tool definitions onto Responses function tools. */
function toResponsesTools(tools: readonly ModelTool[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
  }));
}

/** Map hosted tools onto Responses tool entries, once each, with no extra options. */
function toHostedTools(hosted: readonly HostedTool[] | undefined) {
  return hosted?.includes("web_search") ? [{ type: "web_search" as const }] : [];
}

/**
 * Convert Schway conversation items to Responses input for one metadata namespace.
 * Other providers' reasoning items, hosted items and function-call IDs are omitted.
 */
function toResponsesInput(items: readonly ConversationItem[], namespace: ResponsesNamespace, replayHosted: boolean): ResponseInput {
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
    // Each kept hosted item goes back before the content block that followed it in the original response.
    const hosted = replayHosted ? keptHostedItems(item.providerMetadata?.[namespace]).sort((a, b) => a.position - b.position) : [];
    let next = 0;
    for (const [index, block] of item.content.entries()) {
      while (next < hosted.length && hosted[next]!.position <= index) input.push(hosted[next++]!.item as unknown as ResponseInput[number]);
      if (block.type === "thinking") {
        const reasoning = namespaceField(block.providerMetadata, namespace, "item");
        if (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)) {
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
      const itemId = namespaceField(block.providerMetadata, namespace, "item_id");
      input.push({
        type: "function_call",
        call_id: block.id,
        name: block.name,
        arguments: toToolArguments(block.arguments),
        ...(typeof itemId === "string" && itemId.length > 0 ? { id: itemId } : {}),
      });
    }
    while (next < hosted.length) input.push(hosted[next++]!.item as unknown as ResponseInput[number]);
  }
  return input;
}

/** JSON-stringify tool arguments. Strings are sent unchanged. */
function toToolArguments(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value ?? {}); }
  catch { return "{}"; }
}

/** Read an opaque field from one provider metadata namespace. */
function namespaceField(
  metadata: ProviderMetadata | undefined,
  namespace: ResponsesNamespace,
  key: string,
): unknown {
  const record = metadata?.[namespace];
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  return (record as Record<string, unknown>)[key];
}

/** In-progress output item while assembling a Responses stream. */
type StreamBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; item?: unknown }
  | { type: "tool_call"; id: string; name: string; json: string; itemId?: string }
  | { type: "hosted"; item?: Record<string, unknown> };

/** Accumulate Responses stream events into Schway deltas and a final message. */
function createStreamBuilder(namespace: ResponsesNamespace) {
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
          // Includes response.web_search_call.* progress, which carries no text or thinking.
          return [];
      }
    },
    /** Completed hosted items within the size and count caps, each with the number of content blocks before it. */
    hosted(): KeptHostedItem[] {
      return assemble(blocks, namespace).hosted;
    },
    /** Build the Schway assistant message after the stream ends. */
    complete(): AssistantMessage {
      const { content, hosted } = assemble(blocks, namespace);
      const metadata: Record<string, unknown> = {};
      if (responseId) metadata.response_id = responseId;
      if (status) metadata.status = status;
      if (hosted.length > 0) metadata[HOSTED_ITEMS_KEY] = hosted;
      return {
        type: "assistant",
        id,
        content,
        ...(Object.keys(metadata).length > 0
          ? { providerMetadata: { [namespace]: metadata } }
          : {}),
      };
    },
  };
}

/** Build content blocks in output order and keep hosted items with their position among those blocks. */
function assemble(blocks: readonly StreamBlock[], namespace: ResponsesNamespace): { content: AssistantContent[]; hosted: KeptHostedItem[] } {
  const content: AssistantContent[] = [];
  const hosted: KeptHostedItem[] = [];
  for (const block of blocks) {
    if (!block) continue;
    if (block.type === "hosted") {
      // Only completed items are kept; an oversized item or one past the count cap is dropped, and the message still commits.
      if (block.item && hosted.length < MAX_HOSTED_ITEMS && serializedBytes(block.item) <= MAX_HOSTED_ITEM_BYTES) {
        hosted.push({ position: content.length, item: block.item });
      }
      continue;
    }
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "thinking") {
      if (!block.text && block.item === undefined) continue;
      content.push({
        type: "thinking",
        text: block.text,
        ...(block.item !== undefined
          ? { providerMetadata: { [namespace]: { item: block.item } } }
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
        ? { providerMetadata: { [namespace]: { item_id: block.itemId } } }
        : {}),
    });
  }
  return { content, hosted };
}

/** Keep only the fields a Responses `web_search_call` input item accepts: type, id, status and action. */
function hostedReplayItem(item: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = { type: item.type };
  for (const key of ["id", "status", "action"] as const) if (item[key] !== undefined && item[key] !== null) kept[key] = item[key];
  return kept;
}

/** Open a stream block from an output_item.added payload. */
function startBlock(blocks: StreamBlock[], index: number, item: ResponseOutputItem): void {
  if (item.type === "message") {
    blocks[index] = { type: "text", text: "" };
    return;
  }
  if (item.type === "reasoning") {
    blocks[index] = { type: "thinking", text: "" };
    return;
  }
  if (item.type === "function_call") blocks[index] = toolCallBlock(item);
  else if (item.type === "web_search_call") blocks[index] = { type: "hosted" };
}

/** Finalize a block from output_item.done, capturing reasoning metadata and completed hosted items. */
function finishBlock(blocks: StreamBlock[], index: number, item: ResponseOutputItem): void {
  if (item.type === "web_search_call") {
    blocks[index] = { type: "hosted", item: hostedReplayItem(item as unknown as Record<string, unknown>) };
    return;
  }
  if (item.type === "reasoning") {
    const current = blocks[index];
    const summary = reasoningSummaryText(item);
    if (!current || current.type !== "thinking") {
      blocks[index] = { type: "thinking", text: summary, item };
      return;
    }
    if (current.text.length === 0 && summary.length > 0) current.text = summary;
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
    if (next.id) current.id = next.id;
    if (next.name) current.name = next.name;
    if (next.json.length > 0) current.json = next.json;
    if (next.itemId) current.itemId = next.itemId;
  }
}

/** Join reasoning summary parts when deltas never arrived. */
function reasoningSummaryText(item: ResponseReasoningItem): string {
  return item.summary.map((part) => part.text).filter((text) => text.length > 0).join("\n\n");
}

/** Read call_id, name, and argument JSON from a function_call item. */
function toolCallBlock(item: ResponseFunctionToolCall): Extract<StreamBlock, { type: "tool_call" }> {
  return {
    type: "tool_call",
    id: item.call_id,
    name: item.name,
    json: item.arguments,
    ...(item.id ? { itemId: item.id } : {}),
  };
}

/** Append output_text and emit a text_delta. */
function appendText(blocks: StreamBlock[], index: number, text: string): ModelStreamEvent[] {
  const current = blocks[index];
  if (!current || current.type !== "text") blocks[index] = { type: "text", text };
  else current.text += text;
  return [{ type: "text_delta", text }];
}

/** Append reasoning text and emit a thinking_delta. */
function appendThinking(blocks: StreamBlock[], index: number, text: string): ModelStreamEvent[] {
  const current = blocks[index];
  if (!current || current.type !== "thinking") blocks[index] = { type: "thinking", text };
  else current.text += text;
  return [{ type: "thinking_delta", text }];
}

/** Append streamed function-call argument JSON. */
function appendToolJson(blocks: StreamBlock[], index: number, json: string): void {
  const current = blocks[index];
  if (current && current.type === "tool_call") current.json += json;
}

/** Parse assembled tool JSON. Malformed input is returned as the raw string. */
function parseToolArguments(json: string): unknown {
  if (json.length === 0) return {};
  try { return JSON.parse(json); }
  catch { return json; }
}
