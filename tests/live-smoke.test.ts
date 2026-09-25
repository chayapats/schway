import { expect, test } from "bun:test";
import { access } from "node:fs/promises";
import type { Model, ModelRequest } from "../src/model/model.ts";
import type { CredentialStore } from "../src/auth/store.ts";
import { runLiveSmoke, type SmokeSelection } from "../src/live/smoke.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { loadProviderModel } from "../src/model/loader.ts";
import { encodeChatCompletionsSse } from "./fixtures/openai-compatible.ts";

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

test("expired subscription without refresh is pending and never starts login", async () => {
  const report = await runLiveSmoke(selection(["codex"]), {
    createStore: () => ({ ...missingStore, get: async () => JSON.stringify({ accessToken: "private", expiresAt: 1 }) }),
    createModel: async () => { throw Error("should not instantiate expired token"); },
  });
  expect(report.scenarios[0]).toMatchObject({ status: "pending", reason: "subscription_requires_login" });
});
