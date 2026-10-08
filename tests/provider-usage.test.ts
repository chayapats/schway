import { expect, test } from "bun:test";
import { createOpenAIModel } from "../src/model/providers/openai.ts";
import { createOpenAICompatibleModel } from "../src/model/providers/openai-compatible.ts";
import { reportedTokens, type ModelUsage } from "../src/model/model.ts";
import { collect } from "./helpers/scripted-model.ts";
import { encodeSse as openaiSse, sampleRequest as openaiRequest, TEXT_STREAM_EVENTS as openaiText } from "./fixtures/openai.ts";
import { createXaiModel } from "../src/model/providers/xai.ts";
import { CODEX_ACCOUNT_CLAIM, createCodexSubscriptionModel } from "../src/model/providers/codex-subscription.ts";
import { encodeXaiSse, XAI_TEXT_EVENTS } from "./fixtures/xai.ts";
import { encodeChatCompletionsSse, sampleRequest as compatibleRequest, TEXT_STREAM_CHUNKS } from "./fixtures/openai-compatible.ts";

test("Responses records final usage and keeps missing dimensions unknown", async () => {
  const complete = openaiText.at(-1)!;
  const fixtures = [...openaiText.slice(0, -1), { ...complete, response: { ...complete.response, usage: { input_tokens: 23, output_tokens: 8 } } }];
  const model = createOpenAIModel({
    model: "gpt-6-astra", apiKey: "fixture", fetch: async () => new Response(openaiSse(fixtures), { headers: { "Content-Type": "text/event-stream" } }) });
  expect((await collect(model.stream(openaiRequest()))).filter(event => event.type === "usage")).toEqual([
    { type: "usage", usage: { inputTokens: 23, outputTokens: 8, cachedInputTokens: null, reasoningTokens: null } },
  ]);
  const absent = createOpenAIModel({
    model: "gpt-6-astra", apiKey: "fixture", fetch: async () => new Response(openaiSse(openaiText), { headers: { "Content-Type": "text/event-stream" } }) });
  expect((await collect(absent.stream(openaiRequest()))).some(event => event.type === "usage")).toBe(false);
});

test("compatible usage-only SSE chunk is requested and normalized", async () => {
  let includeUsage = false;
  const model = createOpenAICompatibleModel({
    model: "gpt-4o", baseUrl: "https://example.test/v1", auth: "none", fetch: async (_, init) => {
    includeUsage = (JSON.parse(String(init?.body)) as { stream_options: { include_usage: boolean } }).stream_options.include_usage;
    return new Response(encodeChatCompletionsSse([...TEXT_STREAM_CHUNKS, { choices: [], usage: { prompt_tokens: 17, completion_tokens: 6 } }]), { headers: { "Content-Type": "text/event-stream" } });
  } });
  expect((await collect(model.stream(compatibleRequest()))).filter(event => event.type === "usage")).toEqual([
    { type: "usage", usage: { inputTokens: 17, outputTokens: 6 } },
  ]);
  expect(includeUsage).toBe(true);
  expect(reportedTokens(undefined)).toBeNull();
  expect(reportedTokens(-1)).toBeNull();
  expect(reportedTokens(1.5)).toBeNull();
});

/** Replace the terminal Responses usage object of a fixture stream. */
function withUsage(events: readonly object[], usage: unknown): object[] {
  const complete = events.at(-1) as { response: Record<string, unknown> };
  return [...events.slice(0, -1), { ...complete, response: { ...complete.response, usage } }];
}

