import { expect, test } from "bun:test";
import { access } from "node:fs/promises";
import type { Model, ModelRequest } from "../src/model/model.ts";
import type { CredentialStore } from "../src/auth/store.ts";
import { runLiveSmoke, type SmokeSelection } from "../src/live/smoke.ts";
import { collect, createScriptedModel } from "./helpers/scripted-model.ts";
import { boundedSmokeFetch, MAX_SMOKE_WIRE_BYTES } from "../src/live/transport.ts";
import { sampleRequest } from "./fixtures/openai-compatible.ts";
import { loadProviderModel } from "../src/model/loader.ts";
import { encodeChatCompletionsSse, TEXT_STREAM_CHUNKS } from "./fixtures/openai-compatible.ts";
import { encodeSse as encodeAnthropicSse, TEXT_STREAM_EVENTS as ANTHROPIC_TEXT_EVENTS } from "./fixtures/anthropic.ts";
import { encodeSse as encodeOpenAiSse, TEXT_STREAM_EVENTS as OPENAI_TEXT_EVENTS } from "./fixtures/openai.ts";

const missingStore: CredentialStore = { get: async () => null, set: async () => {}, delete: async () => false };
const selection = (providers: SmokeSelection["providers"]): SmokeSelection => ({
  enabled: true, providers, revision: "test-revision", timeoutMs: 300, env: {},
});
const validModel = (requests: ModelRequest[]): Model => createScriptedModel({ responses: [
  { toolCalls: [{ id: "read-1", name: "read", arguments: { path: "smoke-sentinel.txt" } }] },
  request => {
    requests.push(request);
    const result = request.items.find(item => item.type === "tool_result");
    return { text: result?.type === "tool_result" ? (result.content.match(/1\|([a-f0-9]{40})/)?.[1] ?? "missing") : "missing" };
  },
] });

test("disabled mode does not discover credentials, create a store, or load a provider", async () => {
  let calls = 0;
  const report = await runLiveSmoke({ ...selection(["anthropic"]), enabled: false }, {
    createStore: () => { calls++; return missingStore; },
    createModel: async () => { calls++; throw Error("unexpected"); },
  });
  expect(calls).toBe(0);
  expect(report.aggregate).toBe("incomplete");
  expect(report.scenarios[0]?.status).toBe("skipped");
});

