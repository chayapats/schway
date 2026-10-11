import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { createContextManager } from "../src/context/manager.ts";
import { runCli } from "../src/cli/main.ts";
import { loadConfigEditor } from "../src/config/editing.ts";
import { resolveSettings } from "../src/config/config.ts";
import { fetchSubscriptionCatalog, fetchSubscriptionModels, CODEX_MODELS_URL, CODEX_RESPONSES_URL, createCodexSubscriptionModel, resolveCodexReasoning } from "../src/model/providers/codex-subscription.ts";
import { createSession } from "../src/session/session.ts";
import { TuiController } from "../src/tui/controller.ts";
import { modelPickerEntries } from "../src/tui/model-picker.ts";
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
  expect(models).toEqual([{ id: "real-codex", authRoute: "codex", contextWindow: 111000, defaultThinking: "medium", supportedThinking: ["low", "medium", "high", "xhigh", "max", "ultra"] }]);
  expect(JSON.stringify(models)).not.toContain("subscription-secret");
});

test("verified Codex levels remain visible when an incompatible saved effort awaits recovery", async () => {
  await withTempDir(async root => {
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root,
      cli: { provider: "openai", model: "real-codex", openaiAuth: "codex", thinking: "ultra" } });
    editor.setModelCapabilities([{ id: "real-codex", contextWindow: 64000, maxOutput: 6000, defaultThinking: "low", supportedThinking: ["low", "max"] }]);
    expect(editor.settings).toMatchObject({ thinking: "ultra", defaultThinking: "low", supportedThinking: ["low", "max"],
      contextWindow: 64000, maxOutput: 6000, catalog: { contextWindow: 64000, maxOutput: 6000 } });
    await (await editor.prepare({ scope: "session", key: "thinking", value: "max" })).commit();
    expect(editor.settings.thinking).toBe("max");
  });
});

test("missing Codex adapter still allows thinking reset after a saved unverified effort", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root,
      cli: { provider: "openai", model: "real-codex", openaiAuth: "codex", thinking: "high" } });
    const controller = new TuiController({ session: createSession(), sessionId: "no-codex-adapter", workspace,
      configEditor: editor, provider: "openai", modelId: "real-codex", contextManager: createContextManager(workspace),
      stageSettings: async () => ({ model: undefined, contextManager: createContextManager(workspace) }),
    });
    try {
      expect(controller.describeThinking()).toContain("Choose thinking · /model open choices");
      expect(await controller.thinkingCommand("reset")).toBe(true);
      expect(editor.settings.thinking).toBeUndefined();
    } finally { controller.dispose(); }
  });
});

test("Codex config rejects unverified explicit effort but loads saved settings provisionally for recovery", async () => {
  const cli = { provider: "openai" as const, model: "gpt-5.4", openaiAuth: "codex" as const, thinking: "high" as const };
  expect(resolveSettings({ cli })).toMatchObject({ error: expect.stringContaining("subscription catalog") });
  await withTempDir(async root => {
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, cli });
    expect(editor.settings.thinking).toBe("high");
    await (await editor.prepare({ scope: "session", key: "thinking", value: null })).commit();
    expect(editor.settings.thinking).toBeUndefined();
  });
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
    await Bun.write(join(home, ".schway/config.json"), JSON.stringify({ provider: "openai", model: "gpt-5.4", thinking: "high" }));
    const editor = await loadConfigEditor({ home, workspaceRoot: root });
    editor.setModelCapabilities([{ id: "real-codex", defaultThinking: "low", supportedThinking: ["low"] }]);
    await (await editor.prepareSubscriptionModel("real-codex")).commit();
    expect(editor.settings).toMatchObject({ provider: "openai", model: "real-codex", openaiAuth: "codex", defaultThinking: "low" });
    expect(editor.settings.thinking).toBeUndefined();
    expect((await Bun.file(join(home, ".schway/config.json")).json()).thinking).toBe("high");
    expect((await editor.prepare({ scope: "session", key: "thinking", value: "low" })).settings.thinking).toBe("low");
  });
});

