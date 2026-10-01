import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { codexSubscriptionIdentity, grokSubscriptionIdentity, credentialIdentity } from "../src/auth/store.ts";
import { loadConfigEditor } from "../src/config/editing.ts";
import { createContextManager } from "../src/context/manager.ts";
import type { ModelCapability } from "../src/model/catalog.ts";
import { createSession } from "../src/session/session.ts";
import { TuiController } from "../src/tui/controller.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { withTempDir } from "./helpers.ts";

test("resuming another workspace uses its configured route after an API-key choice", async () => {
  await withTempDir(async root => {
    const firstRoot = join(root, "first");
    const secondRoot = join(root, "second");
    await mkdir(join(secondRoot, ".schway"), { recursive: true });
    await writeFile(join(secondRoot, ".schway", "config.json"), JSON.stringify({ provider: "openai", openaiAuth: "codex", model: "gpt-5.4" }));
    const first = { root: firstRoot, launchCwd: firstRoot, extraRoots: [] };
    const second = { root: secondRoot, launchCwd: secondRoot, extraRoots: [] };
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: firstRoot });
    const store = fakeCredentialStore();
    await store.set(credentialIdentity({ provider: "openai" }), "api-secret");
    const activated: string[] = [];
    const staged: string[] = [];
    const controller = new TuiController({ session: createSession(), sessionId: "first", workspace: first,
      provider: editor.settings.provider, modelId: editor.settings.model, contextManager: createContextManager(first), configEditor: editor,
      credentials: { store, env: {}, reload: async () => ({ error: "unused" }) },
      stageSettings: async (settings, _signal, workspace) => {
        staged.push(`${settings.openaiAuth}:${settings.model}`);
        return { model: createScriptedModel({ provider: settings.openaiAuth === "codex" ? "codex-subscription" : settings.provider, id: settings.model }), contextManager: createContextManager(workspace!) };
      },
      onModelActivated: choice => activated.push(choice.authRoute),
    });
    try {
      controller.openModelPicker();
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      const picker = controller.snapshot().modelPicker!;
      const index = picker.entries.findIndex(entry => entry.authRoute === "api-key" && entry.modelId === "gpt-5.4");
      expect(index).toBeGreaterThanOrEqual(0);
      controller.moveModelPicker(index - picker.selectedIndex);
      expect(await controller.selectPickerModel()).toBe(true);
      expect(controller.snapshot().activeRoute).toBe("OpenAI API key");
      expect(await controller.switchSession(createSession(), "first-again", { workspace: first, contextManager: createContextManager(first) })).toBe(true);
      expect(controller.snapshot().activeRoute).toBe("OpenAI API key");
      expect(await controller.switchSession(createSession(), "second", { workspace: second, contextManager: createContextManager(second) })).toBe(true);
      expect(controller.snapshot().activeRoute).toBe("ChatGPT subscription");
      expect(staged).toEqual(["api-key:gpt-5.4", "api-key:gpt-5.4", "codex:gpt-5.4"]);
      expect(activated).toEqual(["api-key"]);
    } finally { controller.dispose(); }
  });
});

test("an API-key row clears subscription-only thinking without blocking activation", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root,
      cli: { provider: "openai", openaiAuth: "codex", model: "gpt-5.4", thinking: "xhigh" } });
    editor.setModelCapabilities([{ id: "gpt-5.4", supportedThinking: ["xhigh"] }]);
    const store = fakeCredentialStore();
    await store.set(codexSubscriptionIdentity(), "account-token");
    await store.set(credentialIdentity({ provider: "openai" }), "api-secret");
    const staged: string[] = [];
    const controller = new TuiController({ session: createSession(), sessionId: "thinking-route", workspace,
      provider: "openai", modelId: "gpt-5.4", model: createScriptedModel({ provider: "codex-subscription", id: "gpt-5.4" }),
      contextManager: createContextManager(workspace), configEditor: editor,
      credentials: { store, env: {}, reload: async () => ({ error: "unused" }), listSubscriptionCatalog: async () => [{ id: "gpt-5.4", supportedThinking: ["xhigh"] }] },
      stageSettings: async settings => {
        staged.push(`${settings.openaiAuth}:${settings.thinking ?? "unset"}`);
        return { model: createScriptedModel({ provider: settings.provider, id: settings.model }), contextManager: createContextManager(workspace) };
      },
    });
    try {
      controller.openModelPicker();
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      const picker = controller.snapshot().modelPicker!;
      const index = picker.entries.findIndex(entry => entry.authRoute === "api-key" && entry.modelId === "gpt-5.4");
      expect(index).toBeGreaterThanOrEqual(0);
      controller.moveModelPicker(index - picker.selectedIndex);
      expect(await controller.selectPickerModel()).toBe(true);
      expect(controller.snapshot().activeRoute).toBe("OpenAI API key");
      expect(staged).toEqual(["api-key:unset"]);
    } finally { controller.dispose(); }
  });
});

