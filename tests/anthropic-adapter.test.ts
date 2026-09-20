import { expect, test } from "bun:test";
import { STABLE_SYSTEM_PROMPT } from "../src/context/prompt.ts";
import {
  createAnthropicModel,
  DEFAULT_ANTHROPIC_MODEL,
} from "../src/model/providers/anthropic.ts";
import { collect } from "./helpers/scripted-model.ts";
import {
  encodeSse,
  sampleRequest,
  TEXT_STREAM_EVENTS,
  THINKING_STREAM_EVENTS,
} from "./fixtures/anthropic.ts";

type CapturedRequest = { body?: unknown; calls: number };

function sseFetch(events: readonly object[], captured: CapturedRequest) {
  return async (_input: string | URL | Request, init?: RequestInit) => {
    captured.calls += 1;
    captured.body = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(encodeSse(events), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
}

test("converts a Schway request into an Anthropic Messages request", async () => {
  const captured: CapturedRequest = { calls: 0 };
  const model = createAnthropicModel({
    apiKey: "sk-test",
    fetch: sseFetch(TEXT_STREAM_EVENTS, captured),
  });

  await collect(model.stream(sampleRequest()));

  expect(captured.calls).toBe(1);
  const body = captured.body as {
    model: string;
    max_tokens: number;
    stream: boolean;
    system: Array<{ type: string; text: string }>;
    messages: Array<{ role: string; content: unknown }>;
  };
  expect(body.model).toBe(DEFAULT_ANTHROPIC_MODEL);
  expect(body.stream).toBe(true);
  expect(body.max_tokens).toBeGreaterThan(0);
  expect(body.system[0]).toEqual({ type: "text", text: STABLE_SYSTEM_PROMPT });
  expect(body.system[1]).toEqual({
    type: "text",
    text: "<environment>\nWorkspace root: /tmp/project\nLaunch directory: /tmp/project\n</environment>",
  });
  expect(body.messages).toEqual([
    {
      role: "user",
      content: [{ type: "text", text: "hello" }],
    },
  ]);
});

test("converts chunked text stream events into Schway deltas and metadata", async () => {
  const captured: CapturedRequest = { calls: 0 };
  const model = createAnthropicModel({
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
    anthropic: {
      message_id: "msg_01ABC",
      stop_reason: "end_turn",
    },
  });
});

test("thinking chunks keep opaque provider metadata and survive request round-trip", async () => {
  const captured: CapturedRequest = { calls: 0 };
  const model = createAnthropicModel({
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
    providerMetadata: { anthropic: { signature: "sig-abc" } },
  });

  const replay: CapturedRequest = { calls: 0 };
  const replayModel = createAnthropicModel({
    apiKey: "sk-test",
    fetch: sseFetch(TEXT_STREAM_EVENTS, replay),
  });
  await collect(
    replayModel.stream({
      ...sampleRequest(),
      items: [...sampleRequest().items, complete.message],
    }),
  );
  const body = replay.body as {
    messages: Array<{ role: string; content: unknown }>;
  };
  expect(body.messages[1]).toEqual({
    role: "assistant",
    content: [
      {
        type: "thinking",
        thinking: "Consider the repo.",
        signature: "sig-abc",
      },
      { type: "text", text: "Looks good." },
    ],
  });
});

test("SDK automatic retries are disabled", async () => {
  let calls = 0;
  const model = createAnthropicModel({
    apiKey: "sk-test",
    fetch: async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "api_error", message: "internal" },
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  await expect(collect(model.stream(sampleRequest()))).rejects.toThrow();
  expect(calls).toBe(1);
});

test("stream failure surfaces an actionable error without Anthropic wire types as the result", async () => {
  const model = createAnthropicModel({
    apiKey: "sk-test",
    fetch: async () => {
      throw new Error("network reset");
    },
  });

  expect(model.provider).toBe("anthropic");
  await expect(collect(model.stream(sampleRequest()))).rejects.toThrow(
    /Connection error/,
  );
});
