import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigEditor, loadConfigEditor } from "../src/config/editing.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { TuiController } from "../src/tui/controller.ts";
import { preferenceLines } from "../src/tui/preferences-view.ts";
import { preferenceRows } from "../src/tui/preferences.ts";
import { resolveWorkspace } from "../src/workspace/workspace.ts";
import { withTempDir } from "./helpers.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";

test("Advanced preferences name the ChatGPT route without renaming a model called codex", () => {
  const editor = new ConfigEditor({
    user: { provider: "openai", model: "codex", openaiAuth: "codex" },
    project: { openaiAuth: "codex" }, session: { openaiAuth: "codex" },
  }, { user: "/unused/user.json", project: "/unused/project.json" });
  const rows = preferenceRows(editor, "project", [], undefined, "advanced");
  const selectedIndex = rows.findIndex(row => row.key === "openaiAuth");
  const route = rows[selectedIndex]!;
  expect(route.value).toBe("chatgpt");
  expect(route.scopeSaved).toBe("chatgpt");
  expect(route.saved).toBe("user config=chatgpt; project config=chatgpt; session=chatgpt");
  const frame = preferenceLines({ scope: "project", page: "advanced", selectedIndex, choiceIndex: 0,
    rows: rows.map(row => row.key === "openaiAuth" ? { ...row, choices: ["codex"], action: undefined } : row) }, false).join("\n");
  expect(frame).toContain("OpenAI access: chatgpt");
  expect(frame).toContain("Choice: chatgpt");
  expect(frame).not.toContain("codex");
  const modelIndex = rows.findIndex(row => row.key === "model");
  expect(preferenceLines({ scope: "project", page: "advanced", selectedIndex: modelIndex, choiceIndex: 0, rows }, false).join("\n"))
    .toContain("Model: codex");
  expect(editor.settings.openaiAuth).toBe("codex");
  expect(editor.preferenceLayers.project?.openaiAuth).toBe("codex");
});

test("config show and an inherited route preview name ChatGPT while file edits retain codex", async () => withTempDir(async root => {
  const home = join(root, "home"), project = join(root, "project"), userFile = join(home, ".schway/config.json");
  await mkdir(project); await mkdir(join(home, ".schway"), { recursive: true });
  await writeFile(userFile, JSON.stringify({ provider: "openai", model: "account-model", openaiAuth: "codex" }));
  const workspace = await resolveWorkspace(project);
  const editor = await loadConfigEditor({ home, workspaceRoot: project });
  const controller = new TuiController({ session: createSession(), sessionId: "config-route", workspace,
    configEditor: editor, provider: "openai", modelId: "account-model",
    model: createScriptedModel({ provider: "codex-subscription", id: "account-model" }), contextManager: createContextManager(workspace),
    stageSettings: async next => ({ model: createScriptedModel({ provider: next.openaiAuth === "codex" ? "codex-subscription" : "openai", id: next.model }), contextManager: createContextManager(workspace) }),
  });
  try {
    for (const route of ["chatgpt", "codex"] as const) {
      expect(await controller.configCommand(`set openaiAuth ${route} --scope user`)).toBe(true);
      expect(await controller.configCommand("show")).toBe(true);
      expect(controller.snapshot().transcript.at(-1)?.text).toContain("openaiAuth: chatgpt [user-global]");
      expect(JSON.parse(await readFile(userFile, "utf8")).openaiAuth).toBe("codex");
      expect(editor.settings.openaiAuth).toBe("codex");
    }
    expect(await controller.configCommand("set openaiAuth api-key")).toBe(true);
    expect(controller.openPreferences()).toBe(true);
    controller.movePreference(controller.snapshot().preferences!.rows.findIndex(row => row.key === "advanced"));
    expect(await controller.selectPreference()).toBe(true);
    controller.movePreference(controller.snapshot().preferences!.rows.findIndex(row => row.key === "openaiAuth"));
    expect(await controller.selectPreference()).toBe(true);
    expect(controller.snapshot().preferences?.preview).toContain("Effective after save: chatgpt");
    expect(controller.snapshot().preferences?.preview).not.toContain("codex");
    expect(await controller.selectPreference()).toBe(true);
    expect(editor.settings.openaiAuth).toBe("codex");
    expect(JSON.parse(await readFile(userFile, "utf8")).openaiAuth).toBe("codex");
  } finally { controller.dispose(); }
}));

test("workspace memory rows and previews name ChatGPT while retaining the stored route", async () => withTempDir(async root => {
  const home = join(root, "home"), project = join(root, "project"); await mkdir(project);
  const workspace = await resolveWorkspace(project);
  const editor = await loadConfigEditor({ home, workspaceRoot: project, interactiveMemory: true });
  await (await editor.prepareMemory({ provider: "openai", model: "account-model", openaiAuth: "codex" })).commit();
  const controller = new TuiController({ session: createSession(), sessionId: "memory-route", workspace,
    configEditor: editor, provider: "openai", modelId: "account-model",
    model: createScriptedModel({ provider: "codex-subscription", id: "account-model" }), contextManager: createContextManager(workspace),
    stageSettings: async next => ({ model: createScriptedModel({ provider: "codex-subscription", id: next.model }), contextManager: createContextManager(workspace) }),
  });
  try {
    expect(controller.openPreferences()).toBe(true);
    controller.movePreference(controller.snapshot().preferences!.rows.findIndex(row => row.key === "advanced"));
    expect(await controller.selectPreference()).toBe(true);
    controller.movePreference(1, "scope");
    const panel = controller.snapshot().preferences!;
    expect(panel.scope).toBe("memory");
    expect(panel.rows[0]?.value).toBe("openai/account-model (chatgpt)");
    expect(panel.rows[0]?.saved).toContain("openai/account-model (chatgpt)");
    expect(await controller.selectPreference()).toBe(true);
    expect(controller.snapshot().preferences?.preview).toContain("Effective after save: openai/account-model (chatgpt)");
    expect(controller.snapshot().preferences?.preview).not.toContain("codex");
    expect(await controller.selectPreference()).toBe(true);
    expect(editor.settings.openaiAuth).toBe("codex");
    expect(editor.preferenceLayers.memory?.openaiAuth).toBe("codex");
    const reopened = await loadConfigEditor({ home, workspaceRoot: project, interactiveMemory: true });
    expect(reopened.settings.openaiAuth).toBe("codex");
    expect(preferenceRows(reopened, "memory", [])[0]?.value).toBe("openai/account-model (chatgpt)");
  } finally { controller.dispose(); }
}));