test("the same model activates the chosen subscription or API-key route atomically", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root });
    const store = fakeCredentialStore();
    await store.set(codexSubscriptionIdentity(), "account-token");
    await store.set(credentialIdentity({ provider: "openai" }), "api-secret");
    const requests: string[] = [];
    const outcomes: string[] = [];
    const controller = new TuiController({ session: createSession(), sessionId: "routes", workspace,
      provider: "openai", modelId: "gpt-5.4", contextManager: createContextManager(workspace), configEditor: editor,
      credentials: { store, env: {}, reload: async () => ({ error: "unused" }), listSubscriptionCatalog: async () => [{ id: "gpt-5.4", supportedThinking: [] }] },
      stageSettings: async settings => {
        const account = settings.openaiAuth === "codex";
        expect(await store.get(account ? codexSubscriptionIdentity() : credentialIdentity({ provider: "openai" }))).toBe(account ? "account-token" : "api-secret");
        return { model: createScriptedModel({ provider: account ? "codex-subscription" : "openai", id: settings.model,
          responses: [() => { requests.push(`${settings.openaiAuth}:${settings.model}`); return { text: "fixture" }; }] }), contextManager: createContextManager(workspace) };
      },
      onModelActivated: choice => outcomes.push(`${choice.authRoute}:${choice.modelId}`),
    });
    try {
      for (const route of ["codex", "api-key"] as const) {
        controller.openModelPicker();
        while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
        controller.searchModels("gpt-5.4");
        const picker = controller.snapshot().modelPicker!;
        const rows = picker.entries.filter(entry => entry.provider === "openai" && entry.modelId === "gpt-5.4");
        expect(rows.map(entry => entry.authRoute).sort()).toEqual(["api-key", "codex"]);
        const index = picker.entries.findIndex(entry => entry.authRoute === route && entry.modelId === "gpt-5.4");
        controller.moveModelPicker(index - picker.selectedIndex);
        expect(await controller.selectPickerModel()).toBe(true);
        expect(controller.snapshot().activeRoute).toBe(route === "codex" ? "ChatGPT subscription" : "OpenAI API key");
        await controller.submit(`request through ${route}`);
      }
      expect(requests).toEqual(["codex:gpt-5.4", "api-key:gpt-5.4"]);
      expect(outcomes).toEqual(["codex:gpt-5.4", "api-key:gpt-5.4"]);
      expect(await controller.selectModel("openai/typed-api-id")).toBe(true);
      expect(controller.effectiveBudgets()).toEqual({ contextWindow: 32768, maxOutput: 16384 });
      await controller.submit("typed API request");
      expect(requests.at(-1)).toBe("api-key:typed-api-id");
      expect(outcomes.at(-1)).toBe("api-key:typed-api-id");
    } finally { controller.dispose(); }
  });
});

