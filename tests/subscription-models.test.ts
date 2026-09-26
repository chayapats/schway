import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { createContextManager } from "../src/context/manager.ts";
import { runCli } from "../src/cli/main.ts";
import { loadConfigEditor } from "../src/config/editing.ts";
import { fetchSubscriptionCatalog, fetchSubscriptionModels, CODEX_MODELS_URL, CODEX_RESPONSES_URL, createCodexSubscriptionModel, resolveCodexReasoning } from "../src/model/providers/codex-subscription.ts";
import { createSession } from "../src/session/session.ts";
import { TuiController } from "../src/tui/controller.ts";
import { withTempDir } from "./helpers.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { codexSubscriptionIdentity } from "../src/auth/store.ts";

const catalog = { models: [
  { slug: "real-codex", visibility: "list", context_window: 111000, default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "max" }] },
  { slug: "hidden-codex", visibility: "hide" },
  { slug: "real-codex", visibility: "list" },
  { slug: "bad/slash", visibility: "list" },
] };

test("subscription discovery uses Codex account auth and the official catalog, never Platform models", async () => {
  const store = fakeCredentialStore();
  await store.set(codexSubscriptionIdentity(), JSON.stringify({ accessToken: "subscription-secret", accountId: "account-fixture", expiresAt: Date.now() + 600_000 }));
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const models = await fetchSubscriptionModels({ store, fetch: async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json(catalog);
  } });
  expect(models).toEqual(["real-codex"]);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toStartWith(`${CODEX_MODELS_URL}?client_version=`);
  expect(requests[0]!.init?.method).toBe("GET");
  expect(requests[0]!.init?.redirect).toBe("error");
  expect(requests[0]!.init?.headers).toMatchObject({ Authorization: "Bearer subscription-secret", "ChatGPT-Account-Id": "account-fixture" });
  expect(JSON.stringify(models)).not.toContain("subscription-secret");
});

test("subscription catalog retains verified reasoning capabilities and context without exposing hidden models", async () => {
  const store = fakeCredentialStore();
  await store.set(codexSubscriptionIdentity(), JSON.stringify({ accessToken: "subscription-secret", expiresAt: Date.now() + 600_000 }));
  const models = await fetchSubscriptionCatalog({ store, fetch: async () => Response.json({ models: [
    { slug: "real-codex", visibility: "list", context_window: 111000, default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }, { effort: "max" }, { effort: "ultra" }] },
    { slug: "hidden-codex", visibility: "hide", default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low" }] },
  ] }) });
  expect(models).toEqual([{ id: "real-codex", contextWindow: 111000, defaultThinking: "medium", supportedThinking: ["low", "medium", "high", "xhigh", "max", "ultra"] }]);
  expect(JSON.stringify(models)).not.toContain("subscription-secret");
});

test("verified subscription metadata validates thinking and budgets only for the selected account model", async () => {
  await withTempDir(async root => {
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, cli: { provider: "openai", openaiAuth: "codex" } });
    editor.setModelCapabilities([{ id: "real-codex", contextWindow: 111000, defaultThinking: "medium", supportedThinking: ["low", "medium", "high", "max"] }]);
    const choice = await editor.prepareModel("openai", "real-codex");
    await choice.commit();
    expect(editor.settings.contextWindow).toBe(111000);
    expect(editor.settings.defaultThinking).toBe("medium");
    expect(editor.settings.thinking).toBeUndefined();
    await (await editor.prepare({ scope: "session", key: "thinking", value: "max" })).commit();
    expect(editor.settings.thinking).toBe("max");
    await expect(editor.prepare({ scope: "session", key: "thinking", value: "ultra" })).rejects.toThrow("subscription catalog");
    expect(editor.settings.thinking).toBe("max");
  });
});

