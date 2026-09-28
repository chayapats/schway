// Hold the real preference critical section at an injected filesystem boundary until SIGKILL.
import { mock } from "bun:test";
import * as filesystem from "node:fs/promises";

let attemptLocalContention: () => Promise<void>;
let held = false;
mock.module("node:fs/promises", () => ({ ...filesystem,
  rename: async (source: string, destination: string) => {
    if (!held && destination.includes("/.schway/interactive/") && destination.endsWith(".json")) {
      held = true;
      await attemptLocalContention();
      process.stdout.write("LOCKED\n");
      await new Promise(() => {});
    }
    return filesystem.rename(source, destination);
  },
}));
const { loadConfigEditor } = await import("../../src/config/editing.ts");
const { createContextManager } = await import("../../src/context/manager.ts");
const { createSession } = await import("../../src/session/session.ts");
const { TuiController } = await import("../../src/tui/controller.ts");
const { resolveWorkspace } = await import("../../src/workspace/workspace.ts");
const { createScriptedModel } = await import("../helpers/scripted-model.ts");
const workspace = await resolveWorkspace(process.argv[2]!);
async function createController() {
  const editor = await loadConfigEditor({ home: process.env.HOME!, workspaceRoot: workspace.root, interactiveMemory: true });
  return new TuiController({ session: createSession(), sessionId: "lock-owner", workspace,
    configEditor: editor, provider: editor.settings.provider, modelId: editor.settings.model,
    contextManager: createContextManager(workspace), model: createScriptedModel(),
    stageSettings: async next => ({ model: createScriptedModel({ provider: next.provider, id: next.model }), contextManager: createContextManager(workspace) }),
  });
}
attemptLocalContention = async () => {
  const contender = await createController();
  await contender.selectModel("openai/gpt-5.4");
  if (!contender.snapshot().transcript.at(-1)?.text.includes("not remembered")) throw new Error("Same-process contender bypassed the active writer");
  contender.dispose();
};
const controller = await createController();
await controller.selectModel("openai/gpt-4o");
throw new Error("Lock fixture unexpectedly completed");
