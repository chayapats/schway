import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { createContextManager } from "../src/context/manager.ts";
import { loadConfigEditor } from "../src/config/editing.ts";
import { fetchSubscriptionModels, CODEX_MODELS_URL, CODEX_RESPONSES_URL, createCodexSubscriptionModel } from "../src/model/providers/codex-subscription.ts";
import { createSession } from "../src/session/session.ts";
import { TuiController } from "../src/tui/controller.ts";
import { withTempDir } from "./helpers.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { codexSubscriptionIdentity } from "../src/auth/store.ts";

const catalog = { models: [
  { slug: "real-codex", visibility: "list", context_window: 111000 },
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
    const requests: Array<{ url: string; model?: string }> = [];
    const transport = async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith(CODEX_MODELS_URL)) {
        requests.push({ url: String(url) });
        return Response.json(catalog);
      }
      expect(String(url)).toBe(CODEX_RESPONSES_URL);
      const body = JSON.parse(String(init?.body));
      requests.push({ url: String(url), model: body.model });
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
      credentials: { store, env: {}, reload: async () => ({ error: "unused" }), listSubscriptionModels: signal => fetchSubscriptionModels({ store, fetch: transport, signal }) },
      stageSettings: async settings => ({ model: createCodexSubscriptionModel({ model: settings.model, store, fetch: transport }), contextManager: createContextManager(workspace) }),
    });
    try {
      controller.openModelPicker();
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      controller.searchModels("real-codex");
      expect(await controller.selectPickerModel()).toBe(true);
      await controller.submit("hello");
      expect(requests.map(request => request.model).filter(Boolean)).toEqual(["real-codex"]);
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
