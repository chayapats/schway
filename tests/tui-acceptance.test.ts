import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfigEditor } from "../src/config/editing.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { handleSlashCommand } from "../src/tui/app.ts";
import { dispatchEditorInput, type SlashCommand } from "../src/tui/commands.ts";
import { TuiController } from "../src/tui/controller.ts";
import { withTempDir } from "./helpers.ts";

test("application slash dispatch reports rejected preparation without accepting the editor", async () => {
  await withTempDir(async root => {
    const home = join(root, "home");
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const configEditor = await loadConfigEditor({ home, workspaceRoot: root });
    const manager = createContextManager(workspace, { home });
    const controller = new TuiController({
      session: createSession(), sessionId: "test-session", workspace, contextManager: manager,
      provider: "openai", modelId: "test", configEditor,
    });
    let accepted = 0;
    let quit = false;
    const builtin = async (command: SlashCommand) =>
      handleSlashCommand(command.name, command.args, {
        controller, home, workspaceRoot: root, skillScope: { manager, workspaceRoot: root },
        sessionsDir: join(root, "sessions"), settings: () => configEditor.settings,
        env: {}, secrets: [], finishQuit: () => { quit = true; }, stderr: { write() {} },
      }, command.raw);
    try {
      expect(await dispatchEditorInput("/resume", controller, builtin, () => { accepted++; })).toBe(false);
      expect(await dispatchEditorInput("/model bad provider", controller, builtin, () => { accepted++; })).toBe(false);
      expect(accepted).toBe(0);
      expect(controller.snapshot().transcript.some(entry => entry.text.includes("Usage: /resume"))).toBe(true);
      expect(await dispatchEditorInput("/help", controller, builtin, () => { accepted++; })).toBe(true);
      expect(accepted).toBe(1);
      expect(quit).toBe(false);
    } finally { controller.dispose(); }
  });
});
