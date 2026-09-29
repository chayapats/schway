import { expect, test } from "bun:test";
import { join } from "node:path";
import { resolveSettings, validateThinking } from "../src/config/config.ts";
import { ConfigEditor } from "../src/config/editing.ts";
import { parseModelList, openRouterModelCapabilities } from "../src/model/model-list.ts";
import { assertThinking, describeEffectiveThinking, resolveThinkingPolicy } from "../src/model/thinking.ts";
import { createOpenAICompatibleModel } from "../src/model/providers/openai-compatible.ts";
import { createOpenAIModel } from "../src/model/providers/openai.ts";
import { createXaiModel } from "../src/model/providers/xai.ts";
import { resolveCodexReasoning } from "../src/model/providers/codex-subscription.ts";
import { runCli } from "../src/cli/main.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { TuiController } from "../src/tui/controller.ts";
import { loadInteractiveModel } from "../src/tui/app.ts";
import { preferenceRows } from "../src/tui/preferences.ts";
import { collect, createScriptedModel } from "./helpers/scripted-model.ts";
import { withTempDir } from "./helpers.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { sampleRequest, encodeSse, TEXT_STREAM_EVENTS } from "./fixtures/openai.ts";
import { encodeChatCompletionsSse, TEXT_STREAM_CHUNKS } from "./fixtures/openai-compatible.ts";

const baseUrl = "https://openrouter.ai/api/v1";
const modelId = "meta/muse-spark-1.3-contributor";
const payload = { data: [{ id: modelId, reasoning: { mandatory: true, supported_efforts: ["max", "xhigh", "high", "medium", "low", "minimal"], default_effort: "medium" } }] };
const models = () => parseModelList(payload, "OpenRouter", baseUrl);
const capability = () => openRouterModelCapabilities(models())[0]!;

test("OpenAI Luna and Sol requested/default reasoning agrees with Responses wire controls", async () => {
  for (const model of ["gpt-6-luna", "gpt-6-sol"]) {
    const settings = resolveSettings({ cli: { provider: "openai", model, thinking: "medium" } });
    expect(settings).toMatchObject({ thinking: "medium", defaultThinking: "medium" });
    const bodies: Record<string, unknown>[] = [];
    const adapter = createOpenAIModel({ apiKey: "fixture", model, fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(encodeSse(TEXT_STREAM_EVENTS), { headers: { "content-type": "text/event-stream" } });
    } });
    for (const thinking of [undefined, "medium", "off"] as const) await collect(adapter.stream({ ...sampleRequest(), thinking }));
    expect(bodies.map(body => body.reasoning)).toEqual([undefined, { effort: "medium", summary: "auto" }, { effort: "none" }]);
    expect(describeEffectiveThinking("openai", undefined, model)).toContain("provider default (medium");
    await expect(collect(adapter.stream({ ...sampleRequest(), thinking: "minimal" }))).rejects.toThrow("not supported");
    expect(bodies).toHaveLength(3);
  }
});

test("OpenRouter parses exact efforts, respects mandatory reasoning and does not guess missing metadata", () => {
  const cap = capability();
  const context = { provider: "openai-compatible", model: modelId, baseUrl, capability: cap };
  expect(resolveThinkingPolicy(context)).toMatchObject({ provenance: "provider-catalog", defaultThinking: "medium", supportsDisabling: false });
  expect(validateThinking(context.provider, modelId, "medium", undefined, cap, baseUrl)).toBeUndefined();
  expect(validateThinking(context.provider, modelId, "off", undefined, cap, baseUrl)).toContain("OpenRouter model catalog");
  expect(() => assertThinking({ ...context, model: "another-model" }, "medium")).toThrow("does not match");
  expect(() => assertThinking({ ...context, baseUrl: "https://example.com/v1" }, "medium")).toThrow("endpoint");
  const listed = parseModelList({ data: [
    { id: "all", reasoning: { mandatory: false, supported_efforts: null, default_effort: "none" } },
    { id: "missing", supported_parameters: ["reasoning_effort"] },
    { id: "no-selector", reasoning: { mandatory: true } },
  ] }, "OpenRouter", baseUrl);
  const caps = openRouterModelCapabilities(listed);
  expect(caps[0]).toMatchObject({ supportedThinking: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], defaultThinking: "off", supportsDisabling: true });
  expect(caps[1]?.supportedThinking).toEqual([]);
  expect(caps[2]?.supportedThinking).toEqual([]);
  expect(parseModelList(payload, "Untrusted", "https://example.com/v1")[0]?.reasoningCapability).toBeUndefined();
});

