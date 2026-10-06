import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { BoxRenderable, TextRenderable, TextareaRenderable } from "@opentui/core";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createConversationView } from "../src/tui/view.ts";
import { TuiController } from "../src/tui/controller.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { createJsonlSession, sessionsDirectory } from "../src/session/jsonl.ts";
import { dispatchEditorInput } from "../src/tui/commands.ts";
import { slashPaletteHint } from "../src/tui/palette.ts";
import { openDraftStore } from "../src/drafts/store.ts";
import { createScriptedModel, type ScriptedTurn } from "./helpers/scripted-model.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { withTempDir } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

type Options = { width?: number; height?: number; root?: string; responses?: ScriptedTurn[]; drafts?: boolean };

/** A real renderer whose submissions go through the production dispatcher; builtins only record their names. */
async function setup(options: Options = {}) {
  const terminal = await createTestRenderer({ width: options.width ?? 80, height: options.height ?? 30, kittyKeyboard: true });
  const root = options.root ?? "/project";
  const workspace = { root, launchCwd: root, extraRoots: [] };
  const home = join(root, "home");
  const session = options.drafts ? await createJsonlSession({ directory: sessionsDirectory(home), workspace, deferred: true }) : createSession();
  const sessionId = options.drafts ? (session as Awaited<ReturnType<typeof createJsonlSession>>).header.id : "slash-session";
  const controller = new TuiController({
    session, workspace, home, provider: "scripted", modelId: "test-model", sessionId,
    model: createScriptedModel({ responses: options.responses ?? [{ text: "Done." }] }),
    contextManager: createContextManager(workspace, { home }), secrets: ["secret-sentinel"],
    credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ model: createScriptedModel() }) },
  });
  const submitted: string[] = [], builtins: string[] = [];
  let modelSubmissions = 0;
  const submitTurn = controller.submit.bind(controller);
  controller.submit = (...args: Parameters<typeof controller.submit>) => { modelSubmissions++; return submitTurn(...args); };
  const view = createConversationView(terminal.renderer, {
    controller, workspaceRoot: root, home, env: {}, secrets: ["secret-sentinel"], draftPersistence: options.drafts,
    quit: () => {},
    submit: (value, accepted) => {
      submitted.push(value);
      return dispatchEditorInput(value, controller, async command => { builtins.push(command.name); return true; }, accepted);
    },
  });
  cleanups.push(() => { view.destroy(); controller.dispose(); terminal.renderer.destroy(); });
  await terminal.flush();
  const editor = terminal.renderer.root.findDescendantById("prompt") as TextareaRenderable;
  const picker = terminal.renderer.root.findDescendantById("picker") as BoxRenderable;
  const hints = terminal.renderer.root.findDescendantById("hints") as TextRenderable;
  const selected = () => picker.getChildren().map(row => (row as TextRenderable).plainText).find(row => row.startsWith("› "));
  const settle = async () => { await Bun.sleep(5); view.refresh(); await terminal.flush(); };
  /** Let an asynchronous dispatch (collision check, builtin, notice) finish before observing. */
  const drain = async () => { for (let round = 0; round < 4; round++) { await Bun.sleep(10); await settle(); } };
  const type = async (text: string) => { await terminal.mockInput.typeText(text); await settle(); };
  const enter = async () => { terminal.mockInput.pressEnter(); await drain(); };
  const keypadEnter = async () => { terminal.renderer.stdin.emit("data", Buffer.from("\x1b[57414u")); await drain(); };
  const transcriptText = () => controller.snapshot().transcript.map(entry => JSON.stringify(entry)).join("\n");
  return {
    ...terminal, controller, view, editor, picker, hints, selected, settle, drain, type, enter, keypadEnter, transcriptText, sessionId,
    submitted, builtins, modelSubmissions: () => modelSubmissions,
  };
}

type Ui = Awaited<ReturnType<typeof setup>>;

/** Nothing ran: no dispatch, builtin, model turn, notice or transcript entry. */
function expectNothingRan(ui: Ui, entries: number) {
  expect(ui.submitted).toEqual([]);
  expect(ui.builtins).toEqual([]);
  expect(ui.modelSubmissions()).toBe(0);
  expect(ui.controller.snapshot().transcript).toHaveLength(entries);
  expect(ui.transcriptText()).not.toContain("Unknown command");
  expect(ui.captureCharFrame()).not.toContain("Unknown command");
}