test("Codex login without a usable model activates account reasoning only in this session", async () => {
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
      contextManager: createContextManager(workspace),
      credentials: { store, env: {}, reload: async () => ({ model: createScriptedModel({ provider: "codex-subscription" }) }), codexLogin: async () => ({ ok: true as const, status: "Signed in" }), listSubscriptionCatalog: async () => [capability] },
      stageSettings: async settings => ({ model: createScriptedModel({ provider: "codex-subscription", id: settings.model }), contextManager: createContextManager(workspace) }),
    });
    try {
      expect(await controller.login("codex")).toBe(true);
      expect(controller.snapshot()).toMatchObject({ provider: "openai", modelId: "real-codex" });
      expect(editor.settings).toMatchObject({ provider: "openai", model: "real-codex", openaiAuth: "codex", contextWindow: 111000, defaultThinking: "medium" });
      expect(controller.describeThinking()).toContain("Provider default (medium");
      expect(await controller.thinkingCommand("max")).toBe(true);
      expect(controller.snapshot().thinking).toBe("max");
      expect(await controller.thinkingCommand("ultra")).toBe(false);
      expect(await controller.thinkingCommand("reset")).toBe(true);
      expect(controller.describeThinking()).toContain("Provider default (medium");
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
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, cli: { provider: "openai" } });
    let discovered = 0;
    const controller = new TuiController({ session: createSession(), sessionId: "denied-login", workspace,
      configEditor: editor, provider: "openai", modelId: editor.settings.model,
      model: createScriptedModel({ provider: "openai" }), contextManager: createContextManager(workspace),
      credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ error: "unused" }), codexLogin: async () => ({ ok: false as const, message: "Denied" }), listSubscriptionCatalog: async () => { discovered++; return []; } },
      stageSettings: async () => { throw Error("unexpected adapter change"); },
    });
    try {
      expect(await controller.login("codex")).toBe(false);
      expect(controller.snapshot().provider).toBe("openai");
      expect(discovered).toBe(0);
    } finally { controller.dispose(); }
  });
});

test("cancelling first-login discovery retains the provider choice and sign-in", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, cli: { provider: "openai" } });
    let begin!: () => void;
    const requested = new Promise<void>(resolve => { begin = resolve; });
    const controller = new TuiController({ session: createSession(), sessionId: "cancel-discovery", workspace,
      configEditor: editor, provider: "openai", modelId: editor.settings.model,
      contextManager: createContextManager(workspace),
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
      expect(controller.snapshot().provider).toBe("openai");
    } finally { controller.dispose(); }
  });
});

test("cancelling after secure-store commit reports saved credentials and blocks the previous account adapter", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const store = fakeCredentialStore();
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root,
      cli: { provider: "openai", model: "old-codex", openaiAuth: "codex" } });
    let oldCalls = 0;
    let committed!: () => void;
    const saved = new Promise<void>(resolve => { committed = resolve; });
    const controller = new TuiController({ session: createSession(), sessionId: "cancel-after-save", workspace,
      configEditor: editor, provider: "openai", modelId: "old-codex",
      model: createScriptedModel({ provider: "codex-subscription", responses: [() => { oldCalls++; return { text: "old account" }; }] }),
      contextManager: createContextManager(workspace),
      credentials: { store, env: {}, reload: async () => ({ error: "unused" }),
        codexLogin: async ({ onSaved, signal }) => {
          await store.set(codexSubscriptionIdentity(), "replacement-credential");
          onSaved?.(); committed();
          await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
          throw new Error("unreachable");
        } },
    });
    try {
      const pending = controller.login("codex");
      await saved;
      controller.cancel();
      expect(await pending).toBe(false);
      expect(await store.get(codexSubscriptionIdentity())).toBe("replacement-credential");
      const text = JSON.stringify(controller.snapshot());
      expect(text).toContain("Sign-in cancelled; credential saved · /model choose model");
      expect(text).not.toContain("Nothing was saved");
      await controller.submit("continue task");
      expect(oldCalls).toBe(0);
    } finally { controller.dispose(); }
  });
});

