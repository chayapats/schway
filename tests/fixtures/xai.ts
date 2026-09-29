/** xAI `/v1/models` payload covering listed efforts, a `none` effort, and no reasoning capability. */
export const XAI_MODELS_PAYLOAD = {
  data: [
    {
      id: "grok-4.7",
      context_length: 256_000,
      capabilities: { reasoning_effort: ["low", "medium", "high", "xhigh"] },
      default_reasoning_effort: "high",
    },
    {
      id: "grok-4.5",
      context_length: 128_000,
      capabilities: { reasoning_effort: ["none", "low", "medium", "high"] },
      default_reasoning_effort: "low",
    },
    {
      id: "grok-3",
      context_length: 131_072,
    },
  ],
};

/** Text deltas that assemble to "Hello world". */
export const XAI_TEXT_EVENTS = [
  { type: "response.created", response: { id: "resp_text", status: "in_progress" } },
  { type: "response.output_item.added", output_index: 0, item: { id: "msg_text", type: "message", role: "assistant", status: "in_progress", content: [] } },
  { type: "response.output_text.delta", output_index: 0, delta: "Hello" },
  { type: "response.output_text.delta", output_index: 0, delta: " world" },
  { type: "response.output_item.done", output_index: 0, item: { id: "msg_text", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello world" }] } },
  { type: "response.completed", response: { id: "resp_text", status: "completed", usage: { input_tokens: 3, output_tokens: 2 } } },
];

/** Two function calls emitted together so the agent loop can run them in parallel. */
export const XAI_PARALLEL_TOOL_EVENTS = [
  { type: "response.created", response: { id: "resp_tools", status: "in_progress" } },
  { type: "response.output_item.added", output_index: 0, item: { id: "fc_read", type: "function_call", call_id: "call_read", name: "read", arguments: "", status: "in_progress" } },
  { type: "response.output_item.added", output_index: 1, item: { id: "fc_grep", type: "function_call", call_id: "call_grep", name: "grep", arguments: "", status: "in_progress" } },
  { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":"note.txt"}' },
  { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"pattern":"hello"}' },
  { type: "response.output_item.done", output_index: 0, item: { id: "fc_read", type: "function_call", call_id: "call_read", name: "read", arguments: '{"path":"note.txt"}', status: "completed" } },
  { type: "response.output_item.done", output_index: 1, item: { id: "fc_grep", type: "function_call", call_id: "call_grep", name: "grep", arguments: '{"pattern":"hello"}', status: "completed" } },
  { type: "response.completed", response: { id: "resp_tools", status: "completed" } },
];

/** Reasoning item whose encrypted payload must be replayed verbatim. */
export const XAI_REASONING_ITEM = {
  id: "rs_xai",
  type: "reasoning",
  summary: [{ type: "summary_text", text: "Look at the repo." }],
  encrypted_content: "enc-xai-opaque",
};

/** Reasoning summary plus a following text message. */
export const XAI_REASONING_EVENTS = [
  { type: "response.created", response: { id: "resp_reason", status: "in_progress" } },
  { type: "response.output_item.added", output_index: 0, item: { id: "rs_xai", type: "reasoning", summary: [], encrypted_content: null } },
  { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "Look at the repo." },
  { type: "response.output_item.done", output_index: 0, item: XAI_REASONING_ITEM },
  { type: "response.output_item.added", output_index: 1, item: { id: "msg_reason", type: "message", role: "assistant", status: "in_progress", content: [] } },
  { type: "response.output_text.delta", output_index: 1, delta: "Done." },
  { type: "response.output_item.done", output_index: 1, item: { id: "msg_reason", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done." }] } },
  { type: "response.completed", response: { id: "resp_reason", status: "completed" } },
];

/** Encode Responses events as `text/event-stream` bytes. */
export function encodeXaiSse(events: readonly object[]): string {
  return events.map(event => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}
