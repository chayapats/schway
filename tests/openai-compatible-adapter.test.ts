import { expect, test } from "bun:test";
import { STABLE_SYSTEM_PROMPT } from "../src/context/prompt.ts";
import {
  createOpenAICompatibleModel,
  DEFAULT_OPENAI_COMPATIBLE_MODEL,
} from "../src/model/providers/openai-compatible.ts";
import { collect } from "./helpers/scripted-model.ts";
import { readTool } from "../src/tools/read.ts";
import { toPlainJsonSchema } from "../src/tools/schema.ts";
import {
  encodeChatCompletionsSse,
  INTERLEAVED_TOOL_STREAM_CHUNKS,
  sampleRequest,
  TEXT_STREAM_CHUNKS,
  TOOL_USE_STREAM_CHUNKS,
} from "./fixtures/openai-compatible.ts";

type CapturedRequest = {
  url?: string;
  method?: string;
  body?: unknown;
  headers?: Headers;
  calls: number;
  signal?: AbortSignal;
};

/** Fake fetch that records the Chat Completions request and returns an SSE fixture. */
function sseFetch(chunks: readonly object[], captured: CapturedRequest) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    captured.calls += 1;
    captured.url = String(input);
    captured.method = init?.method;
    captured.signal = init?.signal ?? undefined;
    captured.headers = new Headers(init?.headers);
    captured.body = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(encodeChatCompletionsSse(chunks), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
}

test("converts a Schway request into a Chat Completions request at the custom base URL", async () => {
  const captured: CapturedRequest = { calls: 0 };
  const model = createOpenAICompatibleModel({
    baseUrl: "http://127.0.0.1:11434/v1",
    fetch: sseFetch(TEXT_STREAM_CHUNKS, captured),
  });

  await collect(model.stream(sampleRequest()));

  expect(model.provider).toBe("openai-compatible");
  expect(model.id).toBe(DEFAULT_OPENAI_COMPATIBLE_MODEL);
  expect(captured.calls).toBe(1);
  expect(captured.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
  expect(captured.method).toBe("POST");
  const body = captured.body as {
    model: string;
    stream: boolean;
    messages: unknown[];
  };
  expect(body.model).toBe(DEFAULT_OPENAI_COMPATIBLE_MODEL);
  expect(body.stream).toBe(true);
  expect(body.messages).toEqual([
    {
      role: "system",
      content: `${STABLE_SYSTEM_PROMPT}\n\n<environment>\nWorkspace root: /tmp/project\nLaunch directory: /tmp/project\n</environment>`,
    },
    {
      role: "user",
      content: "hello",
    },
  ]);
});

test("a user-supplied model ID is sent even when absent from a catalog", async () => {
  const captured: CapturedRequest = { calls: 0 };
  const model = createOpenAICompatibleModel({
    baseUrl: "http://127.0.0.1:8080/v1",
    model: "llama3.2",
    fetch: sseFetch(TEXT_STREAM_CHUNKS, captured),
  });
  await collect(model.stream(sampleRequest()));
  const body = captured.body as { model: string };
  expect(body.model).toBe("llama3.2");
  expect(model.id).toBe("llama3.2");
  expect(model.provider).toBe("openai-compatible");
});

test("converts chunked text stream events into Schway deltas", async () => {
  const model = createOpenAICompatibleModel({
    baseUrl: "http://127.0.0.1:8080/v1",
    fetch: sseFetch(TEXT_STREAM_CHUNKS, { calls: 0 }),
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
});

test("includes tool definitions on the Chat Completions request", async () => {
  const captured: CapturedRequest = { calls: 0 };
  const model = createOpenAICompatibleModel({
    baseUrl: "http://127.0.0.1:8080/v1",
    fetch: sseFetch(TEXT_STREAM_CHUNKS, captured),
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
      function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
      };
    }>;
  };
  expect(body.tools).toEqual([
    {
      type: "function",
      function: {
        name: "read",
        description: readTool.description,
        parameters: schema,
      },
    },
  ]);
});

test("assembles streamed tool arguments before exposing a complete tool call", async () => {
  const model = createOpenAICompatibleModel({
    baseUrl: "http://127.0.0.1:8080/v1",
    fetch: sseFetch(TOOL_USE_STREAM_CHUNKS, { calls: 0 }),
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
    },
  ]);
});

test("assembles interleaved chunked tool calls without mixing identifiers", async () => {
  const model = createOpenAICompatibleModel({
    baseUrl: "http://127.0.0.1:8080/v1",
    fetch: sseFetch(INTERLEAVED_TOOL_STREAM_CHUNKS, { calls: 0 }),
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
    },
    {
      type: "tool_call",
      id: "call_grep1",
      name: "grep",
      arguments: { pattern: "hello" },
    },
  ]);
});

