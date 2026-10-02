import { expect, test } from "bun:test";
import { helpText, parseSkillInvocation, parseSlashCommand } from "../src/tui/commands.ts";
import { commandCatalog } from "../src/tui/command-catalog.ts";
import { createTestRenderer } from "@opentui/core/testing";
import type { TextareaRenderable } from "@opentui/core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfigEditor } from "../src/config/editing.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createJsonlSession, loadJsonlSession } from "../src/session/jsonl.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { writeTool } from "../src/tools/write.ts";
import { handleSlashCommand } from "../src/tui/app.ts";
import { dispatchEditorInput } from "../src/tui/commands.ts";
import { TuiController } from "../src/tui/controller.ts";
import { createConversationView } from "../src/tui/view.ts";
import { resolveWorkspace } from "../src/workspace/workspace.ts";
import { withTempDir } from "./helpers.ts";
import { createScriptedModel, type ScriptedTurnFactory } from "./helpers/scripted-model.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { codexSubscriptionIdentity } from "../src/auth/store.ts";

/** Build an isolated persisted session with scripted model responses and real slash-command dispatch. */
async function fixture(home: string, responses: ScriptedTurnFactory[]) {
  const workspace = await resolveWorkspace(home);
  const directory = join(home, "sessions");
  const session = await createJsonlSession({ directory, workspace });
  const config = await loadConfigEditor({ home, workspaceRoot: home });
  const store = fakeCredentialStore();
  await store.set(codexSubscriptionIdentity(), "fixture-login");
  const model = createScriptedModel({ responses });
  const controller = new TuiController({ home, workspace, session, sessionId: session.header.id,
    provider: "scripted", modelId: "fixture", thinking: "high", auth: "none",
    appearanceEnvironment: "light", configEditor: config,
    model, tools: createToolRegistry([writeTool]), credentials: { store, env: {}, reload: async () => ({ model }) },
    contextManager: createContextManager(workspace, { home }) });
  const ctx = { controller, home, workspaceRoot: home, skillScope: { workspaceRoot: home },
    sessionsDir: directory, settings: () => config.settings, env: {}, secrets: [],
    finishQuit() {}, stderr: { write() {} } };
  const send = (input: string, accepted?: () => void) => dispatchEditorInput(input, controller,
    (command, accept) => handleSlashCommand(command.name, command.args, ctx, command.raw, accept), accepted);
  return { controller, session, directory, config, store, send };
}

test("clear parses as the new conversation action while retaining the original input", () => {
  expect(parseSlashCommand(" /CLEAR ")).toEqual({ name: "new", raw: "/CLEAR", args: "" });
  expect(parseSlashCommand("/clear ignored arguments")).toEqual({ name: "new", raw: "/clear ignored arguments", args: "ignored arguments" });
});

test("real clear dispatch isolates model context, retains settings and file edits, and resumes old history", async () => {
  await withTempDir(async home => {
    const requests: string[] = [];
    const f = await fixture(home, [
      { toolCalls: [{ id: "save", name: "write", arguments: { path: "kept.txt", content: "keep this edit" } }] },
      { text: "Saved the old task." },
      request => { requests.push(JSON.stringify(request.items)); return { text: "Fresh answer." }; },
    ]);
    try {
      await f.send("old task secret marker");
      const oldItems = structuredClone(f.session.items);
      const oldId = f.session.header.id;
      const before = f.controller.snapshot();
      const settings = structuredClone(f.config.settings);
      expect(await f.send("/clear")).toBe(true);
      const fresh = f.controller.snapshot();
      expect(fresh.sessionId).not.toBe(oldId);
      expect(fresh.transcript.some(entry => entry.text.includes("old task secret marker"))).toBe(false);
      for (const key of ["provider", "modelId", "thinking", "approvalMode"] as const) {
        expect(fresh[key]).toEqual(before[key]);
      }
      expect(f.config.settings).toEqual(settings);
      expect(await f.store.get(codexSubscriptionIdentity())).toBe("fixture-login");
      expect(await readFile(join(home, "kept.txt"), "utf8")).toBe("keep this edit");
      expect((await loadJsonlSession({ directory: f.directory, id: oldId })).items).toEqual(oldItems);
      await f.send("fresh task marker");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain("fresh task marker");
      expect(requests[0]).not.toContain("old task secret marker");
      expect(requests[0]).not.toContain("Saved the old task.");
      expect(await f.send(`/resume ${oldId}`)).toBe(true);
      expect(f.controller.snapshot().sessionId).toBe(oldId);
      expect(f.controller.snapshot().transcript.some(entry => entry.text.includes("old task secret marker"))).toBe(true);
      expect(await readFile(join(home, "kept.txt"), "utf8")).toBe("keep this edit");
    } finally { f.controller.dispose(); }
  });
});

test("clear during a busy turn keeps the session and unaccepted command", async () => {
  await withTempDir(async home => {
    const f = await fixture(home, [{ text: "Working", waitForAbort: true }]);
    try {
      const turn = f.send("running task");
      for (let i = 0; i < 100 && !f.controller.running; i++) await Bun.sleep(5);
      expect(f.controller.running).toBe(true);
      let accepted = false;
      expect(await f.send("/clear", () => { accepted = true; })).toBe(false);
      expect(accepted).toBe(false);
      expect(f.controller.snapshot().sessionId).toBe(f.session.header.id);
      expect(f.controller.snapshot().transcript.at(-1)?.text).toBe("Wait for this turn · Esc stop");
      f.controller.cancel();
      await turn;
    } finally { f.controller.dispose(); }
  });
});

for (const command of ["/new", "/clear"]) test(`${command} keeps ordinary drafts with their original conversation`, async () => {
  await withTempDir(async home => {
    const f = await fixture(home, []);
    const terminal = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true });
    const view = createConversationView(terminal.renderer, { controller: f.controller, home, workspaceRoot: home,
      env: {}, secrets: [], quit() {}, submit: f.send });
    const editor = terminal.renderer.root.findDescendantById("prompt") as TextareaRenderable;
    try {
      await terminal.mockInput.pasteBracketedText("unsent draft ไทย\nsecond line");
      view.refresh(); await terminal.flush();
      expect(await f.send(command)).toBe(true);
      view.refresh(); await terminal.flush();
      expect(editor.plainText).toBe("");
      expect(await f.send(`/resume ${f.session.header.id}`)).toBe(true);
      view.refresh(); await terminal.flush();
      expect(editor.plainText).toBe("unsent draft ไทย\nsecond line");
    } finally { view.destroy(); f.controller.dispose(); terminal.renderer.destroy(); }
  });
});

test("clear is discoverable as a built-in alias and cannot invoke a skill", () => {
  expect(commandCatalog([]).find(entry => entry.name === "clear")).toMatchObject({
    insertion: "/clear ", description: "Start a new conversation", available: true, group: "built-in",
  });
  expect(helpText()).toContain("/clear - start a new conversation (same as /new)");
  expect(parseSkillInvocation("/clear")).toBeNull();
});
