import { beforeAll, afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { createContextManager } from "../src/context/manager.ts";
import { ConfigEditor, loadConfigEditor } from "../src/config/editing.ts";
import { createJsonlSession, sessionsDirectory } from "../src/session/jsonl.ts";
import { TuiController } from "../src/tui/controller.ts";
import { createSession } from "../src/session/session.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { createCodexLoginRunner, createGrokLoginRunner, loadInteractiveModel } from "../src/tui/app.ts";
import { credentialIdentity } from "../src/auth/store.ts";
import { encodeSse, TEXT_STREAM_EVENTS } from "./fixtures/openai.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { withTempDir } from "./helpers.ts";

for (const route of ["codex", "grok"] as const) for (const committed of [true, false]) test(`${route} picker cancellation retains a started ${committed ? "successful" : "failed"} credential write until settlement`, async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] }, saved = fakeCredentialStore();
    const writing = Promise.withResolvers<void>(), finishWrite = Promise.withResolvers<void>();
    let deletes = 0, requests = 0, signal: AbortSignal | undefined;
    const store = { ...saved, async set(identity: Parameters<typeof saved.set>[0], value: string) {
      writing.resolve(); await finishWrite.promise;
      if (!committed) throw Error("Fixture secure-store write failed");
      await saved.set(identity, value);
    }, async delete(identity: Parameters<typeof saved.delete>[0]) { deletes++; return saved.delete(identity); } };
    const { codexSubscriptionIdentity, grokSubscriptionIdentity } = await import("../src/auth/store.ts");
    const { GROK_DEVICE_AUTHORIZATION_URL } = await import("../src/model/providers/grok-subscription.ts");
    const fetchFixture = async (input: string | URL | Request) => {
      requests++;
      const url = String(input);
      if (url.includes("usercode") || url === GROK_DEVICE_AUTHORIZATION_URL) {
        return Response.json(route === "grok"
          ? { user_code: "FIXTURE-CODE", verification_uri: "https://approval.example/device", device_code: "fixture-device", interval: 1 }
          : { device_auth_id: "fixture-device-auth", user_code: "FIXTURE-CODE", verification_uri: "https://approval.example/device", interval: "0" });
      }
      if (route === "codex" && url.includes("deviceauth/token")) {
        return Response.json({
          status: "success",
          authorization_code: "fixture-auth-code",
          code_challenge: "fixture-challenge",
          code_verifier: "fixture-verifier",
        });
      }
      return Response.json({ access_token: "fixture-account-access", refresh_token: "fixture-refresh", expires_in: 3600 });
    };
    const codex = createCodexLoginRunner({ store, secrets: [], fetch: fetchFixture });
    const grok = createGrokLoginRunner({ store, secrets: [], fetch: fetchFixture });
    const provider = route === "codex" ? "openai" : "xai", modelId = route === "codex" ? "gpt-5.4" : "grok-4.7";
    let modelCalls = 0;
    const controller = new TuiController({ session: createSession(), sessionId: "saving-picker", workspace, provider, modelId,
      openaiAuth: "codex", xaiAuth: "grok", contextManager: createContextManager(workspace),
      model: createScriptedModel({ provider: route === "codex" ? "codex-subscription" : "grok-subscription", id: modelId,
        responses: [() => { modelCalls++; return { text: "Old adapter must not run after replacement" }; }] }),
      credentials: { store, env: {}, reload: async () => ({ error: "Account requires activation" }),
        codexLogin: options => { signal = options.signal; options.onProgress("The browser could not be opened automatically"); return codex({ ...options, device: true }); },
        grokLogin: options => { signal = options.signal; options.onProgress("The browser could not be opened automatically"); return grok({ ...options, device: true }); } },
    });
    let pending: Promise<boolean> | undefined;
    try {
      controller.openModelPicker(); while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
      const query = route === "codex" ? "ChatGPT" : "Grok subscription";
      controller.connectPickerProviders(); controller.searchModels(query); pending = controller.selectPickerModel(); await writing.promise;
      expect(requests).toBe(route === "codex" ? 3 : 2); expect(controller.snapshot().loginChooser).toBeDefined();
      controller.cancel(); expect(signal?.aborted).toBe(true); controller.cancel();
      expect(controller.snapshot().modelPicker).toBeUndefined(); expect(controller.snapshot().loginChooser).toBeDefined();
      expect(controller.running).toBe(true); expect(await controller.logout(route)).toBe(false); expect(deletes).toBe(0);
      expect(await controller.selectLoginChoice()).toBe(false);
      let idle = false; const waiting = controller.waitForIdle().then(() => { idle = true; });
      await Bun.sleep(0); expect(idle).toBe(false);
      finishWrite.resolve(); expect(await pending).toBe(false); await waiting;
      expect(controller.running).toBe(false); expect(controller.snapshot().modelPicker?.query).toBe(query);
      expect(controller.snapshot().modelId).toBe(modelId); expect(controller.snapshot().provider).toBe(provider);
      const identity = route === "codex" ? codexSubscriptionIdentity() : grokSubscriptionIdentity();
      expect((await saved.get(identity)) !== null).toBe(committed);
      if (committed) { controller.closeModelPicker(); expect(await controller.submit("Do not use the replaced account adapter")).toBe(false); expect(modelCalls).toBe(0); }
      await controller.logout(route); expect(deletes).toBe(1); expect(await saved.get(identity)).toBeNull();
    } finally { finishWrite.resolve(); await pending; controller.dispose(); }
  });
});

