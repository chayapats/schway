import { expect, test } from "bun:test";
import { join } from "node:path";
import { createContextManager } from "../src/context/manager.ts";
import { loadConfigEditor } from "../src/config/editing.ts";
import { createJsonlSession, sessionsDirectory } from "../src/session/jsonl.ts";
import { TuiController } from "../src/tui/controller.ts";
import { createSession } from "../src/session/session.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { loadInteractiveModel } from "../src/tui/app.ts";
import { credentialIdentity } from "../src/auth/store.ts";
import { encodeSse, TEXT_STREAM_EVENTS } from "./fixtures/openai.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { withTempDir } from "./helpers.ts";

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
    expect(controller.snapshot().transcript.at(-1)?.text).toContain("/login");
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