async function startRunningTurn(ui: Ui) {
  await ui.type("start work"); ui.mockInput.pressEnter();
  const deadline = Date.now() + 5000;
  while (!ui.controller.running && Date.now() < deadline) await ui.settle();
  expect(ui.controller.running).toBe(true);
}

for (const [draft, arrows, insertion] of [["/ses", 0, "/sessions "], ["/ses", 1, "/session "], ["/", 0, "/model "], ["/mod", 0, "/model "]] as const) {
  test(`${draft}${arrows ? " + ↓" : ""} + Enter inserts the highlighted ${insertion.trim()} without dispatching`, async () => {
    const ui = await setup();
    const entries = ui.controller.snapshot().transcript.length;
    await ui.type(draft);
    for (let count = 0; count < arrows; count++) { ui.mockInput.pressArrow("down"); await ui.settle(); }
    expect(ui.selected()).toContain(insertion.trim());
    await ui.enter();
    expect(ui.editor.plainText).toBe(insertion);
    expect(ui.editor.cursorOffset).toBe(insertion.length);
    expectNothingRan(ui, entries);
  });
}

test("/session with /session highlighted runs on the first Enter; /ses inserts /sessions and the next Enter dispatches it once", async () => {
  const ui = await setup();
  await ui.type("/session");
  expect(ui.selected()).toMatch(/\/session\s/);
  expect(ui.hints.plainText).toBe("↑↓ select · Enter send · Esc keep editing");
  await ui.enter();
  expect(ui.transcriptText()).toContain("Session: slash-session");
  expect(ui.editor.plainText).toBe("");

  await ui.type("/ses");
  await ui.enter();
  expect(ui.editor.plainText).toBe("/sessions ");
  expect(ui.builtins).toEqual([]);
  // The inserted command closes the list, so this Enter sends it.
  expect(ui.picker.visible).toBe(false);
  expect(ui.captureCharFrame()).not.toContain("No matches");
  expect(ui.hints.plainText).toContain("Enter send");
  expect(ui.hints.plainText).not.toContain("Enter insert");
  await ui.enter();
  expect(ui.submitted).toEqual(["/sessions "]);
  expect(ui.builtins).toEqual(["sessions"]);
  expect(ui.modelSubmissions()).toBe(0);
  expect(ui.transcriptText()).not.toContain("Unknown command");
});

test("a complete command closes the list whether Enter or Tab inserted it; argument lists and unknown names keep theirs", async () => {
  const ui = await setup();
  await ui.type("/ses");
  ui.mockInput.pressTab(); await ui.settle();
  expect(ui.editor.plainText).toBe("/sessions ");
  expect(ui.picker.visible).toBe(false);
  expect(ui.captureCharFrame()).not.toContain("No matches");
  // A command with an argument list still offers it after insertion.
  ui.editor.setText(""); await ui.type("/the");
  await ui.enter();
  expect(ui.editor.plainText).toBe("/theme ");
  expect(ui.picker.visible).toBe(true);
  expect(ui.selected()).toContain("/theme auto");
  // An unknown name keeps its no-match row.
  ui.editor.setText(""); await ui.type("/zzqx ");
  expect(ui.picker.visible).toBe(true);
  expect(ui.captureCharFrame()).toContain("No matches · Esc keep editing");
});

test("a typed command that collides keeps its collision notice instead of inserting another command", async () => withTempDir(async root => {
  await mkdir(join(root, ".agents/skills/session"), { recursive: true });
  await Bun.write(join(root, ".agents/skills/session/SKILL.md"), "---\nname: session\ndescription: Conflicting skill\n---\nTask");
  const ui = await setup({ root });
  await ui.controller.refreshCommands();
  await ui.type("/session");
  expect(ui.selected()).not.toMatch(/\/session\s/);
  expect(ui.hints.plainText).not.toContain("Enter insert");
  await ui.enter();
  expect(ui.editor.plainText).toBe("/session");
  expect(ui.transcriptText()).toContain("Command conflicts with skill");
  expect(ui.builtins).toEqual([]);
  // Dispatch lowercases names, so a case variant collides the same way instead of inserting another command.
  ui.editor.setText(""); await ui.settle();
  await ui.type("/Session");
  await ui.enter();
  expect(ui.editor.plainText).toBe("/Session");
  expect(ui.builtins).toEqual([]);
  ui.editor.setText(""); await ui.settle();
  await ui.type("/session");
  // An explicit arrow choice still wins over the typed name.
  ui.mockInput.pressArrow("down"); await ui.settle();
  const chosen = ui.selected()!.match(/\/(\S+)/)![1]!;
  expect(ui.hints.plainText).toContain("Enter insert");
  await ui.enter();
  expect(ui.editor.plainText).toBe(`/${chosen} `);
  expect(ui.builtins).toEqual([]);
}));

