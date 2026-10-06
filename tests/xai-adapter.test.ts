import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runAgentLoop } from "../src/agent/loop.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createJsonlSession, loadJsonlSession, sessionsDirectory } from "../src/session/jsonl.ts";
import { createSession } from "../src/session/session.ts";
import { createXaiModel } from "../src/model/providers/xai.ts";
import { loadProviderModel } from "../src/model/loader.ts";
import { promptCacheKey } from "../src/model/prompt-cache-key.ts";
import { GROK_TOKEN_URL, saveSubscriptionTokens } from "../src/model/providers/grok-subscription.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { grepTool } from "../src/tools/grep.ts";
import { readTool } from "../src/tools/read.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { sampleRequest } from "./fixtures/openai.ts";
import { collect } from "./helpers/scripted-model.ts";
import { withTempDir } from "./helpers.ts";
import {
  encodeXaiSse,
  XAI_PARALLEL_TOOL_EVENTS,
  XAI_REASONING_EVENTS,
  XAI_REASONING_ITEM,
  XAI_TEXT_EVENTS,
} from "./fixtures/xai.ts";

/** Local Responses server that records the request and returns one SSE body. */
function serveResponses(events: readonly object[], status = 200) {
  const seen: Array<{ pathname: string; authorization: string | null; convId: string | null; body: unknown }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = request.method === "GET" ? undefined : await request.json();
      seen.push({ pathname: new URL(request.url).pathname, authorization: request.headers.get("authorization"), convId: request.headers.get("x-grok-conv-id"), body });
      return new Response(status === 200 ? encodeXaiSse(events) : "nope", {
        status,
        headers: status === 200 ? { "Content-Type": "text/event-stream" } : {},
      });
    },
  });
  return { server, seen, baseUrl: `http://127.0.0.1:${server.port}/v1` };
}

test("text deltas assemble and the request uses the xAI Responses path and bearer key", async () => {
  const served = serveResponses(XAI_TEXT_EVENTS);
  try {
    const model = createXaiModel({ apiKey: "xai-test-key", model: "grok-4.7", baseUrl: served.baseUrl });
    expect(model.provider).toBe("xai");
    const events = await collect(model.stream(sampleRequest()));
    expect(events.some(event => event.type === "text_delta" && event.text === "Hello")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "message_complete", message: { content: [{ type: "text", text: "Hello world" }] } });
    expect(served.seen).toHaveLength(1);
    expect(served.seen[0]?.pathname).toBe("/v1/responses");
    expect(served.seen[0]?.authorization).toBe("Bearer xai-test-key");
  } finally { served.server.stop(true); }
});

