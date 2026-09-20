import { STABLE_SYSTEM_PROMPT } from "../../src/context/prompt.ts";
import type { ConversationItem } from "../../src/conversation/types.ts";
import type { ModelRequest } from "../../src/model/model.ts";

/** Chunked text stream used to test adapter delta assembly. */
export const TEXT_STREAM_EVENTS = [
  {
    type: "message_start",
    message: {
      id: "msg_01ABC",
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-sonnet-4-5",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 1 },
    },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Hello" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: " world" },
  },
  {
    type: "content_block_stop",
    index: 0,
  },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 2 },
  },
  {
    type: "message_stop",
  },
];

/** Thinking plus text stream, including a signature delta. */
export const THINKING_STREAM_EVENTS = [
  {
    type: "message_start",
    message: {
      id: "msg_thinking",
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-sonnet-4-5",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 1 },
    },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "", signature: "" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "Consider the repo." },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "signature_delta", signature: "sig-abc" },
  },
  {
    type: "content_block_stop",
    index: 0,
  },
  {
    type: "content_block_start",
    index: 1,
    content_block: { type: "text", text: "" },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "text_delta", text: "Looks good." },
  },
  {
    type: "content_block_stop",
    index: 1,
  },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 8 },
  },
  {
    type: "message_stop",
  },
];

/** Streamed tool_use whose input JSON arrives as partial_json deltas. */
export const TOOL_USE_STREAM_EVENTS = [
  {
    type: "message_start",
    message: {
      id: "msg_tool",
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-sonnet-4-5",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 30, output_tokens: 1 },
    },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Let me read that." },
  },
  {
    type: "content_block_stop",
    index: 0,
  },
  {
    type: "content_block_start",
    index: 1,
    content_block: {
      type: "tool_use",
      id: "toolu_01READ",
      name: "read",
      input: {},
    },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"path":' },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '"note.txt"}' },
  },
  {
    type: "content_block_stop",
    index: 1,
  },
  {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 16 },
  },
  {
    type: "message_stop",
  },
];

/** Encode Anthropic stream events as `text/event-stream` bytes. */
export function encodeSse(events: readonly object[]): string {
  return events
    .map((event) => {
      const type = (event as { type: string }).type;
      return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
}

/** Minimal Schway model request used by adapter protocol tests. */
export function sampleRequest(): ModelRequest {
  return {
    systemPrompt: STABLE_SYSTEM_PROMPT,
    context: [
      {
        name: "environment",
        content: "Workspace root: /tmp/project\nLaunch directory: /tmp/project",
      },
    ],
    items: [
      {
        type: "user",
        id: "u1",
        content: [{ type: "text", text: "hello" }],
      },
    ] satisfies ConversationItem[],
  };
}