test("a signed-in account can retry discovery in /model without repeating OAuth", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, cli: { provider: "openai" } });
    let attempts = 0;
    let oauthAttempts = 0;
    const store = fakeCredentialStore();
    const controller = new TuiController({ session: createSession(), sessionId: "retry-catalog", workspace,
      configEditor: editor, provider: "openai", modelId: editor.settings.model,
      contextManager: createContextManager(workspace),
      credentials: { store, env: {}, reload: async () => ({ error: "unused" }), codexLogin: async ({ onSaved }) => {
        oauthAttempts++;
        await store.set(codexSubscriptionIdentity(), "saved-account-credential");
        onSaved?.();
        return { ok: true as const, status: "Credential saved" };
      },
        listSubscriptionCatalog: async () => {
          if (++attempts === 1) throw new Error("Temporary catalog failure");
          return [{ id: "real-codex", defaultThinking: "low", supportedThinking: ["low"] }];
        } },
      stageSettings: async settings => ({ model: createScriptedModel({ provider: "codex-subscription", id: settings.model }), contextManager: createContextManager(workspace) }),
    });
    try {
      expect(await controller.login("codex")).toBe(false);
      expect(await store.get(codexSubscriptionIdentity())).toBe("saved-account-credential");
      expect(controller.snapshot().provider).toBe("openai");
      expect(controller.openModelPicker()).toBe(true);
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      expect(controller.snapshot().modelPicker?.entries.filter(entry => entry.kind === "model" && entry.authRoute === "codex").map(entry => entry.modelId)).toEqual(["real-codex"]);
      expect(controller.snapshot().modelPicker?.entries.some(entry => entry.kind === "connect")).toBe(true);
      controller.searchModels("real-codex");
      expect(await controller.selectPickerModel()).toBe(true);
      expect(controller.snapshot()).toMatchObject({ provider: "openai", modelId: "real-codex" });
      expect(attempts).toBe(2);
      expect(oauthAttempts).toBe(1);
    } finally { controller.dispose(); }
  });
});

test("activation failure keeps saved credentials and gives a redacted model retry", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const store = fakeCredentialStore();
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, cli: { provider: "openai" } });
    const controller = new TuiController({ session: createSession(), sessionId: "activation-failure", workspace,
      configEditor: editor, provider: "openai", modelId: editor.settings.model,
      contextManager: createContextManager(workspace),
      credentials: { store, env: {}, reload: async () => ({ error: "unused" }),
        codexLogin: async ({ onSaved }) => {
          await store.set(codexSubscriptionIdentity(), "saved-credential-secret");
          onSaved?.();
          return { ok: true as const, status: "Credential saved" };
        }, listSubscriptionCatalog: async () => [{ id: "account-model", supportedThinking: [] }] },
      stageSettings: async () => { throw new Error("native-activation-secret-sentinel"); },
    });
    try {
      expect(await controller.login("codex")).toBe(false);
      expect(await store.get(codexSubscriptionIdentity())).toBe("saved-credential-secret");
      expect(controller.snapshot().provider).toBe("openai");
      const text = JSON.stringify(controller.snapshot());
      expect(text).toContain("/model retry");
      expect(text).not.toContain("native-activation-secret-sentinel");
    } finally { controller.dispose(); }
  });
});

test("adding Codex does not discover or change the active API-key model's thinking", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root,
      cli: { provider: "openai", model: "gpt-5.4", openaiAuth: "api-key" } });
    let discoveries = 0;
    const controller = new TuiController({ session: createSession(), sessionId: "pending-key", workspace,
      configEditor: editor, provider: "openai", modelId: "gpt-5.4", model: createScriptedModel({ provider: "openai", id: "gpt-5.4" }),
      contextManager: createContextManager(workspace),
      stageSettings: async settings => ({ model: createScriptedModel({ provider: settings.provider, id: settings.model }), contextManager: createContextManager(workspace) }),
      credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ error: "unused" }),
        codexLogin: async () => ({ ok: true as const, status: "Signed in" }),
        listSubscriptionCatalog: async () => { discoveries++; throw Error("Catalog unavailable"); } },
    });
    try {
      expect(await controller.login("codex")).toBe(true);
      expect(discoveries).toBe(0);
      expect(await controller.thinkingCommand("")).toBe(true);
      expect(await controller.thinkingCommand("high")).toBe(true);
      expect(discoveries).toBe(0);
      expect(controller.describeThinking()).not.toContain("Choose thinking · /model open choices");
      expect(controller.describeThinking()).toContain("high");
    } finally { controller.dispose(); }
  });
});