test("interactive login and overwrite refresh the active real provider and logout disables its old saved key", async () => {
  await withTempDir(async root => {
    const home = join(root, "home");
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const store = fakeCredentialStore();
    const configEditor = await loadConfigEditor({ home, workspaceRoot: root, cli: { provider: "openai", model: "gpt-6-astra" } });
    const session = await createJsonlSession({ directory: sessionsDirectory(home), workspace });
    const settings = configEditor.settings;
    const secrets: string[] = [];
    const headers: string[] = [];
    const controller = new TuiController({
      session, sessionId: session.header.id, workspace, configEditor, secrets,
      provider: settings.provider, modelId: settings.model, contextManager: createContextManager(workspace),
      credentials: {
        store, env: {}, rememberSecret: key => secrets.push(key),
        reload: () => loadInteractiveModel(settings.provider, settings.model, {
          runtimeApiKey: undefined, env: {}, credentialStore: store, secrets,
          fetch: async (_input, init) => {
            headers.push(new Headers(init?.headers).get("authorization") ?? "");
            return new Response(encodeSse(TEXT_STREAM_EVENTS), { headers: { "Content-Type": "text/event-stream" } });
          },
        }),
      },
    });
    for (const key of ["first-secret-sentinel", "second-secret-sentinel"]) {
      expect(controller.beginLogin("openai")).toBe(true);
      controller.enterCredentialText(key);
      expect(controller.snapshot().credentialEntry?.masked).toMatch(/^•+$/);
      expect(JSON.stringify(controller.snapshot())).not.toContain(key);
      expect(await controller.submitCredential()).toBe(true);
      await controller.submit("hello");
    }
    expect(headers).toEqual(["Bearer first-secret-sentinel", "Bearer second-secret-sentinel"]);
    expect(await controller.logout("openai")).toBe(true);
    expect(await store.get(credentialIdentity({ provider: "openai" }))).toBeNull();
    await controller.submit("cannot reuse deleted key");
    expect(headers).toHaveLength(2);
    expect(controller.snapshot().transcript.at(-1)?.text).toContain("Alt+L sign in");
    controller.notice("first-secret-sentinel second-secret-sentinel");
    expect(JSON.stringify(controller.snapshot())).not.toContain("secret-sentinel");
    expect(await Bun.file(join(sessionsDirectory(home), `${session.header.id}.jsonl`)).text()).not.toContain("secret-sentinel");
    expect(await Bun.file(join(root, ".schway/config.json")).exists()).toBe(false);
    expect(await Bun.file(join(home, ".schway/config.json")).exists()).toBe(false);
    controller.dispose();
  });
});

test("interactive login reports denied secure-store reads after saving and never uses a stale adapter", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const saved = fakeCredentialStore();
    const secrets: string[] = [];
    const denied = { ...saved, async get() { throw new Error("native-read-secret-sentinel"); } };
    const session = createSession();
    const controller = new TuiController({
      session, sessionId: "denied-read", workspace, secrets,
      provider: "openai", modelId: "test", contextManager: createContextManager(workspace),
      credentials: {
        store: denied, env: {},
        reload: () => loadInteractiveModel("openai", "test", {
          env: {}, runtimeApiKey: undefined, credentialStore: denied, secrets,
        }),
      },
    });
    expect(controller.beginLogin("openai")).toBe(true);
    controller.enterCredentialText("saved-secret-sentinel");
    expect(await controller.submitCredential()).toBe(true);
    expect(await saved.get(credentialIdentity({ provider: "openai" }))).toBe("saved-secret-sentinel");
    expect(controller.snapshot().status).toBe("error");
    expect(JSON.stringify(controller.snapshot())).toContain("Unlock or allow access");
    expect(JSON.stringify(controller.snapshot())).not.toContain("secret-sentinel");
    await controller.submit("must not reach an old adapter");
    expect(session.items).toEqual([]);
    controller.dispose();
  });
});

test("credential changes wait for an active turn and cancelled entry leaves storage unchanged", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const store = fakeCredentialStore();
    const controller = new TuiController({
      session: createSession(), sessionId: "busy-login", workspace,
      provider: "openai", modelId: "test", model: createScriptedModel({ waitForAbort: true }),
      contextManager: createContextManager(workspace),
      credentials: { store, env: {}, reload: async () => ({ model: createScriptedModel() }) },
    });
    const turn = controller.submit("ongoing turn");
    expect(controller.beginLogin("openai")).toBe(false);
    expect(await controller.login("grok")).toBe(false);
    expect(controller.snapshot().transcript.at(-1)?.text).toBe("Wait for this turn · Esc stop");
    expect(await controller.logout("openai")).toBe(false);
    expect(await store.get(credentialIdentity({ provider: "openai" }))).toBeNull();
    controller.cancel();
    await turn;
    expect(controller.beginLogin("openai")).toBe(true);
    controller.enterCredentialText("cancelled-secret-sentinel");
    controller.cancel();
    expect(controller.snapshot().credentialEntry).toBeUndefined();
    expect(await store.get(credentialIdentity({ provider: "openai" }))).toBeNull();
    expect(JSON.stringify(controller.snapshot())).not.toContain("secret-sentinel");
    controller.dispose();
  });
});