test("connecting a missing route returns to its search and identity without selecting it", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root });
    const store = fakeCredentialStore();
    const outcomes: string[] = [];
    const controller = new TuiController({ session: createSession(), sessionId: "connect", workspace,
      provider: "openai", modelId: "gpt-5.4", model: createScriptedModel({ provider: "openai" }),
      contextManager: createContextManager(workspace), configEditor: editor,
      credentials: { store, env: {}, reload: async () => ({ model: createScriptedModel({ provider: "openai" }) }), listRouteModels: async () => [{ id: "route-first" }, { id: "gpt-5.4" }] },
      stageSettings: async settings => ({ model: createScriptedModel({ provider: settings.provider, id: settings.model }), contextManager: createContextManager(workspace) }),
      onModelActivated: choice => outcomes.push(choice.provider),
    });
    try {
      controller.openModelPicker();
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      controller.searchModels("OpenAI API key");
      const identity = controller.snapshot().modelPicker!.entries[0]!.identity;
      expect(await controller.selectPickerModel()).toBe(true);
      expect(controller.snapshot().credentialEntry).toBeDefined();
      expect(controller.snapshot().provider).toBe("openai");
      controller.cancel();
      expect(controller.snapshot().credentialEntry).toBeUndefined();
      expect(outcomes).toEqual([]);
      expect(controller.snapshot().modelPicker?.query).toBe("OpenAI API key");
      expect(controller.snapshot().modelPicker?.entries[controller.snapshot().modelPicker!.selectedIndex]?.identity).toBe(identity);
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      expect(await controller.selectPickerModel()).toBe(true);
      controller.enterCredentialText("isolated-secret");
      expect(await controller.submitCredential()).toBe(true);
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      const picker = controller.snapshot().modelPicker!;
      expect(picker.query).toBe("OpenAI API key");
      expect(picker.entries[picker.selectedIndex]?.kind).toBe("model");
      expect(picker.entries[picker.selectedIndex]?.modelId).toBe("route-first");
      expect(picker.entries[picker.selectedIndex]?.access).toBe("API key");
      expect(outcomes).toEqual([]);
      expect(await controller.selectPickerModel()).toBe(true);
      expect(outcomes).toEqual(["openai"]);
      expect(JSON.stringify(controller.snapshot())).not.toContain("isolated-secret");
    } finally { controller.dispose(); }
  });
});

test("two endpoint identities remain separate when catalog refresh changes row order", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const profiles = { alpha: { baseUrl: "https://a.example/v1", model: "shared" }, beta: { baseUrl: "https://b.example/v1", model: "shared", credentialIdentity: "hidden-identity-marker" } };
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, cli: { profiles } });
    const store = fakeCredentialStore();
    await store.set(codexSubscriptionIdentity(), "account-token");
    await store.set(credentialIdentity({ provider: "openai-compatible", profile: "alpha", baseUrl: profiles.alpha.baseUrl }), "alpha-secret");
    await store.set(credentialIdentity({ provider: "openai-compatible", profile: "beta", baseUrl: profiles.beta.baseUrl, credentialIdentity: profiles.beta.credentialIdentity }), "beta-secret");
    let resolveCatalog!: (models: readonly ModelCapability[]) => void;
    const controller = new TuiController({ session: createSession(), sessionId: "profiles", workspace,
      provider: "openai", modelId: "gpt-5.4", contextManager: createContextManager(workspace), configEditor: editor,
      credentials: { store, env: {}, reload: async () => ({ error: "unused" }), listSubscriptionCatalog: async () => new Promise(resolve => { resolveCatalog = resolve; }) },
      stageSettings: async settings => {
        expect(settings.baseUrl).toBe(profiles.beta.baseUrl);
        expect(await store.get(credentialIdentity({ provider: "openai-compatible", profile: "beta", baseUrl: settings.baseUrl, credentialIdentity: settings.credentialIdentity }))).toBe("beta-secret");
        return { model: createScriptedModel({ provider: "openai-compatible", id: settings.model }), contextManager: createContextManager(workspace) };
      },
    });
    try {
      controller.openModelPicker();
      while (controller.snapshot().modelPicker?.accessLoading) await Bun.sleep(1);
      controller.searchModels("shared");
      const picker = controller.snapshot().modelPicker!;
      const alpha = picker.entries.find(entry => entry.kind === "model" && entry.profile === "alpha")!;
      const beta = picker.entries.find(entry => entry.kind === "model" && entry.profile === "beta")!;
      expect(alpha.identity).not.toBe(beta.identity);
      expect(JSON.stringify(picker)).not.toContain("hidden-identity-marker");
      controller.moveModelPicker(picker.entries.indexOf(beta) - picker.selectedIndex);
      const selected = controller.snapshot().modelPicker!.entries[controller.snapshot().modelPicker!.selectedIndex]!.identity;
      controller.searchModels("shar");
      expect(controller.snapshot().modelPicker!.entries[controller.snapshot().modelPicker!.selectedIndex]!.identity).toBe(selected);
      resolveCatalog([{ id: "shared", supportedThinking: [] }]);
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      expect(controller.snapshot().modelPicker!.entries[controller.snapshot().modelPicker!.selectedIndex]!.identity).toBe(selected);
      expect(await controller.selectPickerModel()).toBe(true);
      expect(controller.snapshot().profile).toBe("beta");
    } finally { controller.dispose(); }
  });
});