test("subscription activation preserves compatible thinking and shadows unsupported saved thinking only in session", async () => {
  await withTempDir(async root => {
    const home = join(root, "home");
    await mkdir(join(home, ".schway"), { recursive: true });
    await Bun.write(join(home, ".schway/config.json"), JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-6", thinking: "high" }));
    const editor = await loadConfigEditor({ home, workspaceRoot: root });
    editor.setModelCapabilities([{ id: "real-codex", defaultThinking: "low", supportedThinking: ["low"] }]);
    await (await editor.prepareSubscriptionModel("real-codex")).commit();
    expect(editor.settings).toMatchObject({ provider: "openai", model: "real-codex", openaiAuth: "codex", defaultThinking: "low" });
    expect(editor.settings.thinking).toBeUndefined();
    expect((await Bun.file(join(home, ".schway/config.json")).json()).thinking).toBe("high");
    expect((await editor.prepare({ scope: "session", key: "thinking", value: "low" })).settings.thinking).toBe("low");
  });
});

test("explicit Codex login activates the account model and reasoning only in this session", async () => {
  await withTempDir(async root => {
    const home = join(root, "home");
    await mkdir(join(home, ".schway"), { recursive: true });
    await Bun.write(join(home, ".schway/config.json"), JSON.stringify({ provider: "openai-compatible", model: "local-model", baseUrl: "http://localhost:11434/v1" }));
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({ home, workspaceRoot: root });
    const capability = { id: "real-codex", contextWindow: 111000, defaultThinking: "medium" as const, supportedThinking: ["low", "medium", "high", "max"] as const };
    const store = fakeCredentialStore();
    await store.set(codexSubscriptionIdentity(), "test-store-value");
    const controller = new TuiController({ session: createSession(), sessionId: "auto-login", workspace,
      configEditor: editor, provider: editor.settings.provider, modelId: editor.settings.model,
      model: createScriptedModel({ provider: "openai-compatible" }), contextManager: createContextManager(workspace),
      credentials: { store, env: {}, reload: async () => ({ model: createScriptedModel({ provider: "codex-subscription" }) }), codexLogin: async () => ({ ok: true as const, status: "Signed in" }), listSubscriptionCatalog: async () => [capability] },
      stageSettings: async settings => ({ model: createScriptedModel({ provider: "codex-subscription", id: settings.model }), contextManager: createContextManager(workspace) }),
    });
    try {
      expect(await controller.login("codex")).toBe(true);
      expect(controller.snapshot()).toMatchObject({ provider: "openai", modelId: "real-codex" });
      expect(editor.settings).toMatchObject({ provider: "openai", model: "real-codex", openaiAuth: "codex", contextWindow: 111000, defaultThinking: "medium" });
      expect(controller.describeThinking()).toContain("provider default (medium");
      expect(await controller.thinkingCommand("max")).toBe(true);
      expect(controller.snapshot().thinking).toBe("max");
      expect(await controller.thinkingCommand("ultra")).toBe(false);
      expect(await controller.thinkingCommand("reset")).toBe(true);
      expect(controller.describeThinking()).toContain("provider default (medium");
      expect((await Bun.file(join(home, ".schway/config.json")).json()).provider).toBe("openai-compatible");
      expect(resolveCodexReasoning("max", "real-codex", capability)).toEqual({ effort: "max", summary: "auto" });
      expect(() => resolveCodexReasoning("ultra", "real-codex", capability)).toThrow("subscription catalog");
      expect(await controller.logout("codex")).toBe(true);
      expect(controller.describeThinking()).not.toContain("Supported:");
    } finally { controller.dispose(); }
  });
});

test("denied login never switches provider or fetches subscription models", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, cli: { provider: "anthropic" } });
    let discovered = 0;
    const controller = new TuiController({ session: createSession(), sessionId: "denied-login", workspace,
      configEditor: editor, provider: "anthropic", modelId: editor.settings.model,
      model: createScriptedModel({ provider: "anthropic" }), contextManager: createContextManager(workspace),
      credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ error: "unused" }), codexLogin: async () => ({ ok: false as const, message: "Denied" }), listSubscriptionCatalog: async () => { discovered++; return []; } },
      stageSettings: async () => { throw Error("unexpected adapter change"); },
    });
    try {
      expect(await controller.login("codex")).toBe(false);
      expect(controller.snapshot().provider).toBe("anthropic");
      expect(discovered).toBe(0);
    } finally { controller.dispose(); }
  });
});