test("Grok sign-in activates its recommended model, emits billing route, and logout blocks only Grok", async () => {
  const { grokSubscriptionIdentity } = await import("../src/auth/store.ts");
  const { bindGrokModel } = await import("../src/model/loader.ts");
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] }, home = join(root, "home"), store = fakeCredentialStore();
    await store.set(credentialIdentity({ provider: "xai" }), "billing-key");
    const editor = await loadConfigEditor({ home, workspaceRoot: root, cli: { provider: "openai", model: "gpt-6-astra" }, interactiveMemory: true });
    const activated: string[] = [];
    const controller = new TuiController({ session: createSession(), sessionId: "grok", workspace, home, configEditor: editor, provider: "openai", modelId: "", contextManager: createContextManager(workspace),
      credentials: { store, env: { XAI_API_KEY: "environment-key" }, reload: async () => ({ model: createScriptedModel() }), grokLogin: async ({ onSaved }) => { await store.set(grokSubscriptionIdentity(), JSON.stringify({ accessToken: "approved", obtainedAt: 0 })); onSaved?.(); return { ok: true, status: "Saved" }; }, listGrokModels: async () => [{ id: "grok-other" }, { id: "grok-4.7", recommended: true }] },
      stageSettings: async next => ({ model: bindGrokModel(createScriptedModel({ provider: "xai", id: next.model })), contextManager: createContextManager(workspace) }), onModelActivated: choice => { activated.push(choice.authRoute); },
    });
    try {
      expect(await controller.login("grok")).toBe(true); expect(editor.settings.xaiAuth).toBe("grok"); expect(controller.snapshot().modelId).toBe("grok-4.7"); expect(activated).toEqual(["grok"]);
      expect(controller.snapshot().transcript.some(entry => entry.text === "Grok model active · grok-4.7 · Enter send")).toBe(true);
      expect(await controller.logout("grok")).toBe(true); expect(await store.get(grokSubscriptionIdentity())).toBeNull(); expect(await store.get(credentialIdentity({ provider: "xai" }))).toBe("billing-key");
      expect(controller.snapshot().transcript.some(entry => entry.text.includes("Grok disconnected · Alt+L reconnect this account"))).toBe(true); expect(await controller.submit("Do not bill an API key")).toBe(false);
    } finally { controller.dispose(); }
  });
});
test("Grok plan rejection preserves the saved login and other routes but blocks the replaced account", async () => {
  const { grokSubscriptionIdentity } = await import("../src/auth/store.ts");
  for (const previous of ["openai", "xai"] as const) await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] }, store = fakeCredentialStore();
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, cli: { provider: previous, model: "previous-model", ...(previous === "xai" ? { xaiAuth: "grok" } : {}) } });
    const controller = new TuiController({ session: createSession(), sessionId: "grok", workspace, configEditor: editor, provider: previous, xaiAuth: previous === "xai" ? "grok" : "auto", modelId: "previous-model", model: createScriptedModel({ provider: previous, id: "previous-model" }), contextManager: createContextManager(workspace),
      credentials: { store, env: {}, reload: async () => ({ model: createScriptedModel() }), grokLogin: async ({ onSaved }) => { await store.set(grokSubscriptionIdentity(), "saved"); onSaved?.(); return { ok: true, status: "Saved" }; }, listGrokModels: async () => { throw Error("Your Grok plan doesn't include API access. Use an xAI API key instead."); } }, stageSettings: async () => { throw Error("must not activate"); },
    });
    try { expect(await controller.login("grok")).toBe(previous !== "xai"); expect(controller.snapshot().modelId).toBe("previous-model"); expect(await store.get(grokSubscriptionIdentity())).toBe("saved");
      if (previous === "xai") expect(controller.snapshot().transcript.at(-1)?.text).toBe("Models unavailable; sign-in saved · /model retry · Alt+L sign in · F2 details");
      expect(await controller.submit("Use the retained route if its credentials are unchanged")).toBe(previous !== "xai"); }
    finally { controller.dispose(); }
  });
});
test("Grok cancellation and disposal abort the shared login path without saving or exposing device codes", async () => {
  for (const dispose of [false, true]) {
    const workspace = { root: "/project", launchCwd: "/project", extraRoots: [] }, store = fakeCredentialStore();
    const controller = new TuiController({ session: createSession(), sessionId: "cancel-grok", workspace, provider: "xai", modelId: "", contextManager: createContextManager(workspace), credentials: { store, env: {}, reload: async () => ({ model: createScriptedModel() }), grokLogin: async ({ signal, onApproval }) => { onApproval({ kind: "device", verificationUri: "https://x.ai/device", userCode: "ABCD-EFGH" }); await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); return { ok: false, message: "Cancelled" }; } } });
    const running = controller.login("grok --device");
    expect(controller.snapshot().loginApproval).toBe("Open x.ai/device and enter ABCD-EFGH · Esc cancel");
    expect(controller.snapshot().transcript.some(entry => entry.text.includes("ABCD-EFGH"))).toBe(false);
    if (dispose) controller.dispose(); else controller.cancel();
    expect(await running).toBe(false); expect(controller.snapshot().loginApproval).toBeUndefined();
    expect(controller.snapshot().transcript.some(entry => entry.text === "Sign-in cancelled · Alt+L retry")).toBe(true); controller.dispose();
  }
});

const unguardedFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = Object.assign((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") throw new Error("Grok fixtures must not use external network");
    return unguardedFetch(input, init);
  }, { preconnect: unguardedFetch.preconnect }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = unguardedFetch; });

 test("Grok rejects pasted callbacks and restores a picker after cancellation", async () => {
  const { LOGIN_USAGE } = await import("../src/tui/commands.ts");
  const workspace = { root: "/project", launchCwd: "/project", extraRoots: [] };
  const controller = new TuiController({ session: createSession(), sessionId: "picker-grok", workspace, provider: "xai", modelId: "grok-4.7", contextManager: createContextManager(workspace),
    credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ model: createScriptedModel() }), grokLogin: async ({ signal, onApproval }) => { onApproval({ kind: "browser" }); await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); return { ok: false, message: "Cancelled" }; } },
  });
  try {
    expect(await controller.login("grok --code forbidden")).toBe(false); expect(controller.snapshot().transcript.at(-1)?.text).toBe(LOGIN_USAGE);
    controller.openModelPicker(); while (controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
    controller.connectPickerProviders(); controller.searchModels("Grok subscription");
    const picker = controller.snapshot().modelPicker!;
    const index = picker.entries.findIndex(entry => entry.authRoute === "grok"); expect(index).toBeGreaterThanOrEqual(0);
    controller.moveModelPicker(index - picker.selectedIndex);
    const signingIn = controller.selectPickerModel();
    expect(controller.snapshot().loginApprovalData?.kind).toBe("browser"); controller.cancel(); await signingIn;
    expect(controller.snapshot().modelPicker?.query).toBe("Grok subscription");
  } finally { controller.dispose(); }
});


function chooserController(overrides: Partial<import("../src/tui/controller.ts").TuiControllerOptions> = {}) {
  const workspace = { root: "/project", launchCwd: "/project", extraRoots: [] };
  return new TuiController({ session: createSession(), sessionId: "grouped-login", workspace,
    provider: "openai", modelId: "", contextManager: createContextManager(workspace),
    configEditor: new ConfigEditor({ cli: { provider: "openai", ...(overrides.baseUrl ? { baseUrl: overrides.baseUrl } : {}) } }, { user: "/unused-user-config", project: "/unused-project-config" }),
    stageSettings: async settings => ({ model: createScriptedModel({ provider: settings.provider, id: settings.model }), contextManager: createContextManager(workspace) }),
    credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ model: createScriptedModel() }) }, ...overrides });
}

function chooseLoginRow(controller: TuiController, id: string) {
  const panel = controller.snapshot().loginChooser!;
  const ids = panel.rows.filter(row => row.kind === "choice").map(row => row.id);
  expect(ids).toContain(id);
  controller.moveLoginChooser(ids.indexOf(id) - ids.indexOf(panel.selectedId));
}

test("grouped chooser orders payment groups, details and stable actions without starting work", async () => {
  const calls: string[] = [];
  const controller = chooserController({ credentials: { store: fakeCredentialStore(), env: {}, reload: async () => { calls.push("reload"); return { model: createScriptedModel() }; },
    codexLogin: async () => { calls.push("codex"); return { ok: false, message: "Denied" }; },
    grokLogin: async () => { calls.push("grok"); return { ok: false, message: "Denied" }; } } });
  try {
    expect(controller.openLoginChooser()).toBe(true);
    expect(controller.snapshot().loginChooser).toEqual({ level: "main", selectedId: "chatgpt", rows: [
      { kind: "group", label: "Subscription" },
      { kind: "choice", id: "chatgpt", label: "ChatGPT", detail: "recommended · browser", hasMore: true },
      { kind: "choice", id: "grok", label: "Grok", detail: "browser", hasMore: true },
      { kind: "group", label: "API key" },
      { kind: "choice", id: "openai", label: "OpenAI", hasMore: false },
      { kind: "choice", id: "xai", label: "xAI", hasMore: false },
      { kind: "group", label: "Custom endpoint" },
      { kind: "choice", id: "compatible", label: "OpenAI-compatible", detail: "URL + key", hasMore: false },
    ] });
    controller.moveLoginChooser(-1); expect(controller.snapshot().loginChooser!.selectedId).toBe("compatible");
    controller.moveLoginChooser(1); expect(controller.snapshot().loginChooser!.selectedId).toBe("chatgpt");
    for (const id of ["chatgpt", "grok", "openai", "xai", "compatible"]) {
      chooseLoginRow(controller, id);
      const notices = controller.snapshot().transcript.length;
      expect(controller.openLoginMoreOptions()).toBe(id === "chatgpt" || id === "grok");
      if (id === "chatgpt" || id === "grok") {
        expect(controller.snapshot().loginChooser).toMatchObject({ level: id, selectedId: `${id}-device` });
        expect(controller.snapshot().loginChooser!.rows.map(row => row.label)).toEqual(id === "chatgpt" ? ["Device approval", "Paste browser callback"] : ["Device code"]);
        controller.cancel(); expect(controller.snapshot().loginChooser).toMatchObject({ level: "main", selectedId: id });
      }
      expect(controller.snapshot().transcript.length).toBe(notices);
    }
    expect(calls).toEqual([]);
    controller.cancel(); expect(controller.snapshot().loginChooser).toBeUndefined();
    expect(await controller.login("")).toBe(true); expect(controller.snapshot().loginChooser!.selectedId).toBe("chatgpt");
  } finally { controller.dispose(); }
});

test("key and callback entries restore their originating row and direct commands return to the composer", async () => {
  const store = fakeCredentialStore();
  const controller = chooserController({ credentials: { store, env: {}, reload: async () => ({ model: createScriptedModel() }) } });
  try {
    for (const id of ["openai", "xai"]) {
      controller.openLoginChooser(); chooseLoginRow(controller, id);
      expect(await controller.selectLoginChoice()).toBe(true);
      controller.enterCredentialText("cancelled-key"); controller.cancel();
      expect(controller.snapshot().loginChooser).toMatchObject({ level: "main", selectedId: id });
      expect(await store.get(credentialIdentity({ provider: id as "openai" | "xai" }))).toBeNull();
      controller.cancel(); expect(controller.snapshot().loginChooser).toBeUndefined();
    }
    controller.openLoginChooser(); controller.openLoginMoreOptions(); chooseLoginRow(controller, "chatgpt-callback");
    expect(await controller.selectLoginChoice()).toBe(true); expect(controller.snapshot().loginCallbackEntry).toEqual({ masked: "" });
    controller.enterLoginCallbackText("private-callback"); controller.cancel();
    expect(controller.snapshot().loginChooser).toMatchObject({ level: "chatgpt", selectedId: "chatgpt-callback" });
    controller.cancel(); expect(controller.snapshot().loginChooser).toMatchObject({ level: "main", selectedId: "chatgpt" });
    controller.cancel();
    expect(await controller.login("openai")).toBe(true); controller.cancel(); expect(controller.snapshot().loginChooser).toBeUndefined();
  } finally { controller.dispose(); }
});