test("catalog failure, empty result and retry never invent a subscription row", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const store = fakeCredentialStore();
    await store.set(codexSubscriptionIdentity(), "account-token");
    let calls = 0;
    const controller = new TuiController({ session: createSession(), sessionId: "catalog-retry", workspace,
      provider: "openai", modelId: "gpt-5.4", model: createScriptedModel({ provider: "codex-subscription" }),
      contextManager: createContextManager(workspace),
      credentials: { store, env: {}, reload: async () => ({ error: "unused" }), listSubscriptionCatalog: async () => {
        calls++;
        if (calls === 1) throw new Error("network offline");
        if (calls === 2) throw new Error("Unauthorized account catalog");
        return calls === 3 ? [] : [{ id: "account-only", supportedThinking: [] }];
      } },
    });
    try {
      controller.openModelPicker();
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      expect(controller.snapshot().modelPicker?.catalogState).toBe("offline");
      expect(controller.snapshot().modelPicker?.entries.filter(entry => entry.kind === "model" && entry.authRoute === "codex").every(entry => entry.listUnavailable)).toBe(true);
      expect(controller.retryModelPickerCatalog()).toBe(true);
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      expect(controller.snapshot().modelPicker?.catalogState).toBe("failed");
      expect(controller.snapshot().modelPicker?.entries.filter(entry => entry.kind === "model" && entry.authRoute === "codex").every(entry => entry.listUnavailable)).toBe(true);
      expect(controller.retryModelPickerCatalog()).toBe(true);
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      expect(controller.snapshot().modelPicker?.catalogState).toBe("empty");
      expect(controller.snapshot().modelPicker?.entries.filter(entry => entry.kind === "model" && entry.authRoute === "codex").every(entry => entry.listUnavailable)).toBe(true);
      expect(controller.retryModelPickerCatalog()).toBe(true);
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      expect(controller.snapshot().modelPicker?.entries.filter(entry => entry.kind === "model" && entry.authRoute === "codex").map(entry => entry.modelId)).toEqual(["account-only"]);
    } finally { controller.dispose(); }
  });
});

test("failed activation emits no remembered choice and keeps the previous billing route", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root });
    const store = fakeCredentialStore();
    await store.set(codexSubscriptionIdentity(), "account-token");
    await store.set(credentialIdentity({ provider: "openai" }), "api-secret");
    const outcomes: string[] = [];
    const controller = new TuiController({ session: createSession(), sessionId: "failed-activation", workspace,
      provider: "openai", modelId: "gpt-5.4", model: createScriptedModel({ provider: "openai" }),
      contextManager: createContextManager(workspace), configEditor: editor,
      credentials: { store, env: {}, reload: async () => ({ error: "unused" }), listSubscriptionCatalog: async () => [{ id: "gpt-5.4", supportedThinking: [] }] },
      stageSettings: async () => { throw new Error("fixture activation denied"); },
      onModelActivated: choice => outcomes.push(choice.authRoute),
    });
    try {
      controller.openModelPicker();
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      const picker = controller.snapshot().modelPicker!;
      const index = picker.entries.findIndex(entry => entry.authRoute === "codex" && entry.modelId === "gpt-5.4");
      controller.moveModelPicker(index - picker.selectedIndex);
      expect(await controller.selectPickerModel()).toBe(false);
      expect(controller.snapshot().activeRoute).toBe("OpenAI API key");
      expect(controller.snapshot().modelPicker).toBeDefined();
      expect(outcomes).toEqual([]);
    } finally { controller.dispose(); }
  });
});

