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
import { stageInteractiveSettings, loadInteractiveModel } from "../src/tui/app.ts";
import { preferenceRows } from "../src/tui/preferences.ts";
import { collect, createScriptedModel } from "./helpers/scripted-model.ts";
import { withTempDir } from "./helpers.ts";
import { credentialIdentity, grokSubscriptionIdentity } from "../src/auth/store.ts";
import { bindGrokModel } from "../src/model/loader.ts";
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


test("typed OpenRouter model switches discover uncached targets and roll back unsupported efforts", async () => {
  await withTempDir(async dir => {
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const editor = new ConfigEditor({ cli: { provider: "openai-compatible", model: modelId, thinking: "medium", baseUrl, auth: "none" } },
      { user: join(dir, "user.json"), project: join(dir, "project.json") }, [capability()]);
    const discovered: string[] = [];
    const store = fakeCredentialStore();
    const currentModel = createScriptedModel({ provider: "openai-compatible", id: modelId });
    const controller = new TuiController({ session: createSession(), sessionId: "router-switch", workspace, configEditor: editor,
      provider: "openai-compatible", modelId, baseUrl, model: currentModel, contextManager: createContextManager(workspace),
      stageSettings: (next, signal, _workspace, model) => stageInteractiveSettings(next, editor.settings, {
        forceLoad: true, model, signal, workspace, home: dir, runtimeApiKey: undefined, env: {}, secrets: [], credentialStore: store,
        fetch: async url => { discovered.push(String(url)); return Response.json({ data: [
          { id: "org/second", reasoning: { supported_efforts: ["medium"], default_effort: "medium" } },
          { id: "org/unsupported", reasoning: { supported_efforts: ["low"] } },
        ] }); },
      }),
    });
    try {
      expect(await controller.selectModel("openai-compatible/org/second")).toBe(true);
      expect(editor.settings).toMatchObject({ model: "org/second", thinking: "medium", reasoningCapability: { id: "org/second" } });
      expect(discovered).toEqual([`${baseUrl}/models`]);
      expect(await controller.selectModel("openai-compatible/org/unsupported")).toBe(false);
      expect(discovered).toEqual([`${baseUrl}/models`, `${baseUrl}/models`]);
      expect(editor.settings.model).toBe("org/second");
      expect(controller.snapshot().modelId).toBe("org/second");
      expect(editor.settings.thinking).toBe("medium");
    } finally { controller.dispose(); }
  });
});