for (const provider of ["chatgpt", "grok"] as const) for (const device of [false, true]) test(`${provider} ${device ? "device" : "browser"} approval cancellation restores its exact chooser origin`, async () => {
  const methods: boolean[] = [];
  const wait = async ({ device, signal }: { device: boolean; signal: AbortSignal }) => {
    methods.push(device); await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    return { ok: false as const, message: "Cancelled" };
  };
  const controller = chooserController({ credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ model: createScriptedModel() }), codexLogin: wait, grokLogin: wait } });
  try {
    controller.openLoginChooser(); chooseLoginRow(controller, provider); if (device) controller.openLoginMoreOptions();
    const origin = controller.snapshot().loginChooser!;
    const pending = controller.selectLoginChoice(); expect(controller.running).toBe(true);
    controller.cancel(); await pending;
    expect(controller.snapshot().loginChooser).toMatchObject({ level: origin.level, selectedId: origin.selectedId });
    expect(methods).toEqual([device]);
    if (device) controller.cancel(); controller.cancel(); expect(controller.snapshot().loginChooser).toBeUndefined();
    const direct = controller.login(provider === "chatgpt" ? `codex${device ? " --device" : ""}` : `grok${device ? " --device" : ""}`);
    controller.cancel(); await direct; expect(controller.snapshot().loginChooser).toBeUndefined();
  } finally { controller.dispose(); }
});

for (const provider of ["chatgpt", "grok"] as const) test(`${provider} deferred device cancellation traverses both chooser levels before the runner settles`, async () => {
  let finish!: () => void;
  let signal!: AbortSignal;
  const wait = async (options: { signal: AbortSignal }) => {
    signal = options.signal;
    await new Promise<void>(resolve => { finish = resolve; });
    return { ok: false as const, message: "Cancelled" };
  };
  const controller = chooserController({ credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ model: createScriptedModel() }), codexLogin: wait, grokLogin: wait } });
  let pending: Promise<boolean> | undefined;
  try {
    controller.openLoginChooser(); chooseLoginRow(controller, provider); controller.openLoginMoreOptions();
    pending = controller.selectLoginChoice();
    expect(controller.running).toBe(true);
    controller.cancel();
    expect(signal.aborted).toBe(true);
    expect(controller.snapshot().loginChooser).toMatchObject({ level: provider, selectedId: `${provider}-device` });
    controller.cancel();
    expect(controller.snapshot().loginChooser).toMatchObject({ level: "main", selectedId: provider });
    controller.cancel();
    expect(controller.snapshot().loginChooser).toBeUndefined();
    expect(controller.running).toBe(true);
    finish(); await pending;
    expect(controller.running).toBe(false);
    expect(controller.snapshot().loginChooser).toBeUndefined();
  } finally { finish?.(); await pending; controller.dispose(); }
});

for (const [value, error] of [
  ["", "Enter an endpoint URL · Use http:// or https://"],
  ["localhost:8787", "Enter a full URL · Use http:// or https://"],
  ["ftp://host/v1", "Enter a full URL · Use http:// or https://"],
  ["http://user:pw@host/v1", "Remove credentials from the URL · Enter the key next"],
  ["http://host/v1?x=1", "Remove the URL query · Enter retry"],
  ["http://host/v1?", "Remove the URL query · Enter retry"],
]) test(`endpoint URL validation keeps ${JSON.stringify(value)} in the ephemeral field`, async () => {
  const controller = chooserController();
  try {
    controller.openLoginChooser(); chooseLoginRow(controller, "compatible"); await controller.selectLoginChoice();
    controller.enterEndpointUrlText(value); expect(controller.submitEndpointUrl()).toBe(false);
    expect(controller.snapshot().endpointUrlEntry).toEqual({ value, error });
    expect(controller.snapshot().credentialEntry).toBeUndefined();
    expect(controller.snapshot().transcript).toEqual([]);
    controller.cancel(); expect(controller.snapshot().loginChooser).toMatchObject({ level: "main", selectedId: "compatible" });
  } finally { controller.dispose(); }
});

test("endpoint URL prefill accepts only the same valid HTTP(S) URLs as profiles, and direct login stays key-only", async () => {
  for (const baseUrl of [undefined, "http://localhost:8787", "https://host/v1#models", "localhost:8787", "https://user:pw@host/v1", "https://host/v1?x=1"]) {
    const controller = chooserController({ baseUrl });
    try {
      expect(controller.beginEndpointLogin()).toBe(true);
      expect(controller.snapshot().endpointUrlEntry?.value).toBe(baseUrl === "http://localhost:8787" || baseUrl === "https://host/v1#models" ? baseUrl : "");
      controller.cancel();
      if (baseUrl === "http://localhost:8787") { expect(await controller.login("openai-compatible")).toBe(true); expect(controller.snapshot().endpointUrlEntry).toBeUndefined(); controller.cancel(); expect(controller.snapshot().loginChooser).toBeUndefined(); }
    } finally { controller.dispose(); }
  }
});

