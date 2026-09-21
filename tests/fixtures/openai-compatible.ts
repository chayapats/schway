import { STABLE_SYSTEM_PROMPT } from "../../src/context/prompt.ts";
import type { ConversationItem } from "../../src/conversation/types.ts";
import type { ModelRequest } from "../../src/model/model.ts";

/** One Chat Completions SSE chunk. */
function chunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  id = "chatcmpl-text",
) {
  return {
    id,
    object: "chat.completion.chunk",
    created: 0,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };
}

/** Chunked text stream used to test adapter delta assembly. */
export const TEXT_STREAM_CHUNKS = [
  chunk({ role: "assistant", content: "" }),
  chunk({ content: "Hello" }),
  chunk({ content: " world" }),
  chunk({}, "stop"),
];

/** Streamed tool-call arguments assembled across Chat Completions chunks. */
export const TOOL_USE_STREAM_CHUNKS = [
  chunk({ role: "assistant", content: "Let me read that." }, null, "chatcmpl-tool"),
  chunk(
    {
      tool_calls: [
        {
          index: 0,
          id: "call_read1",
          type: "function",
          function: { name: "read", arguments: "" },
        },
      ],
    },
    null,
    "chatcmpl-tool",
  ),
  chunk(
    {
      tool_calls: [
        {
          index: 0,
          function: { arguments: '{"path":"' },
        },
      ],
    },
    null,
    "chatcmpl-tool",
  ),
  chunk(
    {
      tool_calls: [
        {
          index: 0,
          function: { arguments: 'note.txt"}' },
        },
      ],
    },
    null,
    "chatcmpl-tool",
  ),
  chunk({}, "tool_calls", "chatcmpl-tool"),
];

/** Interleaved tool calls that must keep identifiers and JSON separate. */
export const INTERLEAVED_TOOL_STREAM_CHUNKS = [
  chunk(
    {
      tool_calls: [
        {
          index: 0,
          id: "call_read1",
          type: "function",
          function: { name: "read", arguments: "" },
        },
      ],
    },
    null,
    "chatcmpl-multi",
  ),
  chunk(
    {
      tool_calls: [
        {
          index: 1,
          id: "call_grep1",
          type: "function",
          function: { name: "grep", arguments: "" },
        },
      ],
    },
    null,
    "chatcmpl-multi",
  ),
  chunk(
    {
      tool_calls: [
        { index: 0, function: { arguments: '{"path":"note.txt"}' } },
        { index: 1, function: { arguments: '{"pattern":"hello"}' } },
      ],
    },
    null,
    "chatcmpl-multi",
  ),
  chunk({}, "tool_calls", "chatcmpl-multi"),
];

/** Encode Chat Completions chunks as `text/event-stream` bytes, including [DONE]. */
export function encodeChatCompletionsSse(chunks: readonly object[]): string {
  return `${chunks
    .map((entry) => `data: ${JSON.stringify(entry)}\n\n`)
    .join("")}data: [DONE]\n\n`;
}

/** Minimal Schway model request used by compatible-adapter protocol tests. */
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