test("OpenRouter sends exact medium/minimal, leaves defaults alone and rejects off/conflicts before fetch", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(encodeChatCompletionsSse(TEXT_STREAM_CHUNKS));
  };
  const adapter = createOpenAICompatibleModel({ baseUrl, model: modelId, modelCapability: capability(), fetch });
  for (const thinking of [undefined, "medium", "minimal"] as const) await collect(adapter.stream({ ...sampleRequest(), thinking }));
  expect(bodies.map(body => body.reasoning)).toEqual([undefined, { effort: "medium" }, { effort: "minimal" }]);
  for (const thinking of ["off", "ultra"] as const) await expect(collect(adapter.stream({ ...sampleRequest(), thinking }))).rejects.toThrow("not advertised");
  const conflict = createOpenAICompatibleModel({ baseUrl, model: modelId, modelCapability: capability(), thinking: "medium", extraBody: { reasoning: { effort: "high" } }, fetch });
  await expect(collect(conflict.stream(sampleRequest()))).rejects.toThrow("conflicts");
  expect(bodies).toHaveLength(3);
  const generic = createOpenAICompatibleModel({ baseUrl: "https://example.com/v1", model: modelId, modelCapability: capability(), fetch });
  await collect(generic.stream(sampleRequest()));
  expect(bodies[3]?.reasoning).toBeUndefined();
  await expect(collect(generic.stream({ ...sampleRequest(), thinking: "medium" }))).rejects.toThrow("not supported");
  expect(bodies).toHaveLength(4);
});

test("xAI API and Grok shared adapter rejects missing/mismatched/unadvertised efforts before fetching", async () => {
  let calls = 0;
  for (const apiKey of ["fixture", async () => "fixture"] as const) {
    const adapter = createXaiModel({ apiKey, model: "grok-fixture", modelCapability: { id: "grok-fixture", supportedThinking: ["medium"] }, fetch: async () => { calls++; return new Response(); } });
    await expect(collect(adapter.stream({ ...sampleRequest(), thinking: "ultra" }))).rejects.toThrow("not listed");
    await expect(collect(adapter.stream({ ...sampleRequest(), thinking: "off" }))).rejects.toThrow("not listed");
  }
  const mismatched = createXaiModel({ apiKey: "fixture", model: "grok-fixture", modelCapability: { id: "other", supportedThinking: ["medium"] }, fetch: async () => { calls++; return new Response(); } });
  await expect(collect(mismatched.stream({ ...sampleRequest(), thinking: "medium" }))).rejects.toThrow("does not match");
  expect(calls).toBe(0);
  expect(() => resolveCodexReasoning("medium", "codex-fixture", { id: "other", supportedThinking: ["medium"] })).toThrow("does not match");
  expect(resolveCodexReasoning(undefined, "codex-fixture", { id: "codex-fixture", supportedThinking: ["medium"], defaultThinking: "medium" })).toBeUndefined();
});