test("ChatGPT connection returns to account discovery without silently activating a route", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root });
    const store = fakeCredentialStore();
    const outcomes: string[] = [];
    const controller = new TuiController({ session: createSession(), sessionId: "subscription-connect", workspace,
      provider: "openai", modelId: "gpt-5.4", model: createScriptedModel({ provider: "openai" }),
      contextManager: createContextManager(workspace), configEditor: editor,
      credentials: { store, env: {}, reload: async () => ({ error: "unused" }),
        codexLogin: async () => { await store.set(codexSubscriptionIdentity(), "new-account-token"); return { ok: true, status: "Saved" }; },
        listSubscriptionCatalog: async () => [{ id: "account-model", supportedThinking: [] }] },
      stageSettings: async settings => ({ model: createScriptedModel({ provider: "codex-subscription", id: settings.model }), contextManager: createContextManager(workspace) }),
      onModelActivated: choice => outcomes.push(choice.authRoute),
    });
    try {
      controller.openModelPicker();
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      controller.searchModels("ChatGPT");
      expect(controller.snapshot().modelPicker?.entries[0]).toMatchObject({ kind: "sign-in", authRoute: "codex" });
      expect(await controller.selectPickerModel()).toBe(true);
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      expect(controller.snapshot().provider).toBe("openai");
      expect(controller.snapshot().modelPicker?.query).toBe("ChatGPT");
      expect(controller.snapshot().modelPicker?.entries.some(entry => entry.modelId === "account-model" && entry.verifiedCatalog)).toBe(true);
      expect(outcomes).toEqual([]);
      expect(await controller.selectPickerModel()).toBe(true);
      expect(controller.snapshot().activeRoute).toBe("ChatGPT subscription");
      expect(outcomes).toEqual(["codex"]);
    } finally { controller.dispose(); }
  });
});

test("a highlighted API row keeps its identity when the same subscription model arrives later", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const store = fakeCredentialStore();
    await store.set(codexSubscriptionIdentity(), "account-token");
    await store.set(credentialIdentity({ provider: "openai" }), "api-secret");
    let resolveCatalog!: (models: readonly ModelCapability[]) => void;
    const controller = new TuiController({ session: createSession(), sessionId: "same-id-refresh", workspace,
      provider: "openai", modelId: "gpt-5.4", contextManager: createContextManager(workspace),
      credentials: { store, env: {}, reload: async () => ({ error: "unused" }), listSubscriptionCatalog: () => new Promise(resolve => { resolveCatalog = resolve; }) },
    });
    try {
      controller.openModelPicker();
      while (controller.snapshot().modelPicker?.accessLoading) await Bun.sleep(1);
      controller.searchModels("openai/gpt-5.4");
      const before = controller.snapshot().modelPicker!;
      const api = before.entries.find(entry => entry.kind === "model" && entry.authRoute === "api-key")!;
      controller.moveModelPicker(before.entries.indexOf(api) - before.selectedIndex);
      resolveCatalog([{ id: "gpt-5.4", supportedThinking: [] }]);
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      const after = controller.snapshot().modelPicker!;
      expect(after.entries.filter(entry => entry.modelId === "gpt-5.4").map(entry => entry.authRoute).sort()).toEqual(["api-key", "codex"]);
      expect(after.entries[after.selectedIndex]?.identity).toBe(api.identity);
    } finally { controller.dispose(); }
  });
});

test("an unresponsive account catalog stops loading within the picker deadline", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const store = fakeCredentialStore();
    await store.set(codexSubscriptionIdentity(), "account-token");
    const controller = new TuiController({ session: createSession(), sessionId: "slow-catalog", workspace,
      provider: "openai", modelId: "gpt-5.4", contextManager: createContextManager(workspace),
      credentials: { store, env: {}, reload: async () => ({ error: "unused" }), listSubscriptionCatalog: () => new Promise(() => {}) },
    });
    try {
      const started = Date.now();
      controller.openModelPicker();
      while (controller.snapshot().modelPicker?.loading && Date.now() - started < 7_000) await Bun.sleep(20);
      expect(controller.snapshot().modelPicker?.loading).toBe(false);
      expect(Date.now() - started).toBeLessThan(7_000);
      expect(controller.snapshot().modelPicker?.error).toContain("retry");
      expect(controller.snapshot().modelPicker?.entries.filter(entry => entry.kind === "model" && entry.authRoute === "codex").every(entry => entry.listUnavailable)).toBe(true);
    } finally { controller.dispose(); }
  });
}, 8_000);

