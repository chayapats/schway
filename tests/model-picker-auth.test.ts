import { expect, test } from "bun:test";
import { modelPickerEntries } from "../src/tui/model-picker.ts";
import { loadModelPickerAccess } from "../src/tui/model-access.ts";
import { codexSubscriptionIdentity, credentialIdentity } from "../src/auth/store.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { withTempDir } from "./helpers.ts";
import { join } from "node:path";
import { loadConfigEditor } from "../src/config/editing.ts";
import { TuiController } from "../src/tui/controller.ts";
import { createSession } from "../src/session/session.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";

test("account model order stays fixed when the active model is in the middle, including search", () => {
  for (const query of ["", "model"]) {
    const entries = modelPickerEntries(query, "openai", "current-model", {}, {
      activeRoute: "codex", subscriptionModels: ["second-model", "current-model", "third-model"],
      profiles: { local: { baseUrl: "http://localhost:11434/v1", model: "local-model" } },
    });
    expect(entries.filter(entry => entry.kind === "model" && entry.authRoute === "codex").map(entry => entry.modelId))
      .toEqual(["second-model", "current-model", "third-model"]);
    expect(entries.find(entry => entry.active)?.modelId).toBe("current-model");
  }
});

test("all five auth groups and compatible profiles keep fixed order regardless of active state", () => {
  const entries = modelPickerEntries("", "xai", "api", {}, { activeRoute: "api-key", baseUrl: "http://localhost:8787",
    subscriptionModels: ["account"], grokModels: [{ id: "grok" }], apiModels: [{ id: "openai" }], xaiModels: [{ id: "api" }], compatibleModels: [{ id: "local" }],
    profiles: { second: { baseUrl: "https://b.example/path?hidden=1", model: "b" }, first: { baseUrl: "https://user:password@a.example:8443/v1", model: "a" } },
    access: { providers: { "openai-compatible": "No key required" }, profiles: { second: "No key required", first: "No key required" }, subscription: "ChatGPT", grok: "Grok", openaiApiKey: "API key", xaiApiKey: "API key" },
  });
  expect(entries.filter(entry => entry.kind === "header").map(entry => entry.groupLabel)).toEqual([
    "ChatGPT subscription", "Grok subscription", "OpenAI API key", "xAI API key", "OpenAI-compatible · localhost:8787", "second · b.example", "first · a.example:8443",
  ]);
  expect(entries.find(entry => entry.active)?.modelId).toBe("api");
});

test("picker access follows credential precedence without exposing secrets", async () => {
  const store = fakeCredentialStore();
  await store.set(codexSubscriptionIdentity(), JSON.stringify({ accessToken: "subscription-secret" }));
  const saved = await loadModelPickerAccess({ store, env: {} });
  expect(saved.providers).toMatchObject({ openai: "ChatGPT" });
  expect(saved.openaiTransport).toBe("codex");
  expect(JSON.stringify(saved)).not.toContain("secret");
  const env = { OPENAI_API_KEY: "environment-secret" };
  expect((await loadModelPickerAccess({ store, env })).providers.openai).toBe("API key");
  expect((await loadModelPickerAccess({ store, env, openaiAuth: "codex" })).providers.openai).toBe("ChatGPT");
  expect((await loadModelPickerAccess({ store, env: {}, openaiAuth: "api-key" })).providers.openai).toBe("Login required");
  const openaiRuntime = await loadModelPickerAccess({ store, env: {}, runtimeApiKey: "sk-openai", runtimeProvider: "openai" });
  expect(openaiRuntime.openaiApiKey).toBe("API key");
  expect(openaiRuntime.xaiApiKey).toBe("Login required");
  const xaiRuntime = await loadModelPickerAccess({ store, env: {}, runtimeApiKey: "xai-runtime", runtimeProvider: "xai" });
  expect(xaiRuntime.xaiApiKey).toBe("API key");
  expect(xaiRuntime.openaiApiKey).toBe("Login required");
});

test("unconnected routes have one sign-in row and profiles stay in config order", async () => {
  const store = fakeCredentialStore();
  const profiles = {
    local: { baseUrl: "http://localhost:11434/v1", auth: "none" as const },
    saved: { baseUrl: "https://example.test/v1", auth: "required" as const },
    missing: { baseUrl: "https://example.test/v1", auth: "required" as const },
  };
  await store.set(credentialIdentity({ provider: "openai-compatible", profile: "saved", baseUrl: profiles.saved.baseUrl }), "profile-secret");
  const access = await loadModelPickerAccess({ store, env: {}, profiles });
  expect(access.profiles).toEqual({ local: "No key required", saved: "API key", missing: "Login required" });
  const entries = modelPickerEntries("", "openai", "gpt-5.4", {}, { profiles, access });
  expect(entries.filter(entry => entry.kind === "model").map(entry => entry.profile)).toEqual(["local", "saved"]);
  expect(entries.filter(entry => entry.kind === "sign-in").map(entry => entry.groupLabel)).toEqual(["ChatGPT subscription", "Grok subscription", "OpenAI API key", "xAI API key", "missing · example.test"]);
  expect(entries.filter(entry => entry.access === "Login required").every(entry => entry.kind === "sign-in")).toBe(true);
  expect(entries.some(entry => entry.active)).toBe(false);
});

