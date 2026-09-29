import { expect, test } from "bun:test";
import { createOpenAIModel } from "../src/model/providers/openai.ts";
import { createOpenAICompatibleModel } from "../src/model/providers/openai-compatible.ts";
import { reportedTokens } from "../src/model/model.ts";
import { collect } from "./helpers/scripted-model.ts";
import { encodeSse as openaiSse, sampleRequest as openaiRequest, TEXT_STREAM_EVENTS as openaiText } from "./fixtures/openai.ts";
import { encodeChatCompletionsSse, sampleRequest as compatibleRequest, TEXT_STREAM_CHUNKS } from "./fixtures/openai-compatible.ts";

test("Responses records final usage and keeps missing dimensions unknown", async () => {
  const complete = openaiText.at(-1)!;
  const fixtures = [...openaiText.slice(0, -1), { ...complete, response: { ...complete.response, usage: { input_tokens: 23, output_tokens: 8 } } }];
  const model = createOpenAIModel({ apiKey: "fixture", fetch: async () => new Response(openaiSse(fixtures), { headers: { "Content-Type": "text/event-stream" } }) });
  expect((await collect(model.stream(openaiRequest()))).filter(event => event.type === "usage")).toEqual([
    { type: "usage", usage: { inputTokens: 23, outputTokens: 8 } },
  ]);
  const absent = createOpenAIModel({ apiKey: "fixture", fetch: async () => new Response(openaiSse(openaiText), { headers: { "Content-Type": "text/event-stream" } }) });
  expect((await collect(absent.stream(openaiRequest()))).some(event => event.type === "usage")).toBe(false);
});

test("compatible usage-only SSE chunk is requested and normalized", async () => {
  let includeUsage = false;
  const model = createOpenAICompatibleModel({ baseUrl: "https://example.test/v1", auth: "none", fetch: async (_, init) => {
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
