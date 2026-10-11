import { beforeAll, afterAll, expect, test } from "bun:test";
import Ajv from "ajv";
import { access } from "node:fs/promises";
import type { Model, ModelRequest } from "../src/model/model.ts";
import type { CredentialStore } from "../src/auth/store.ts";
import { runLiveSmoke, type SmokeSelection } from "../src/live/smoke.ts";
import { collect, createScriptedModel } from "./helpers/scripted-model.ts";
import { boundedSmokeFetch, MAX_SMOKE_WIRE_BYTES } from "../src/live/transport.ts";
import { sampleRequest } from "./fixtures/openai-compatible.ts";
import { loadProviderModel } from "../src/model/loader.ts";
import { encodeChatCompletionsSse, TEXT_STREAM_CHUNKS } from "./fixtures/openai-compatible.ts";
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
  const report = await runLiveSmoke({ ...selection(["openai-api-key"]), enabled: false }, {
    createStore: () => { calls++; return missingStore; },
    createModel: async () => { calls++; throw Error("unexpected"); },
  });
  expect(calls).toBe(0);
  expect(report.aggregate).toBe("incomplete");
  expect(report.scenarios[0]?.status).toBe("skipped");
  let xaiCalls = 0;
  const disabled = await runLiveSmoke({ ...selection(["xai-api-key"]), enabled: false }, {
    createStore: () => { xaiCalls++; return missingStore; },
    createModel: async () => { xaiCalls++; throw Error("unexpected"); },
  });
  expect(xaiCalls).toBe(0);
  expect(disabled.scenarios[0]).toMatchObject({ provider: "xai-api-key", status: "skipped", reason: "live_disabled" });
});

test("xai-api-key skips missing credentials without loading an adapter", async () => {
  let constructed = false;
  const report = await runLiveSmoke(selection(["xai-api-key"]), {
    createStore: () => missingStore,
    createModel: async () => { constructed = true; throw Error("loaded"); },
  });
  expect(report.scenarios[0]).toMatchObject({ provider: "xai-api-key", status: "skipped", reason: "missing_credentials", model: "grok-4.7" });
  expect(constructed).toBe(false);
});

test("each provider exercises a real read tool and final answer without leaking sentinel or credentials", async () => {
  const seen: string[] = [];
  const requests: ModelRequest[] = [];
  const report = await runLiveSmoke({ ...selection(["openai-api-key", "compatible", "codex"]),
    env: { OPENAI_API_KEY: "OPENAI_PRIVATE_VALUE", OPENAI_COMPATIBLE_API_KEY: "COMPAT_PRIVATE_VALUE" },
    compatible: { baseUrl: "https://localhost:1133/v1", auth: "required" },
  }, {
    createStore: () => ({ ...missingStore, get: async identity => identity.account === "codex-subscription:chatgpt" ? JSON.stringify({ accessToken: "stored-subscription-private" }) : null }),
    createModel: async input => { seen.push(input.provider + ":" + (input.openaiAuth ?? "api-key")); return validModel(requests); },
  });
  expect(seen).toEqual(["openai:api-key", "openai-compatible:api-key", "openai:codex"]);
  expect(report.aggregate).toBe("passed");
  expect(report.scenarios.map(item => item.status)).toEqual(["passed", "passed", "passed"]);
  expect(report.scenarios.map(item => item.authSource)).toEqual(["env", "env", "stored-subscription"]);
  expect(requests).toHaveLength(3);
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
  const report = await runLiveSmoke({ ...selection(["openai-api-key", "compatible"]),
    runtimeKeys: { "openai-api-key": "runtime-secret" }, env: { OPENAI_API_KEY: "environment-secret", OPENAI_COMPATIBLE_API_KEY: "compatible-env-secret" },
    compatible: { baseUrl: "https://localhost:1133/v1", auth: "required" },
  }, {
    createStore: () => ({ ...missingStore, get: async identity => identity.account.startsWith("api-key:openai-compatible") ? "stored-compatible-secret" : null }),
    createModel: async input => { seen.push(input.apiKey ?? ""); return validModel([]); },
  });
  expect(seen).toEqual(["runtime-secret", "compatible-env-secret"]);
  expect(report.scenarios.map(item => item.authSource)).toEqual(["runtime", "env"]);
  expect(report.aggregate).toBe("passed");
  expect(JSON.stringify(report)).not.toMatch(/runtime-secret|stored-compatible-secret|environment-secret|compatible-env-secret/);
});