test("an explicit arrow choice wins: /session + ↓ to /sessions inserts it and does not run /session", async () => {
  const ui = await setup();
  const entries = ui.controller.snapshot().transcript.length;
  await ui.type("/session");
  ui.mockInput.pressArrow("down"); await ui.settle();
  expect(ui.selected()).toContain("/sessions");
  expect(ui.hints.plainText).toBe("↑↓ select · Enter insert · Tab complete · Esc keep editing");
  await ui.enter();
  expect(ui.editor.plainText).toBe("/sessions ");
  expect(ui.transcriptText()).not.toContain("Session: slash-session");
  expectNothingRan(ui, entries);
});

test("argument lists insert the highlighted form; an exact or dismissed draft sends unchanged", async () => {
  const ui = await setup();
  await ui.type("/the");
  // Enter inserts the command, which opens its argument list; the next Enter inserts the highlighted argument.
  await ui.enter();
  expect(ui.editor.plainText).toBe("/theme ");
  expect(ui.selected()).toContain("/theme auto");
  await ui.enter();
  expect(ui.editor.plainText).toBe("/theme auto");
  expect(ui.submitted).toEqual([]);
  // The highlight now matches, so Enter sends and the accepted command clears the composer.
  expect(ui.hints.plainText).toBe("↑↓ select · Enter send · Esc keep editing");
  await ui.enter();
  expect(ui.editor.plainText).toBe("");

  // Esc hides the list, so Enter sends the typed text unchanged instead of inserting.
  await ui.type("/theme ");
  expect(ui.editor.plainText).toBe("/theme ");
  ui.mockInput.pressEscape(); await ui.settle();
  expect(ui.picker.visible).toBe(false);
  ui.mockInput.pressEnter(); await ui.settle();
  expect(ui.editor.plainText).not.toBe("/theme auto");
  await ui.drain();
  expect(ui.editor.plainText).toBe("");

  // The bare command typed exactly matches its highlight and sends without inserting.
  await ui.type("/theme");
  expect(ui.selected()).toMatch(/\/theme\s/);
  ui.mockInput.pressEnter(); await ui.settle();
  expect(ui.editor.plainText).not.toBe("/theme ");
  await ui.drain();
  expect(ui.editor.plainText).toBe("");
  expect(ui.transcriptText()).not.toContain("Unknown command");
});

test("keypad Enter inserts and sends exactly as Return does", async () => {
  const ui = await setup();
  const entries = ui.controller.snapshot().transcript.length;
  await ui.type("/ses");
  await ui.keypadEnter();
  expect(ui.editor.plainText).toBe("/sessions ");
  expectNothingRan(ui, entries);
  await ui.keypadEnter();
  expect(ui.submitted).toEqual(["/sessions "]);
  expect(ui.builtins).toEqual(["sessions"]);
});

test("during a running turn Enter inserts without starting work; the match case keeps the busy notice and text", async () => {
  const ui = await setup({ responses: [{ text: "Working", waitForAbort: true }] });
  await startRunningTurn(ui);
  const turns = ui.modelSubmissions(), sent = ui.submitted.length;
  await ui.type("/ses");
  expect(ui.hints.plainText).toBe("↑↓ select · Enter insert · Tab complete · Esc keep editing");
  await ui.enter();
  expect(ui.editor.plainText).toBe("/sessions ");
  expect(ui.submitted).toHaveLength(sent);
  expect(ui.modelSubmissions()).toBe(turns);
  expect(ui.builtins).toEqual([]);

  ui.editor.setText(""); await ui.settle();
  await ui.type("/session");
  expect(ui.hints.plainText).toBe("↑↓ select · Esc keep editing");
  await ui.enter();
  expect(ui.transcriptText()).toContain("Wait for this turn · Esc stop");
  expect(ui.editor.plainText).toBe("/session");
  expect(ui.modelSubmissions()).toBe(turns);
  expect(ui.controller.running).toBe(true);
  ui.controller.cancel();
});

