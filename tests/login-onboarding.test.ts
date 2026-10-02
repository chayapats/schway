import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfigEditor } from "../src/config/editing.ts";
import { createContextManager } from "../src/context/manager.ts";
import { codexSubscriptionIdentity, credentialIdentity, grokSubscriptionIdentity } from "../src/auth/store.ts";
import { bindGrokModel } from "../src/model/loader.ts";
import { createSession } from "../src/session/session.ts";
import { TuiController } from "../src/tui/controller.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { withTempDir } from "./helpers.ts";
import { createTestRenderer } from "@opentui/core/testing";
import { TextareaRenderable } from "@opentui/core";
import { createConversationView } from "../src/tui/view.ts";

type Route = "codex" | "grok";

/** Run a subscription login journey with isolated credentials and scripted account models. */
async function withLogin(route: Route, run: (controller: TuiController) => Promise<void>, existing = false, outcome: "success" | "denied" | "cancel" = "success") {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, interactiveMemory: true,
      ...(existing ? { cli: { provider: "openai", model: "gpt-6-astra", openaiAuth: "api-key" } } : {}) });
    const store = fakeCredentialStore();
    /** Save fixture credentials or settle the scripted approval failure. */
    const login = async ({ signal, onSaved }: { signal: AbortSignal; onSaved?: () => void }) => {
      if (outcome === "cancel") await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      if (outcome === "denied") return { ok: false as const, message: "Sign-in denied · Alt+L retry" };
      await store.set(route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity(), "saved");
      onSaved?.();
      return { ok: true as const, status: "Saved" };
    };
    const controller = new TuiController({ session: createSession(), sessionId: "onboarding", workspace,
      provider: "openai", modelId: existing ? "gpt-6-astra" : "", openaiAuth: existing ? "api-key" : "auto",
      ...(existing ? { model: createScriptedModel({ provider: "openai", id: "gpt-6-astra" }) } : {}),
      configEditor: editor, contextManager: createContextManager(workspace),
      credentials: { store, env: {}, reload: async () => ({ error: "Use the selected route" }),
        codexLogin: login, grokLogin: login,
        listSubscriptionCatalog: async () => [{ id: "account-default", recommended: true, supportedThinking: [] }],
        listGrokModels: async () => [{ id: "grok-default", recommended: true }],
      },
      stageSettings: async settings => ({ model: route === "grok"
        ? bindGrokModel(createScriptedModel({ provider: "xai", id: settings.model }))
        : createScriptedModel({ provider: "codex-subscription", id: settings.model }), contextManager: createContextManager(workspace) }),
    });
    try { await run(controller); } finally { controller.dispose(); }
  });
}

for (const route of ["codex", "grok"] as const) for (const picker of [false, true]) test(`first ${route} login from ${picker ? "picker" : "command"} returns ready to type`, async () => {
  await withLogin(route, async controller => {
    await withDraft(controller, async () => {
      expect(await signIn(controller, route, picker)).toBe(true);
      expect(controller.snapshot()).toMatchObject({ modelId: route === "codex" ? "account-default" : "grok-default", readiness: "ready" });
      expect(controller.snapshot().modelPicker).toBeUndefined();
      expect(controller.snapshot().activeRoute).toContain(route === "codex" ? "ChatGPT" : "Grok");
    });
  });
});

/** Verify a login journey preserves the real composer's unsent text and cursor. */
async function withDraft(controller: TuiController, run: () => Promise<void>) {
  const terminal = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true });
  const view = createConversationView(terminal.renderer, { controller, workspaceRoot: "/project", home: "/home/test", env: {}, secrets: [],
    quit: () => {}, submit: async () => false });
  try {
    await terminal.flush();
    await terminal.mockInput.pasteBracketedText("Keep my ไทย task");
    const editor = terminal.renderer.root.findDescendantById("prompt") as TextareaRenderable;
    editor.cursorOffset = 5;
    await run(); view.refresh(); await terminal.flush();
    // Failed/cancelled login returns to its originating panel; Esc restores the composer.
    for (let step = 0; step < 3 && (controller.snapshot().loginChooser || controller.snapshot().modelPicker); step++) {
      terminal.mockInput.pressEscape(); view.refresh(); await terminal.flush();
    }
    expect(editor.plainText).toBe("Keep my ไทย task");
    expect(editor.cursorOffset).toBe(5);
    expect(controller.snapshot().transcript.some(entry => entry.kind === "user")).toBe(false);
  } finally { view.destroy(); terminal.renderer.destroy(); }
}