for (const outcome of ["success", "list-failure", "activation-failure"] as const) test(`endpoint key save replaces an unavailable profile in session scope through ${outcome}`, async () => {
  await withTempDir(async root => {
    const home = join(root, "home"), workspace = { root, launchCwd: root, extraRoots: [] }, store = fakeCredentialStore();
    const editor = await loadConfigEditor({ home, workspaceRoot: root, interactiveMemory: true, cli: {
      profile: "old", profiles: { old: { baseUrl: "https://old.example/v1", model: "old-model", auth: "none" } },
    } });
    const session = createSession(); const listings: unknown[] = []; const staged: string[] = [];
    const controller = chooserController({ session, home, workspace, configEditor: editor, provider: editor.settings.provider, modelId: editor.settings.model,
      profile: "old", baseUrl: editor.settings.baseUrl, auth: editor.settings.auth,
      credentials: { store, env: {}, reload: async () => { throw Error("the old endpoint must not reload"); }, listRouteModels: async (route, _signal, options) => {
        listings.push({ route, options }); if (outcome === "list-failure") throw Error("Offline"); return [{ id: "other" }, { id: "endpoint-model", recommended: true }];
      } }, stageSettings: async settings => { staged.push(settings.baseUrl!); if (outcome === "activation-failure") throw Error("Offline");
        return { model: createScriptedModel({ provider: settings.provider, id: settings.model }), contextManager: createContextManager(workspace) }; },
    });
    try {
      controller.openLoginChooser(); chooseLoginRow(controller, "compatible"); expect(await controller.selectLoginChoice()).toBe(true);
      // Replace the valid profile URL prefill without touching any settings.
      while (controller.snapshot().endpointUrlEntry!.value) controller.backspaceEndpointUrl();
      controller.enterEndpointUrlText("  http://localhost:8787  "); expect(controller.submitEndpointUrl()).toBe(true);
      expect(controller.snapshot().credentialEntry).toBeDefined(); expect(editor.settings.baseUrl).toBe("https://old.example/v1");
      controller.enterCredentialText("endpoint-private-key"); expect(await controller.submitCredential()).toBe(true);
      expect(listings).toEqual([{ route: "compatible", options: { baseUrl: "http://localhost:8787" } }]);
      expect(editor.settings.baseUrl).toBe("http://localhost:8787"); expect(editor.settings.profile).toBeUndefined();
      expect(controller.snapshot().transcript.some(entry => entry.text.includes("Automatic authentication is disabled"))).toBe(false);
      expect(await store.get(credentialIdentity({ provider: "openai-compatible", baseUrl: "http://localhost:8787" }))).toBe("endpoint-private-key");
      expect(controller.snapshot().transcript.some(entry => entry.text === "Endpoint ready for this session · /config set baseUrl http://localhost:8787 --scope user to keep it")).toBe(true);
      if (outcome === "success") { expect(controller.snapshot().modelId).toBe("endpoint-model"); expect(staged).toEqual(["http://localhost:8787"]); }
      else { expect(controller.snapshot().modelId).toBe("old-model"); expect(controller.snapshot().status).toBe("error"); expect(controller.snapshot().transcript.at(-1)?.text).toContain("Sign-in saved · /model choose a model"); }
      expect(await Bun.file(join(home, ".schway/config.json")).exists()).toBe(false); expect(await Bun.file(join(root, ".schway/config.json")).exists()).toBe(false);
      if (outcome !== "success") expect(await controller.submit("do not reuse the old endpoint adapter")).toBe(false);
      expect(JSON.stringify(session.items)).not.toContain("http://localhost:8787");
      // Durable workspace choice contains route/model only; the ephemeral endpoint is not remembered.
      const next = await loadConfigEditor({ home, workspaceRoot: root, interactiveMemory: true });
      expect(next.settings.baseUrl).not.toBe("http://localhost:8787");
    } finally { controller.dispose(); }
  });
});

test("URL and key Esc retain the typed endpoint while an empty key saves nothing", async () => {
  const controller = chooserController();
  try {
    controller.openLoginChooser(); chooseLoginRow(controller, "compatible"); await controller.selectLoginChoice();
    controller.enterEndpointUrlText("http://localhost:8787"); controller.submitEndpointUrl(); controller.enterCredentialText("cancelled-key");
    controller.cancel(); expect(controller.snapshot().endpointUrlEntry).toEqual({ value: "http://localhost:8787" });
    expect(controller.submitEndpointUrl()).toBe(true); expect(await controller.submitCredential()).toBe(false);
    expect(controller.snapshot().transcript.at(-1)?.text).toBe("Key not saved · Alt+L retry · /model choose model");
    expect(controller.snapshot().loginChooser).toBeUndefined();
  } finally { controller.dispose(); }
});

