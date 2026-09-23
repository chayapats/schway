import { expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "./helpers.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { TuiController } from "../src/tui/controller.ts";
import { credentialIdentity } from "../src/auth/store.ts";
import { bindCredentialInput, loadCredentialSafeTui } from "../src/tui/credential-input.ts";

test("real renderer key and paste dispatch keep secrets out of normal editor, undo, frames and input debug capture", async () => {
  await withTempDir(async root => {
    const beforeDebug = process.env.OTUI_DEBUG;
    const beforeLog = process.env.OTUI_STDIN_LOG;
    process.env.OTUI_DEBUG = "1";
    process.env.OTUI_STDIN_LOG = join(root, "raw-input.log");
    const { InputRenderable } = await loadCredentialSafeTui();
    const { createTestRenderer } = await import("@opentui/core/testing");
    const setup = await createTestRenderer({ width: 80, height: 24, consoleMode: "disabled" });
    const store = fakeCredentialStore();
    const session = createSession();
    const controller = new TuiController({
      session, sessionId: "input", provider: "openai", modelId: "test", contextManager: createContextManager({ root, launchCwd: root, extraRoots: [] }),
      credentials: { store, env: {}, reload: async () => ({ model: createScriptedModel() }) },
    });
    const input = new InputRenderable(setup.renderer, { value: "ordinary editor content" });
    setup.renderer.root.add(input);
    input.focus();
    const cleanup = bindCredentialInput(setup.renderer.keyInput, controller, () => {});
    try {
      expect(controller.beginLogin("openai")).toBe(true);
      await setup.mockInput.typeText("typed-secret-sentinel");
      await setup.mockInput.pasteBracketedText("-paste-secret-sentinel");
      expect(input.value).toBe("ordinary editor content");
      expect(JSON.stringify(controller.snapshot())).not.toContain("sentinel");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain("sentinel");
      expect(setup.renderer.getDebugInputs()).toEqual([]);
      expect(await Bun.file(join(root, "raw-input.log")).exists()).toBe(false);
      setup.mockInput.pressEnter();
      await controller.waitForIdle();
      expect(await store.get(credentialIdentity({ provider: "openai" }))).toBe("typed-secret-sentinel-paste-secret-sentinel");
      expect(session.items).toEqual([]);
      setup.mockInput.pressKey("z", { ctrl: true });
      expect(input.value).not.toContain("sentinel");
      expect(controller.beginLogin("openai")).toBe(true);
      await setup.mockInput.pasteBracketedText("cancelled-secret-sentinel");
      setup.mockInput.pressEscape();
      await Bun.sleep(40);
      expect(controller.snapshot().credentialEntry).toBeUndefined();
      expect(await store.get(credentialIdentity({ provider: "openai" }))).toBe("typed-secret-sentinel-paste-secret-sentinel");
      expect(JSON.stringify(controller.snapshot())).not.toContain("sentinel");
    } finally {
      cleanup(); controller.dispose(); setup.renderer.destroy();
      if (beforeDebug === undefined) delete process.env.OTUI_DEBUG; else process.env.OTUI_DEBUG = beforeDebug;
      if (beforeLog === undefined) delete process.env.OTUI_STDIN_LOG; else process.env.OTUI_STDIN_LOG = beforeLog;
    }
  });
});