test("status reports the loaded adapter when a saved auth preference disagrees", () => {
  const workspace = { root: "/project", launchCwd: "/project", extraRoots: [] };
  const controller = new TuiController({ session: createSession(), sessionId: "route-status", workspace,
    provider: "openai", modelId: "gpt-5.4", openaiAuth: "codex",
    model: createScriptedModel({ provider: "openai", id: "gpt-5.4" }), contextManager: createContextManager(workspace) });
  try { expect(controller.snapshot().activeRoute).toBe("OpenAI API key"); }
  finally { controller.dispose(); }
});

test("a credential-read timeout is labelled as access discovery, not catalog failure", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const store = { ...fakeCredentialStore(), get: async () => new Promise<null>(() => {}) };
    const controller = new TuiController({ session: createSession(), sessionId: "slow-access", workspace,
      provider: "openai", modelId: "gpt-5.4", contextManager: createContextManager(workspace),
      credentials: { store, env: {}, reload: async () => ({ error: "unused" }) },
    });
    try {
      controller.openModelPicker();
      const started = Date.now();
      while (controller.snapshot().modelPicker?.loading && Date.now() - started < 7_000) await Bun.sleep(20);
      expect(controller.snapshot().modelPicker?.loading).toBe(false);
      expect(controller.snapshot().modelPicker?.error).toContain("Model access discovery");
      expect(controller.snapshot().modelPicker?.error).not.toContain("ChatGPT catalog");
    } finally { controller.dispose(); }
  });
}, 8_000);


for (const route of ["codex", "grok"] as const) test(`${route} picker Esc restores search promptly and ignores old OAuth callbacks during a newer sign-in`, async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] }, store = fakeCredentialStore();
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, cli: { provider: "openai", model: "gpt-5.4" } });
    type Waiter = { signal: AbortSignal; onProgress: (message: string) => void; onSaved?: () => void };
    const calls: Array<{ options: Waiter; resolve: (result: { ok: true; status: string }) => void }> = [];
    const runner = (options: Waiter) => new Promise<{ ok: true; status: string }>(resolve => calls.push({ options, resolve }));
    const controller = new TuiController({ session: createSession(), sessionId: "deferred-picker", workspace, configEditor: editor,
      provider: "openai", modelId: "gpt-5.4", model: createScriptedModel({ provider: "openai", id: "gpt-5.4" }), contextManager: createContextManager(workspace),
      credentials: { store, env: {}, reload: async () => ({ model: createScriptedModel() }), codexLogin: runner, grokLogin: runner },
      stageSettings: async settings => ({ model: createScriptedModel({ id: settings.model }), contextManager: createContextManager(workspace) }),
    });
    const label = route === "codex" ? "ChatGPT" : "Grok subscription";
    let first: Promise<boolean> | undefined, second: Promise<boolean> | undefined;
    try {
      controller.openModelPicker(); while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      controller.searchModels(label);
      const identity = controller.snapshot().modelPicker!.entries[controller.snapshot().modelPicker!.selectedIndex]!.identity;
      const settings = editor.settings;
      first = controller.selectPickerModel(); expect(calls).toHaveLength(1);
      controller.cancel();
      expect(calls[0]!.options.signal.aborted).toBe(true); expect(controller.running).toBe(false);
      expect(controller.snapshot().modelPicker?.query).toBe(label);
      expect(controller.snapshot().modelPicker!.entries[controller.snapshot().modelPicker!.selectedIndex]!.identity).toBe(identity);
      expect(editor.settings).toEqual(settings); expect(controller.snapshot().modelId).toBe("gpt-5.4");
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      second = controller.selectPickerModel(); expect(calls).toHaveLength(2);
      const approval = controller.snapshot().loginApproval;
      calls[0]!.options.onProgress("The browser could not be opened automatically"); calls[0]!.options.onSaved?.();
      calls[0]!.resolve({ ok: true, status: "Old saved result" }); expect(await first).toBe(false);
      expect(controller.running).toBe(true); expect(controller.snapshot().loginApproval).toBe(approval);
      expect(controller.snapshot().loginChooser).toBeUndefined(); expect(controller.snapshot().modelPicker).toBeUndefined();
      expect(editor.settings).toEqual(settings); expect(controller.snapshot().modelId).toBe("gpt-5.4");
      controller.cancel(); calls[1]!.resolve({ ok: true, status: "Cancelled late" }); expect(await second).toBe(false);
      expect(controller.snapshot().modelPicker?.query).toBe(label); expect(editor.settings).toEqual(settings);
    } finally { for (const call of calls) call.resolve({ ok: true, status: "Stopped" }); await first; await second; controller.dispose(); }
  });
});