for (const route of ["codex", "grok"] as const) for (const outcome of ["denied", "cancel"] as const) for (const picker of [false, true]) {
  test(`${route} ${outcome} from ${picker ? "picker" : "command"} preserves the draft and usable model`, async () => {
    await withLogin(route, async controller => {
      await withDraft(controller, async () => {
        const pending = signIn(controller, route, picker);
        if (outcome === "cancel") {
          while (!controller.snapshot().loginApproval) await Bun.sleep(1);
          controller.cancel();
        }
        expect(await pending).toBe(false);
        expect(controller.snapshot()).toMatchObject({ provider: "openai", modelId: "gpt-6-astra", readiness: "ready", openaiAuth: "api-key" });
      });
    }, true, outcome);
  });
}

/** Enter subscription login through its direct command or the public model picker. */
async function signIn(controller: TuiController, route: Route, picker: boolean) {
  if (!picker) return controller.login(route);
  controller.openModelPicker();
  while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
  controller.searchModels(route === "codex" ? "ChatGPT" : "Grok subscription");
  return controller.selectPickerModel();
}

for (const route of ["codex", "grok"] as const) for (const picker of [false, true]) test(`adding ${route} from ${picker ? "picker" : "command"} retains the usable model and API billing`, async () => {
  await withLogin(route, async controller => {
    expect(await signIn(controller, route, picker)).toBe(true);
    expect(controller.snapshot()).toMatchObject({ provider: "openai", modelId: "gpt-6-astra", openaiAuth: "api-key", readiness: "ready" });
    expect(controller.snapshot().activeRoute).toContain("API key");
  }, true);
});

for (const provider of ["openai", "xai", "openai-compatible"] as const) for (const picker of [false, true]) {
  test(`first ${provider} key from ${picker ? "picker" : "command"} activates its listed default`, async () => {
    await withTempDir(async root => {
      const workspace = { root, launchCwd: root, extraRoots: [] }, store = fakeCredentialStore();
      const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, interactiveMemory: true,
        cli: { provider, baseUrl: "http://localhost:8787", auth: "required" } });
      const modelId = provider === "xai" ? "grok-default" : "gpt-default";
      const controller = new TuiController({ session: createSession(), sessionId: "key-login", workspace,
        provider: "openai", modelId: "", configEditor: editor, contextManager: createContextManager(workspace),
        credentials: { store, env: {}, reload: async () => ({ error: "Do not reload an unselected route" }),
          listRouteModels: async () => [{ id: modelId, recommended: true }] },
        stageSettings: async settings => ({ model: createScriptedModel({ provider: settings.provider, id: settings.model }), contextManager: createContextManager(workspace) }),
      });
      try {
        if (picker) {
          controller.openModelPicker();
          while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
          const entries = controller.snapshot().modelPicker!.entries;
          const index = entries.findIndex(row => row.kind === "sign-in" && row.provider === provider && row.authRoute !== "codex" && row.authRoute !== "grok");
          expect(index).toBeGreaterThanOrEqual(0);
          while (controller.snapshot().modelPicker!.selectedIndex !== index) controller.moveModelPicker(1);
          expect(await controller.selectPickerModel()).toBe(true);
        } else expect(await controller.login(provider)).toBe(true);
        controller.enterCredentialText("fixture-key");
        expect(await controller.submitCredential()).toBe(true);
        expect(controller.snapshot()).toMatchObject({ provider, modelId, readiness: "ready" });
        expect(controller.snapshot().modelPicker).toBeUndefined();
        expect(await store.get(credentialIdentity({ provider, baseUrl: "http://localhost:8787" }))).toBe("fixture-key");
      } finally { controller.dispose(); }
    });
  });
}

for (const outcome of ["failure", "empty", "ambiguous"] as const) test(`API discovery ${outcome} retains the saved key without choosing a fallback`, async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] }, store = fakeCredentialStore();
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, interactiveMemory: true });
    let activations = 0;
    const controller = new TuiController({ session: createSession(), sessionId: "discovery", workspace,
      provider: "openai", modelId: "", configEditor: editor, contextManager: createContextManager(workspace),
      credentials: { store, env: {}, reload: async () => ({ error: "unused" }),
        listRouteModels: async () => { if (outcome === "failure") throw Error("Authentication rejected"); return outcome === "ambiguous" ? [{ id: "gpt-unfamiliar-a" }, { id: "gpt-unfamiliar-b" }] : []; } },
      stageSettings: async () => { activations++; throw Error("Must not activate a guessed model"); },
    });
    try {
      controller.beginLogin("openai"); controller.enterCredentialText("saved-key");
      expect(await controller.submitCredential()).toBe(true);
      expect(controller.snapshot().modelId).toBe("");
      expect(activations).toBe(0);
      expect(controller.snapshot().transcript.at(-1)?.text).toContain("/model choose");
      expect(await store.get(credentialIdentity({ provider: "openai" }))).toBe("saved-key");
    } finally { controller.dispose(); }
  });
});