test("programmatic credentialed HTTP is rejected before secure-store or provider discovery", async () => {
  let stores = 0;
  let models = 0;
  const report = await runLiveSmoke({ ...selection(["compatible"]),
    compatible: { baseUrl: "http://127.0.0.1:12345/v1", auth: "required" },
    env: { OPENAI_COMPATIBLE_API_KEY: "fake-credential-not-real" },
  }, {
    createStore: () => { stores++; return missingStore; },
    createModel: async () => { models++; return validModel([]); },
  });
  expect(stores).toBe(0);
  expect(models).toBe(0);
  expect(report.scenarios[0]).toMatchObject({ status: "failed_runner", reason: "insecure_endpoint", authSource: "unavailable" });
  expect(JSON.stringify(report)).not.toContain("fake-credential-not-real");
});

test("no-auth compatible requires explicit selection and can use isolated endpoint", async () => {
  const report = await runLiveSmoke({ ...selection(["compatible"]), compatible: { baseUrl: "http://localhost:4000/v1", auth: "none" },
    runtimeKeys: { compatible: "ignored-fixture-runtime-key" } }, {
    createStore: () => { throw Error("should not read secure store"); },
    createModel: async input => { expect(input.apiKey).toBeUndefined(); return validModel([]); },
  });
  expect(report.scenarios[0]).toMatchObject({ status: "passed", authSource: "none" });
  expect(JSON.stringify(report)).not.toContain("ignored-fixture-runtime-key");
});

test("tool-free final statement and incorrect read never pass", async () => {
  const noop = await runLiveSmoke({ ...selection(["openai-api-key"]), env: { OPENAI_API_KEY: "secret" } }, {
    createStore: () => missingStore,
    createModel: async () => createScriptedModel({ text: "success" }),
  });
  expect(noop.scenarios[0]).toMatchObject({ status: "failed_provider", reason: "missing_tool_evidence" });
  const wrong = await runLiveSmoke({ ...selection(["openai-api-key"]), env: { OPENAI_API_KEY: "secret" } }, {
    createStore: () => missingStore,
    createModel: async () => createScriptedModel({ responses: [
      { toolCalls: [{ id: "bad", name: "read", arguments: { path: "wrong.txt" } }] },
      { text: "success" },
    ] }),
  });
  expect(wrong.scenarios[0]?.status).toBe("failed_provider");
  let rejected = "";
  const absolute = await runLiveSmoke({ ...selection(["openai-api-key"]), env: { OPENAI_API_KEY: "secret" } }, {
    createStore: () => missingStore,
    createModel: async () => createScriptedModel({ responses: [
      { toolCalls: [{ id: "bad", name: "read", arguments: { path: "/etc/passwd" } }] },
      request => { const result = request.items.find(item => item.type === "tool_result"); rejected = result?.type === "tool_result" ? result.content : ""; return { text: "done" }; },
    ] }),
  });
  expect(rejected).toContain("Invalid arguments for tool read:");
  expect(absolute.scenarios[0]?.status).toBe("failed_provider");
});