test("re-login cannot send a turn through the previous account adapter when discovery fails", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, cli: { provider: "openai", model: "old-codex", openaiAuth: "codex" } });
    editor.setModelCapabilities([{ id: "old-codex", supportedThinking: ["low"] }]);
    const store = fakeCredentialStore();
    await store.set(codexSubscriptionIdentity(), "old-account-token");
    let oldRequests = 0;
    const oldModel = createScriptedModel({ provider: "codex-subscription", id: "old-codex", responses: [() => { oldRequests++; return { text: "old account replied" }; }] });
    let discoveries = 0;
    const controller = new TuiController({ session: createSession(), sessionId: "account-change", workspace,
      configEditor: editor, provider: "openai", modelId: "old-codex", model: oldModel, contextManager: createContextManager(workspace),
      credentials: { store, env: {}, reload: async () => ({ error: "unused" }), codexLogin: async () => {
        await store.set(codexSubscriptionIdentity(), "new-account-token");
        return { ok: true as const, status: "Signed in" };
      }, listSubscriptionCatalog: async () => {
        if (++discoveries === 1) throw Error("Catalog unavailable");
        return [{ id: "new-codex", supportedThinking: ["medium"] }];
      } },
      stageSettings: async settings => ({ model: createScriptedModel({ provider: "codex-subscription", id: settings.model }), contextManager: createContextManager(workspace) }),
    });
    try {
      expect(await controller.login("codex")).toBe(false);
      await controller.submit("hello");
      expect(oldRequests).toBe(0);
      expect(JSON.stringify(controller.snapshot())).not.toContain("old account replied");
      expect(await controller.selectModel("openai/old-codex")).toBe(false);
      controller.openModelPicker();
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      controller.searchModels("new-codex");
      expect(await controller.selectPickerModel()).toBe(true);
      expect(controller.snapshot()).toMatchObject({ provider: "openai", modelId: "new-codex" });
    } finally { controller.dispose(); }
  });
});

test("Codex catalog requests verified 0.160.0 compatibility and retains gpt-6.1-sol medium thinking", async () => {
  const store = fakeCredentialStore();
  await store.set(codexSubscriptionIdentity(), JSON.stringify({ accessToken: "subscription-secret", expiresAt: Date.now() + 600_000 }));
  const seen: string[] = [];
  const models = await fetchSubscriptionCatalog({ store, fetch: async url => {
    const clientVersion = new URL(String(url)).searchParams.get("client_version") ?? "";
    seen.push(clientVersion);
    // Same-account verification on 2026-10-02: 0.156.1 omitted this model; 0.160.0 exposed it.
    return Response.json({ models: [
      ...catalog.models,
      ...(clientVersion === "0.160.0" ? [{ slug: "gpt-6.1-sol", visibility: "list",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }, { effort: "max" }, { effort: "ultra" }] }] : []),
    ] });
  } });
  expect(seen).toEqual(["0.160.0"]);
  expect(models.map(model => model.id)).toEqual(["real-codex", "gpt-6.1-sol"]);
  const selected = models.find(model => model.id === "gpt-6.1-sol")!;
  expect(selected).toEqual({ id: "gpt-6.1-sol", authRoute: "codex",
    supportedThinking: ["low", "medium", "high", "xhigh", "max", "ultra"] });
  expect(resolveCodexReasoning("medium", selected.id, selected)).toEqual({ effort: "medium", summary: "auto" });
});

test("local /skills works without subscription credentials or catalog access", async () => {
  await withTempDir(async root => {
    let contacted = 0;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(["--provider", "openai", "--openai-auth", "codex", "-p", "/skills"], {
      cwd: root, env: { HOME: join(root, "home") }, credentialStore: fakeCredentialStore(),
      stdout: { write: text => { stdout.push(text); } }, stderr: { write: text => { stderr.push(text); } },
      fetch: async () => { contacted++; throw Error("local command must not call provider"); },
    });
    expect(code).toBe(0);
    expect(stderr.join("")).not.toContain("/login chatgpt");
    expect(stdout.join("")).toContain("skill");
    expect(contacted).toBe(0);
  });
});

