import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { TextareaRenderable } from "@opentui/core";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createJsonlSession, sessionsDirectory } from "../src/session/jsonl.ts";
import { openDraftStore } from "../src/drafts/store.ts";
import { loadExtensions } from "../src/extensions/loader.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { resolveWorkspace } from "../src/workspace/workspace.ts";
import { createContextManager } from "../src/context/manager.ts";
import { loadConfigEditor } from "../src/config/editing.ts";
import type { Model } from "../src/model/model.ts";
import { TuiController } from "../src/tui/controller.ts";
import { createConversationView } from "../src/tui/view.ts";
import { dispatchEditorInput } from "../src/tui/commands.ts";
import { handleSlashCommand } from "../src/tui/app.ts";
import { withTempDir } from "./helpers.ts";

type Outcome = { text: string } | { error: string; status: number };

/** A model whose every turn waits for the test to choose its outcome, so "running" lasts exactly as long as needed. */
function gatedModel() {
  const pending: Array<(outcome: Outcome) => void> = [];
  const prompts: string[] = [];
  const model: Model = {
    provider: "scripted",
    id: "gated",
    async *stream(request) {
      const users = request.items.filter(item => item.type === "user");
      prompts.push(users.at(-1)!.content.map(block => block.type === "text" ? block.text : "").join(""));
      const outcome = await new Promise<Outcome>((resolve, reject) => {
        pending.push(resolve);
        request.signal?.addEventListener("abort", () => {
          pending.splice(pending.indexOf(resolve), 1);
          reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
        }, { once: true });
      });
      if ("error" in outcome) throw Object.assign(new Error(outcome.error), { status: outcome.status });
      yield { type: "text_delta", text: outcome.text };
      yield { type: "message_complete", message: { type: "assistant", id: `assistant-${prompts.length}`, content: [{ type: "text", text: outcome.text }] } };
    },
  };
  return { model, prompts, waiting: () => pending.length, release: (outcome: Outcome) => pending.shift()!(outcome) };
}

async function setup(root: string, size = { width: 80, height: 24 }) {
  const home = await realpath(root);
  await Bun.write(join(home, "commands.ts"), "export let ran = 0; export default ctx => { ctx.registerCommand({ name: 'ship', description: 'Ship the change', execute() { ran++; } }); };");
  const modulePath = await realpath(join(home, "commands.ts"));
  const workspace = await resolveWorkspace(home)
  const loaded = await loadExtensions({ modules: [modulePath], workspace, tools: createToolRegistry(), home });
  const extension = await import(pathToFileURL(modulePath).href) as { ran: number };
  const session = await createJsonlSession({ directory: sessionsDirectory(home), workspace, deferred: true });
  const gate = gatedModel();
  const controller = new TuiController({ ...loaded, extensions: loaded.runtime, home, session, workspace, sessionId: session.header.id, provider: "scripted", modelId: "gated", model: gate.model, contextManager: createContextManager(workspace, { home }) });
  await controller.refreshCommands();
  const terminal = await createTestRenderer({ ...size, kittyKeyboard: true, exitOnCtrlC: false, exitSignals: [] });
  const config = await loadConfigEditor({ home, workspaceRoot: home });
  const ctx = { controller, home, workspaceRoot: home, skillScope: { workspaceRoot: home }, sessionsDir: sessionsDirectory(home), settings: () => config.settings, env: {}, secrets: [], finishQuit() {}, stderr: { write() {} } };
  let submission: Promise<unknown> = Promise.resolve();
  let accepted = 0;
  const view = createConversationView(terminal.renderer, { controller, home, workspaceRoot: home, env: {}, secrets: [], draftPersistence: true, quit() {},
    submit: (value, onAccepted) => submission = dispatchEditorInput(value, controller, command => handleSlashCommand(command.name, command.args, ctx), () => { accepted++; onAccepted(); }) });
  const editor = terminal.renderer.root.findDescendantById("prompt") as TextareaRenderable;
  const userTurns = () => session.items.filter(item => item.type === "user").length;
  const frame = async () => { view.refresh(); await terminal.renderOnce(); return terminal.captureCharFrame(); };
  const hintRow = async () => (await frame()).split("\n")[terminal.renderer.height - 1]!.trim();
  // An accepted prompt's dispatch settles with its turn; a rejected one settles at once. Either way, let the press land.
  const enter = async () => { terminal.mockInput.pressEnter(); await Promise.race([submission, Bun.sleep(20)]); };
  const until = async (ready: () => boolean) => { for (let i = 0; i < 200 && !ready(); i++) await Bun.sleep(5); expect(ready()).toBe(true); };
  const saved = () => openDraftStore({ home, workspaceRoot: home, sessionId: session.header.id }).checkpoint?.text;
  const close = () => { view.destroy(); controller.dispose(); terminal.renderer.destroy(); };
  return { ...terminal, ...gate, controller, session, view, editor, extension, userTurns, frame, hintRow, enter, until, saved, close, accepted: () => accepted };
}
type Ui = Awaited<ReturnType<typeof setup>>;