test("each provider exercises a real read tool and final answer without leaking sentinel or credentials", async () => {
  const seen: string[] = [];
  const requests: ModelRequest[] = [];
  const report = await runLiveSmoke({ ...selection(["anthropic", "openai-api-key", "compatible", "codex"]),
    env: { ANTHROPIC_API_KEY: "ANTHROPIC_PRIVATE_VALUE", OPENAI_API_KEY: "OPENAI_PRIVATE_VALUE", OPENAI_COMPATIBLE_API_KEY: "COMPAT_PRIVATE_VALUE" },
    compatible: { baseUrl: "https://localhost:1133/v1", auth: "required" },
  }, {
    createStore: () => ({ ...missingStore, get: async identity => identity.account === "codex-subscription:chatgpt" ? JSON.stringify({ accessToken: "stored-subscription-private" }) : null }),
    createModel: async input => { seen.push(input.provider + ":" + (input.openaiAuth ?? "api-key")); return validModel(requests); },
  });
  expect(seen).toEqual(["anthropic:api-key", "openai:api-key", "openai-compatible:api-key", "openai:codex"]);
  expect(report.aggregate).toBe("passed");
  expect(report.scenarios.map(item => item.status)).toEqual(["passed", "passed", "passed", "passed"]);
  expect(report.scenarios.map(item => item.authSource)).toEqual(["env", "env", "env", "stored-subscription"]);
  expect(requests).toHaveLength(4);
  expect(requests.every(request => request.tools?.map(tool => tool.name).join(",") === "read")).toBe(true);
  expect(requests.every(request => request.items.some(item => item.type === "tool_result" && !item.isError && /1\|[a-f0-9]{40}/.test(item.content)))).toBe(true);
  expect(JSON.stringify(report)).not.toMatch(/PRIVATE_VALUE|stored-subscription-private|smoke-sentinel.txt|\/tmp\//);
});

test("only requested provider instantiates; missing required credentials are incomplete", async () => {
  let creations = 0;
  const report = await runLiveSmoke(selection(["openai-api-key"]), {
    createStore: () => missingStore,
    createModel: async () => { creations++; return validModel([]); },
  });
  expect(creations).toBe(0);
  expect(report.aggregate).toBe("incomplete");
  expect(report.scenarios[0]).toMatchObject({ status: "skipped", reason: "missing_credentials" });
});

test("runtime override wins over environment and store-backed API credentials use production identity", async () => {
  const seen: string[] = [];
  const report = await runLiveSmoke({ ...selection(["anthropic", "openai-api-key"]),
    runtimeKeys: { anthropic: "runtime-secret" }, env: { ANTHROPIC_API_KEY: "environment-secret" },
  }, {
    createStore: () => ({ ...missingStore, get: async identity => identity.account === "api-key:openai" ? "stored-openai-secret" : null }),
    createModel: async input => { seen.push(input.apiKey ?? ""); return validModel([]); },
  });
  expect(seen).toEqual(["runtime-secret", "stored-openai-secret"]);
  expect(report.scenarios.map(item => item.authSource)).toEqual(["runtime", "stored"]);
  expect(report.aggregate).toBe("passed");
  expect(JSON.stringify(report)).not.toMatch(/runtime-secret|stored-openai-secret|environment-secret/);
});

test("no-auth compatible requires explicit selection and can use isolated endpoint", async () => {
  const report = await runLiveSmoke({ ...selection(["compatible"]), compatible: { baseUrl: "http://localhost:4000/v1", auth: "none" } }, {
    createStore: () => { throw Error("should not read secure store"); },
    createModel: async () => validModel([]),
  });
  expect(report.scenarios[0]).toMatchObject({ status: "passed", authSource: "none" });
});

test("tool-free final statement and incorrect read never pass", async () => {
  const noop = await runLiveSmoke({ ...selection(["anthropic"]), env: { ANTHROPIC_API_KEY: "secret" } }, {
    createStore: () => missingStore,
    createModel: async () => createScriptedModel({ text: "success" }),
  });
  expect(noop.scenarios[0]).toMatchObject({ status: "failed_provider", reason: "missing_tool_evidence" });
  const wrong = await runLiveSmoke({ ...selection(["anthropic"]), env: { ANTHROPIC_API_KEY: "secret" } }, {
    createStore: () => missingStore,
    createModel: async () => createScriptedModel({ responses: [
      { toolCalls: [{ id: "bad", name: "read", arguments: { path: "wrong.txt" } }] },
      { text: "success" },
    ] }),
  });
  expect(wrong.scenarios[0]?.status).toBe("failed_provider");
  let rejected = "";
  const absolute = await runLiveSmoke({ ...selection(["anthropic"]), env: { ANTHROPIC_API_KEY: "secret" } }, {
    createStore: () => missingStore,
    createModel: async () => createScriptedModel({ responses: [
      { toolCalls: [{ id: "bad", name: "read", arguments: { path: "/etc/passwd" } }] },
      request => { const result = request.items.find(item => item.type === "tool_result"); rejected = result?.type === "tool_result" ? result.content : ""; return { text: "done" }; },
    ] }),
  });
  expect(rejected).toBe("Only the smoke sentinel may be read.");
  expect(absolute.scenarios[0]?.status).toBe("failed_provider");
});

test("unadvertised activate_skill call blocks every tool before execution, even alongside read", async () => {
  let readCalls = 0;
  let modelRounds = 0;
  let workspace = "";
  const report = await runLiveSmoke({ ...selection(["anthropic"]), env: { ANTHROPIC_API_KEY: "fake" } }, {
    createStore: () => missingStore,
    onWorkspace: value => { workspace = value.root; },
    readSentinel: async () => { readCalls++; return { content: "must not execute" }; },
    createModel: async () => createScriptedModel({ responses: [
      () => { modelRounds++; return { toolCalls: [
        { id: "bad", name: "activate_skill", arguments: { name: "unadvertised" } },
        { id: "read", name: "read", arguments: { path: "smoke-sentinel.txt" } },
      ] }; },
      () => { modelRounds++; return { text: "must not run" }; },
    ] }),
  });
  expect(report.scenarios[0]).toMatchObject({ status: "failed_provider", reason: "disallowed_tool", toolRoundTrip: false });
  expect(readCalls).toBe(0);
  expect(modelRounds).toBe(1);
  await expect(access(workspace)).rejects.toThrow();
});

test("a padded answer is not the verbatim sentinel", async () => {
  const report = await runLiveSmoke({ ...selection(["anthropic"]), env: { ANTHROPIC_API_KEY: "fake" } }, {
    createStore: () => missingStore,
    createModel: async () => createScriptedModel({ responses: [
      { toolCalls: [{ id: "read", name: "read", arguments: { path: "smoke-sentinel.txt" } }] },
      request => {
        const result = request.items.find(item => item.type === "tool_result");
        const marker = result?.type === "tool_result" ? result.content.match(/1\|([a-f0-9]{40})/)?.[1] : undefined;
        return { text: ` ${marker} ` };
      },
    ] }),
  });
  expect(report.scenarios[0]).toMatchObject({ status: "failed_provider", reason: "missing_tool_evidence", toolRoundTrip: true });
});

test("non-cooperative stream reports a bounded unsettled timeout, retains workspace until settlement, and skips later lanes", async () => {
  let release!: () => void;
  let dir = "";
  let models = 0;
  const blocking: Model = { provider: "anthropic", id: "fake", async *stream() {
    await new Promise<void>(resolve => { release = resolve; });
    yield { type: "message_complete", message: { type: "assistant", id: "late", content: [{ type: "text", text: "late" }] } };
  } };
  const started = performance.now();
  const report = await runLiveSmoke({ ...selection(["anthropic", "openai-api-key"]), timeoutMs: 35,
    env: { ANTHROPIC_API_KEY: "fake", OPENAI_API_KEY: "fake" } }, {
    createStore: () => missingStore,
    createModel: async () => { models++; return blocking; },
    onWorkspace: workspace => { dir = workspace.root; },
  });
  expect(performance.now() - started).toBeLessThan(350);
  expect(report.scenarios[0]).toMatchObject({ status: "failed_provider", reason: "timeout_unsettled", cleanup: "deferred" });
  expect(report.scenarios[1]).toMatchObject({ status: "pending", reason: "prior_run_unsettled" });
  expect(models).toBe(1);
  await access(dir);
  release();
  for (let i = 0; i < 30; i++) { try { await access(dir); await Bun.sleep(10); } catch { break; } }
  await expect(access(dir)).rejects.toThrow();
});

test("oversized assembled tool-call arguments and tool result cannot reach another provider round", async () => {
  let rounds = 0;
  const configured = { ...selection(["anthropic"]), env: { ANTHROPIC_API_KEY: "fake" } };
  const args = await runLiveSmoke(configured, {
    createStore: () => missingStore,
    createModel: async () => ({ provider: "anthropic", id: "fixture", async *stream() {
      rounds++;
      yield { type: "message_complete", message: { type: "assistant", id: "arg", content: [
        { type: "tool_call", id: "a", name: "read", arguments: { path: "smoke-sentinel.txt", padding: "X".repeat(8192) } },
      ] } };
    } }),
  });
  expect(args.scenarios[0]).toMatchObject({ status: "failed_provider", reason: "output_limit" });
  expect(rounds).toBe(1);
  let toolRounds = 0;
  const tool = await runLiveSmoke(configured, {
    createStore: () => missingStore,
    readSentinel: async () => ({ content: "X".repeat(8192) }),
    createModel: async () => createScriptedModel({ responses: [
      () => { toolRounds++; return { toolCalls: [{ id: "read", name: "read", arguments: { path: "smoke-sentinel.txt" } }] }; },
      () => { toolRounds++; return { text: "must not happen" }; },
    ] }),
  });
  expect(tool.scenarios[0]).toMatchObject({ status: "failed_provider", reason: "output_limit" });
  expect(toolRounds).toBe(1);
});

test("transport error, timeout, and cancellation are distinguished and temp directory removed", async () => {
  let tempPath = "";
  const report = await runLiveSmoke({ ...selection(["anthropic"]), env: { ANTHROPIC_API_KEY: "SECRET_IN_ERROR" } }, {
    createStore: () => missingStore,
    createModel: async () => createScriptedModel({ error: "SECRET_IN_ERROR", status: 401 }),
    onWorkspace: workspace => { tempPath = workspace.root; },
  });
  expect(report.scenarios[0]).toMatchObject({ status: "failed_provider", reason: "provider_error" });
  expect(JSON.stringify(report)).not.toContain("SECRET_IN_ERROR");
  await expect(access(tempPath)).rejects.toThrow();
  const timeout = await runLiveSmoke({ ...selection(["anthropic"]), timeoutMs: 25, env: { ANTHROPIC_API_KEY: "x" } }, {
    createStore: () => missingStore,
    createModel: async () => createScriptedModel({ waitForAbort: true }),
  });
  expect(timeout.scenarios[0]).toMatchObject({ status: "failed_provider", reason: "timeout" });
  const controller = new AbortController();
  controller.abort();
  const cancelled = await runLiveSmoke({ ...selection(["anthropic"]), signal: controller.signal }, {
    createStore: () => missingStore,
    createModel: async () => { throw Error("should not instantiate"); },
  });
  expect(cancelled.scenarios[0]).toMatchObject({ status: "pending", reason: "cancelled" });
});

test("credential-store wait is time-bounded before any provider can instantiate", async () => {
  let models = 0;
  const report = await runLiveSmoke({ ...selection(["anthropic"]), timeoutMs: 20 }, {
    createStore: () => ({ ...missingStore, get: () => new Promise<string | null>(() => {}) }),
    createModel: async () => { models++; return validModel([]); },
  });
  expect(models).toBe(0);
  expect(report.scenarios[0]).toMatchObject({ status: "failed_runner", reason: "timeout" });
  expect(report.scenarios[0]!.durationMs).toBeLessThan(150);
});

test("a late keychain resolution cannot change a published timeout report or start a model", async () => {
  let release!: (value: string | null) => void;
  let models = 0;
  const report = await runLiveSmoke({ ...selection(["anthropic"]), timeoutMs: 20 }, {
    createStore: () => ({ ...missingStore, get: () => new Promise<string | null>(resolve => { release = resolve; }) }),
    createModel: async () => { models++; return validModel([]); },
  });
  const published = JSON.stringify(report);
  release("late-secret");
  await Bun.sleep(10);
  expect(models).toBe(0);
  expect(JSON.stringify(report)).toBe(published);
  expect(report.scenarios[0]).toMatchObject({ status: "failed_runner", reason: "timeout" });
});

test("local fake HTTP transport uses the selected compatible adapter and sends tool output back", async () => {
  const bodies: unknown[] = [];
  const urls: string[] = [];
  const report = await runLiveSmoke({ ...selection(["compatible"]), compatible: { baseUrl: "http://127.0.0.1:12345/v1", auth: "required" },
    env: { OPENAI_COMPATIBLE_API_KEY: "fake-http-secret" } }, {
    createStore: () => missingStore,
    createModel: input => loadProviderModel(input, async (url, init) => {
      urls.push(String(url));
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      bodies.push(body);
      const marker = body.messages.find(message => message.role === "tool")?.content.match(/1\|([a-f0-9]{40})/)?.[1];
      const delta = marker ? { content: marker } : { tool_calls: [{ index: 0, id: "read1", type: "function", function: { name: "read", arguments: '{"path":"smoke-sentinel.txt"}' } }] };
      const chunk = (d: object, finish_reason: string | null) => ({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "gpt-4o", choices: [{ index: 0, delta: d, finish_reason }] });
      return new Response(encodeChatCompletionsSse([chunk(delta, null), chunk({}, marker ? "stop" : "tool_calls")]),
        { headers: { "content-type": "text/event-stream" } });
    }),
  });
  expect(report.scenarios[0]).toMatchObject({ status: "passed", toolRoundTrip: true });
  expect(bodies).toHaveLength(2);
  expect(urls).toEqual(["http://127.0.0.1:12345/v1/chat/completions", "http://127.0.0.1:12345/v1/chat/completions"]);
  expect(JSON.stringify(report)).not.toContain("fake-http-secret");
});

test("bounded fetch forwards request/options and charges the cumulative byte budget across responses", async () => {
  const scope = new AbortController();
  const original = new AbortController();
  const request = new Request("http://127.0.0.1:1234/v1", {
    method: "POST", headers: { "x-fixture": "forwarded" }, signal: original.signal,
  });
  let seenInput: string | URL | Request | undefined;
  let seenInit: RequestInit | undefined;
  let hit = 0;
  let cancelled = 0;
  let replies = 0;
  const fake = boundedSmokeFetch({ signal: scope.signal, onLimit: () => { hit++; scope.abort(); },
    fetch: async (input, init) => {
      seenInput = input;
      seenInit = init;
      replies++;
      return new Response(new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new Uint8Array(MAX_SMOKE_WIRE_BYTES / 2 + 4).fill(120));
          if (replies === 1) stream.close();
        },
        cancel() { cancelled++; },
      }), { headers: { "content-type": "text/event-stream", "x-response": "preserved" } });
    },
  });
  const options = { headers: { authorization: "Bearer fixture" }, signal: original.signal };
  const first = await fake(request, options);
  expect(first.headers.get("x-response")).toBe("preserved");
  expect((await first.arrayBuffer()).byteLength).toBeGreaterThan(MAX_SMOKE_WIRE_BYTES / 2);
  expect(seenInput).toBe(request);
  expect(new Headers(seenInit?.headers).get("authorization")).toBe("Bearer fixture");
  expect((seenInput as Request).headers.get("x-fixture")).toBe("forwarded");
  const second = await fake(request, options);
  await expect(second.arrayBuffer()).rejects.toThrow();
  expect(hit).toBe(1);
  expect(seenInit?.signal?.aborted).toBe(true);
  await Bun.sleep(0);
  expect(cancelled).toBeGreaterThanOrEqual(1);
});