test("cancelling post-login discovery leaves the previous provider active and retains sign-in", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, cli: { provider: "anthropic" } });
    let begin!: () => void;
    const requested = new Promise<void>(resolve => { begin = resolve; });
    const controller = new TuiController({ session: createSession(), sessionId: "cancel-discovery", workspace,
      configEditor: editor, provider: "anthropic", modelId: editor.settings.model,
      model: createScriptedModel({ provider: "anthropic" }), contextManager: createContextManager(workspace),
      credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ error: "unused" }), codexLogin: async () => ({ ok: true as const, status: "Signed in" }),
        listSubscriptionCatalog: signal => { begin(); return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })); } },
      stageSettings: async () => { throw Error("unexpected adapter change"); },
    });
    try {
      const pending = controller.login("codex");
      await requested;
      expect(controller.running).toBe(true);
      controller.cancel();
      expect(await pending).toBe(false);
      expect(controller.snapshot().provider).toBe("anthropic");
    } finally { controller.dispose(); }
  });
});

test("a signed-in account can retry discovery in /model without repeating OAuth", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, cli: { provider: "anthropic" } });
    let attempts = 0;
    const controller = new TuiController({ session: createSession(), sessionId: "retry-catalog", workspace,
      configEditor: editor, provider: "anthropic", modelId: editor.settings.model,
      model: createScriptedModel({ provider: "anthropic" }), contextManager: createContextManager(workspace),
      credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ error: "unused" }), codexLogin: async () => ({ ok: true as const, status: "Signed in" }),
        listSubscriptionCatalog: async () => {
          if (++attempts === 1) throw new Error("Temporary catalog failure");
          return [{ id: "real-codex", defaultThinking: "low", supportedThinking: ["low"] }];
        } },
      stageSettings: async settings => ({ model: createScriptedModel({ provider: "codex-subscription", id: settings.model }), contextManager: createContextManager(workspace) }),
    });
    try {
      expect(await controller.login("codex")).toBe(false);
      expect(controller.snapshot().provider).toBe("anthropic");
      expect(controller.openModelPicker()).toBe(true);
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      expect(controller.snapshot().modelPicker?.entries.map(entry => entry.modelId)).toEqual(["real-codex"]);
      expect(await controller.selectPickerModel()).toBe(true);
      expect(controller.snapshot()).toMatchObject({ provider: "openai", modelId: "real-codex" });
      expect(attempts).toBe(2);
    } finally { controller.dispose(); }
  });
});

test("Codex catalog uses a compatible client version rather than Schway's package version", async () => {
  const store = fakeCredentialStore();
  await store.set(codexSubscriptionIdentity(), JSON.stringify({ accessToken: "subscription-secret", expiresAt: Date.now() + 600_000 }));
  const seen: string[] = [];
  const models = await fetchSubscriptionModels({ store, fetch: async url => {
    const clientVersion = new URL(String(url)).searchParams.get("client_version") ?? "";
    seen.push(clientVersion);
    // The real backend returned zero models for Schway 0.1.0, but visible models for Codex 0.156.1.
    return Response.json(clientVersion === "0.156.1" ? catalog : { models: [] });
  } });
  expect(seen).toEqual(["0.156.1"]);
  expect(models).toEqual(["real-codex"]);
});