test("parallel function calls execute and the next request replays both pairs by call_id", async () => {
  await withTempDir(async dir => {
    await writeFile(join(dir, "note.txt"), "hello from workspace\n");
    let calls = 0;
    const bodies: unknown[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        bodies.push(await request.json());
        calls += 1;
        const events = calls === 1 ? XAI_PARALLEL_TOOL_EVENTS : XAI_TEXT_EVENTS;
        return new Response(encodeXaiSse(events), { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    try {
      const model = createXaiModel({ apiKey: "xai-test-key", model: "grok-4.7", baseUrl: `http://127.0.0.1:${server.port}/v1` });
      const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
      const events = await collect(runAgentLoop({
        session: createSession([{ type: "user", id: "u1", content: [{ type: "text", text: "inspect" }] }]),
        model, workspace, contextManager: createContextManager(workspace),
        tools: createToolRegistry([readTool, grepTool]),
      }));
      expect(events.filter(event => event.type === "tool.finished")).toHaveLength(2);
      const second = bodies[1] as { input: Array<{ type?: string; call_id?: string }> };
      const pairs = ["call_read", "call_grep"].map(id => ({
        call: second.input.find(item => item.type === "function_call" && item.call_id === id),
        output: second.input.find(item => item.type === "function_call_output" && item.call_id === id),
      }));
      expect(pairs.every(pair => pair.call && pair.output)).toBe(true);
    } finally { server.stop(true); }
  });
});

test("encrypted reasoning is replayed verbatim and omitted openai or codex items are not sent", async () => {
  const reasoningServer = serveResponses(XAI_REASONING_EVENTS);
  try {
    const model = createXaiModel({ apiKey: "xai-test-key", model: "grok-4.7", baseUrl: reasoningServer.baseUrl, thinking: "high", modelCapability: { id: "grok-4.7", supportedThinking: ["low", "medium", "high", "xhigh"] } });
    const events = await collect(model.stream(sampleRequest()));
    const complete = events.at(-1);
    if (complete?.type !== "message_complete") throw new Error("expected message_complete");
    const replay = serveResponses(XAI_TEXT_EVENTS);
    const replayModel = createXaiModel({ apiKey: "xai-test-key", model: "grok-4.7", baseUrl: replay.baseUrl });
    await collect(replayModel.stream({
      ...sampleRequest(),
      items: [
        ...sampleRequest().items,
        {
          type: "assistant",
          id: "foreign",
          content: [
            { type: "thinking", text: "openai", providerMetadata: { openai: { item: { id: "rs_openai", type: "reasoning", encrypted_content: "enc-openai" } } } },
            { type: "thinking", text: "codex", providerMetadata: { codex: { item: { id: "rs_codex", type: "reasoning", encrypted_content: "enc-codex" } } } },
            { type: "tool_call", id: "call_foreign", name: "read", arguments: { path: "note.txt" }, providerMetadata: { openai: { item_id: "fc_openai" } } },
            { type: "text", text: "foreign" },
          ],
        },
        complete.message,
      ],
    }));
    const input = (replay.seen[0]?.body as { input: Array<Record<string, unknown>> }).input;
    expect(input).toContainEqual(XAI_REASONING_ITEM);
    expect(JSON.stringify(input)).not.toContain("enc-openai");
    expect(JSON.stringify(input)).not.toContain("rs_openai");
    expect(JSON.stringify(input)).not.toContain("fc_openai");
    expect(JSON.stringify(input)).not.toContain("enc-codex");
    const foreignCall = input.find(item => item.type === "function_call" && item.call_id === "call_foreign");
    expect(foreignCall?.id).toBeUndefined();
    replay.server.stop(true);
  } finally { reasoningServer.server.stop(true); }
});

test("a resumed JSONL session replays xAI reasoning and never sends another provider's item", async () => {
  await withTempDir(async dir => {
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const created = await createJsonlSession({ directory: sessionsDirectory(dir), workspace });
    created.append({
      type: "assistant",
      id: "stored",
      content: [
        { type: "thinking", text: "stored", providerMetadata: { xai: { item: XAI_REASONING_ITEM } } },
        { type: "text", text: "kept" },
      ],
    });
    const loaded = await loadJsonlSession({ directory: sessionsDirectory(dir), id: created.header.id });
    const served = serveResponses(XAI_TEXT_EVENTS);
    try {
      const model = createXaiModel({ apiKey: "xai-test-key", model: "grok-4.7", baseUrl: served.baseUrl });
      await collect(model.stream({ ...sampleRequest(), items: loaded.items.filter(item => item.type === "user" || item.type === "assistant" || item.type === "tool_result") }));
      expect((served.seen[0]?.body as { input: unknown[] }).input).toContainEqual(XAI_REASONING_ITEM);
    } finally { served.server.stop(true); }
  });
});

test("unset thinking sends no reasoning field and store stays false", async () => {
  const served = serveResponses(XAI_TEXT_EVENTS);
  try {
    const model = createXaiModel({ apiKey: "xai-test-key", model: "grok-4.7", baseUrl: served.baseUrl });
    await collect(model.stream(sampleRequest()));
    const body = served.seen[0]?.body as { store: boolean; stream: boolean; include: string[]; reasoning?: unknown; max_output_tokens: number };
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(body.max_output_tokens).toBeGreaterThan(0);
    expect(body.reasoning).toBeUndefined();
  } finally { served.server.stop(true); }
});

test("a listed off level sends effort none and an unlisted off sends no reasoning field", async () => {
  const withNone = serveResponses(XAI_TEXT_EVENTS);
  const without = serveResponses(XAI_TEXT_EVENTS);
  try {
    await collect(createXaiModel({
      apiKey: "xai-test-key", model: "grok-4.5", baseUrl: withNone.baseUrl, thinking: "off",
      modelCapability: { id: "grok-4.5", supportedThinking: ["off", "low"], supportsDisabling: true },
    }).stream(sampleRequest()));
    await collect(createXaiModel({
      apiKey: "xai-test-key", model: "grok-3", baseUrl: without.baseUrl, thinking: "off",
      modelCapability: { id: "grok-3", supportedThinking: ["off"] },
    }).stream(sampleRequest()));
    expect((withNone.seen[0]?.body as { reasoning: unknown }).reasoning).toEqual({ effort: "none", summary: "auto" });
    expect((without.seen[0]?.body as { reasoning?: unknown }).reasoning).toBeUndefined();
  } finally { withNone.server.stop(true); without.server.stop(true); }
});

test("HTTP 500 is not retried by the SDK", async () => {
  const served = serveResponses([], 500);
  try {
    const model = createXaiModel({ apiKey: "xai-test-key", model: "grok-4.7", baseUrl: served.baseUrl });
    await expect(collect(model.stream(sampleRequest()))).rejects.toThrow();
    expect(served.seen).toHaveLength(1);
  } finally { served.server.stop(true); }
});

test("abort stops the stream", async () => {
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      calls += 1;
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  });
  const controller = new AbortController();
  try {
    const model = createXaiModel({ apiKey: "xai-test-key", model: "grok-4.7", baseUrl: `http://127.0.0.1:${server.port}/v1` });
    const pending = collect(model.stream({ ...sampleRequest(), signal: controller.signal }));
    await Bun.sleep(20);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(calls).toBe(1);
  } finally { server.stop(true); }
});

test("a missing or blank model ID is rejected before any request", () => {
  expect(() => createXaiModel({ apiKey: "xai-test-key" })).toThrow("A model ID is required.");
  expect(() => createXaiModel({ apiKey: "xai-test-key", model: "  " })).toThrow("A model ID is required.");
});

const CACHE_KEY = promptCacheKey({ rootId: "8a4f1f36-6a43-4c55-9d1e-5b0f2f0c9e11", activeBranchId: "main" });

test("the API-key route sends the conversation key as prompt_cache_key and no x-grok-conv-id header", async () => {
  const served = serveResponses(XAI_TEXT_EVENTS);
  try {
    const model = createXaiModel({ apiKey: "xai-test-key", model: "grok-4.7", baseUrl: served.baseUrl });
    await collect(model.stream(sampleRequest(), { promptCacheKey: CACHE_KEY }));
    const body = served.seen[0]?.body as Record<string, unknown>;
    expect(body.prompt_cache_key).toBe(CACHE_KEY);
    expect(served.seen[0]?.convId).toBeNull();
    // The key is the only addition: the rest of the request shape is unchanged.
    expect(body.store).toBe(false);
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(body).not.toHaveProperty("reasoning");
    expect(body).not.toHaveProperty("previous_response_id");
  } finally { served.server.stop(true); }
});

test("a request without a conversation key, or with a value that is not a derived key, sends no prompt_cache_key", async () => {
  const served = serveResponses(XAI_TEXT_EVENTS);
  try {
    const model = createXaiModel({ apiKey: "xai-test-key", model: "grok-4.7", baseUrl: served.baseUrl });
    await collect(model.stream(sampleRequest()));
    await collect(model.stream(sampleRequest(), {}));
    await collect(model.stream(sampleRequest(), { promptCacheKey: "8a4f1f36-6a43-4c55-9d1e-5b0f2f0c9e11" }));
    expect(served.seen).toHaveLength(3);
    for (const entry of served.seen) {
      expect(entry.body).not.toHaveProperty("prompt_cache_key");
      expect(entry.convId).toBeNull();
    }
  } finally { served.server.stop(true); }
});

test("the Grok subscription route sends the same key on the first request and on the one 401 refresh resend", async () => {
  const store = fakeCredentialStore();
  await saveSubscriptionTokens(store, { accessToken: "old-grok-token", refreshToken: "refresh", obtainedAt: 0 });
  const bodies: Array<Record<string, unknown>> = [];
  const auth: string[] = [];
  const convIds: Array<string | null> = [];
  let refreshes = 0;
  const model = await loadProviderModel({ provider: "xai", model: "grok-4.7", xaiAuth: "grok", grokStore: store }, async (url, init) => {
    if (String(url) === GROK_TOKEN_URL) { refreshes++; return Response.json({ access_token: "renewed-grok-token" }); }
    expect(String(url)).toBe("https://api.x.ai/v1/responses");
    const headers = new Headers(init!.headers);
    bodies.push(JSON.parse(String(init!.body)) as Record<string, unknown>);
    auth.push(headers.get("authorization")!);
    convIds.push(headers.get("x-grok-conv-id"));
    return bodies.length === 1
      ? Response.json({}, { status: 401 })
      : new Response(encodeXaiSse(XAI_TEXT_EVENTS), { headers: { "Content-Type": "text/event-stream" } });
  });
  const events = await collect(model.stream(sampleRequest(), { promptCacheKey: CACHE_KEY }));
  expect(events.at(-1)?.type).toBe("message_complete");
  expect(refreshes).toBe(1);
  expect(auth).toEqual(["Bearer old-grok-token", "Bearer renewed-grok-token"]);
  expect(bodies.map(body => body.prompt_cache_key)).toEqual([CACHE_KEY, CACHE_KEY]);
  expect(bodies[1]).toEqual(bodies[0]!);
  expect(convIds).toEqual([null, null]);
});