for (const route of ["codex", "grok"] as const) test(`${route} picker connection selects the first discovered row without activating it`, async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] }, store = fakeCredentialStore();
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, cli: { provider: "openai", model: "gpt-5.4" } });
    const runner = async () => { await store.set(route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity(), "saved-token"); return { ok: true as const, status: "Saved" }; };
    const activated: string[] = [];
    const controller = new TuiController({ session: createSession(), sessionId: "connected-picker", workspace, configEditor: editor,
      provider: "openai", modelId: "gpt-5.4", model: createScriptedModel({ provider: "openai", id: "gpt-5.4" }), contextManager: createContextManager(workspace),
      credentials: { store, env: {}, reload: async () => ({ error: "unused" }), codexLogin: runner, grokLogin: runner,
        listSubscriptionCatalog: async () => [{ id: "account-first", supportedThinking: [] }, { id: "account-second", supportedThinking: [] }],
        listGrokModels: async () => [{ id: "grok-first" }, { id: "grok-second" }] },
      stageSettings: async settings => { activated.push(settings.model); return { model: createScriptedModel({ id: settings.model }), contextManager: createContextManager(workspace) }; },
    });
    try {
      controller.openModelPicker(); while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      const query = route === "codex" ? "ChatGPT" : "Grok subscription"; controller.searchModels(query);
      expect(await controller.selectPickerModel()).toBe(true); while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      const picker = controller.snapshot().modelPicker!;
      expect(picker.query).toBe(query); expect(picker.entries[picker.selectedIndex]?.modelId).toBe(route === "codex" ? "account-first" : "grok-first");
      expect(controller.snapshot().modelId).toBe("gpt-5.4"); expect(editor.settings.provider).toBe("openai"); expect(activated).toEqual([]);
    } finally { controller.dispose(); }
  });
});