test("headless OpenRouter --thinking fetches metadata before sending exact effort without picker", async () => {
  await withTempDir(async dir => {
    const requests: { url: string; body?: Record<string, unknown> }[] = [];
    let error = "";
    const code = await runCli(["-p", "hello", "--provider", "openai-compatible", "--base-url", baseUrl, "--model", modelId, "--auth", "none", "--thinking", "medium"], {
      cwd: dir, env: { HOME: dir }, stdout: { write() {} }, stderr: { write(text) { error += text; } }, credentialStore: fakeCredentialStore(),
      fetch: async (url, init) => {
        requests.push({ url: String(url), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
        return String(url).endsWith("/models") ? Response.json(payload) : new Response(encodeChatCompletionsSse(TEXT_STREAM_CHUNKS));
      },
    });
    expect(error).toBe("");
    expect(code).toBe(0);
    expect(requests.map(request => request.url)).toEqual([`${baseUrl}/models`, `${baseUrl}/chat/completions`]);
    expect(requests[1]?.body?.reasoning).toEqual({ effort: "medium" });
  });
});

test("interactive OpenRouter discovers on /thinking, shares options with preferences and drops endpoint evidence", async () => {
  await withTempDir(async dir => {
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const editor = new ConfigEditor({ cli: { provider: "openai-compatible", model: modelId, baseUrl } }, { user: join(dir, "user.json"), project: join(dir, "project.json") });
    const controller = new TuiController({ session: createSession(), sessionId: "router-thinking", workspace, configEditor: editor,
      provider: "openai-compatible", modelId, baseUrl, model: createScriptedModel(), contextManager: createContextManager(workspace),
      credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ model: createScriptedModel() }), listRouteModels: async () => models() },
      stageSettings: async () => ({ model: createScriptedModel(), contextManager: createContextManager(workspace) }),
    });
    try {
      expect(await controller.thinkingCommand("medium")).toBe(true);
      expect(controller.snapshot().effectiveThinking).toContain("medium (reasoning effort medium)");
      expect(controller.commandChoices("/thinking ").map(choice => choice.name)).toContain("thinking minimal");
      expect(controller.commandChoices("/thinking ").map(choice => choice.name)).not.toContain("thinking off");
      expect(preferenceRows(editor, "session", []).find(row => row.key === "thinking")?.choices).toEqual([undefined, "max", "xhigh", "high", "medium", "low", "minimal"]);
      expect(await controller.thinkingCommand("off")).toBe(false);
      await (await editor.prepare({ scope: "session", key: "thinking", value: null })).commit();
      expect(controller.describeThinking()).toContain("provider default (medium");
      await (await editor.prepare({ scope: "session", key: "baseUrl", value: "https://example.com/v1" })).commit();
      expect(editor.settings.reasoningCapability).toBeUndefined();
      await expect(editor.prepare({ scope: "session", key: "thinking", value: "medium" })).rejects.toThrow("not supported");
    } finally { controller.dispose(); }
  });
});


test("interactive remembered OpenRouter reasoning loads and validates catalog before creating an adapter", async () => {
  const urls: string[] = [];
  const loaded = await loadInteractiveModel("openai-compatible", modelId, { baseUrl, thinking: "medium", auth: "none",
    runtimeApiKey: undefined, env: {}, secrets: [], credentialStore: fakeCredentialStore(),
    fetch: async (url, init) => { urls.push(String(url));
      if (String(url).endsWith("/models")) return Response.json(payload);
      expect(JSON.parse(String(init?.body)).reasoning).toEqual({ effort: "medium" });
      return new Response(encodeChatCompletionsSse(TEXT_STREAM_CHUNKS));
    },
  });
  if ("error" in loaded) throw Error(loaded.error);
  expect(loaded.capability).toMatchObject({ id: modelId, defaultThinking: "medium" });
  await collect(loaded.model.stream(sampleRequest()));
  expect(urls).toEqual([`${baseUrl}/models`, `${baseUrl}/chat/completions`]);
});

test("OpenRouter catalog refresh preserves account model capabilities and explicit defaults", async () => {
  await withTempDir(async dir => {
    const editor = new ConfigEditor({ cli: { provider: "openai", openaiAuth: "codex", model: "account-model" } },
      { user: join(dir, "user.json"), project: join(dir, "project.json") },
      [{ id: "account-model", defaultThinking: "high", supportedThinking: ["medium", "high"] }]);
    editor.setEndpointCapabilities(baseUrl, openRouterModelCapabilities(models()));
    expect(editor.settings.defaultThinking).toBe("high");
    expect((await editor.prepare({ scope: "session", key: "thinking", value: "medium" })).settings.thinking).toBe("medium");
    const disabled = openRouterModelCapabilities(parseModelList({ data: [{ id: "optional", reasoning: {
      supported_efforts: ["low", "high"], default_effort: "high", default_enabled: false,
    } }] }, "OpenRouter", baseUrl))[0]!;
    expect(disabled.defaultThinking).toBe("off");
    expect(describeEffectiveThinking("openai-compatible", undefined, "optional", { baseUrl, capability: disabled })).toContain("provider default (off");
  });
});

test("xAI preserves an exact newly advertised effort instead of dropping it through OpenAI SDK enums", async () => {
  let body: Record<string, unknown> | undefined;
  const adapter = createXaiModel({ apiKey: "fixture", model: "grok-fixture", thinking: "ultra",
    modelCapability: { id: "grok-fixture", supportedThinking: ["ultra"] }, fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body)); return new Response(encodeSse(TEXT_STREAM_EVENTS));
    } });
  await collect(adapter.stream(sampleRequest()));
  expect(body?.reasoning).toEqual({ effort: "ultra", summary: "auto" });
});
