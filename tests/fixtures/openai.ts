import { STABLE_SYSTEM_PROMPT } from "../../src/context/prompt.ts";
import type { ConversationItem } from "../../src/conversation/types.ts";
import type { ModelRequest } from "../../src/model/model.ts";

/** Minimal Responses object fields the adapter reads from stream events. */
function responseStub(id: string, status: "in_progress" | "completed") {
  return {
    id,
    object: "response",
    created_at: 0,
    status,
    model: "gpt-5.4",
    output: [],
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: 1,
    tool_choice: "auto",
    tools: [],
    output_text: "",
  };
}

/** Chunked text stream used to test adapter delta assembly. */
export const TEXT_STREAM_EVENTS = [
  {
    type: "response.created",
    sequence_number: 0,
    response: responseStub("resp_text", "in_progress"),
  },
  {
    type: "response.output_item.added",
    sequence_number: 1,
    output_index: 0,
    item: {
      id: "msg_text",
      type: "message",
      role: "assistant",
      status: "in_progress",
      content: [],
    },
  },
  {
    type: "response.output_text.delta",
    sequence_number: 2,
    output_index: 0,
    content_index: 0,
    item_id: "msg_text",
    delta: "Hello",
    logprobs: [],
  },
  {
    type: "response.output_text.delta",
    sequence_number: 3,
    output_index: 0,
    content_index: 0,
    item_id: "msg_text",
    delta: " world",
    logprobs: [],
  },
  {
    type: "response.output_item.done",
    sequence_number: 4,
    output_index: 0,
    item: {
      id: "msg_text",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Hello world", annotations: [] }],
    },
  },
  {
    type: "response.completed",
    sequence_number: 5,
    response: responseStub("resp_text", "completed"),
  },
];

/** Reasoning summary plus text, including encrypted content for round-trip. */
export const THINKING_STREAM_EVENTS = [
  {
    type: "response.created",
    sequence_number: 0,
    response: responseStub("resp_thinking", "in_progress"),
  },
  {
    type: "response.output_item.added",
    sequence_number: 1,
    output_index: 0,
    item: {
      id: "rs_abc",
      type: "reasoning",
      summary: [],
      encrypted_content: null,
    },
  },
  {
    type: "response.reasoning_summary_text.delta",
    sequence_number: 2,
    output_index: 0,
    summary_index: 0,
    item_id: "rs_abc",
    delta: "Consider the repo.",
  },
  {
    type: "response.output_item.done",
    sequence_number: 3,
    output_index: 0,
    item: {
      id: "rs_abc",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "Consider the repo." }],
      encrypted_content: "enc-abc",
    },
  },
  {
    type: "response.output_item.added",
    sequence_number: 4,
    output_index: 1,
    item: {
      id: "msg_thinking",
      type: "message",
      role: "assistant",
      status: "in_progress",
      content: [],
    },
  },
  {
    type: "response.output_text.delta",
    sequence_number: 5,
    output_index: 1,
    content_index: 0,
    item_id: "msg_thinking",
    delta: "Looks good.",
    logprobs: [],
  },
  {
    type: "response.output_item.done",
    sequence_number: 6,
    output_index: 1,
    item: {
      id: "msg_thinking",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Looks good.", annotations: [] }],
    },
  },
  {
    type: "response.completed",
    sequence_number: 7,
    response: responseStub("resp_thinking", "completed"),
  },
];