test("bounded fetch prevents four selected adapters from consuming an oversized undelimited SSE chunk", async () => {
  const lanes = [
    { provider: "anthropic" as const, apiKey: "fake-anthropic" },
    { provider: "openai" as const, openaiAuth: "api-key" as const, apiKey: "fake-openai" },
    { provider: "openai-compatible" as const, baseUrl: "http://127.0.0.1:1234/v1", auth: "none" as const },
    { provider: "openai" as const, openaiAuth: "codex" as const, codexTokens: { accessToken: "fake-codex", accountId: "account" } },
  ];
  for (const lane of lanes) {
    const controller = new AbortController();
    let exceeded = 0;
    let requests = 0;
    let requestSignal: AbortSignal | undefined;
    let requestHeaders: Headers | undefined;
    const fake = boundedSmokeFetch({ signal: controller.signal, onLimit: () => { exceeded++; controller.abort(); },
      fetch: async (input, init) => {
        requests++;
        requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        requestHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        return new Response(new ReadableStream<Uint8Array>({ start(stream) {
          stream.enqueue(new TextEncoder().encode(`data: ${"x".repeat(MAX_SMOKE_WIRE_BYTES + 1)}`));
          stream.close();
        } }), { headers: { "content-type": "text/event-stream" } });
      },
    });
    const model = await loadProviderModel(lane, fake);
    let failed = false;
    try { await collect(model.stream({ ...sampleRequest(), signal: controller.signal })); }
    catch { failed = true; }
    expect(failed).toBe(true);
    expect(exceeded).toBe(1);
    expect(requests).toBe(1);
    expect(requestSignal?.aborted).toBe(true);
    expect(requestHeaders).toBeDefined();
  }
});