test("after discovery removes the highlighted choice, Enter sends and the hint stops offering insert", async () => withTempDir(async root => {
  for (const name of ["deploy-alpha", "deploy-beta"]) {
    await mkdir(join(root, `.agents/skills/${name}`), { recursive: true });
    await Bun.write(join(root, `.agents/skills/${name}/SKILL.md`), `---\nname: ${name}\ndescription: Deploy ${name}\n---\nTask`);
  }
  const ui = await setup({ root });
  await ui.controller.refreshCommands();
  await ui.type("/deploy");
  expect(ui.selected()).toContain("/deploy-alpha");
  expect(ui.hints.plainText).toContain("Enter insert");
  await rm(join(root, ".agents/skills/deploy-alpha"), { recursive: true });
  await ui.controller.refreshCommands(); await ui.settle();
  expect(ui.selected()).toBeUndefined();
  expect(ui.hints.plainText).toBe("↑↓ select · Enter send · Esc keep editing");
  await ui.enter();
  expect(ui.submitted).toEqual(["/deploy"]);
  expect(ui.editor.plainText).toBe("/deploy");
}));

test("an Enter insertion is an ordinary draft edit that never clears the saved draft", async () => withTempDir(async root => {
  const ui = await setup({ root, drafts: true });
  const store = () => openDraftStore({ home: join(root, "home"), workspaceRoot: root, sessionId: ui.sessionId }).checkpoint?.text;
  await ui.type("unsent ordinary task");
  expect(ui.view.flushDraft()).toEqual({ saved: true, failed: false });
  // Replacing the text directly keeps the ordinary checkpoint; an empty composer would clear it.
  ui.editor.setText("/ses"); await ui.settle();
  await ui.enter();
  expect(ui.editor.plainText).toBe("/sessions ");
  // Slash text is never persisted, so the earlier checkpoint stays and is not cleared by the insertion.
  ui.view.flushDraft();
  expect(store()).toBe("unsent ordinary task");
  // Further typing extends the inserted text, which stays the composer draft.
  await ui.type("x");
  expect(ui.editor.plainText).toBe("/sessions x");
  expect(ui.submitted).toEqual([]);
}));

for (const width of [120, 80, 50, 40]) test(`[${width} columns] the hint names what Enter does now and keeps Esc keep editing`, async () => {
  const ui = await setup({ width, height: 30 });
  const narrow = width <= 50;
  await ui.type("/ses");
  expect(ui.hints.plainText).toBe(width === 40 ? "Enter insert · Esc keep editing" : narrow ? "Enter insert · Tab complete · Esc keep editing" : "↑↓ select · Enter insert · Tab complete · Esc keep editing");
  ui.editor.setText(""); await ui.type("/session");
  expect(ui.hints.plainText).toBe(width === 40 ? "Enter send · Esc keep editing" : "↑↓ select · Enter send · Esc keep editing");
});

for (const width of [120, 80, 50, 40]) test(`[${width} columns] while working the hint keeps Enter insert when it applies and always keeps Esc`, async () => {
  const ui = await setup({ width, height: 30, responses: [{ text: "Working", waitForAbort: true }] });
  await startRunningTurn(ui);
  const narrow = width <= 50;
  await ui.type("/ses");
  expect(ui.hints.plainText).toBe(width === 40 ? "Enter insert · Esc keep editing" : narrow ? "Enter insert · Tab complete · Esc keep editing" : "↑↓ select · Enter insert · Tab complete · Esc keep editing");
  ui.editor.setText(""); await ui.type("/session");
  expect(ui.hints.plainText).toBe("↑↓ select · Esc keep editing");
  ui.controller.cancel();
});

test("slash palette hint drops arrows first, then Tab, and keeps Enter and Esc", () => {
  expect(slashPaletteHint({ enter: "insert", working: false }, 200)).toBe("↑↓ select · Enter insert · Tab complete · Esc keep editing");
  expect(slashPaletteHint({ enter: "insert", working: true }, 200)).toBe("↑↓ select · Enter insert · Tab complete · Esc keep editing");
  expect(slashPaletteHint({ enter: "send", working: false }, 200)).toBe("↑↓ select · Enter send · Esc keep editing");
  expect(slashPaletteHint({ enter: "send", working: true }, 200)).toBe("↑↓ select · Esc keep editing");
  expect(slashPaletteHint({ enter: "insert", working: false }, 48)).toBe("Enter insert · Tab complete · Esc keep editing");
  expect(slashPaletteHint({ enter: "insert", working: false }, 38)).toBe("Enter insert · Esc keep editing");
  expect(slashPaletteHint({ enter: "send", working: false }, 38)).toBe("Enter send · Esc keep editing");
});