for (const route of ["codex", "grok"] as const) for (const outcome of ["success", "missing", "failure", "cancel"] as const) {
  test(`${route} reconnection ${outcome} never substitutes another model or billing route`, async () => {
    await withTempDir(async root => {
      const workspace = { root, launchCwd: root, extraRoots: [] }, store = fakeCredentialStore();
      const provider = route === "codex" ? "openai" : "xai", modelId = route === "codex" ? "account-chosen" : "grok-chosen";
      const identity = route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity();
      const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root,
        cli: { provider, model: modelId, openaiAuth: "codex", xaiAuth: "grok" } });
      const discovered = Promise.withResolvers<void>();
      /** Return the account fixture or wait for discovery cancellation. */
      const list = async (signal: AbortSignal) => {
        discovered.resolve();
        if (outcome === "cancel") await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        if (outcome === "failure") throw Error("Expired account; no API fallback");
        return [{ id: route === "codex" ? "new-default" : "grok-default", recommended: true, supportedThinking: [] },
          ...(outcome === "missing" ? [] : [{ id: modelId, supportedThinking: [] }])];
      };
      let requests = 0;
      const controller = new TuiController({ session: createSession(), sessionId: "reconnect", workspace,
        provider, modelId, openaiAuth: "codex", xaiAuth: "grok", configEditor: editor, contextManager: createContextManager(workspace),
        credentials: { store, env: { OPENAI_API_KEY: "other-billing", XAI_API_KEY: "other-billing" }, reload: async () => { throw Error("No automatic billing fallback"); },
          codexLogin: async ({ onSaving, onSaved }) => { onSaving?.(); await store.set(identity, "refreshed"); onSaved?.(); return { ok: true, status: "Saved" }; },
          grokLogin: async ({ onSaving, onSaved }) => { onSaving?.(); await store.set(identity, "refreshed"); onSaved?.(); return { ok: true, status: "Saved" }; },
          listSubscriptionCatalog: list, listGrokModels: list },
        stageSettings: async settings => {
          const model = createScriptedModel({ provider: route === "codex" ? "codex-subscription" : "xai", id: settings.model,
            responses: [() => { requests++; return { text: "Fresh account adapter" }; }] });
          return { model: route === "grok" ? bindGrokModel(model) : model, contextManager: createContextManager(workspace) };
        },
      });
      try {
        const pending = controller.login(route); await discovered.promise;
        if (outcome === "cancel") controller.cancel();
        expect(await pending).toBe(outcome === "success");
        expect(controller.snapshot()).toMatchObject({ provider, modelId, openaiAuth: "codex", xaiAuth: "grok" });
        expect(await store.get(identity)).toBe("refreshed");
        expect(await controller.submit("Use the refreshed account")).toBe(outcome === "success");
        expect(requests).toBe(outcome === "success" ? 1 : 0);
        if (outcome !== "success") expect(JSON.stringify(controller.snapshot())).toMatch(/\/model|Alt\+L/);
      } finally { controller.dispose(); }
    });
  });
}

for (const route of ["codex", "grok"] as const) test(`saving an API key preserves active ${route} billing and adapter`, async () => {
  await withLogin(route, async controller => {
    await controller.login(route);
    const before = controller.snapshot();
    controller.beginLogin(route === "codex" ? "openai" : "xai"); controller.enterCredentialText("another-key");
    expect(await controller.submitCredential()).toBe(true);
    expect(controller.snapshot()).toMatchObject({ provider: before.provider, modelId: before.modelId, activeRoute: before.activeRoute, readiness: "ready" });
    expect(await controller.submit("Keep subscription billing")).toBe(true);
  });
});

test("adding an endpoint preserves the usable model, settings and reasoning", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] }, store = fakeCredentialStore();
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root,
      cli: { provider: "openai", model: "gpt-6-astra", openaiAuth: "api-key", thinking: "high" } });
    const before = editor.settings;
    const controller = new TuiController({ session: createSession(), sessionId: "add-endpoint", workspace,
      provider: "openai", modelId: "gpt-6-astra", configEditor: editor, model: createScriptedModel({ provider: "openai" }),
      contextManager: createContextManager(workspace), credentials: { store, env: {}, reload: async () => { throw Error("Existing route must remain active"); } },
      stageSettings: async () => { throw Error("Adding an endpoint must not activate it"); },
    });
    try {
      controller.beginEndpointLogin(); controller.enterEndpointUrlText("http://localhost:8787"); controller.submitEndpointUrl();
      controller.enterCredentialText("endpoint-key"); expect(await controller.submitCredential()).toBe(true);
      expect(editor.settings).toEqual(before);
      expect(controller.snapshot()).toMatchObject({ provider: "openai", modelId: "gpt-6-astra", readiness: "ready" });
      expect(await store.get(credentialIdentity({ provider: "openai-compatible", baseUrl: "http://localhost:8787" }))).toBe("endpoint-key");
      expect(controller.snapshot().transcript.at(-1)?.text).toContain("/config set baseUrl http://localhost:8787");
      expect(await controller.submit("Keep working")).toBe(true);
    } finally { controller.dispose(); }
  });
});