test("bounded fetch preserves valid streaming and message completion for all four adapter lanes", async () => {
  const codexEvents = [
    { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message" } },
    { type: "response.output_text.delta", output_index: 0, delta: "Hello" },
    { type: "response.output_item.done", output_index: 0, item: { type: "message" } },
    { type: "response.completed", response: { id: "resp_1", status: "completed" } },
  ];
  const codexSse = `${codexEvents.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  const lanes = [
    { input: { provider: "anthropic" as const, apiKey: "fixture" }, sse: encodeAnthropicSse(ANTHROPIC_TEXT_EVENTS) },
    { input: { provider: "openai" as const, openaiAuth: "api-key" as const, apiKey: "fixture" }, sse: encodeOpenAiSse(OPENAI_TEXT_EVENTS) },
    { input: { provider: "openai-compatible" as const, baseUrl: "http://127.0.0.1:1234/v1", auth: "none" as const }, sse: encodeChatCompletionsSse(TEXT_STREAM_CHUNKS) },
    { input: { provider: "openai" as const, openaiAuth: "codex" as const, codexTokens: { accessToken: "fixture", accountId: "account" } }, sse: codexSse },
  ];
  for (const lane of lanes) {
    const controller = new AbortController();
    let tripped = false;
    let calls = 0;
    const guarded = boundedSmokeFetch({ signal: controller.signal, onLimit: () => { tripped = true; controller.abort(); },
      fetch: async () => {
        calls++;
        return new Response(lane.sse, { headers: { "content-type": "text/event-stream" } });
      },
    });
    const model = await loadProviderModel(lane.input, guarded);
    const events = await collect(model.stream({ ...sampleRequest(), signal: controller.signal }));
    expect(events.at(-1)?.type).toBe("message_complete");
    expect(tripped).toBe(false);
    expect(calls).toBe(1);
  }
});

test("production compatible fetch seam completes a real local two-request tool round trip", async () => {
  const seen: Array<{ url: string; authorization: string | null; body: unknown }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { messages: Array<{ role: string; content?: string }> };
    seen.push({ url: request.url, authorization: request.headers.get("authorization"), body });
    const result = body.messages.find(message => message.role === "tool")?.content;
    const marker = result?.match(/1\|([a-f0-9]{40})/)?.[1];
    const delta = marker ? { content: marker } : { tool_calls: [{ index: 0, id: "read1", type: "function", function: { name: "read", arguments: '{"path":"smoke-sentinel.txt"}' } }] };
    const chunk = (payload: object, finish_reason: string | null) => ({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "gpt-4o",
      choices: [{ index: 0, delta: payload, finish_reason }] });
    return new Response(encodeChatCompletionsSse([chunk(delta, null), chunk({}, marker ? "stop" : "tool_calls")]),
      { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const report = await runLiveSmoke({ ...selection(["compatible"]), timeoutMs: 2000,
      compatible: { baseUrl: `http://127.0.0.1:${server.port}/v1`, auth: "required" },
      env: { OPENAI_COMPATIBLE_API_KEY: "fake-local-key" } });
    expect(report.scenarios[0]).toMatchObject({ status: "passed", toolRoundTrip: true });
    expect(seen).toHaveLength(2);
    expect(seen.every(request => request.authorization === "Bearer fake-local-key" && request.url.endsWith("/v1/chat/completions"))).toBe(true);
    expect(JSON.stringify(seen[1]!.body)).toMatch(/1\|[a-f0-9]{40}/);
    expect(JSON.stringify(report)).not.toContain("fake-local-key");
  } finally { server.stop(true); }
});