test("same-model Grok/API-key switches fetch the target route and reject its unsupported effort transactionally", async () => {
  for (const from of ["grok", "api-key"] as const) await withTempDir(async dir => {
    const to = from === "grok" ? "api-key" : "grok";
    const modelId = "grok-shared";
    const thinking = from === "grok" ? "medium" : "low";
    let targetEffort: "low" | "medium" = from === "grok" ? "low" : "medium";
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const store = fakeCredentialStore();
    await store.set(grokSubscriptionIdentity(), JSON.stringify({ accessToken: "fixture-grok", obtainedAt: 1 }));
    const editor = new ConfigEditor({ cli: { provider: "xai", xaiAuth: from, model: modelId, thinking } },
      { user: join(dir, "user.json"), project: join(dir, "project.json") },
      [{ id: modelId, authRoute: from, supportedThinking: [thinking] }]);
    const current = createScriptedModel({ provider: "xai", id: modelId });
    const requests: string[] = [];
    const controller = new TuiController({ session: createSession(), sessionId: "route-switch", workspace, configEditor: editor,
      provider: "xai", xaiAuth: from, modelId, model: from === "grok" ? bindGrokModel(current) : current, contextManager: createContextManager(workspace),
      stageSettings: (next, signal, _workspace, model) => stageInteractiveSettings(next, editor.settings, {
        forceLoad: true, model, signal, workspace, home: dir, runtimeApiKey: undefined, env: { XAI_API_KEY: "fixture-api" }, secrets: [], credentialStore: store,
        fetch: async (url, init) => { requests.push(String(url));
          expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${to === "grok" ? "fixture-grok" : "fixture-api"}`);
          return Response.json({ data: [{ id: modelId, capabilities: { reasoning_effort: [targetEffort] } }] });
        },
      }),
    });
    try {
      expect(await controller.configCommand(`set xaiAuth ${to}`)).toBe(false);
      expect(requests).toEqual(["https://api.x.ai/v1/models"]);
      expect(editor.settings).toMatchObject({ xaiAuth: from, thinking });
      expect(controller.snapshot().modelId).toBe(modelId);
      targetEffort = thinking;
      expect(await controller.configCommand(`set xaiAuth ${to}`)).toBe(true);
      expect(requests).toEqual(["https://api.x.ai/v1/models", "https://api.x.ai/v1/models"]);
      expect(editor.settings).toMatchObject({ xaiAuth: to, thinking, reasoningCapability: { authRoute: to } });
    } finally { controller.dispose(); }
  });
});


test("replacement Grok credentials invalidate the old adapter and reasoning catalog before failed discovery", async () => {
  await withTempDir(async dir => {
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const editor = new ConfigEditor({ cli: { provider: "xai", xaiAuth: "grok", model: "grok-shared", thinking: "medium" } },
      { user: join(dir, "user.json"), project: join(dir, "project.json") },
      [{ id: "grok-shared", authRoute: "grok", supportedThinking: ["medium"] }]);
    const controller = new TuiController({ session: createSession(), sessionId: "grok-replacement", workspace, configEditor: editor,
      provider: "xai", xaiAuth: "grok", modelId: "grok-shared", model: bindGrokModel(createScriptedModel({ provider: "xai", id: "grok-shared" })), contextManager: createContextManager(workspace),
      credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ error: "not activated" }),
        grokLogin: async ({ onSaved }) => { onSaved?.(); return { ok: true, status: "Signed in" }; },
        listGrokModels: async () => { throw Error("Catalog unavailable"); },
      },
      stageSettings: async () => { throw Error("Must not activate without discovery"); },
    });
    try {
      expect(await controller.login("grok")).toBe(false);
      expect(editor.settings.reasoningCapability).toBeUndefined();
      expect(await controller.submit("must not reach old account adapter")).toBe(false);
    } finally { controller.dispose(); }
  });
});


test("catalog updates preserve opposite billing-route evidence for the same model ID", async () => {
  await withTempDir(async dir => {
    const editor = new ConfigEditor({ cli: { provider: "xai", xaiAuth: "grok", model: "grok-shared" } },
      { user: join(dir, "user.json"), project: join(dir, "project.json") },
      [{ id: "grok-shared", authRoute: "grok", supportedThinking: ["medium"] }]);
    editor.replaceRouteCapabilities([], [{ id: "grok-shared", authRoute: "api-key", supportedThinking: ["low"] }], "api-key");
    expect(editor.settings.supportedThinking).toEqual(["medium"]);
    expect((await editor.prepare({ scope: "session", key: "xaiAuth", value: "api-key" })).settings.supportedThinking).toEqual(["low"]);
    editor.setModelCapability({ id: "grok-shared", authRoute: "grok", supportedThinking: ["high"] });
    expect(editor.settings.supportedThinking).toEqual(["high"]);
    expect((await editor.prepare({ scope: "session", key: "xaiAuth", value: "api-key" })).settings.supportedThinking).toEqual(["low"]);
  });
});

test("replacing an xAI API key preserves the active Grok adapter and its reasoning evidence", async () => {
  await withTempDir(async dir => {
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const editor = new ConfigEditor({ cli: { provider: "xai", xaiAuth: "grok", model: "grok-shared" } },
      { user: join(dir, "user.json"), project: join(dir, "project.json") }, [
        { id: "grok-shared", authRoute: "grok", supportedThinking: ["medium"] },
        { id: "grok-shared", authRoute: "api-key", supportedThinking: ["low"] },
      ]);
    const store = fakeCredentialStore();
    await store.set(credentialIdentity({ provider: "xai" }), "old-fixture-key");
    let reloads = 0;
    const activated: string[] = [];
    const controller = new TuiController({ session: createSession(), sessionId: "api-key-replacement", workspace, configEditor: editor,
      provider: "xai", xaiAuth: "grok", modelId: "grok-shared", model: bindGrokModel(createScriptedModel({ provider: "xai", id: "grok-shared" })), contextManager: createContextManager(workspace),
      credentials: { store, env: {}, reload: async () => { reloads++; return { error: "must not reload Grok" }; } },
      onModelActivated: choice => { activated.push(choice.authRoute); },
    });
    try {
      expect(controller.beginLogin("xai")).toBe(true);
      controller.enterCredentialText("replacement-fixture-key");
      expect(await controller.submitCredential()).toBe(true);
      expect(await store.get(credentialIdentity({ provider: "xai" }))).toBe("replacement-fixture-key");
      expect(reloads).toBe(0);
      expect(activated).toEqual([]);
      expect(editor.settings).toMatchObject({ xaiAuth: "grok", supportedThinking: ["medium"], reasoningCapability: { authRoute: "grok" } });
      expect((await editor.prepareXaiModel("grok-shared")).settings.reasoningCapability).toBeUndefined();
      expect(await controller.submit("continue on the unchanged Grok account")).toBe(true);
    } finally { controller.dispose(); }
  });
});

test("failed xAI sign-in model discovery clears only API-key reasoning evidence", async () => {
  await withTempDir(async dir => {
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const editor = new ConfigEditor({ cli: { provider: "xai", xaiAuth: "api-key", model: "" } },
      { user: join(dir, "user.json"), project: join(dir, "project.json") }, [
        { id: "grok-shared", authRoute: "grok", supportedThinking: ["medium"] },
        { id: "grok-shared", authRoute: "api-key", supportedThinking: ["low"] },
      ]);
    let listings = 0;
    const controller = new TuiController({ session: createSession(), sessionId: "api-key-list-failure", workspace, configEditor: editor,
      provider: "xai", xaiAuth: "api-key", modelId: "", contextManager: createContextManager(workspace),
      credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ error: "not activated" }),
        listRouteModels: async () => { listings++; throw Error("Catalog unavailable"); },
      },
      stageSettings: async () => { throw Error("Fallback unavailable"); },
    });
    try {
      expect(controller.beginLogin("xai")).toBe(true);
      controller.enterCredentialText("fixture-key");
      expect(await controller.submitCredential()).toBe(true);
      expect(listings).toBe(1);
      expect((await editor.prepareGrokModel("grok-shared")).settings.supportedThinking).toEqual(["medium"]);
      expect((await editor.prepareXaiModel("grok-shared")).settings.reasoningCapability).toBeUndefined();
    } finally { controller.dispose(); }
  });
});