const DETAIL_CASES: Array<{ name: string; usage: unknown; expected: Required<Pick<ModelUsage, "inputTokens" | "outputTokens" | "cachedInputTokens" | "reasoningTokens">> }> = [
  { name: "reported details", usage: { input_tokens: 1200, output_tokens: 300, input_tokens_details: { cached_tokens: 1024 }, output_tokens_details: { reasoning_tokens: 256 } },
    expected: { inputTokens: 1200, outputTokens: 300, cachedInputTokens: 1024, reasoningTokens: 256 } },
  { name: "no detail objects", usage: { input_tokens: 3, output_tokens: 2 },
    expected: { inputTokens: 3, outputTokens: 2, cachedInputTokens: null, reasoningTokens: null } },
  { name: "reported zeros", usage: { input_tokens: 3, output_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    expected: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 0, reasoningTokens: 0 } },
  { name: "negative details", usage: { input_tokens: 3, output_tokens: 2, input_tokens_details: { cached_tokens: -1 }, output_tokens_details: { reasoning_tokens: -4 } },
    expected: { inputTokens: 3, outputTokens: 2, cachedInputTokens: null, reasoningTokens: null } },
  { name: "fractional details", usage: { input_tokens: 3, output_tokens: 2, input_tokens_details: { cached_tokens: 1.5 }, output_tokens_details: { reasoning_tokens: 0.25 } },
    expected: { inputTokens: 3, outputTokens: 2, cachedInputTokens: null, reasoningTokens: null } },
  { name: "string details", usage: { input_tokens: 3, output_tokens: 2, input_tokens_details: { cached_tokens: "2" }, output_tokens_details: { reasoning_tokens: "1" } },
    expected: { inputTokens: 3, outputTokens: 2, cachedInputTokens: null, reasoningTokens: null } },
  { name: "non-object details", usage: { input_tokens: 3, output_tokens: 2, input_tokens_details: 7, output_tokens_details: null },
    expected: { inputTokens: 3, outputTokens: 2, cachedInputTokens: null, reasoningTokens: null } },
];

for (const { name, usage, expected } of DETAIL_CASES) {
  test(`xAI Responses usage with ${name} keeps cached and reasoning subsets exact`, async () => {
    const model = createXaiModel({ apiKey: "fixture", model: "grok-fixture", baseUrl: "https://xai.test/v1",
      fetch: async () => new Response(encodeXaiSse(withUsage(XAI_TEXT_EVENTS, usage)), { headers: { "Content-Type": "text/event-stream" } }) });
    expect((await collect(model.stream(openaiRequest()))).filter(event => event.type === "usage")).toEqual([{ type: "usage", usage: expected }]);
  });

  test(`OpenAI Responses usage with ${name} keeps cached and reasoning subsets exact`, async () => {
    const model = createOpenAIModel({ model: "gpt-6-astra", apiKey: "fixture",
      fetch: async () => new Response(openaiSse(withUsage(openaiText, usage)), { headers: { "Content-Type": "text/event-stream" } }) });
    expect((await collect(model.stream(openaiRequest()))).filter(event => event.type === "usage")).toEqual([{ type: "usage", usage: expected }]);
  });

  test(`ChatGPT subscription usage with ${name} keeps cached and reasoning subsets exact and the opaque usage unchanged`, async () => {
    const events = withUsage([
      { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message" } },
      { type: "response.output_text.delta", output_index: 0, delta: "Hello" },
      { type: "response.output_item.done", output_index: 0, item: { type: "message" } },
      { type: "response.completed", response: { id: "resp_1", status: "completed" } },
    ], usage);
    const body = `${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const accessToken = `${encode({ alg: "none" })}.${encode({ [CODEX_ACCOUNT_CLAIM]: { chatgpt_account_id: "acct-usage" } })}.`;
    const model = createCodexSubscriptionModel({ model: "gpt-5.4", tokens: { accessToken, expiresAt: Date.now() + 3_600_000 },
      fetch: async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }) });
    const collected = await collect(model.stream(openaiRequest()));
    expect(collected.filter(event => event.type === "usage")).toEqual([{ type: "usage", usage: expected }]);
    const complete = collected.at(-1);
    if (complete?.type !== "message_complete") throw new Error("expected message_complete");
    expect((complete.message.providerMetadata?.["codex"] as Record<string, unknown>)["usage"]).toEqual(usage);
  });
}