test("compatible live runner classifies undelimited SSE over wire budget as output_limit", async () => {
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    calls++;
    return new Response(new ReadableStream<Uint8Array>({ start(stream) {
      const chunk = new TextEncoder().encode(`data: ${"x".repeat(2048)}`);
      for (let i = 0; i < MAX_SMOKE_WIRE_BYTES / chunk.byteLength + 2; i++) stream.enqueue(chunk);
      stream.close();
    } }), { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const report = await runLiveSmoke({ ...selection(["compatible"]), timeoutMs: 2000,
      compatible: { baseUrl: `http://127.0.0.1:${server.port}/v1`, auth: "none" } });
    expect(report.scenarios[0]).toMatchObject({ status: "failed_provider", reason: "output_limit" });
    expect(report.aggregate).toBe("failed");
    expect(calls).toBe(1);
  } finally { server.stop(true); }
});

test("rejected subscription refresh asks for interactive re-login without starting one", async () => {
  const report = await runLiveSmoke(selection(["codex"]), {
    createStore: () => ({ ...missingStore, get: async () => JSON.stringify({ accessToken: "private" }) }),
    createModel: async () => createScriptedModel({ error: "The ChatGPT subscription session was revoked or rejected by the provider. Sign in again in interactive mode with /login codex.", status: 401 }),
  });
  expect(report.scenarios[0]).toMatchObject({ status: "pending", reason: "subscription_requires_login" });
});

test("runner setup failure is not misreported as a provider failure", async () => {
  let path = "";
  const report = await runLiveSmoke({ ...selection(["anthropic"]), env: { ANTHROPIC_API_KEY: "secret" } }, {
    createStore: () => missingStore, createModel: async () => validModel([]),
    onWorkspace: workspace => { path = workspace.root; throw Error("private setup error"); },
  });
  expect(report.scenarios[0]).toMatchObject({ status: "failed_runner", reason: "runner_error" });
  await expect(access(path)).rejects.toThrow();
  expect(JSON.stringify(report)).not.toContain("private setup error");
});

test("second subscription store read failure is store-unavailable, not expired login, without leaking errors", async () => {
  let reads = 0;
  let constructions = 0;
  const report = await runLiveSmoke(selection(["codex"]), {
    createStore: () => ({ ...missingStore, get: async () => {
      reads++;
      if (reads === 1) return JSON.stringify({ accessToken: "stored-private-token" });
      throw Error("keychain denied read: stored-private-token");
    } }),
    createModel: async () => { constructions++; return validModel([]); },
  });
  expect(reads).toBe(2);
  expect(constructions).toBe(0);
  expect(report.scenarios[0]).toMatchObject({ status: "pending", reason: "credential_store_unavailable", authSource: "unavailable" });
  expect(JSON.stringify(report)).not.toContain("stored-private-token");
});

test("malformed subscription payload remains a re-login problem rather than a store failure", async () => {
  let reads = 0;
  const report = await runLiveSmoke(selection(["codex"]), {
    createStore: () => ({ ...missingStore, get: async () => ++reads === 1 ? "nonempty-private-token" : "{invalid-token" }),
    createModel: async () => { throw Error("must not instantiate"); },
  });
  expect(report.scenarios[0]).toMatchObject({ status: "pending", reason: "subscription_requires_login" });
  expect(JSON.stringify(report)).not.toContain("nonempty-private-token");
});

test("expired subscription without refresh is pending and never starts login", async () => {
  const report = await runLiveSmoke(selection(["codex"]), {
    createStore: () => ({ ...missingStore, get: async () => JSON.stringify({ accessToken: "private", expiresAt: 1 }) }),
    createModel: async () => { throw Error("should not instantiate expired token"); },
  });
  expect(report.scenarios[0]).toMatchObject({ status: "pending", reason: "subscription_requires_login" });
});