test("opening the picker discovers a saved Codex login from another provider and selects its transport", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const configEditor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root });
    const store = fakeCredentialStore();
    await store.set(codexSubscriptionIdentity(), JSON.stringify({ accessToken: "saved-secret" }));
    const controller = new TuiController({ session: createSession(), sessionId: "picker-auth", workspace, configEditor,
      provider: "openai", modelId: "gpt-5.4", contextManager: createContextManager(workspace),
      credentials: { store, env: {}, reload: async () => ({ error: "unused" }), listSubscriptionModels: async () => ["account-first", "account-second"] },
      stageSettings: async settings => ({ model: createScriptedModel({ provider: "codex-subscription", id: settings.model }), contextManager: createContextManager(workspace) }),
    });
    try {
      controller.openModelPicker();
      expect(controller.snapshot().modelPicker!.entries.filter(entry => entry.kind === "model")).toHaveLength(0);
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      controller.browsePickerModels();
      const entries = controller.snapshot().modelPicker!.entries;
      expect(entries.filter(entry => entry.kind === "model").slice(0, 2).map(entry => [entry.modelId, entry.access])).toEqual([["account-first", "ChatGPT"], ["account-second", "ChatGPT"]]);
      expect(entries.filter(entry => entry.kind === "model" && entry.authRoute === "codex")).toHaveLength(2);
      expect(entries.some(entry => entry.provider === "openai" && entry.authRoute === "api-key")).toBe(false);
      expect(await controller.selectPickerModel()).toBe(true);
      expect(configEditor.settings).toMatchObject({ provider: "openai", openaiAuth: "codex", model: "account-first" });
    } finally { controller.dispose(); }
  });
});

test("reopening the picker refreshes saved credentials and preserves search ranking", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const store = fakeCredentialStore();
    const controller = new TuiController({ session: createSession(), sessionId: "picker-refresh", workspace,
      provider: "openai", modelId: "gpt-5.4", contextManager: createContextManager(workspace),
      credentials: { store, env: {}, reload: async () => ({ error: "unused" }) },
    });
    try {
      controller.openModelPicker();
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      expect(controller.snapshot().modelPicker!.entries.map(entry => entry.kind)).toEqual(["connect"]);
      controller.closeModelPicker();
      await store.set(credentialIdentity({ provider: "openai" }), "new-key");
      controller.openModelPicker();
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      expect(controller.snapshot().modelPicker!.entries.find(entry => entry.kind === "model" && entry.authRoute === "api-key" && entry.provider === "openai")).toMatchObject({ provider: "openai", access: "API key" });
      controller.searchModels("gpt");
      expect(controller.snapshot().modelPicker!.entries.find(entry => entry.kind === "model" && entry.authRoute === "api-key" && entry.provider === "openai")).toMatchObject({ provider: "openai", access: "API key" });
      expect(JSON.stringify(controller.snapshot())).not.toContain("new-key");
    } finally { controller.dispose(); }
  });
});

test("Grok picker models retain independent subscription access and active billing identity", async () => {
  const { grokSubscriptionIdentity } = await import("../src/auth/store.ts");
  const { fakeCredentialStore } = await import("./helpers/credential-store.ts");
  const { loadModelPickerAccess } = await import("../src/tui/model-access.ts");
  const { modelPickerEntries } = await import("../src/tui/model-picker.ts");
  const store = fakeCredentialStore();
  const missing = await loadModelPickerAccess({ store, env: { XAI_API_KEY: "api-key" } });
  expect(missing.grok).toBe("Login required"); expect(missing.xaiApiKey).toBe("API key");
  await store.set(grokSubscriptionIdentity(), JSON.stringify({ accessToken: "oauth", obtainedAt: 0 }));
  const access = await loadModelPickerAccess({ store, env: { XAI_API_KEY: "api-key" } }); expect(access.grok).toBe("Grok");
  const entries = modelPickerEntries("grok-4.7", "xai", "grok-4.7", {}, { access, activeRoute: "grok", xaiModels: [{ id: "grok-4.7" }], grokModels: [{ id: "grok-4.7", contextWindow: 777777, maxOutput: 12345 }] });
  expect(entries.filter(entry => entry.active).map(entry => entry.authRoute)).toEqual(["grok"]);
  expect(entries.find(entry => entry.kind === "model" && entry.authRoute === "grok")).toMatchObject({ access: "Grok", contextWindow: 777777, maxOutput: 12345 });
  expect(entries.find(entry => entry.authRoute === "api-key")?.access).toBe("API key");
});