test("headless Codex discovers an available model and advertised thinking without API-key billing", async () => {
  await withTempDir(async root => {
    const store = fakeCredentialStore();
    await store.set(codexSubscriptionIdentity(), JSON.stringify({ accessToken: "subscription-secret", accountId: "account-fixture", expiresAt: Date.now() + 600_000 }));
    const requests: Array<{ url: string; model?: string; effort?: string }> = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(["--provider", "openai", "--model", "real-codex", "--openai-auth", "codex", "--thinking", "max", "-p", "hi"], {
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
  await expect(fetchSubscriptionModels({ store, fetch })).rejects.toThrow("/login chatgpt");
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

test("/thinking activates verified capabilities when auto selected the Codex adapter", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root,
      cli: { provider: "openai", model: "real-codex", openaiAuth: "auto" } });
    let discoveries = 0;
    const controller = new TuiController({ session: createSession(), sessionId: "auto-codex-thinking", workspace,
      configEditor: editor, provider: "openai", modelId: "real-codex", model: createScriptedModel({ provider: "codex-subscription", id: "real-codex" }),
      contextManager: createContextManager(workspace),
      credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ error: "unused" }), listSubscriptionCatalog: async () => {
        discoveries++;
        return [{ id: "real-codex", defaultThinking: "max", supportedThinking: ["max"] }];
      } },
      stageSettings: async settings => ({ model: createScriptedModel({ provider: "codex-subscription", id: settings.model }), contextManager: createContextManager(workspace) }),
    });
    try {
      expect(await controller.thinkingCommand("")).toBe(true);
      expect(controller.describeThinking()).toContain("Supported: max");
      expect(editor.settings).toMatchObject({ openaiAuth: "codex", supportedThinking: ["max"] });
      expect(await controller.thinkingCommand("max")).toBe(true);
      expect(editor.settings.thinking).toBe("max");
      expect(discoveries).toBe(1);
    } finally { controller.dispose(); }
  });
});

test("/thinking discovers account support before allowing explicit Codex effort", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, cli: { provider: "openai", model: "gpt-5.4", openaiAuth: "codex" } });
    let discoveries = 0;
    const controller = new TuiController({ session: createSession(), sessionId: "thinking-discovery", workspace,
      configEditor: editor, provider: "openai", modelId: "gpt-5.4", model: createScriptedModel({ provider: "codex-subscription", id: "gpt-5.4" }),
      contextManager: createContextManager(workspace),
      credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ error: "unused" }), listSubscriptionCatalog: async () => {
        discoveries++;
        return [{ id: "gpt-5.4", defaultThinking: "low", supportedThinking: ["low"] }];
      } },
      stageSettings: async settings => ({ model: createScriptedModel({ provider: "codex-subscription", id: settings.model }), contextManager: createContextManager(workspace) }),
    });
    try {
      expect(await controller.thinkingCommand("high")).toBe(false);
      expect(discoveries).toBe(1);
      expect(await controller.thinkingCommand("low")).toBe(true);
      expect(discoveries).toBe(1);
      expect(controller.describeThinking()).toContain("supported: low");
    } finally { controller.dispose(); }
  });
});

test("subscription picker distinguishes other provider choices from account models", () => {
  const entries = modelPickerEntries("", "openai", "real-codex", {}, { subscriptionMode: true,
    subscriptionModels: ["real-codex"], profiles: { local: { baseUrl: "http://127.0.0.1:11434/v1", model: "local-model" } } });
  expect(entries.some(entry => entry.provider === "openai" && entry.modelId === "gpt-5.4" && entry.authRoute === "api-key")).toBe(true);
  expect(entries.find(entry => entry.provider === "openai" && entry.modelId === "real-codex")?.otherProvider).toBeFalsy();
  expect(entries.find(entry => entry.kind === "model" && entry.authRoute === "api-key")?.otherProvider).toBe(true);
  expect(entries.find(entry => entry.kind === "model" && entry.profile === "local")?.otherProvider).toBe(true);
});