const thai = "ร่างงานถัดไป 🧪\nแล้วสรุปเป็นภาษาไทย";

/** Start one gated turn through the real composer and dispatcher. */
async function startTurn(ui: Ui, prompt = "first task") {
  await ui.mockInput.typeText(prompt);
  await ui.enter();
  await ui.until(() => ui.waiting() === 1);
  expect(ui.controller.running).toBe(true);
  expect(ui.editor.plainText).toBe("");
}

/** Type the multiline Thai draft during work, then press Enter and prove nothing was sent or queued. */
async function rejectDraft(ui: Ui) {
  await ui.mockInput.pasteBracketedText(thai);
  const end = ui.editor.cursorOffset;
  ui.mockInput.pressArrow("left"); ui.mockInput.pressArrow("left");
  const cursor = ui.editor.cursorOffset;
  expect(cursor).toBe(end - 2);
  expect(await ui.hintRow()).toStartWith("Wait, then Enter sends · Esc stop");
  const acceptedBefore = ui.accepted();
  await ui.enter();
  expect(ui.controller.snapshot().transcript.at(-1)?.text).toBe("Still working · Wait, then Enter sends");
  expect(ui.editor.plainText).toBe(thai);
  expect(ui.editor.cursorOffset).toBe(cursor);
  expect(ui.accepted()).toBe(acceptedBefore);
  expect(ui.userTurns()).toBe(1);
  expect(ui.prompts).toEqual(["first task"]);
  expect(ui.controller.running).toBe(true);
  return cursor;
}

/** After the turn settles, the draft is still unsent and only another explicit Enter starts a turn. */
async function expectUnsentUntilEnter(ui: Ui, cursor: number, draft = thai) {
  await ui.controller.waitForIdle();
  expect(ui.controller.running).toBe(false);
  await Bun.sleep(600); await ui.frame();
  expect(ui.editor.plainText).toBe(draft);
  expect(ui.editor.cursorOffset).toBe(cursor);
  expect(ui.saved()).toBe(draft);
  expect(ui.userTurns()).toBe(1);
  expect(ui.prompts).toEqual(["first task"]);
  await ui.enter();
  await ui.until(() => ui.waiting() === 1);
  expect(ui.prompts).toEqual(["first task", draft]);
  expect(ui.userTurns()).toBe(2);
  expect(ui.editor.plainText).toBe("");
  ui.release({ text: "second answer" });
  await ui.controller.waitForIdle();
}

test("running composer offers an unsent draft placeholder and guidance at wide, 50-column and narrow widths", async () => withTempDir(async home => {
  const ui = await setup(home, { width: 120, height: 24 });
  try {
    expect(ui.editor.placeholder).toBe("Ask Schway…");
    await startTurn(ui);
    expect(await ui.frame()).toContain("Draft your next task…");
    expect(ui.editor.placeholder).toBe("Draft your next task…");
    expect(await ui.hintRow()).toStartWith("Wait, then Enter sends · Esc stop · Shift+Tab change mode");
    ui.resize(50, 24);
    expect(await ui.frame()).toContain("Draft your next task…");
    expect(await ui.hintRow()).toStartWith("Wait, then Enter sends · Esc stop");
    ui.resize(30, 20);
    expect(await ui.hintRow()).toStartWith("Working · Esc stop");
    ui.resize(24, 20); await ui.frame();
    expect(ui.editor.placeholder).toBe("Draft next task…");
    await ui.mockInput.pasteBracketedText(thai);
    ui.resize(80, 24);
    const frame = await ui.frame();
    expect(frame).not.toContain("Draft your next task…");
    expect(await ui.hintRow()).toStartWith("Wait, then Enter sends · Esc stop");
    expect(frame).toContain("Esc stop");
    ui.release({ text: "done" });
    await ui.controller.waitForIdle(); await ui.frame();
    expect(ui.editor.placeholder).toBe("Ask Schway…");
    expect(await ui.hintRow()).toContain("Enter send");
    expect(await ui.hintRow()).not.toContain("Wait, then");
  } finally { ui.close(); }
}));

test("Enter during work keeps a multiline Thai draft unsent through completion until another explicit Enter", async () => withTempDir(async home => {
  const ui = await setup(home);
  try {
    await startTurn(ui);
    const cursor = await rejectDraft(ui);
    ui.release({ text: "first answer" });
    await ui.controller.waitForIdle();
    expect(await ui.hintRow()).toStartWith("Shift+Tab change mode · Enter send");
    await expectUnsentUntilEnter(ui, cursor);
  } finally { ui.close(); }
}));

test("cancellation keeps the rejected draft unsent and editable", async () => withTempDir(async home => {
  const ui = await setup(home);
  try {
    await startTurn(ui);
    const cursor = await rejectDraft(ui);
    ui.mockInput.pressEscape();
    await ui.controller.waitForIdle();
    expect(ui.controller.snapshot().outcome?.reason).toBe("cancelled");
    expect(await ui.hintRow()).toContain("Enter send");
    await expectUnsentUntilEnter(ui, cursor);
  } finally { ui.close(); }
}));