/** Streamed function call whose arguments arrive as JSON deltas. */
export const TOOL_USE_STREAM_EVENTS = [
  {
    type: "response.created",
    sequence_number: 0,
    response: responseStub("resp_tool", "in_progress"),
  },
  {
    type: "response.output_item.added",
    sequence_number: 1,
    output_index: 0,
    item: {
      id: "msg_tool",
      type: "message",
      role: "assistant",
      status: "in_progress",
      content: [],
    },
  },
  {
    type: "response.output_text.delta",
    sequence_number: 2,
    output_index: 0,
    content_index: 0,
    item_id: "msg_tool",
    delta: "Let me read that.",
    logprobs: [],
  },
  {
    type: "response.output_item.done",
    sequence_number: 3,
    output_index: 0,
    item: {
      id: "msg_tool",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        { type: "output_text", text: "Let me read that.", annotations: [] },
      ],
    },
  },
  {
    type: "response.output_item.added",
    sequence_number: 4,
    output_index: 1,
    item: {
      id: "fc_read",
      type: "function_call",
      call_id: "call_read1",
      name: "read",
      arguments: "",
      status: "in_progress",
    },
  },
  {
    type: "response.function_call_arguments.delta",
    sequence_number: 5,
    output_index: 1,
    item_id: "fc_read",
    delta: '{"path":',
  },
  {
    type: "response.function_call_arguments.delta",
    sequence_number: 6,
    output_index: 1,
    item_id: "fc_read",
    delta: '"note.txt"}',
  },
  {
    type: "response.output_item.done",
    sequence_number: 7,
    output_index: 1,
    item: {
      id: "fc_read",
      type: "function_call",
      call_id: "call_read1",
      name: "read",
      arguments: '{"path":"note.txt"}',
      status: "completed",
    },
  },
  {
    type: "response.completed",
    sequence_number: 8,
    response: responseStub("resp_tool", "completed"),
  },
];

/** Two function calls with argument JSON interleaved across chunks. */
export const INTERLEAVED_TOOL_STREAM_EVENTS = [
  {
    type: "response.created",
    sequence_number: 0,
    response: responseStub("resp_multi", "in_progress"),
  },
  {
    type: "response.output_item.added",
    sequence_number: 1,
    output_index: 0,
    item: {
      id: "fc_read",
      type: "function_call",
      call_id: "call_read1",
      name: "read",
      arguments: "",
      status: "in_progress",
    },
  },
  {
    type: "response.output_item.added",
    sequence_number: 2,
    output_index: 1,
    item: {
      id: "fc_grep",
      type: "function_call",
      call_id: "call_grep1",
      name: "grep",
      arguments: "",
      status: "in_progress",
    },
  },
  {
    type: "response.function_call_arguments.delta",
    sequence_number: 3,
    output_index: 0,
    item_id: "fc_read",
    delta: '{"path":',
  },
  {
    type: "response.function_call_arguments.delta",
    sequence_number: 4,
    output_index: 1,
    item_id: "fc_grep",
    delta: '{"pattern":',
  },
  {
    type: "response.function_call_arguments.delta",
    sequence_number: 5,
    output_index: 0,
    item_id: "fc_read",
    delta: '"note.txt"}',
  },
  {
    type: "response.function_call_arguments.delta",
    sequence_number: 6,
    output_index: 1,
    item_id: "fc_grep",
    delta: '"hello"}',
  },
  {
    type: "response.output_item.done",
    sequence_number: 7,
    output_index: 0,
    item: {
      id: "fc_read",
      type: "function_call",
      call_id: "call_read1",
      name: "read",
      arguments: '{"path":"note.txt"}',
      status: "completed",
    },
  },
  {
    type: "response.output_item.done",
    sequence_number: 8,
    output_index: 1,
    item: {
      id: "fc_grep",
      type: "function_call",
      call_id: "call_grep1",
      name: "grep",
      arguments: '{"pattern":"hello"}',
      status: "completed",
    },
  },
  {
    type: "response.completed",
    sequence_number: 9,
    response: responseStub("resp_multi", "completed"),
  },
];

/** Failed Responses stream used to test error normalization. */
export const FAILED_STREAM_EVENTS = [
  {
    type: "response.created",
    sequence_number: 0,
    response: responseStub("resp_fail", "in_progress"),
  },
  {
    type: "response.failed",
    sequence_number: 1,
    response: {
      ...responseStub("resp_fail", "completed"),
      status: "failed",
      error: { code: "server_error", message: "internal overlay failed" },
    },
  },
];

/** Encode OpenAI Responses stream events as `text/event-stream` bytes. */
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