test("unadvertised activate_skill call blocks every tool before execution, even alongside read", async () => {
  let readCalls = 0;
  let modelRounds = 0;
  let workspace = "";
  const report = await runLiveSmoke({ ...selection(["openai-api-key"]), env: { OPENAI_API_KEY: "fake" } }, {
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
  const report = await runLiveSmoke({ ...selection(["openai-api-key"]), env: { OPENAI_API_KEY: "fake" } }, {
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
  const blocking: Model = { provider: "openai", id: "fake", async *stream() {
    await new Promise<void>(resolve => { release = resolve; });
    yield { type: "message_complete", message: { type: "assistant", id: "late", content: [{ type: "text", text: "late" }] } };
  } };
  const started = performance.now();
  const report = await runLiveSmoke({ ...selection(["openai-api-key", "compatible"]), timeoutMs: 35,
    compatible: { baseUrl: "https://localhost:1133/v1", auth: "none" },
    env: { OPENAI_API_KEY: "fake" } }, {
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
  const configured = { ...selection(["openai-api-key"]), env: { OPENAI_API_KEY: "fake" } };
  const args = await runLiveSmoke(configured, {
    createStore: () => missingStore,
    createModel: async () => ({ provider: "openai", id: "fixture", async *stream() {
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
  const report = await runLiveSmoke({ ...selection(["openai-api-key"]), env: { OPENAI_API_KEY: "SECRET_IN_ERROR" } }, {
    createStore: () => missingStore,
    createModel: async () => createScriptedModel({ error: "SECRET_IN_ERROR", status: 401 }),
    onWorkspace: workspace => { tempPath = workspace.root; },
  });
  expect(report.scenarios[0]).toMatchObject({ status: "failed_provider", reason: "provider_error" });
  expect(JSON.stringify(report)).not.toContain("SECRET_IN_ERROR");
  await expect(access(tempPath)).rejects.toThrow();
  const timeout = await runLiveSmoke({ ...selection(["openai-api-key"]), timeoutMs: 25, env: { OPENAI_API_KEY: "x" } }, {
    createStore: () => missingStore,
    createModel: async () => createScriptedModel({ waitForAbort: true }),
  });
  expect(timeout.scenarios[0]).toMatchObject({ status: "failed_provider", reason: "timeout" });
  const controller = new AbortController();
  controller.abort();
  const cancelled = await runLiveSmoke({ ...selection(["openai-api-key"]), signal: controller.signal }, {
    createStore: () => missingStore,
    createModel: async () => { throw Error("should not instantiate"); },
  });
  expect(cancelled.scenarios[0]).toMatchObject({ status: "pending", reason: "cancelled" });
});

test("credential-store wait is time-bounded before any provider can instantiate", async () => {
  let models = 0;
  const report = await runLiveSmoke({ ...selection(["openai-api-key"]), timeoutMs: 20 }, {
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
  const report = await runLiveSmoke({ ...selection(["openai-api-key"]), timeoutMs: 20 }, {
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

test("fake HTTPS transport forwards selected compatible authorization and tool output", async () => {
  const bodies: unknown[] = [];
  const urls: string[] = [];
  const authorizations: Array<string | null> = [];
  const report = await runLiveSmoke({ ...selection(["compatible"]), compatible: { baseUrl: "https://127.0.0.1:12345/v1", auth: "required" },
    env: { OPENAI_COMPATIBLE_API_KEY: "fake-http-secret" } }, {
    createStore: () => missingStore,
    createModel: input => loadProviderModel(input, async (url, init) => {
      urls.push(String(url));
      authorizations.push(new Headers(init?.headers ?? (url instanceof Request ? url.headers : undefined)).get("authorization"));
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
  expect(urls).toEqual(["https://127.0.0.1:12345/v1/chat/completions", "https://127.0.0.1:12345/v1/chat/completions"]);
  expect(authorizations).toEqual(["Bearer fake-http-secret", "Bearer fake-http-secret"]);
  expect(JSON.stringify(report)).not.toContain("fake-http-secret");
});

test("bounded fetch forwards request/options and charges the cumulative byte budget across responses", async () => {
  const scope = new AbortController();
  const original = new AbortController();
  const request = new Request("http://127.0.0.1:1234/v1", {
    method: "POST", headers: { "x-fixture": "forwarded" }, signal: original.signal, redirect: "follow",
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
  const options: RequestInit = { headers: { authorization: "Bearer fixture" }, signal: original.signal, redirect: "follow" };
  const first = await fake(request, options);
  expect(first.headers.get("x-response")).toBe("preserved");
  expect((await first.arrayBuffer()).byteLength).toBeGreaterThan(MAX_SMOKE_WIRE_BYTES / 2);
  expect(seenInput).toBe(request);
  expect(new Headers(seenInit?.headers).get("authorization")).toBe("Bearer fixture");
  expect(seenInit?.redirect).toBe("error");
  expect((seenInput as Request).headers.get("x-fixture")).toBe("forwarded");
  const second = await fake(request, options);
  await expect(second.arrayBuffer()).rejects.toThrow();
  expect(hit).toBe(1);
  expect(seenInit?.signal?.aborted).toBe(true);
  await Bun.sleep(0);
  expect(cancelled).toBeGreaterThanOrEqual(1);
});

test("bounded fetch prevents three selected adapters from consuming an oversized undelimited SSE chunk", async () => {
  const lanes = [
    { provider: "openai" as const, model: "gpt-6-astra", openaiAuth: "api-key" as const, apiKey: "fake-openai" },
    { provider: "openai-compatible" as const, model: "gpt-4o", baseUrl: "http://127.0.0.1:1234/v1", auth: "none" as const },
    { provider: "openai" as const, model: "gpt-6-astra", openaiAuth: "codex" as const, codexTokens: { accessToken: "fake-codex", accountId: "account" } },
  ];
  for (const lane of lanes) {
    const controller = new AbortController();
    let exceeded = 0;
    let requests = 0;
    let requestSignal: AbortSignal | undefined;
    let requestHeaders: Headers | undefined;
    let requestRedirect: RequestInit["redirect"];
    const fake = boundedSmokeFetch({ signal: controller.signal, onLimit: () => { exceeded++; controller.abort(); },
      fetch: async (input, init) => {
        requests++;
        requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        requestHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        requestRedirect = init?.redirect;
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
    expect(requestRedirect).toBe("error");
  }
});

test("live fetch forbids following even same-origin redirects from a credential-bearing Request", async () => {
  let targetCalls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/redirect") return Response.redirect(new URL("/target", request.url).href, 302);
    targetCalls++;
    return new Response("unexpected");
  } });
  try {
    const scope = new AbortController();
    const guarded = boundedSmokeFetch({ signal: scope.signal, onLimit: () => {} });
    const request = new Request(`http://127.0.0.1:${server.port}/redirect`, {
      headers: { authorization: "Bearer fixture-not-real" }, redirect: "follow",
    });
    await expect(guarded(request, { redirect: "follow" })).rejects.toThrow();
    expect(targetCalls).toBe(0);
  } finally { server.stop(true); }
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
    { input: { provider: "openai" as const, model: "gpt-6-astra", openaiAuth: "api-key" as const, apiKey: "fixture" }, sse: encodeOpenAiSse(OPENAI_TEXT_EVENTS) },
    { input: { provider: "openai-compatible" as const, model: "gpt-4o", baseUrl: "http://127.0.0.1:1234/v1", auth: "none" as const }, sse: encodeChatCompletionsSse(TEXT_STREAM_CHUNKS) },
    { input: { provider: "openai" as const, model: "gpt-6-astra", openaiAuth: "codex" as const, codexTokens: { accessToken: "fixture", accountId: "account" } }, sse: codexSse },
    { input: { provider: "xai" as const, model: "grok-4.7", apiKey: "fixture" }, sse: encodeOpenAiSse(OPENAI_TEXT_EVENTS) },
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
      compatible: { baseUrl: `http://127.0.0.1:${server.port}/v1`, auth: "none" },
      env: { OPENAI_COMPATIBLE_API_KEY: "fake-local-key" } });
    expect(report.scenarios[0]).toMatchObject({ status: "passed", toolRoundTrip: true, authSource: "none" });
    expect(seen).toHaveLength(2);
    expect(seen.every(request => request.authorization === null && request.url.endsWith("/v1/chat/completions"))).toBe(true);
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
    createModel: async () => createScriptedModel({ error: "The ChatGPT subscription session was revoked or rejected by the provider. Sign in again in interactive mode with /login chatgpt.", status: 401 }),
  });
  expect(report.scenarios[0]).toMatchObject({ status: "pending", reason: "subscription_requires_login" });
});

test("runner setup failure is not misreported as a provider failure", async () => {
  let path = "";
  const report = await runLiveSmoke({ ...selection(["openai-api-key"]), env: { OPENAI_API_KEY: "secret" } }, {
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

test("Grok smoke lane is disabled without discovery and classifies login states using only its identity", async () => {
  const disabled = await runLiveSmoke({ ...selection(["grok"]), enabled: false }, { createStore: () => { throw Error("disabled discovery"); } });
  expect(disabled.scenarios[0]).toMatchObject({ status: "skipped", reason: "live_disabled" });
  for (const state of ["missing", "malformed", "expired", "unreadable", "revoked"] as const) {
    const reads: string[] = [];
    const report = await runLiveSmoke({ ...selection(["grok"]), env: { XAI_API_KEY: "never-send" } }, { createStore: () => ({
      get: async identity => { reads.push(identity.account); if (state === "unreadable") throw Error("locked"); return state === "missing" ? null : state === "malformed" ? "bad" : JSON.stringify({ accessToken: "expired", obtainedAt: 0, expiresAt: 0, ...(state === "revoked" ? { refreshToken: "refresh" } : {}) }); }, set: async () => {}, delete: async () => false,
    }), createModel: input => loadProviderModel(input, async url => { expect(String(url)).toBe("https://auth.x.ai/oauth2/token"); return Response.json({}, { status: 401 }); }) });
    expect(report.scenarios[0]).toMatchObject({ status: "pending", reason: state === "missing" ? "missing_subscription" : state === "unreadable" ? "credential_store_unavailable" : "subscription_requires_login" });
    expect(reads.every(identity => identity === "grok-subscription:xai")).toBe(true);
  }
});

const unguardedFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = Object.assign((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") throw new Error("Grok fixtures must not use external network");
    return unguardedFetch(input, init);
  }, { preconnect: unguardedFetch.preconnect }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = unguardedFetch; });

test("explicit thinking on disabled lanes never reads credentials or catalogs and survives pending credentials", async () => {
  let calls = 0;
  const deps = { createStore: () => { calls++; return missingStore; },
    fetch: async () => { calls++; throw Error("unexpected HTTP"); },
    createModel: async () => { calls++; throw Error("unexpected model"); } };
  const disabled = await runLiveSmoke({ ...selection(["openai-api-key", "codex", "grok", "compatible", "xai-api-key"]), enabled: false,
    thinking: { "openai-api-key": "high", codex: "medium", grok: "medium", compatible: "medium", "xai-api-key": "medium" } }, deps);
  expect(calls).toBe(0);
  expect(disabled.scenarios.map(scenario => scenario.thinking)).toEqual(["high", "medium", "medium", "medium", "medium"]);
  const pending = await runLiveSmoke({ ...selection(["codex", "grok"]), thinking: { codex: "medium", grok: "medium" } }, deps);
  expect(calls).toBe(2);
  expect(pending.scenarios).toMatchObject([{ status: "pending", reason: "missing_subscription", thinking: "medium" },
    { status: "pending", reason: "missing_subscription", thinking: "medium" }]);
});

test("shared public policy refuses unsupported OpenAI and generic compatible thinking before inference", async () => {
  let calls = 0;
  const report = await runLiveSmoke({ ...selection(["openai-api-key", "compatible"]),
    env: { OPENAI_API_KEY: "PRIVATE_KEY" }, models: { "openai-api-key": "gpt-6-luna", compatible: "meta/muse-spark-1.3-contributor" },
    thinking: { "openai-api-key": "minimal", compatible: "medium" }, compatible: { baseUrl: "https://example.org/v1", auth: "none" },
  }, { createStore: () => missingStore, fetch: async () => { calls++; throw Error("unexpected inference"); },
    createModel: async () => { calls++; throw Error("unexpected model construction"); } });
  expect(calls).toBe(0);
  expect(report.scenarios).toMatchObject([{ thinking: "minimal", status: "failed_runner", reason: "unsupported_thinking" },
    { thinking: "medium", status: "failed_runner", reason: "unsupported_thinking" }]);
  expect(JSON.stringify(report)).not.toContain("PRIVATE_KEY");
});

test("reasoning catalog discovery retains its separate byte budget and deadline without starting inference", async () => {
  const { smokeProtocolFixture } = await import("./fixtures/live-process.ts");
  for (const catalogMode of ["oversized", "hang"]) {
    const fixture = smokeProtocolFixture({ catalogMode });
    let models = 0;
    const report = await runLiveSmoke({ ...selection(["grok"]), thinking: { grok: "medium" } }, {
      createStore: () => fixture.store, fetch: fixture.fetch,
      createModel: async () => { models++; throw Error("unexpected inference"); },
    });
    expect(models).toBe(0);
    expect(fixture.requests).toHaveLength(1);
    expect(report.scenarios[0]).toMatchObject({ thinking: "medium", reason: catalogMode === "oversized" ? "output_limit" : "timeout",
      diagnostics: { modelAttemptsStarted: 0, httpRequestsStarted: 1, httpResponsesReceived: catalogMode === "oversized" ? 1 : 0 } });
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE_|api\.x\.ai|schway-live-/);
  }
});


test("production-size Codex and OpenRouter discovery leaves both inference rounds their own byte budget", async () => {
  const { smokeProtocolFixture } = await import("./fixtures/live-process.ts");
  for (const [provider, catalogBytes, model] of [
    ["codex", 522_290, "gpt-6-sol"],
    ["compatible", 762_009, "meta/muse-spark-1.3-contributor"],
  ] as const) {
    const fixture = smokeProtocolFixture({ catalogBytes, inferenceBytes: 100_000 });
    const report = await runLiveSmoke({ ...selection([provider]), timeoutMs: 2000,
      models: { [provider]: model }, thinking: { [provider]: "medium" },
      compatible: { baseUrl: "https://openrouter.ai/api/v1", auth: "none" },
    }, { createStore: () => fixture.store, fetch: fixture.fetch });
    expect(report.scenarios[0]).toMatchObject({ status: "passed", reason: "verified", toolRoundTrip: true,
      diagnostics: { modelAttemptsStarted: 2, modelRoundsCompleted: 2, toolResultsCompleted: 1,
        httpRequestsStarted: 3, httpResponsesReceived: 3 } });
    expect(fixture.requests).toHaveLength(3);
  }
});


test("large discovery preserves cumulative inference limits across rounds", async () => {
  const { smokeProtocolFixture } = await import("./fixtures/live-process.ts");
  const fixture = smokeProtocolFixture({ catalogBytes: 762_009, inferenceBytes: 150_000 });
  const report = await runLiveSmoke({ ...selection(["compatible"]), timeoutMs: 2000,
    models: { compatible: "meta/muse-spark-1.3-contributor" }, thinking: { compatible: "medium" },
    compatible: { baseUrl: "https://openrouter.ai/api/v1", auth: "none" },
  }, { fetch: fixture.fetch });
  expect(report.scenarios[0]).toMatchObject({ status: "failed_provider", reason: "output_limit", toolRoundTrip: false,
    diagnostics: { modelAttemptsStarted: 2, modelRoundsCompleted: 1, toolResultsCompleted: 1,
      httpRequestsStarted: 3, httpResponsesReceived: 3 } });
});


test("smoke advertises the same relative sentinel path restriction it enforces", async () => {
  const requests: ModelRequest[] = [];
  const report = await runLiveSmoke({ ...selection(["xai-api-key"]), env: { XAI_API_KEY: "PRIVATE_KEY" } }, {
    createStore: () => missingStore,
    createModel: async () => validModel(requests),
  });
  expect(report.scenarios[0]).toMatchObject({ status: "passed", reason: "verified", toolRoundTrip: true });
  const tool = requests[0]?.tools?.find(tool => tool.name === "read");
  expect(tool).toBeDefined();
  const validate = new Ajv().compile(tool!.inputSchema);
  expect(validate({ path: "smoke-sentinel.txt", limit: 5 })).toBe(true);
  // Captured #189 failure pattern: the general read contract accepts the absolute spelling.
  const root = requests[0]!.context.find(section => section.name === "environment")?.content.match(/Workspace root: (.+)/)?.[1];
  expect(root).toBeDefined();
  expect(validate({ path: `${root}/smoke-sentinel.txt`, limit: 5 })).toBe(false);
  for (const path of ["./smoke-sentinel.txt", "wrong.txt", "/etc/passwd"]) expect(validate({ path })).toBe(false);
  expect(tool?.description).toContain("exact relative path");
  const user = requests[0]!.items.find(item => item.type === "user");
  expect(user?.type === "user" ? JSON.stringify(user.content) : "").toContain('path exactly');
});


test("captured xAI absolute sentinel call remains a failed read rather than a verified round trip", async () => {
  let root = "";
  let reads = 0;
  const report = await runLiveSmoke({ ...selection(["xai-api-key"]), env: { XAI_API_KEY: "PRIVATE_KEY" } }, {
    createStore: () => missingStore,
    onWorkspace: workspace => { root = workspace.root; },
    readSentinel: async () => { reads++; throw Error("absolute path must be rejected before reading"); },
    createModel: async () => createScriptedModel({ responses: [
      () => ({ toolCalls: [{ id: "read1", name: "read", arguments: { path: `${root}/smoke-sentinel.txt`, limit: 5 } }] }),
      { text: "I cannot read the file." },
    ] }),
  });
  expect(reads).toBe(0);
  expect(report.scenarios[0]).toMatchObject({ status: "failed_provider", reason: "missing_tool_evidence", toolRoundTrip: false,
    diagnostics: { modelAttemptsStarted: 2, modelRoundsCompleted: 2, toolResultsCompleted: 1 } });
  expect(JSON.stringify(report)).not.toMatch(/PRIVATE_|smoke-sentinel|schway-live-/);
});