test("picker endpoint key Esc returns to URL, URL Esc restores the sign-in row, and save does not activate a selected model", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] }, store = fakeCredentialStore();
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, cli: { provider: "openai", model: "gpt-5.4" } });
    const activated: string[] = [];
    const controller = new TuiController({ session: createSession(), sessionId: "endpoint-picker", workspace, configEditor: editor,
      provider: "openai", modelId: "gpt-5.4", model: createScriptedModel({ provider: "openai", id: "gpt-5.4" }), contextManager: createContextManager(workspace),
      credentials: { store, env: {}, reload: async () => { throw Error("old route cannot reload"); }, listRouteModels: async () => [{ id: "fake-coder", contextWindow: 32768 }] },
      stageSettings: async settings => { activated.push(settings.model); return { model: createScriptedModel({ id: settings.model }), contextManager: createContextManager(workspace) }; },
    });
    try {
      controller.openModelPicker(); while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1); controller.searchModels("OpenAI-compatible");
      const settings = editor.settings, identity = controller.snapshot().modelPicker!.entries[0]!.identity;
      expect(await controller.selectPickerModel()).toBe(true); controller.enterEndpointUrlText("http://localhost:8787"); expect(controller.submitEndpointUrl()).toBe(true);
      controller.enterCredentialText("cancelled-secret"); controller.cancel();
      expect(controller.snapshot().endpointUrlEntry?.value).toBe("http://localhost:8787"); expect(editor.settings).toEqual(settings);
      controller.cancel(); expect(controller.snapshot().modelPicker?.query).toBe("OpenAI-compatible");
      expect(controller.snapshot().modelPicker!.entries[controller.snapshot().modelPicker!.selectedIndex]!.identity).toBe(identity);
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      expect(await controller.selectPickerModel()).toBe(true); controller.enterEndpointUrlText("http://localhost:8787"); expect(controller.submitEndpointUrl()).toBe(true);
      controller.enterCredentialText("endpoint-secret"); expect(await controller.submitCredential()).toBe(true);
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      expect(editor.settings.baseUrl).toBe("http://localhost:8787"); expect(editor.settings.provider).toBe("openai-compatible");
      expect(controller.snapshot().modelId).toBe("gpt-5.4"); expect(activated).toEqual([]);
      const picker = controller.snapshot().modelPicker!; expect(picker.query).toBe("OpenAI-compatible");
      expect(picker.entries[picker.selectedIndex]).toMatchObject({ kind: "model", modelId: "fake-coder", groupLabel: "OpenAI-compatible · localhost:8787" });
      expect(await store.get(credentialIdentity({ provider: "openai-compatible", baseUrl: "http://localhost:8787" }))).toBe("endpoint-secret");
      expect(await controller.submit("old adapter must not run")).toBe(false);
    } finally { controller.dispose(); }
  });
});


for (const target of ["xai", "profile"] as const) test(`${target} picker key entry restores its sign-in identity on Esc and its first model after saving`, async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] }, store = fakeCredentialStore();
    const profiles = { remote: { baseUrl: "https://remote.example/v1", model: "remote-model", auth: "required" as const, credentialIdentity: "remote-reference" } };
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, cli: { provider: "openai", model: "gpt-5.4", profiles } });
    const activated: string[] = [];
    const controller = new TuiController({ session: createSession(), sessionId: "key-picker", workspace, configEditor: editor,
      provider: "openai", modelId: "gpt-5.4", model: createScriptedModel({ provider: "openai", id: "gpt-5.4" }), contextManager: createContextManager(workspace),
      credentials: { store, env: {}, reload: async () => { throw Error("another route must not reload"); }, listRouteModels: async () => [{ id: "grok-first" }, { id: "grok-second" }] },
      stageSettings: async settings => { activated.push(settings.model); return { model: createScriptedModel({ id: settings.model }), contextManager: createContextManager(workspace) }; },
    });
    try {
      controller.openModelPicker(); while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      const query = target === "xai" ? "xAI API key" : "remote"; controller.searchModels(query);
      const identity = controller.snapshot().modelPicker!.entries[controller.snapshot().modelPicker!.selectedIndex]!.identity, settings = editor.settings;
      expect(await controller.selectPickerModel()).toBe(true); controller.enterCredentialText("cancelled-key"); controller.cancel();
      expect(controller.snapshot().modelPicker?.query).toBe(query); expect(controller.snapshot().modelPicker!.entries[controller.snapshot().modelPicker!.selectedIndex]!.identity).toBe(identity);
      expect(editor.settings).toEqual(settings);
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      expect(await controller.selectPickerModel()).toBe(true); controller.enterCredentialText("saved-key"); expect(await controller.submitCredential()).toBe(true);
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      const picker = controller.snapshot().modelPicker!; expect(picker.query).toBe(query);
      expect(picker.entries[picker.selectedIndex]?.modelId).toBe(target === "xai" ? "grok-first" : "remote-model");
      expect(editor.settings).toEqual(settings); expect(controller.snapshot().modelId).toBe("gpt-5.4"); expect(activated).toEqual([]);
      const credential = target === "xai" ? credentialIdentity({ provider: "xai" }) : credentialIdentity({ provider: "openai-compatible", profile: "remote", baseUrl: profiles.remote.baseUrl, credentialIdentity: profiles.remote.credentialIdentity });
      expect(await store.get(credential)).toBe("saved-key");
    } finally { controller.dispose(); }
  });
});