test("headless Codex discovers an available model and advertised thinking without API-key billing", async () => {
  await withTempDir(async root => {
    const store = fakeCredentialStore();
    await store.set(codexSubscriptionIdentity(), JSON.stringify({ accessToken: "subscription-secret", accountId: "account-fixture", expiresAt: Date.now() + 600_000 }));
    const requests: Array<{ url: string; model?: string; effort?: string }> = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(["--provider", "openai", "--openai-auth", "codex", "--thinking", "max", "-p", "hi"], {
      cwd: root, env: { HOME: join(root, "home"), OPENAI_API_KEY: "unused-api-key" }, credentialStore: store,
      stdout: { write: text => { stdout.push(text); } }, stderr: { write: text => { stderr.push(text); } },
      fetch: async (url, init) => {
        if (String(url).startsWith(CODEX_MODELS_URL)) { requests.push({ url: String(url) }); return Response.json(catalog); }
        expect(String(url)).toBe(CODEX_RESPONSES_URL);
        const body = JSON.parse(String(init?.body));
        requests.push({ url: String(url), model: body.model, effort: body.reasoning?.effort });
        expect(init?.headers).toMatchObject({ Authorization: "Bearer subscription-secret" });
        return new Response([
          { type: "response.created", response: { id: "r", status: "in_progress" } },
          { type: "response.output_item.added", output_index: 0, item: { type: "message" } },
          { type: "response.output_text.delta", output_index: 0, delta: "subscription replied" },
          { type: "response.output_item.done", output_index: 0, item: { type: "message" } },
          { type: "response.completed", response: { id: "r", status: "completed" } },
        ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    expect(code).toBe(0);
    expect(requests.map(request => request.model).filter(Boolean)).toEqual(["real-codex"]);
    expect(requests.find(request => request.model)?.effort).toBe("max");
    expect(stdout.join("")).toContain("subscription replied");
    expect(stderr.join("")).not.toContain("subscription-secret");
    expect(requests.some(request => request.url.includes("api.openai.com"))).toBe(false);
  });
});

test("automatic API-key selection never borrows subscription catalog capabilities", async () => {
  await withTempDir(async root => {
    const store = fakeCredentialStore();
    await store.set(codexSubscriptionIdentity(), JSON.stringify({ accessToken: "subscription-secret", expiresAt: Date.now() + 600_000 }));
    const stderr: string[] = [];
    let requests = 0;
    const code = await runCli(["--provider", "openai", "--model", "gpt-5.4", "--thinking", "max", "-p", "hi"], {
      cwd: root, env: { HOME: join(root, "home"), OPENAI_API_KEY: "api-key-secret" }, credentialStore: store,
      stdout: { write: () => {} }, stderr: { write: text => { stderr.push(text); } },
      fetch: async () => { requests++; return Response.json(catalog); },
    });
    expect(code).toBe(1);
    expect(stderr.join("")).toContain('Thinking level "max" is not supported');
    expect(stderr.join("")).not.toContain("api-key-secret");
    expect(requests).toBe(0);
  });
});

test("catalog rejects absent auth, malformed/oversized responses and status errors without leaking secrets", async () => {
  const store = fakeCredentialStore();
  let contacted = 0;
  const fetch = async () => { contacted++; return Response.json(catalog); };
  await expect(fetchSubscriptionModels({ store, fetch })).rejects.toThrow("/login codex");
  expect(contacted).toBe(0);
  await store.set(codexSubscriptionIdentity(), JSON.stringify({ accessToken: "subscription-secret", expiresAt: Date.now() + 600_000 }));
  for (const response of [
    new Response("subscription-secret", { status: 401 }),
    Response.json({ models: "invalid" }),
    new Response("x".repeat(1_100_000)),
  ]) {
    try {
      await fetchSubscriptionModels({ store, fetch: async () => response });
      throw Error("unexpected success");
    } catch (error) {
      expect(String(error)).not.toContain("subscription-secret");
    }
  }
});

test("subscription catalog refreshes expired credentials without falling back to an API key", async () => {
  const store = fakeCredentialStore();
  await store.set(codexSubscriptionIdentity(), JSON.stringify({ accessToken: "old-token", refreshToken: "refresh-fixture", expiresAt: Date.now() - 1_000 }));
  const paths: string[] = [];
  const models = await fetchSubscriptionModels({ store, fetch: async (url, init) => {
    paths.push(String(url));
    if (String(url).includes("/oauth/token")) return Response.json({ access_token: "new-token", expires_in: 3600, token_type: "Bearer" });
    expect(init?.headers).toMatchObject({ Authorization: "Bearer new-token" });
    return Response.json(catalog);
  } });
  expect(models).toEqual(["real-codex"]);
  expect(paths).toHaveLength(2);
  expect(paths[1]).toStartWith(CODEX_MODELS_URL);
  expect(paths.some(path => path.includes("api.openai.com/v1/models"))).toBe(false);
});

test("cancelling model discovery does not reveal provider error text", async () => {
  const store = fakeCredentialStore();
  await store.set(codexSubscriptionIdentity(), JSON.stringify({ accessToken: "subscription-secret", expiresAt: Date.now() + 600_000 }));
  const abort = new AbortController();
  const pending = fetchSubscriptionModels({ store, signal: abort.signal, fetch: async () => {
    abort.abort();
    throw new Error("provider echoed subscription-secret");
  } });
  await expect(pending).rejects.toThrow("Model discovery cancelled.");
});

test("catalog failure never falls back to static OpenAI choices", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const configEditor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, cli: { provider: "openai", openaiAuth: "codex" } });
    const controller = new TuiController({
      session: createSession(), sessionId: "failure", workspace, configEditor,
      provider: "openai", modelId: "gpt-5.4", model: createScriptedModel({ provider: "codex-subscription" }),
      contextManager: createContextManager(workspace),
      credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ error: "unused" }), listSubscriptionModels: async () => { throw Error("Sign in with /login codex"); } },
    });
    try {
      controller.openModelPicker();
      await Bun.sleep(0);
      const picker = controller.snapshot().modelPicker!;
      expect(picker.error).toContain("/login codex");
      expect(picker.entries.some(entry => entry.provider === "openai")).toBe(false);
      expect(await controller.selectModel("openai/gpt-5.4")).toBe(false);
    } finally { controller.dispose(); }
  });
});