test("catalog failure never falls back to static OpenAI choices", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const configEditor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, cli: { provider: "openai", openaiAuth: "codex" } });
    const controller = new TuiController({
      session: createSession(), sessionId: "failure", workspace, configEditor,
      provider: "openai", modelId: "gpt-5.4", model: createScriptedModel({ provider: "codex-subscription" }),
      contextManager: createContextManager(workspace),
      credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ error: "unused" }), listSubscriptionModels: async () => { throw Error("Sign in with /login chatgpt"); } },
    });
    try {
      controller.openModelPicker();
      await Bun.sleep(0);
      const picker = controller.snapshot().modelPicker!;
      expect(picker.error).toContain("Ctrl+R retry");
      expect(picker.entries.map(entry => entry.kind)).toEqual(["connect"]);
      expect(picker.entries.filter(entry => entry.kind === "model" && entry.authRoute === "codex").every(entry => entry.listUnavailable)).toBe(true);
      expect(picker.entries.some(entry => entry.provider === "openai" && entry.authRoute === "api-key")).toBe(false);
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
    const store = fakeCredentialStore();
    await store.set(codexSubscriptionIdentity(), "saved-account");
    const controller = new TuiController({
      session: createSession(), sessionId: "switch-provider", workspace, configEditor,
      provider: "openai", modelId: "gpt-5.4", model: createScriptedModel({ provider: "openai" }),
      contextManager: createContextManager(workspace),
      credentials: { store, env: {}, reload: async () => ({ error: "unused" }), listSubscriptionModels: async () => ["real-codex"] },
      stageSettings: async settings => ({ model: createScriptedModel({ provider: "codex-subscription", id: settings.model }), contextManager: createContextManager(workspace) }),
    });
    try {
      controller.openModelPicker();
      await Bun.sleep(0);
      expect(controller.snapshot().modelPicker?.entries.filter(entry => entry.kind === "model" && entry.authRoute === "codex").map(entry => entry.modelId)).toEqual(["real-codex"]);
      expect(await controller.selectModel("openai/gpt-5.4")).toBe(false);
      expect(controller.snapshot().provider).toBe("openai");
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
      if (body.stream !== true) return Response.json({ detail: "Stream must be set to true" }, { status: 400 });
      if (Object.hasOwn(body, "max_output_tokens")) return Response.json({ detail: "Unsupported parameter: max_output_tokens" }, { status: 400 });
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
      provider: "openai", modelId: "gpt-5.4", model: createCodexSubscriptionModel({
        model: "gpt-6-astra", store, fetch: transport }),
      contextManager: createContextManager(workspace),
      credentials: { store, env: {}, reload: async () => ({ error: "unused" }), listSubscriptionCatalog: signal => fetchSubscriptionCatalog({ store, fetch: transport, signal }) },
      stageSettings: async settings => ({ model: createCodexSubscriptionModel({ model: settings.model, thinking: settings.thinking, modelCapability: settings.supportedThinking ? { id: settings.model, supportedThinking: settings.supportedThinking } : undefined, store, fetch: transport }), contextManager: createContextManager(workspace) }),
    });
    try {
      controller.openModelPicker();
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      controller.searchModels("real-codex");
      expect(await controller.selectPickerModel()).toBe(true);
      expect(controller.describeThinking()).toContain("Provider default (medium");
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
    const store = fakeCredentialStore();
    await store.set(codexSubscriptionIdentity(), "account-fixture");
    const controller = new TuiController({
      session: createSession(), sessionId: "models", workspace, configEditor,
      provider: "openai", modelId: "gpt-5.4", model: createScriptedModel({ provider: "codex-subscription" }),
      contextManager: createContextManager(workspace),
      credentials: { store, env: {}, reload: async () => ({ error: "unused" }), listSubscriptionModels: load },
      stageSettings: async settings => ({ model: createScriptedModel({ provider: "codex-subscription", id: settings.model }), contextManager: createContextManager(workspace) }),
    });
    try {
      expect(controller.openModelPicker()).toBe(true);
      expect(controller.snapshot().modelPicker?.loading).toBe(true);
      expect(controller.snapshot().modelPicker?.entries.some(entry => entry.kind === "model" && entry.authRoute === "codex")).toBe(false);
      while (requests === 0) await Bun.sleep(1);
      controller.closeModelPicker();
      expect(controller.openModelPicker()).toBe(true);
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      expect(controller.snapshot().modelPicker?.entries.filter(entry => entry.kind === "model" && entry.authRoute === "codex").map(entry => entry.modelId)).toEqual(["real-codex"]);
      resolveFirst(["stale-codex"]);
      await Bun.sleep(0);
      expect(controller.snapshot().modelPicker?.entries.some(entry => entry.modelId === "stale-codex")).toBe(false);
      controller.searchModels("openai/gpt-5.4");
      expect(controller.snapshot().modelPicker?.entries.filter(entry => entry.kind === "model")).toEqual([]);
      expect(await controller.selectModel("openai/gpt-5.4")).toBe(false);
      expect(controller.snapshot().modelId).toBe("gpt-5.4");
      controller.searchModels("real-codex");
      expect(await controller.selectPickerModel()).toBe(true);
      expect(controller.snapshot().modelId).toBe("real-codex");
    } finally { controller.dispose(); }
  });
});