test("round-trips tool calls and tool results on the next Chat Completions request", async () => {
  const captured: CapturedRequest = { calls: 0 };
  const model = createOpenAICompatibleModel({
    baseUrl: "http://127.0.0.1:8080/v1",
    fetch: sseFetch(TEXT_STREAM_CHUNKS, captured),
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
  const body = captured.body as { messages: unknown[] };
  expect(body.messages.slice(1)).toEqual([
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: "Let me read that.",
      tool_calls: [
        {
          id: "call_read1",
          type: "function",
          function: { name: "read", arguments: '{"path":"note.txt"}' },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_read1",
      content: "     1|hello",
    },
  ]);
});

test("sends custom headers and extra request-body parameters", async () => {
  const captured: CapturedRequest = { calls: 0 };
  const model = createOpenAICompatibleModel({
    baseUrl: "http://127.0.0.1:8080/v1/",
    headers: { "X-Test-Header": "ok" },
    extraBody: { temperature: 0.2, stream: false },
    fetch: sseFetch(TEXT_STREAM_CHUNKS, captured),
  });
  await collect(model.stream(sampleRequest()));
  expect(captured.url).toBe("http://127.0.0.1:8080/v1/chat/completions");
  expect(captured.headers?.get("X-Test-Header")).toBe("ok");
  const body = captured.body as {
    temperature: number;
    stream: boolean;
    messages: unknown;
  };
  expect(body.temperature).toBe(0.2);
  expect(body.stream).toBe(true);
  expect(Array.isArray(body.messages)).toBe(true);
});

test("optional auth sends a bearer token only when an API key is present", async () => {
  const withoutKey: CapturedRequest = { calls: 0 };
  await collect(
    createOpenAICompatibleModel({
      baseUrl: "http://127.0.0.1:8080/v1",
      auth: "optional",
      fetch: sseFetch(TEXT_STREAM_CHUNKS, withoutKey),
    }).stream(sampleRequest()),
  );
  expect(withoutKey.headers?.has("Authorization")).toBe(false);

  const withKey: CapturedRequest = { calls: 0 };
  await collect(
    createOpenAICompatibleModel({
      baseUrl: "http://127.0.0.1:8080/v1",
      auth: "optional",
      apiKey: "sk-local",
      fetch: sseFetch(TEXT_STREAM_CHUNKS, withKey),
    }).stream(sampleRequest()),
  );
  expect(withKey.headers?.get("Authorization")).toBe("Bearer sk-local");
});

test("absent auth never sends Authorization even when an API key is provided", async () => {
  const captured: CapturedRequest = { calls: 0 };
  await collect(
    createOpenAICompatibleModel({
      baseUrl: "http://127.0.0.1:8080/v1",
      auth: "none",
      apiKey: "sk-local",
      fetch: sseFetch(TEXT_STREAM_CHUNKS, captured),
    }).stream(sampleRequest()),
  );
  expect(captured.headers?.has("Authorization")).toBe(false);
});

test("required auth sends a bearer token and fails without a key", async () => {
  const captured: CapturedRequest = { calls: 0 };
  await collect(
    createOpenAICompatibleModel({
      baseUrl: "http://127.0.0.1:8080/v1",
      auth: "required",
      apiKey: "sk-required",
      fetch: sseFetch(TEXT_STREAM_CHUNKS, captured),
    }).stream(sampleRequest()),
  );
  expect(captured.headers?.get("Authorization")).toBe("Bearer sk-required");

  const missing = createOpenAICompatibleModel({
    baseUrl: "http://127.0.0.1:8080/v1",
    auth: "required",
    fetch: sseFetch(TEXT_STREAM_CHUNKS, { calls: 0 }),
  });
  await expect(collect(missing.stream(sampleRequest()))).rejects.toThrow(
    /Missing API key for OpenAI-compatible endpoint/,
  );
});

test("AbortSignal cancels the request and stream consumption", async () => {
  const captured: CapturedRequest = { calls: 0 };
  const controller = new AbortController();
  let seenSignal: (signal: AbortSignal | undefined) => void;
  const fetchStarted = new Promise<AbortSignal | undefined>((resolve) => {
    seenSignal = resolve;
  });
  const model = createOpenAICompatibleModel({
    baseUrl: "http://127.0.0.1:8080/v1",
    fetch: async (input, init) => {
      captured.calls += 1;
      captured.url = String(input);
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

test("AbortSignal stops consuming an in-flight SSE body", async () => {
  const controller = new AbortController();
  let released = false;
  const model = createOpenAICompatibleModel({
    baseUrl: "http://127.0.0.1:8080/v1",
    fetch: async () => {
      const stream = new ReadableStream({
        start(streamController) {
          streamController.enqueue(
            new TextEncoder().encode('data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n'),
          );
        },
        cancel() {
          released = true;
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  const pending = collect(
    model.stream({ ...sampleRequest(), signal: controller.signal }),
  );
  await Bun.sleep(5);
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(released).toBe(true);
});

test("transport failures are not retried by the adapter", async () => {
  let calls = 0;
  const model = createOpenAICompatibleModel({
    baseUrl: "http://127.0.0.1:8080/v1",
    fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "internal" } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  await expect(collect(model.stream(sampleRequest()))).rejects.toThrow(/internal/);
  expect(calls).toBe(1);
});

test("authentication failures are actionable and do not reveal credentials", async () => {
  const secret = "sk-secret-credential";
  const model = createOpenAICompatibleModel({
    baseUrl: "http://127.0.0.1:8080/v1",
    apiKey: secret,
    fetch: async () =>
      new Response(
        JSON.stringify({
          error: { message: `Incorrect API key provided: ${secret}` },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
  });
  try {
    await collect(model.stream(sampleRequest()));
    throw new Error("expected authentication failure");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toMatch(/authentication failed/i);
    expect(message.includes(secret)).toBe(false);
  }
});

test("endpoint errors redact credential header values", async () => {
  const secret = "hdr-secret-credential";
  const model = createOpenAICompatibleModel({
    baseUrl: "http://127.0.0.1:8080/v1",
    auth: "none",
    headers: { "X-Api-Key": secret },
    fetch: async () =>
      new Response(
        JSON.stringify({
          error: { message: `Incorrect API key provided: ${secret}` },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
  });
  try {
    await collect(model.stream(sampleRequest()));
    throw new Error("expected authentication failure");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toMatch(/authentication failed/i);
    expect(message.includes(secret)).toBe(false);
  }
});

test("completing on [DONE] cancels the remaining SSE body", async () => {
  let released = false;
  const payload = encodeChatCompletionsSse(TEXT_STREAM_CHUNKS);
  const model = createOpenAICompatibleModel({
    baseUrl: "http://127.0.0.1:8080/v1",
    fetch: async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload));
        },
        cancel() {
          released = true;
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  const events = await collect(model.stream(sampleRequest()));
  expect(events.at(-1)?.type).toBe("message_complete");
  expect(released).toBe(true);
});

test("malformed SSE produces an actionable error", async () => {
  const model = createOpenAICompatibleModel({
    baseUrl: "http://127.0.0.1:8080/v1",
    fetch: async () =>
      new Response("data: {not-json\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
  });
  await expect(collect(model.stream(sampleRequest()))).rejects.toThrow(
    /Malformed SSE/,
  );
});

test("truncated SSE produces an actionable error", async () => {
  const model = createOpenAICompatibleModel({
    baseUrl: "http://127.0.0.1:8080/v1",
    fetch: async () =>
      new Response("data: {\"id\":\"chatcmpl-1\"", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
  });
  await expect(collect(model.stream(sampleRequest()))).rejects.toThrow(
    /Truncated SSE/,
  );
});

test("assembles text across split SSE frames", async () => {
  const payload = encodeChatCompletionsSse(TEXT_STREAM_CHUNKS);
  const bytes = new TextEncoder().encode(payload);
  const model = createOpenAICompatibleModel({
    baseUrl: "http://127.0.0.1:8080/v1",
    fetch: async () => {
      let offset = 0;
      const stream = new ReadableStream({
        pull(controller) {
          if (offset >= bytes.length) {
            controller.close();
            return;
          }
          const end = Math.min(offset + 7, bytes.length);
          controller.enqueue(bytes.slice(offset, end));
          offset = end;
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  const events = await collect(model.stream(sampleRequest()));
  expect(events.filter((event) => event.type !== "message_complete")).toEqual([
    { type: "text_delta", text: "Hello" },
    { type: "text_delta", text: " world" },
  ]);
});