test("explicit Codex preference discovers models even before switching from another provider", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    await mkdir(join(root, "home/.schway"), { recursive: true });
    await Bun.write(join(root, "home/.schway/config.json"), JSON.stringify({ openaiAuth: "codex" }));
    const configEditor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root });
    const controller = new TuiController({
      session: createSession(), sessionId: "switch-provider", workspace, configEditor,
      provider: "anthropic", modelId: "claude-sonnet-4-6", model: createScriptedModel({ provider: "anthropic" }),
      contextManager: createContextManager(workspace),
      credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ error: "unused" }), listSubscriptionModels: async () => ["real-codex"] },
      stageSettings: async settings => ({ model: createScriptedModel({ provider: "codex-subscription", id: settings.model }), contextManager: createContextManager(workspace) }),
    });
    try {
      controller.openModelPicker();
      await Bun.sleep(0);
      expect(controller.snapshot().modelPicker?.entries.filter(entry => entry.provider === "openai").map(entry => entry.modelId)).toEqual(["real-codex"]);
      expect(await controller.selectModel("openai/gpt-5.4")).toBe(false);
      expect(controller.snapshot().provider).toBe("anthropic");
      expect(await controller.selectModel("openai/real-codex")).toBe(true);
      expect(controller.snapshot().modelId).toBe("real-codex");
    } finally { controller.dispose(); }
  });
});

