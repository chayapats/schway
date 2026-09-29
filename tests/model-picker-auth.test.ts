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

test("all account-visible Codex models precede other providers, including during search", () => {
  for (const query of ["", "model"]) {
    const entries = modelPickerEntries(query, "openai", "current-model", {}, {
      subscriptionMode: true,
      subscriptionModels: ["second-model", "current-model", "third-model"],
      profiles: { local: { baseUrl: "http://localhost:11434/v1", model: "local-model" } },
    });
    expect(entries.slice(0, 3).map(entry => entry.modelId)).toEqual(["current-model", "second-model", "third-model"]);
    expect(entries.slice(3).every(entry => entry.otherProvider)).toBe(true);
  }
});

test("API-key model choices keep the current provider together before other providers", () => {
  const entries = modelPickerEntries("", "openai", "gpt-5.4", {});
  const firstOther = entries.findIndex(entry => entry.provider !== "openai");
  expect(firstOther).toBeGreaterThan(1);
  expect(entries.slice(firstOther).some(entry => entry.provider === "openai")).toBe(false);
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

test("ready profiles precede missing credentials and a current model with no login", async () => {
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
  expect(entries.slice(0, 2).map(entry => entry.profile)).toEqual(["local", "saved"]);
  expect(entries.find(entry => entry.active)?.access).toBe("Login required");
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
      expect(await controller.selectPickerModel()).toBe(false);
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      const entries = controller.snapshot().modelPicker!.entries;
      expect(entries.slice(0, 2).map(entry => [entry.modelId, entry.access])).toEqual([["account-first", "ChatGPT"], ["account-second", "ChatGPT"]]);
      expect(entries.filter(entry => entry.authRoute === "codex")).toHaveLength(2);
      expect(entries.some(entry => entry.provider === "openai" && entry.authRoute === "api-key")).toBe(true);
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
      expect(controller.snapshot().modelPicker!.entries[0]!.access).toBe("Login required");
      controller.closeModelPicker();
      await store.set(credentialIdentity({ provider: "openai" }), "new-key");
      controller.openModelPicker();
      while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      expect(controller.snapshot().modelPicker!.entries[0]).toMatchObject({ provider: "openai", access: "API key" });
      controller.searchModels("gpt");
      expect(controller.snapshot().modelPicker!.entries[0]).toMatchObject({ provider: "openai", access: "API key" });
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
  const entries = modelPickerEntries("grok-4.7", "xai", "grok-4.7", {}, { access, activeRoute: "grok", xaiModels: [{ id: "grok-4.7" }], grokModels: [{ id: "grok-4.7" }] });
  expect(entries.filter(entry => entry.active).map(entry => entry.authRoute)).toEqual(["grok"]);
  expect(entries.find(entry => entry.authRoute === "grok")?.access).toBe("Grok");
  expect(entries.find(entry => entry.authRoute === "api-key")?.access).toBe("API key");
});
