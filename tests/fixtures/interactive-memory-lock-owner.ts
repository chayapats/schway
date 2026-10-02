// Hold the real preference critical section at an injected filesystem boundary until SIGKILL.
import { mock } from "bun:test";
import * as filesystem from "node:fs/promises";
import { join } from "node:path";
const openFile = filesystem.open, renameFile = filesystem.rename;

let attemptLocalContention: () => Promise<void>;
let held = false;
const fault = process.argv[3];
let injectFault = false;
mock.module("node:fs/promises", () => ({ ...filesystem,
  open: async (...args: Parameters<typeof filesystem.open>) => {
    if (injectFault && fault === "global-stage" && String(args[0]).includes("/global/")) {
      injectFault = false; throw new Error("fixture global staging failure");
    }
    return openFile(...args);
  },
  rename: async (source: string, destination: string) => {
    if (fault) {
      if (injectFault && ((fault === "global-rename" && destination.includes("/global/")) ||
          (fault === "workspace-rename" && !destination.includes("/global/")))) {
        injectFault = false; throw new Error("fixture rename failure");
      }
      return renameFile(source, destination);
    }
    if (!held && destination.includes("/.schway/interactive/") && destination.endsWith(".json")) {
      held = true;
      await attemptLocalContention();
      process.stdout.write("LOCKED\n");
      await new Promise(() => {});
    }
    return renameFile(source, destination);
  },
}));
const { loadConfigEditor } = await import("../../src/config/editing.ts");
if (fault) {
  const home = process.env.HOME!, root = process.argv[2]!;
  const a = join(root, "a"), b = join(root, "b");
  await filesystem.mkdir(a); await filesystem.mkdir(b);
  const load = (workspaceRoot: string) => loadConfigEditor({ home, workspaceRoot, interactiveMemory: true });
  const seed = await load(a);
  await (await seed.prepareOpenAIApiModel("gpt-4o")).commit(); await seed.rememberChoice("api-key");
  const editor = await load(a);
  const choice = { provider: "openai" as const, model: "gpt-5.4", openaiAuth: "api-key" as const };
  const staged = process.argv[4] === "prepare";
  if (!staged) await (await editor.prepareOpenAIApiModel(choice.model)).commit();
  const save = async () => staged ? (await editor.prepareMemory(choice)).commit() : editor.rememberChoice("api-key");
  injectFault = true;
  let error: string | undefined;
  try { await save(); } catch (failure) { error = String(failure); }
  const afterFailure = { model: editor.settings.model, memory: editor.preferenceLayers.memory?.model,
    reopened: (await load(a)).settings.model, global: (await load(b)).settings.model };
  await save();
  console.log(JSON.stringify({ error, afterFailure, retried: (await load(a)).settings.model, global: (await load(b)).settings.model }));
  process.exit(0);
}
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