test("account catalog selection reaches the real Schway loop and Codex request body", async () => {
  await withTempDir(async root => {
    const store = fakeCredentialStore();
    await store.set(codexSubscriptionIdentity(), JSON.stringify({ accessToken: "subscription-secret", accountId: "account-fixture", expiresAt: Date.now() + 600_000 }));
    const requests: Array<{ url: string; model?: string; effort?: string }> = [];
    const transport = async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith(CODEX_MODELS_URL)) {
        requests.push({ url: String(url) });
        return Response.json(catalog);
      }
      expect(String(url)).toBe(CODEX_RESPONSES_URL);
      const body = JSON.parse(String(init?.body));
      requests.push({ url: String(url), model: body.model, effort: body.reasoning?.effort });
      return new Response([
        { type: "response.created", response: { id: "r", status: "in_progress" } },
        { type: "response.output_item.added", output_index: 0, item: { type: "message" } },
        { type: "response.output_text.delta", output_index: 0, delta: "real model replied" },
        { type: "response.output_item.done", output_index: 0, item: { type: "message" } },
        { type: "response.completed", response: { id: "r", status: "completed" } },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
    };
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const configEditor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, cli: { provider: "openai", openaiAuth: "codex" } });
    const controller = new TuiController({
      session: createSession(), sessionId: "real-loop", workspace, configEditor,
      provider: "openai", modelId: "gpt-5.4", model: createCodexSubscriptionModel({ store, fetch: transport }),
      contextManager: createContextManager(workspace),
      credentials: { store, env: {}, reload: async () => ({ error: "unused" }), listSubscriptionCatalog: signal => fetchSubscriptionCatalog({ store, fetch: transport, signal }) },
      stageSettings: async settings => ({ model: createCodexSubscriptionModel({ model: settings.model, thinking: settings.thinking, modelCapability: settings.supportedThinking ? { id: settings.model, supportedThinking: settings.supportedThinking } : undefined, store, fetch: transport }), contextManager: createContextManager(workspace) }),
    });
    try {
      controller.openModelPicker();
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      controller.searchModels("real-codex");
      expect(await controller.selectPickerModel()).toBe(true);
      expect(controller.describeThinking()).toContain("provider default (medium");
      expect(await controller.thinkingCommand("max")).toBe(true);
      await controller.submit("hello");
      expect(requests.map(request => request.model).filter(Boolean)).toEqual(["real-codex"]);
      expect(requests.find(request => request.model)?.effort).toBe("max");
      expect(controller.snapshot().transcript.some(entry => entry.text.includes("real model replied"))).toBe(true);
    } finally { controller.dispose(); }
  });
});

test("authenticated subscription picker shows only fetched models, validates selection, and clears stale results", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const configEditor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, cli: { provider: "openai", openaiAuth: "codex" } });
    let resolveFirst!: (models: string[]) => void;
    let requests = 0;
    const load = () => {
      requests++;
      return requests === 1 ? new Promise<string[]>(resolve => { resolveFirst = resolve; }) : Promise.resolve(["real-codex"]);
    };
    const controller = new TuiController({
      session: createSession(), sessionId: "models", workspace, configEditor,
      provider: "openai", modelId: "gpt-5.4", model: createScriptedModel({ provider: "codex-subscription" }),
      contextManager: createContextManager(workspace),
      credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ error: "unused" }), listSubscriptionModels: load },
      stageSettings: async settings => ({ model: createScriptedModel({ provider: "codex-subscription", id: settings.model }), contextManager: createContextManager(workspace) }),
    });
    try {
      expect(controller.openModelPicker()).toBe(true);
      expect(controller.snapshot().modelPicker?.loading).toBe(true);
      expect(controller.snapshot().modelPicker?.entries.some(entry => entry.provider === "openai")).toBe(false);
      controller.closeModelPicker();
      expect(controller.openModelPicker()).toBe(true);
      await Bun.sleep(0);
      expect(controller.snapshot().modelPicker?.entries.filter(entry => entry.provider === "openai").map(entry => entry.modelId)).toEqual(["real-codex"]);
      resolveFirst(["stale-codex"]);
      await Bun.sleep(0);
      expect(controller.snapshot().modelPicker?.entries.some(entry => entry.modelId === "stale-codex")).toBe(false);
      controller.searchModels("openai/gpt-5.4");
      expect(controller.snapshot().modelPicker?.entries).toEqual([]);
      expect(await controller.selectModel("openai/gpt-5.4")).toBe(false);
      expect(controller.snapshot().modelId).toBe("gpt-5.4");
      controller.searchModels("real-codex");
      expect(await controller.selectPickerModel()).toBe(true);
      expect(controller.snapshot().modelId).toBe("real-codex");
    } finally { controller.dispose(); }
  });
});