for (const existing of [false, true]) test(`${existing ? "replacement" : "first"} endpoint fragments stay in cancelled input but are removed from saved routing and model activation`, async () => {
  await withTempDir(async root => {
    const store = fakeCredentialStore();
    const home = join(root, "home"), workspace = { root, launchCwd: root, extraRoots: [] };
    const configEditor = await loadConfigEditor({ home, workspaceRoot: root, interactiveMemory: true,
      cli: existing ? { provider: "openai-compatible", baseUrl: "http://old.example/v1" } : { provider: "openai" },
    });
    const listings: unknown[] = [], staged: string[] = [];
    const controller = chooserController({ configEditor, home, workspace,
      credentials: { store, env: {}, reload: async () => ({ model: createScriptedModel() }), listRouteModels: async (route, _signal, options) => {
        listings.push({ route, baseUrl: options?.baseUrl }); return [{ id: "endpoint-model", recommended: true }];
      } },
      stageSettings: async settings => {
        staged.push(settings.baseUrl!);
        return { model: createScriptedModel({ provider: settings.provider, id: settings.model }), contextManager: createContextManager(workspace) };
      },
    });
    try {
      controller.openLoginChooser(); chooseLoginRow(controller, "compatible"); await controller.selectLoginChoice();
      while (controller.snapshot().endpointUrlEntry!.value) controller.backspaceEndpointUrl();
      const typed = "  http://localhost:8787#section  ";
      controller.enterEndpointUrlText(typed); expect(controller.submitEndpointUrl()).toBe(true);
      controller.enterCredentialText("cancelled-key"); controller.cancel();
      expect(controller.snapshot().endpointUrlEntry).toEqual({ value: typed });
      expect(configEditor.settings.baseUrl).toBe(existing ? "http://old.example/v1" : undefined);
      expect(controller.submitEndpointUrl()).toBe(true); controller.enterCredentialText("endpoint-key");
      expect(await controller.submitCredential()).toBe(true);
      expect(listings).toEqual([{ route: "compatible", baseUrl: "http://localhost:8787" }]);
      expect(staged).toEqual(["http://localhost:8787"]);
      expect(configEditor.settings.baseUrl).toBe("http://localhost:8787");
      expect(controller.snapshot().modelId).toBe("endpoint-model");
      expect(await store.get(credentialIdentity({ provider: "openai-compatible", baseUrl: "http://localhost:8787" }))).toBe("endpoint-key");
      expect(controller.snapshot().transcript.some(entry => entry.text === "Endpoint ready for this session · /config set baseUrl http://localhost:8787 --scope user to keep it")).toBe(true);
      expect(await Bun.file(join(home, ".schway/config.json")).exists()).toBe(false);
      expect(await Bun.file(join(root, ".schway/config.json")).exists()).toBe(false);
      const next = await loadConfigEditor({ home, workspaceRoot: root, interactiveMemory: true });
      expect(next.settings.baseUrl).not.toBe("http://localhost:8787");
    } finally { controller.dispose(); }
  });
});

for (const source of ["api-high", "api-off", "router-high", "router-same-high", "router-new-model-high"] as const) for (const outcome of ["success", "list-failure", "activation-failure"] as const) test(`endpoint activation from unavailable ${source} retains only applicable reasoning through ${outcome}`, async () => {
  await withTempDir(async root => {
    const router = source.startsWith("router"), home = join(root, "home"), workspace = { root, launchCwd: root, extraRoots: [] };
    const configEditor = new ConfigEditor({ cli: router
      ? { profile: "old", profiles: { old: { baseUrl: "https://openrouter.ai/api/v1", model: "router-model", auth: "required" } }, thinking: "high" }
      : { provider: "openai", model: source === "api-off" ? "gpt-6-sol" : "gpt-6-astra", thinking: source === "api-off" ? "off" : "high" },
    }, { user: join(home, ".schway/config.json"), project: join(root, ".schway/config.json") }, router ? [
      { id: "router-model", baseUrl: "https://openrouter.ai/api/v1", supportedThinking: ["off", "high"] },
      { id: "endpoint-model", baseUrl: "https://openrouter.ai/api/v1", supportedThinking: ["off"] },
    ] : undefined);
    const initial = configEditor.settings;
    const endpointUrl = source === "router-same-high" || source === "router-new-model-high" ? "https://openrouter.ai/api/v1" : "http://localhost:8787";
    const selectedModel = source === "router-same-high" ? "router-model" : "endpoint-model";
    const expectedThinking = source === "api-off" ? "off" : source === "router-same-high" || (source === "router-new-model-high" && outcome === "list-failure") ? "high" : undefined;
    const listings: string[] = [], staged: unknown[] = [];
    const controller = chooserController({ home, workspace, configEditor, provider: initial.provider, modelId: initial.model,
      profile: initial.profile, baseUrl: initial.baseUrl, thinking: initial.thinking,
      credentials: { store: fakeCredentialStore(), env: {}, reload: async () => { throw Error("the old adapter must not reload"); }, listRouteModels: async (_route, _signal, options) => {
        listings.push(options!.baseUrl!); if (outcome === "list-failure") throw Error("Offline"); return [{ id: selectedModel, recommended: true }];
      } },
      stageSettings: async settings => {
        staged.push({ baseUrl: settings.baseUrl, thinking: settings.thinking }); if (outcome === "activation-failure") throw Error("Offline");
        return { model: createScriptedModel({ provider: settings.provider, id: settings.model }), contextManager: createContextManager(workspace) };
      },
    });
    try {
      controller.openLoginChooser(); chooseLoginRow(controller, "compatible"); await controller.selectLoginChoice();
      while (controller.snapshot().endpointUrlEntry!.value) controller.backspaceEndpointUrl();
      controller.enterEndpointUrlText(endpointUrl); expect(controller.submitEndpointUrl()).toBe(true);
      controller.enterCredentialText("endpoint-key"); expect(await controller.submitCredential()).toBe(true);
      expect(listings).toEqual([endpointUrl]);
      expect(configEditor.settings.provider).toBe("openai-compatible"); expect(configEditor.settings.baseUrl).toBe(endpointUrl);
      expect(configEditor.settings.profile).toBeUndefined(); expect(configEditor.settings.thinking).toBe(expectedThinking);
      expect(controller.snapshot().thinking).toBe(expectedThinking);
      expect(staged).toEqual(outcome === "list-failure" ? [] : [{ baseUrl: endpointUrl, thinking: expectedThinking }]);
      if (outcome === "success") expect(controller.snapshot().modelId).toBe(selectedModel);
      else {
        expect(controller.snapshot().transcript.at(-1)?.text).toContain("Sign-in saved · /model choose a model");
        expect(await controller.submit("do not use the previous adapter")).toBe(false);
        expect(configEditor.settings.baseUrl).toBe(endpointUrl);
      }
    } finally { controller.dispose(); }
  });
});