test("a failed turn offers its recovery action instead of promising Enter sends", async () => withTempDir(async home => {
  const ui = await setup(home);
  try {
    await startTurn(ui);
    const cursor = await rejectDraft(ui);
    ui.release({ error: "Fixture provider failure", status: 400 });
    await ui.controller.waitForIdle();
    const snapshot = ui.controller.snapshot();
    expect(snapshot.status).toBe("error");
    expect(snapshot.recovery?.actions).toContain("continue");
    const hint = await ui.hintRow();
    expect(hint).toStartWith("Ctrl+R continue");
    expect(hint).not.toContain("Enter send");
    await expectUnsentUntilEnter(ui, cursor);
  } finally { ui.close(); }
}));

test("a recovery-required failure leads with its repair action and still never sends the draft automatically", async () => withTempDir(async home => {
  const ui = await setup(home);
  try {
    await startTurn(ui);
    const cursor = await rejectDraft(ui);
    ui.release({ error: "Invalid API key", status: 401 });
    await ui.controller.waitForIdle();
    const snapshot = ui.controller.snapshot();
    expect(snapshot.recovery?.category).toBe("auth");
    expect(snapshot.recovery?.actions).toContain("connect");
    const hint = await ui.hintRow();
    expect(hint).toStartWith("Alt+L connect");
    expect(hint).not.toContain("Enter send");
    await expectUnsentUntilEnter(ui, cursor);
  } finally { ui.close(); }
}));

test("rejected slash and extension commands keep their own messages and never run after the turn settles", async () => withTempDir(async home => {
  const ui = await setup(home);
  try {
    await startTurn(ui);
    for (const [input, notice] of [
      ["/ship now", "Command not run · Esc stop · /ship retry"],
      ["/model other", "Wait for this turn · Esc stop"],
      ["/theme dark", "Wait for this turn · Esc stop"],
    ] as const) {
      ui.editor.setText(""); ui.view.refresh();
      await ui.mockInput.typeText(input);
      ui.mockInput.pressEscape();
      // Escape first dismisses the palette; the turn keeps running.
      expect(ui.controller.running).toBe(true);
      await ui.enter();
      expect(ui.controller.snapshot().transcript.at(-1)?.text).toBe(notice);
      expect(ui.editor.plainText).toBe(input);
    }
    expect(ui.extension.ran).toBe(0);
    expect(ui.controller.snapshot().modelId).toBe("gated");
    ui.editor.setText("/ship now"); ui.view.refresh();
    await ui.mockInput.typeText(""); ui.mockInput.pressEscape();
    ui.release({ text: "first answer" });
    await ui.controller.waitForIdle();
    await Bun.sleep(50); await ui.frame();
    expect(ui.extension.ran).toBe(0);
    expect(ui.editor.plainText).toBe("/ship now");
    expect(ui.userTurns()).toBe(1);
    await ui.enter();
    expect(ui.extension.ran).toBe(1);
    expect(ui.prompts).toEqual(["first task"]);
  } finally { ui.close(); }
}));

test("completion racing with editing keeps the newest text and sends only it on a later Enter", async () => withTempDir(async home => {
  const ui = await setup(home);
  try {
    await startTurn(ui);
    await ui.mockInput.typeText("old draft");
    await ui.enter();
    expect(ui.controller.snapshot().transcript.at(-1)?.text).toBe("Still working · Wait, then Enter sends");
    const typing = ui.mockInput.typeText(" แก้ไขใหม่");
    ui.release({ text: "first answer" });
    await Promise.all([typing, ui.controller.waitForIdle()]);
    expect(ui.editor.plainText).toBe("old draft แก้ไขใหม่");
    await expectUnsentUntilEnter(ui, ui.editor.cursorOffset, "old draft แก้ไขใหม่");
  } finally { ui.close(); }
}));

test("closing a panel or resizing during and after work never submits the retained draft", async () => withTempDir(async home => {
  const ui = await setup(home);
  try {
    await startTurn(ui);
    const cursor = await rejectDraft(ui);
    ui.mockInput.pressKey("f", { ctrl: true }); await ui.frame();
    await ui.mockInput.typeText("first");
    ui.mockInput.pressEscape(); await ui.frame();
    expect(ui.editor.plainText).toBe(thai);
    expect(ui.editor.cursorOffset).toBe(cursor);
    ui.resize(50, 20); await ui.frame();
    expect(await ui.hintRow()).toStartWith("Wait, then Enter sends · Esc stop");
    ui.release({ text: "first answer" });
    await ui.controller.waitForIdle();
    ui.resize(120, 30); await ui.frame();
    ui.mockInput.pressKey("f", { ctrl: true }); await ui.frame();
    ui.mockInput.pressEscape(); await ui.frame();
    expect(ui.prompts).toEqual(["first task"]);
    await expectUnsentUntilEnter(ui, cursor);
  } finally { ui.close(); }
}));
