import { expect, test } from "bun:test";
import { STABLE_SYSTEM_PROMPT } from "../src/context/prompt.ts";
import { createOpenAIModel } from "../src/model/providers/openai.ts";
import { collect } from "./helpers/scripted-model.ts";
import { readTool } from "../src/tools/read.ts";
import { toPlainJsonSchema } from "../src/tools/schema.ts";
import {
  encodeSse,
  INTERLEAVED_TOOL_STREAM_EVENTS,
  sampleRequest,
  TEXT_STREAM_EVENTS,
  THINKING_STREAM_EVENTS,
  TOOL_USE_STREAM_EVENTS,
  FAILED_STREAM_EVENTS,
} from "./fixtures/openai.ts";

type CapturedRequest = { body?: unknown; calls: number; signal?: AbortSignal };

/** Fake fetch that records the OpenAI request body and returns an SSE fixture. */
function sseFetch(events: readonly object[], captured: CapturedRequest) {
  return async (_input: string | URL | Request, init?: RequestInit) => {
    captured.calls += 1;
    captured.signal = init?.signal ?? undefined;
    captured.body = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(encodeSse(events), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
}

test("createOpenAIModel rejects a missing or blank model ID", () => {
  expect(() => createOpenAIModel({ apiKey: "sk-test" })).toThrow("A model ID is required.");
  expect(() => createOpenAIModel({ apiKey: "sk-test", model: "  " })).toThrow("A model ID is required.");
});

test("converts a Schway request into an OpenAI Responses request", async () => {
  const captured: CapturedRequest = { calls: 0 };
  const model = createOpenAIModel({
    model: "gpt-6-astra",
    apiKey: "sk-test",
    fetch: sseFetch(TEXT_STREAM_EVENTS, captured),
  });

  await collect(model.stream(sampleRequest()));

  expect(captured.calls).toBe(1);
  const body = captured.body as {
    model: string;
    stream: boolean;
    store: boolean;
    instructions: string;
    input: unknown[];
    include: string[];
    max_output_tokens: number;
  };
  expect(body.model).toBe("gpt-6-astra");
  expect(body.stream).toBe(true);
  expect(body.store).toBe(false);
  expect(body.max_output_tokens).toBeGreaterThan(0);
  expect(body.include).toContain("reasoning.encrypted_content");
  expect(body.instructions).toContain(STABLE_SYSTEM_PROMPT);
  expect(body.instructions).toContain("<environment>");
  expect(body.instructions).toContain("Workspace root: /tmp/project");
  expect(body.input).toEqual([
    {
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    },
  ]);
});

test("a user-supplied model ID is sent even when absent from a catalog", async () => {
  const captured: CapturedRequest = { calls: 0 };
  const model = createOpenAIModel({
    apiKey: "sk-test",
    model: "my-custom-gpt",
    fetch: sseFetch(TEXT_STREAM_EVENTS, captured),
  });
  await collect(model.stream(sampleRequest()));
  const body = captured.body as { model: string };
  expect(body.model).toBe("my-custom-gpt");
  expect(model.id).toBe("my-custom-gpt");
  expect(model.provider).toBe("openai");
});

test("converts chunked text stream events into Schway deltas and metadata", async () => {
  const captured: CapturedRequest = { calls: 0 };
  const model = createOpenAIModel({
    model: "gpt-6-astra",
    apiKey: "sk-test",
    fetch: sseFetch(TEXT_STREAM_EVENTS, captured),
  });

  const events = await collect(model.stream(sampleRequest()));
  expect(events.filter((event) => event.type !== "message_complete")).toEqual([
    { type: "text_delta", text: "Hello" },
    { type: "text_delta", text: " world" },
  ]);
  const complete = events.at(-1);
  expect(complete?.type).toBe("message_complete");
  if (complete?.type !== "message_complete") {
    throw new Error("expected message_complete");
  }
  expect(complete.message.content).toEqual([
    { type: "text", text: "Hello world" },
  ]);
  expect(complete.message.providerMetadata).toEqual({
    openai: {
      response_id: "resp_text",
      status: "completed",
    },
  });
});

test("thinking chunks keep opaque provider metadata and survive request round-trip", async () => {
  const captured: CapturedRequest = { calls: 0 };
  const model = createOpenAIModel({
    model: "gpt-6-astra",
    apiKey: "sk-test",
    fetch: sseFetch(THINKING_STREAM_EVENTS, captured),
  });

  const events = await collect(model.stream(sampleRequest()));
  const complete = events.at(-1);
  if (complete?.type !== "message_complete") {
    throw new Error("expected message_complete");
  }
  expect(events).toContainEqual({
    type: "thinking_delta",
    text: "Consider the repo.",
  });
  const thinking = complete.message.content[0];
  expect(thinking).toEqual({
    type: "thinking",
    text: "Consider the repo.",
    providerMetadata: {
      openai: {
        item: {
          id: "rs_abc",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Consider the repo." }],
          encrypted_content: "enc-abc",
        },
      },
    },
  });

  const replay: CapturedRequest = { calls: 0 };
  const replayModel = createOpenAIModel({
    model: "gpt-6-astra",
    apiKey: "sk-test",
    fetch: sseFetch(TEXT_STREAM_EVENTS, replay),
  });
  await collect(
    replayModel.stream({
      ...sampleRequest(),
      items: [...sampleRequest().items, complete.message],
    }),
  );
  const body = replay.body as { input: unknown[] };
  expect(body.input[1]).toEqual({
    id: "rs_abc",
    type: "reasoning",
    summary: [{ type: "summary_text", text: "Consider the repo." }],
    encrypted_content: "enc-abc",
  });
  expect(body.input[2]).toEqual({
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Looks good." }],
  });
});

test("SDK automatic retries are disabled", async () => {
  let calls = 0;
  const model = createOpenAIModel({
    model: "gpt-6-astra",
    apiKey: "sk-test",
    fetch: async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          error: { message: "internal", type: "server_error" },
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  await expect(collect(model.stream(sampleRequest()))).rejects.toThrow();
  expect(calls).toBe(1);
});

test("stream failure surfaces an actionable error without OpenAI wire types as the result", async () => {
  const model = createOpenAIModel({
    model: "gpt-6-astra",
    apiKey: "sk-test",
    fetch: async () => {
      throw new Error("network reset");
    },
  });

  expect(model.provider).toBe("openai");
  await expect(collect(model.stream(sampleRequest()))).rejects.toThrow(
    /Connection error|network reset/,
  );
});

test("failed Responses events become actionable errors", async () => {
  const model = createOpenAIModel({
    model: "gpt-6-astra",
    apiKey: "sk-test",
    fetch: sseFetch(FAILED_STREAM_EVENTS, { calls: 0 }),
  });
  await expect(collect(model.stream(sampleRequest()))).rejects.toThrow(
    /internal overlay failed/,
  );
});

test("the shared AbortSignal reaches provider operations", async () => {
  const captured: CapturedRequest = { calls: 0 };
  const controller = new AbortController();
  let seenSignal: (signal: AbortSignal | undefined) => void;
  const fetchStarted = new Promise<AbortSignal | undefined>((resolve) => {
    seenSignal = resolve;
  });
  const model = createOpenAIModel({
    model: "gpt-6-astra",
    apiKey: "sk-test",
    fetch: async (_input, init) => {
      captured.calls += 1;
      captured.signal = init?.signal ?? undefined;
      seenSignal(init?.signal ?? undefined);
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    },
  });

  const pending = collect(
    model.stream({ ...sampleRequest(), signal: controller.signal }),
  );
  await fetchStarted;
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(captured.calls).toBe(1);
  expect(captured.signal?.aborted).toBe(true);
});

test("includes tool definitions on the OpenAI request", async () => {
  const captured: CapturedRequest = { calls: 0 };
  const model = createOpenAIModel({
    model: "gpt-6-astra",
    apiKey: "sk-test",
    fetch: sseFetch(TEXT_STREAM_EVENTS, captured),
  });
  const schema = toPlainJsonSchema(readTool.inputSchema);
  await collect(
    model.stream({
      ...sampleRequest(),
      tools: [
        {
          name: readTool.name,
          description: readTool.description,
          inputSchema: schema,
        },
      ],
    }),
  );
  const body = captured.body as {
    tools: Array<{
      type: string;
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      strict: boolean;
    }>;
  };
  expect(body.tools).toEqual([
    {
      type: "function",
      name: "read",
      description: readTool.description,
      parameters: schema,
      strict: false,
    },
  ]);
});

test("assembles streamed tool arguments before exposing a complete tool call", async () => {
  const captured: CapturedRequest = { calls: 0 };
  const model = createOpenAIModel({
    model: "gpt-6-astra",
    apiKey: "sk-test",
    fetch: sseFetch(TOOL_USE_STREAM_EVENTS, captured),
  });
  const events = await collect(model.stream(sampleRequest()));
  expect(events.filter((event) => event.type !== "message_complete")).toEqual([
    { type: "text_delta", text: "Let me read that." },
  ]);
  const complete = events.at(-1);
  if (complete?.type !== "message_complete") {
    throw new Error("expected message_complete");
  }
  expect(complete.message.content).toEqual([
    { type: "text", text: "Let me read that." },
    {
      type: "tool_call",
      id: "call_read1",
      name: "read",
      arguments: { path: "note.txt" },
      providerMetadata: { openai: { item_id: "fc_read" } },
    },
  ]);
  expect(complete.message.providerMetadata).toEqual({
    openai: {
      response_id: "resp_tool",
      status: "completed",
    },
  });
});

test("assembles interleaved chunked tool calls without mixing identifiers", async () => {
  const model = createOpenAIModel({
    model: "gpt-6-astra",
    apiKey: "sk-test",
    fetch: sseFetch(INTERLEAVED_TOOL_STREAM_EVENTS, { calls: 0 }),
  });
  const events = await collect(model.stream(sampleRequest()));
  const complete = events.at(-1);
  if (complete?.type !== "message_complete") {
    throw new Error("expected message_complete");
  }
  expect(complete.message.content).toEqual([
    {
      type: "tool_call",
      id: "call_read1",
      name: "read",
      arguments: { path: "note.txt" },
      providerMetadata: { openai: { item_id: "fc_read" } },
    },
    {
      type: "tool_call",
      id: "call_grep1",
      name: "grep",
      arguments: { pattern: "hello" },
      providerMetadata: { openai: { item_id: "fc_grep" } },
    },
  ]);
});

test("round-trips tool calls and tool results on the next OpenAI request", async () => {
  const captured: CapturedRequest = { calls: 0 };
  const model = createOpenAIModel({
    model: "gpt-6-astra",
    apiKey: "sk-test",
    fetch: sseFetch(TEXT_STREAM_EVENTS, captured),
  });
  await collect(
    model.stream({
      ...sampleRequest(),
      items: [
        ...sampleRequest().items,
        {
          type: "assistant",
          id: "a1",
          content: [
            { type: "text", text: "Let me read that." },
            {
              type: "tool_call",
              id: "call_read1",
              name: "read",
              arguments: { path: "note.txt" },
              providerMetadata: { openai: { item_id: "fc_read" } },
            },
          ],
        },
        {
          type: "tool_result",
          id: "tr1",
          toolCallId: "call_read1",
          content: "     1|hello",
          isError: false,
        },
      ],
    }),
  );
  const body = captured.body as { input: unknown[] };
  expect(body.input).toEqual([
    {
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Let me read that." }],
    },
    {
      type: "function_call",
      call_id: "call_read1",
      name: "read",
      arguments: '{"path":"note.txt"}',
      id: "fc_read",
    },
    {
      type: "function_call_output",
      call_id: "call_read1",
      output: "     1|hello",
    },
  ]);
});

test("tool errors round-trip with the same call identifier", async () => {
  const captured: CapturedRequest = { calls: 0 };
  const model = createOpenAIModel({
    model: "gpt-6-astra",
    apiKey: "sk-test",
    fetch: sseFetch(TEXT_STREAM_EVENTS, captured),
  });
  await collect(
    model.stream({
      ...sampleRequest(),
      items: [
        ...sampleRequest().items,
        {
          type: "assistant",
          id: "a1",
          content: [
            {
              type: "tool_call",
              id: "call_bad",
              name: "read",
              arguments: { path: "missing.txt" },
            },
          ],
        },
        {
          type: "tool_result",
          id: "tr1",
          toolCallId: "call_bad",
          content: "File not found: missing.txt",
          isError: true,
        },
      ],
    }),
  );
  const body = captured.body as { input: unknown[] };
  expect(body.input[2]).toEqual({
    type: "function_call_output",
    call_id: "call_bad",
    output: "File not found: missing.txt",
  });
});