test("opening a chooser while a turn runs gives the specified busy notice and never starts sign-in", async () => {
  const controller = chooserController({ model: createScriptedModel({ waitForAbort: true }), modelId: "test" });
  const turn = controller.submit("work");
  try { expect(controller.openLoginChooser()).toBe(false); expect(controller.snapshot().transcript.at(-1)?.text).toBe("Wait for this turn · Esc stop"); }
  finally { controller.cancel(); await turn; controller.dispose(); }
});


for (const device of [false, true]) test(`Grok chooser ${device ? "device" : "browser"} uses the real OAuth runner and protocol fixtures`, async () => {
  const { createGrokLoginRunner } = await import("../src/tui/app.ts");
  const { GROK_TOKEN_URL, GROK_DEVICE_AUTHORIZATION_URL } = await import("../src/model/providers/grok-subscription.ts");
  const { grokSubscriptionIdentity } = await import("../src/auth/store.ts");
  const store = fakeCredentialStore(), requests: string[] = [], secrets: string[] = [];
  const runner = createGrokLoginRunner({ store, secrets,
    openBrowser: async value => {
      const url = new URL(value); expect(url.origin).toBe("https://auth.x.ai");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      await (await fetch(`${url.searchParams.get("redirect_uri")}?state=${url.searchParams.get("state")}&code=fixture-code`)).text();
    }, fetch: async (input, init) => {
      const url = String(input); requests.push(url); const body = new URLSearchParams(String(init?.body));
      if (url === GROK_DEVICE_AUTHORIZATION_URL) { expect(body.get("scope")).toContain("api:access"); return Response.json({ device_code: "fixture-device", user_code: "ABCD-EFGH", verification_uri: "https://x.ai/device", interval: 1 }); }
      expect(url).toBe(GROK_TOKEN_URL); expect(body.get("grant_type")).toBe(device ? "urn:ietf:params:oauth:grant-type:device_code" : "authorization_code");
      if (!device) { expect(body.get("code")).toBe("fixture-code"); expect(body.get("code_verifier")!.length).toBeGreaterThanOrEqual(43); }
      return Response.json({ access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600 });
    },
  });
  const controller = chooserController({ credentials: { store, env: {}, reload: async () => ({ model: createScriptedModel() }), grokLogin: runner, listGrokModels: async () => [{ id: "grok-4.7", recommended: true }] } });
  try {
    controller.openLoginChooser(); chooseLoginRow(controller, "grok"); if (device) controller.openLoginMoreOptions();
    expect(requests).toEqual([]); expect(await controller.selectLoginChoice()).toBe(true);
    expect(requests).toEqual(device ? [GROK_DEVICE_AUTHORIZATION_URL, GROK_TOKEN_URL] : [GROK_TOKEN_URL]);
    expect(await store.get(grokSubscriptionIdentity())).toContain("fixture-access"); expect(controller.snapshot().modelId).toBe("grok-4.7");
    expect(JSON.stringify(controller.snapshot())).not.toContain("fixture-access");
  } finally { controller.dispose(); }
});

test("xAI chooser saves only its API key and discovers models through the xAI protocol fixture", async () => {
  const { XAI_MODELS_PAYLOAD } = await import("./fixtures/xai.ts");
  const { fetchProviderModelList } = await import("../src/model/model-list.ts");
  const { XAI_MODELS_URL } = await import("../src/model/providers/xai.ts");
  const store = fakeCredentialStore(), requests: string[] = [];
  const controller = chooserController({ credentials: { store, env: {}, reload: async () => ({ model: createScriptedModel() }),
    listRouteModels: async (route, signal) => {
      expect(route).toBe("xai");
      const key = await store.get(credentialIdentity({ provider: "xai" }));
      return fetchProviderModelList({ url: XAI_MODELS_URL, apiKey: key!, label: "xAI", signal, fetch: async (input, init) => {
        requests.push(String(input)); expect(new Headers(init?.headers).get("authorization")).toBe("Bearer xai-fixture-key"); return Response.json(XAI_MODELS_PAYLOAD);
      } });
    },
  } });
  try {
    controller.openLoginChooser(); chooseLoginRow(controller, "xai"); expect(await controller.selectLoginChoice()).toBe(true);
    expect(requests).toEqual([]); controller.enterCredentialText("xai-fixture-key"); expect(await controller.submitCredential()).toBe(true);
    expect(requests).toEqual([XAI_MODELS_URL]); expect(controller.snapshot().modelId).toBe("grok-4.7");
    expect(await store.get(credentialIdentity({ provider: "openai" }))).toBeNull();
  } finally { controller.dispose(); }
});

test("endpoint entry fails clearly when session settings cannot be committed", () => {
  const controller = chooserController({ configEditor: undefined, stageSettings: undefined });
  try { expect(controller.beginEndpointLogin()).toBe(false); expect(controller.snapshot().endpointUrlEntry).toBeUndefined(); expect(controller.snapshot().transcript.at(-1)?.text).toBe("Endpoint setup unavailable · Restart Schway · Alt+L sign in"); }
  finally { controller.dispose(); }
});
