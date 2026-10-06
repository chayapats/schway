import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { BoxRenderable, TextRenderable, type ScrollBoxRenderable, type TextareaRenderable } from "@opentui/core";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createConversationView } from "../src/tui/view.ts";
import { TuiController } from "../src/tui/controller.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { createJsonlSession, sessionsDirectory } from "../src/session/jsonl.ts";
import { dispatchEditorInput } from "../src/tui/commands.ts";
import { commandCatalog, paletteChoices, type KeyboardGuideChoice, type PaletteChoice } from "../src/tui/command-catalog.ts";
import {
  PALETTE_APPROVAL, PALETTE_NO_MATCHES, PALETTE_PLACEHOLDER, PALETTE_RUNNING, guidanceLines, keyboardGuideAvailability, keyboardRowParts,
  nextPaletteSelection, paletteDetail, paletteHint, paletteSections, type PaletteReturnContext,
} from "../src/tui/palette.ts";
import { loadExtensions } from "../src/extensions/loader.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { editTool } from "../src/tools/edit.ts";
import { ConfigEditor } from "../src/config/editing.ts";
import { openDraftStore } from "../src/drafts/store.ts";
import { createScriptedModel, type ScriptedTurn } from "./helpers/scripted-model.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { withTempDir } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const idle: PaletteReturnContext = { running: false, toolApproval: false, inspectable: true, details: true };
const thaiDraft = "ร่างภาษาไทย 🧪\nบรรทัดที่สอง";

type Options = { width?: number; height?: number; env?: Record<string, string>; root?: string; modules?: string[]; responses?: ScriptedTurn[]; drafts?: boolean; ask?: boolean };

/** A real renderer whose only dispatch path is counted; builtins record their names instead of acting. */
async function setup(options: Options = {}) {
  const terminal = await createTestRenderer({ width: options.width ?? 80, height: options.height ?? 28, kittyKeyboard: true });
  const root = options.root ?? "/project";
  const workspace = { root, launchCwd: root, extraRoots: [] };
  const home = join(root, "home");
  const loaded = options.modules ? await loadExtensions({ modules: options.modules, workspace, home, tools: createToolRegistry() }) : undefined;
  const session = options.drafts ? await createJsonlSession({ directory: sessionsDirectory(home), workspace, deferred: true }) : createSession();
  const sessionId = options.drafts ? (session as Awaited<ReturnType<typeof createJsonlSession>>).header.id : "palette-session";
  const controller = new TuiController({
    session, workspace, home, provider: "scripted", modelId: "test-model", sessionId,
    model: createScriptedModel({ responses: options.responses ?? [{ text: "Done.\n\n```ts\nconst answer = 42;\n```" }] }),
    contextManager: createContextManager(workspace, { home }), secrets: ["secret-sentinel"], extensions: loaded?.runtime,
    ...options.ask ? { tools: createToolRegistry([editTool]), configEditor: new ConfigEditor({ cli: { approval: { mode: "ask" } } }, { user: join(root, "user-config"), project: join(root, "project-config") }) } : {},
    credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ model: createScriptedModel() }) },
  });
  const submitted: string[] = [], builtins: string[] = [];
  let modelSubmissions = 0;
  const submitTurn = controller.submit.bind(controller);
  controller.submit = (...args: Parameters<typeof controller.submit>) => { modelSubmissions++; return submitTurn(...args); };
  const view = createConversationView(terminal.renderer, {
    controller, workspaceRoot: root, home, env: options.env ?? {}, secrets: ["secret-sentinel"], draftPersistence: options.drafts,
    quit: () => {},
    submit: (value, accepted) => {
      submitted.push(value);
      return dispatchEditorInput(value, controller, async command => { builtins.push(command.name); return command.name === "help" ? controller.openCommandHelp() : true; }, accepted);
    },
  });
  cleanups.push(() => { view.destroy(); controller.dispose(); terminal.renderer.destroy(); });
  await terminal.flush();
  const editor = terminal.renderer.root.findDescendantById("prompt") as TextareaRenderable;
  const transcript = terminal.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable;
  const picker = terminal.renderer.root.findDescendantById("picker") as BoxRenderable;
  const hints = terminal.renderer.root.findDescendantById("hints") as TextRenderable;
  const rows = () => picker.getChildren().map(row => (row as TextRenderable).plainText);
  const selected = () => rows().find(row => row.startsWith("› "));
  const settle = async () => { await Bun.sleep(5); view.refresh(); await terminal.flush(); };
  return { ...terminal, sessionId, controller, view, session, editor, transcript, picker, hints, rows, selected, settle, submitted, builtins, modelSubmissions: () => modelSubmissions };
}

type Ui = Awaited<ReturnType<typeof setup>>;

async function openPalette(ui: Ui, query = "") {
  ui.mockInput.pressKey("h", { meta: true }); await ui.settle();
  expect(ui.controller.commandHelpOpen).toBe(true);
  if (query) { await ui.mockInput.typeText(query); await ui.settle(); }
}

async function clearQuery(ui: Ui) {
  while (ui.editor.plainText) ui.mockInput.pressBackspace();
  await ui.settle();
}

/** Seed a Thai multiline draft, a mid-text cursor and a scrolled-up transcript. */
async function seedDraft(ui: Ui) {
  for (let index = 0; index < 30; index++) ui.controller.notice(`Earlier note ${index}`);
  await ui.settle();
  await ui.mockInput.pasteBracketedText(thaiDraft); ui.editor.cursorOffset = 5; await ui.settle();
  ui.transcript.scrollTo(3); await ui.settle();
  return { scroll: ui.transcript.scrollTop, entries: ui.controller.snapshot().transcript.length };
}

async function expectRestored(ui: Ui, before: { scroll: number; entries: number }) {
  expect(ui.controller.commandHelpOpen).toBe(false);
  expect(ui.editor.plainText).toBe(thaiDraft);
  expect(ui.editor.cursorOffset).toBe(5);
  expect(ui.transcript.scrollTop).toBe(before.scroll);
  expect(ui.controller.snapshot().transcript).toHaveLength(before.entries);
}

test("availability reflects the composer the palette returns to, with approval owning input first", () => {
  const ready = keyboardGuideAvailability(idle);
  expect(Object.values(ready).filter(state => !state.available)).toHaveLength(1);
  expect(ready.cancel).toEqual({ available: false, reason: "Nothing running · Enter send a task" });
  const running = keyboardGuideAvailability({ ...idle, running: true });
  expect(running.review).toEqual({ available: false, reason: "Wait for this turn · Esc stop" });
  expect(running.details).toEqual({ available: false, reason: "Wait for this turn · Esc stop" });
  expect(running.cancel).toEqual({ available: true });
  expect(running.newline).toEqual({ available: true });
  // Enter cannot send during work, so the running reason never promises it.
  expect(keyboardGuideAvailability({ ...idle, running: true, inspectable: false })["inspect-copy"]).toEqual({ available: false, reason: "Nothing to inspect yet · Esc stop" });
  expect(keyboardGuideAvailability({ ...idle, inspectable: false })["inspect-copy"]).toEqual({ available: false, reason: "Nothing to inspect · Enter send a task" });
  expect(keyboardGuideAvailability({ ...idle, details: false }).details).toEqual({ available: false, reason: "No details to show · Esc back" });
  const approval = keyboardGuideAvailability({ ...idle, running: true, toolApproval: true });
  for (const id of ["newline", "inspect-copy", "copy-selection", "approval-mode", "shortcuts", "details", "review"] as const) {
    expect(approval[id]).toEqual({ available: false, reason: "Approval waiting · Esc back to request" });
  }
  expect(approval.cancel).toEqual({ available: true });
});

test("hints say insert for commands, never run, and keep layer actions at narrow widths", () => {
  const rows = paletteChoices(commandCatalog([]), keyboardGuideAvailability(idle));
  const command = rows.find(row => row.kind === "command")!, keyboard = rows.find(row => row.kind === "keyboard")!;
  const hints = [
    paletteHint({ guide: false, inserted: false, selected: command }, 120), paletteHint({ guide: false, inserted: false, selected: command }, 48),
    paletteHint({ guide: false, inserted: true }, 48), paletteHint({ guide: false, inserted: false, selected: keyboard }, 48),
    paletteHint({ guide: true, inserted: false, selected: keyboard }, 48), paletteHint({ guide: false, inserted: false }, 48),
  ];
  expect(hints).toEqual([
    "↑↓ select · Tab preview · Enter insert · Esc restore", "Tab preview · Enter insert · Esc restore",
    "Enter insert · Tab complete · Esc restore", "↑↓ select · Enter show keys · Esc restore", "Esc back", "Esc restore",
  ]);
  for (const hint of hints) { expect(hint).not.toMatch(/\brun\b/i); expect(Bun.stringWidth(hint)).toBeLessThanOrEqual(52); }
});

test("rows keep selection, type, reason and destructive meaning in plain text at 50 columns", () => {
  const availability = keyboardGuideAvailability({ ...idle, running: true });
  const rows = paletteChoices(commandCatalog([]), availability);
  const review = rows.find((row): row is KeyboardGuideChoice => row.id === "keyboard:review")!;
  const parts = keyboardRowParts(review, true, 21, 48);
  const text = parts.lead + parts.label + parts.detail;
  expect(text.startsWith("› ! Alt+R")).toBe(true);
  expect(text).toContain("Review changes");
  expect(Bun.stringWidth(text)).toBeLessThanOrEqual(48);
  expect(paletteDetail(review)).toEqual({ text: "! Wait for this turn · Esc stop", warning: true });
  expect(paletteDetail(rows.find(row => row.id === "keyboard:newline"))).toEqual({ text: "Shift+Enter or Ctrl+J · Continue your draft on another line", warning: false });
  expect(paletteDetail(rows[0])).toBeUndefined();
  const lines = guidanceLines(review);
  expect(lines.map(line => line.text)).toEqual(["Review changes · Alt+R", review.description, review.guidance, "! Wait for this turn · Esc stop"]);
  const sections = paletteSections(rows, true).flatMap(section => "header" in section ? [section.header] : []);
  expect(sections).toEqual(["Keyboard", "Destructive"]);
  expect(paletteSections(rows, false).every(section => !("header" in section))).toBe(true);
  // Keyboard rows stay selectable even when unavailable; unavailable commands never do.
  const mixed: PaletteChoice[] = [{ ...rows[0]!, available: false } as PaletteChoice, review, rows[1]!];
  expect(nextPaletteSelection(mixed, -1, 1)).toBe(1);
  expect(nextPaletteSelection(mixed, 1, 1)).toBe(2);
  expect(nextPaletteSelection(mixed, 2, 1)).toBe(1);
  expect(nextPaletteSelection([mixed[0]!], -1, 1)).toBe(-1);
});

test("the four audit searches and curated intents open guidance without dispatch, then Esc layers restore the Thai draft", async () => {
  const fetched: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (...args: unknown[]) => { fetched.push(args); throw new Error("network blocked"); }, realFetch);
  cleanups.push(() => { globalThis.fetch = realFetch; });
  const ui = await setup();
  const before = await seedDraft(ui);
  for (const [query, label, key] of [
    ["newline", "Insert a newline", "Shift+Enter or Ctrl+J"], ["copy", "Copy code or a result", "Alt+I, then C"],
    ["approval", "Change approval mode", "Shift+Tab"], ["shortcuts", "Find keyboard shortcuts", "Alt+H"],
    ["line break", "Insert a newline", "Shift+Enter or Ctrl+J"], ["mode", "Change approval mode", "Shift+Tab"],
    ["details", "Inspect details", "F2 or Ctrl+I"], ["review", "Review changes", "Alt+R"],
  ] as const) {
    await openPalette(ui, query);
    expect(ui.editor.placeholder).toBe(PALETTE_PLACEHOLDER);
    expect(ui.selected()).toContain(key);
    expect(ui.selected()).toContain(label);
    expect(ui.hints.plainText).toBe("↑↓ select · Enter show keys · Esc restore");
    ui.mockInput.pressTab(); await ui.settle();
    expect(ui.editor.plainText).toBe(query);
    ui.mockInput.pressEnter(); await ui.settle();
    const frame = ui.captureCharFrame();
    expect(frame).toContain(`${label} · ${key}`);
    expect(ui.hints.plainText).toBe("Esc back");
    expect(ui.editor.plainText).toBe(query);
    // Guidance is read-only: action keys, Enter and typing never act or edit.
    ui.mockInput.pressEnter(); ui.mockInput.pressTab({ shift: true }); await ui.mockInput.typeText("x"); await ui.settle();
    expect(ui.editor.plainText).toBe(query);
    expect(ui.controller.snapshot().approvalMode).toBe("auto");
    ui.mockInput.pressEscape(); await ui.settle();
    expect(ui.controller.commandHelpOpen).toBe(true);
    expect(ui.editor.plainText).toBe(query);
    expect(ui.selected()).toContain(label);
    ui.mockInput.pressEscape(); await ui.settle();
    await expectRestored(ui, before);
  }
  expect(ui.submitted).toEqual([]); expect(ui.builtins).toEqual([]); expect(ui.modelSubmissions()).toBe(0);
  expect(ui.session.items).toHaveLength(0); expect(fetched).toEqual([]);
});

test("exact keys find their guidance first and Thai or unmatched searches offer the no-match action", async () => {
  const ui = await setup();
  await ui.mockInput.pasteBracketedText(thaiDraft); ui.editor.cursorOffset = 5; await ui.settle();
  for (const [query, label] of [["ctrl+j", "Insert a newline"], ["Shift+Enter", "Insert a newline"], ["shift+tab", "Change approval mode"],
    ["alt+h", "Find keyboard shortcuts"], ["F2", "Inspect details"], ["ctrl+i", "Inspect details"], ["alt+r", "Review changes"],
    ["ctrl+c", "Copy selected text"], ["esc", "Stop running work"]] as const) {
    await openPalette(ui, query);
    expect(ui.rows().find(row => !row.startsWith("    ") && !row.startsWith(PALETTE_RUNNING))).toContain(label);
    expect(ui.selected()).toContain(label);
    ui.mockInput.pressEscape(); await ui.settle();
  }
  await openPalette(ui);
  await ui.mockInput.pasteBracketedText("ภาษาไทยไม่มี"); await ui.settle();
  expect(ui.rows()).toEqual([PALETTE_NO_MATCHES]);
  expect(ui.hints.plainText).toBe("Esc restore");
  ui.mockInput.pressEnter(); ui.mockInput.pressTab(); ui.mockInput.pressArrow("down"); await ui.settle();
  expect(ui.controller.commandHelpOpen).toBe(true); expect(ui.editor.plainText).toBe("ภาษาไทยไม่มี");
  await clearQuery(ui);
  expect(ui.selected()).toContain("/model");
  ui.mockInput.pressEscape(); await ui.settle();
  expect(ui.editor.plainText).toBe(thaiDraft); expect(ui.editor.cursorOffset).toBe(5);
  expect(ui.submitted).toEqual([]);
});

test("a short palette names its own Esc verb in the compact status bar: restore in results, back in guidance", async () => {
  const ui = await setup({ width: 60, height: 12 });
  await ui.mockInput.pasteBracketedText(thaiDraft); ui.editor.cursorOffset = 5; await ui.settle();
  const footer = () => ui.captureCharFrame().trimEnd().split("\n").at(-1)!.trim();
  await openPalette(ui);
  await ui.mockInput.pasteBracketedText("ภาษาไทยไม่มี"); await ui.settle();
  expect(ui.rows()).toEqual([PALETTE_NO_MATCHES]);
  expect(ui.hints.visible).toBe(false);
  expect(footer()).toBe("Auto · Esc restore");
  await clearQuery(ui);
  await ui.mockInput.typeText("newline"); await ui.settle();
  expect(footer()).toBe("Auto · Esc restore");
  ui.mockInput.pressEnter(); await ui.settle();
  expect(ui.captureCharFrame()).toContain("Insert a newline");
  expect(footer()).toBe("Auto · Esc back");
  // The verbs describe the handlers: back returns to the same results, restore returns the draft.
  ui.mockInput.pressEscape(); await ui.settle();
  expect(ui.controller.commandHelpOpen).toBe(true); expect(ui.editor.plainText).toBe("newline");
  expect(footer()).toBe("Auto · Esc restore");
  ui.mockInput.pressEscape(); await ui.settle();
  expect(ui.controller.commandHelpOpen).toBe(false);
  expect(ui.editor.plainText).toBe(thaiDraft); expect(ui.editor.cursorOffset).toBe(5);
  expect(footer()).toBe("Auto · Enter send");
});

test("commands preview with arguments and Enter inserts without executing; deletion reaches its path only after ordinary Enter", async () => {
  const ui = await setup();
  await ui.mockInput.pasteBracketedText("keep ไทย"); await ui.settle();
  await openPalette(ui, "appearance");
  expect(ui.selected()).toContain("/theme");
  expect(ui.hints.plainText).toBe("↑↓ select · Tab preview · Enter insert · Esc restore");
  ui.mockInput.pressTab(); await ui.settle();
  expect(ui.editor.plainText).toBe("/theme ");
  expect(ui.hints.plainText).toBe("Enter insert · Tab complete · Esc restore");
  ui.mockInput.pressArrow("down"); ui.mockInput.pressTab(); await ui.settle();
  expect(ui.editor.plainText).toBe("/theme dark");
  ui.mockInput.pressEnter(); await ui.settle();
  expect(ui.controller.commandHelpOpen).toBe(false);
  expect(ui.editor.plainText).toBe("/theme dark");
  expect(ui.submitted).toEqual([]); expect(ui.controller.appearanceMode()).toBe("auto");

  ui.editor.setText("keep ไทย"); await ui.settle();
  await openPalette(ui, "delete");
  expect(ui.selected()).toContain("/delete-session");
  expect(ui.selected()).toContain("· deletes");
  ui.mockInput.pressEnter(); await ui.settle();
  expect(ui.controller.commandHelpOpen).toBe(false);
  expect(ui.editor.plainText).toBe("/delete-session ");
  expect(ui.submitted).toEqual([]); expect(ui.builtins).toEqual([]);
  await ui.mockInput.typeText("saved-session"); await ui.settle();
  ui.mockInput.pressEscape(); await ui.settle();
  ui.mockInput.pressEnter(); await ui.settle();
  await Bun.sleep(20); await ui.settle();
  expect(ui.submitted).toEqual(["/delete-session saved-session"]);
  expect(ui.builtins).toEqual(["delete-session"]);
  expect(ui.modelSubmissions()).toBe(0);
});

test("duplicates and unavailable extensions stay visible, unselectable and uninsertable", async () => withTempDir(async root => {
  await Bun.write(join(root, "ping.ts"), "export default ctx => ctx.registerCommand({ name: 'ping', description: 'Ping extension', execute() { throw new Error('executed'); } });");
  const ui = await setup({ root, modules: ["ping.ts"], width: 50, height: 30, env: { NO_COLOR: "1" } });
  // Skills appear after the extension loaded, as dynamic discovery would find them.
  for (const name of ["ping", "help"]) await Bun.write(join(root, `.agents/skills/${name}/SKILL.md`), `---\nname: ${name}\ndescription: Conflicting skill\n---\nTask`);
  await ui.controller.refreshCommands();
  const files = (await readdir(root, { recursive: true })).sort();
  for (const query of ["/ping", "/help"]) {
    await openPalette(ui, query);
    const unavailable = ui.rows().filter(row => row.includes(`! ${query}`));
    expect(unavailable).toHaveLength(2);
    for (const row of unavailable) expect(row).toContain("Collision");
    expect(unavailable.some(row => row.startsWith("› "))).toBe(false);
    ui.mockInput.pressArrow("down"); ui.mockInput.pressTab(); ui.mockInput.pressEnter(); await ui.settle();
    expect(ui.editor.plainText).not.toBe(`${query} `);
    expect(ui.submitted).toEqual([]);
    ui.mockInput.pressEscape(); await ui.settle(); ui.editor.setText(""); await ui.settle();
  }
  expect((await readdir(root, { recursive: true })).sort()).toEqual(files);
}));

test("running work keeps the palette readable, reflects disabled actions and is not cancelled by opening or leaving it", async () => {
  const ui = await setup({ responses: [{ text: "Working", waitForAbort: true }] });
  await ui.mockInput.typeText("start work"); ui.mockInput.pressEnter();
  const deadline = Date.now() + 5000;
  while (!ui.controller.running && Date.now() < deadline) await ui.settle();
  expect(ui.controller.running).toBe(true);
  await ui.mockInput.pasteBracketedText(thaiDraft); ui.editor.cursorOffset = 5; await ui.settle();
  await openPalette(ui, "review");
  expect(ui.rows()[0]).toBe(PALETTE_RUNNING);
  expect(ui.selected()).toContain("! Alt+R");
  expect(ui.rows().at(-1)).toBe("! Wait for this turn · Esc stop");
  ui.mockInput.pressEnter(); await ui.settle();
  expect(ui.captureCharFrame()).toContain("! Wait for this turn · Esc stop");
  ui.mockInput.pressEscape(); await ui.settle();
  expect(ui.controller.running).toBe(true); expect(ui.controller.commandHelpOpen).toBe(true);
  await clearQuery(ui); await ui.mockInput.typeText("cancel"); await ui.settle();
  expect(ui.selected()).toContain("Esc or Ctrl+C");
  expect(ui.selected()).not.toContain("! ");
  ui.mockInput.pressEscape(); await ui.settle();
  expect(ui.controller.running).toBe(true);
  expect(ui.editor.plainText).toBe(thaiDraft); expect(ui.editor.cursorOffset).toBe(5);
  // A command inserted while running keeps the existing submission restriction.
  ui.editor.setText(""); await ui.settle();
  await openPalette(ui, "/model");
  ui.mockInput.pressEnter(); await ui.settle();
  expect(ui.editor.plainText).toBe("/model ");
  ui.mockInput.pressEscape(); await ui.settle();
  ui.mockInput.pressEnter(); await ui.settle(); await Bun.sleep(10); await ui.settle();
  expect(ui.builtins).toEqual([]);
  expect(ui.editor.plainText).toBe("/model ");
  expect(ui.controller.running).toBe(true);
  ui.controller.cancel();
});

test("selection follows identity through discovery and state refreshes, and nested guidance returns to it", async () => {
  const ui = await setup({ width: 120, height: 30 });
  await openPalette(ui, "copy");
  const first = ui.selected()!;
  ui.mockInput.pressArrow("down"); await ui.settle();
  const second = ui.selected()!;
  expect(second).not.toBe(first);
  await ui.controller.refreshCommands(); ui.controller.notice("Background note"); await ui.settle();
  expect(ui.selected()).toBe(second);
  ui.mockInput.pressEnter(); await ui.settle();
  ui.mockInput.pressEscape(); await ui.settle();
  expect(ui.selected()).toBe(second);
  // Filtering re-ranks deterministically and selects the best match; clearing returns to the first command.
  await ui.mockInput.typeText(" code"); await ui.settle();
  expect(ui.selected()).toContain("Copy code or a result");
  for (let count = 0; count < 5; count++) ui.mockInput.pressBackspace();
  await ui.settle();
  expect(ui.selected()).toBe(first);
  await clearQuery(ui);
  expect(ui.selected()).toContain("/model");
  ui.mockInput.pressEscape(); await ui.settle();
  expect(ui.submitted).toEqual([]);
});

test("the search query never reaches draft persistence and the saved draft survives nested guidance", async () => withTempDir(async root => {
  const ui = await setup({ root, drafts: true });
  ui.editor.setText(thaiDraft); ui.editor.cursorOffset = 5; await ui.settle();
  expect(ui.view.flushDraft()).toEqual({ saved: true, failed: false });
  const store = () => openDraftStore({ home: join(root, "home"), workspaceRoot: root, sessionId: ui.sessionId }).checkpoint?.text;
  expect(store()).toBe(thaiDraft);
  await openPalette(ui, "copy secret-sentinel");
  ui.view.flushDraft();
  expect(store()).toBe(thaiDraft);
  await clearQuery(ui); await ui.mockInput.typeText("newline"); await ui.settle();
  ui.mockInput.pressEnter(); await ui.settle();
  ui.view.flushDraft();
  expect(store()).toBe(thaiDraft);
  ui.mockInput.pressEscape(); ui.mockInput.pressEscape(); await ui.settle();
  expect(ui.editor.plainText).toBe(thaiDraft); expect(ui.editor.cursorOffset).toBe(5);
}));

for (const noColor of [false, true]) test(`50-column palette keeps markers, type and reasons${noColor ? " without color" : ""}`, async () => {
  const ui = await setup({ width: 50, height: 30, env: noColor ? { NO_COLOR: "1" } : {} });
  await openPalette(ui, "e");
  for (const row of ui.rows()) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(48);
  await clearQuery(ui);
  ui.mockInput.pressArrow("up"); await ui.settle();
  expect(ui.selected()).toContain("/delete-session");
  expect(ui.selected()).toContain("· deletes");
  expect(ui.rows()).toContain("    Destructive");
  ui.mockInput.pressArrow("up"); await ui.settle();
  expect(ui.selected()).toMatch(/^› ! Esc or Ctrl\+C/);
  expect(ui.rows().at(-1)).toBe("! Nothing running · Enter send a task");
  ui.mockInput.pressEnter(); await ui.settle();
  const frame = ui.captureCharFrame();
  expect(frame).toContain("Stop running work · Esc or Ctrl+C");
  expect(frame).toContain("! Nothing running · Enter send a task");
});

for (const preview of [false, true]) test(`an approval arriving behind help never receives palette text or a decision${preview ? " after Tab preview" : ""}`, async () => withTempDir(async root => {
  await Bun.write(join(root, "note.txt"), "before");
  const ui = await setup({ root, ask: true, responses: [{ toolCalls: [{ id: "pending", name: "edit", arguments: { path: "note.txt", edits: [{ oldText: "before", newText: "after" }] } }] }, { text: "done" }] });
  await ui.mockInput.pasteBracketedText(thaiDraft); ui.editor.cursorOffset = 5; await ui.settle();
  await openPalette(ui, "appearance");
  if (preview) { ui.mockInput.pressTab(); await ui.settle(); expect(ui.editor.plainText).toBe("/theme "); }
  const turn = ui.controller.submit("edit the note");
  const deadline = Date.now() + 5000;
  while (!ui.controller.snapshot().toolApproval?.diff && Date.now() < deadline) await ui.settle();
  await ui.settle();
  const request = ui.controller.snapshot().toolApproval;
  expect(request?.diff).toBeDefined();
  expect(ui.controller.commandHelpOpen).toBe(true);
  if (!preview) expect(ui.rows()[0]).toBe(PALETTE_APPROVAL);
  else expect(ui.editor.plainText).toBe("/theme ");
  expect(ui.hints.plainText).toBe("Esc back to request");
  // Enter on the command, and repeated Enter, neither insert nor decide the approval.
  ui.mockInput.pressEnter(); await ui.settle(); ui.mockInput.pressEnter(); await ui.settle();
  expect(ui.controller.commandHelpOpen).toBe(true);
  expect(ui.controller.snapshot().toolApproval).toEqual(request!);
  expect(await Bun.file(join(root, "note.txt")).text()).toBe("before");
  ui.mockInput.pressEscape(); await ui.settle();
  expect(ui.controller.commandHelpOpen).toBe(false);
  const approval = ui.controller.snapshot().toolApproval!;
  expect(approval.enteringReason).toBe(false);
  expect(approval.selected).toBe(0);
  expect(ui.editor.plainText).toBe("");
  expect(ui.captureCharFrame()).not.toContain("/theme");
  expect(await Bun.file(join(root, "note.txt")).text()).toBe("before");
  // Denying without a reason settles the turn and returns the original draft, not the palette insertion.
  ui.controller.denyToolApproval(); await turn; await ui.settle();
  expect(await Bun.file(join(root, "note.txt")).text()).toBe("before");
  expect(ui.editor.plainText).toBe(thaiDraft); expect(ui.editor.cursorOffset).toBe(5);
  expect(ui.submitted).toEqual([]); expect(ui.builtins).toEqual([]);
}));

test("slash completion without matches names Esc keep editing and Esc keeps the typed draft", async () => {
  const ui = await setup();
  for (const text of ["/", "/zzqx"]) { ui.editor.setText(text); await ui.settle(); await ui.settle(); }
  expect(ui.rows()).toEqual(["No matches · Esc keep editing"]);
  ui.mockInput.pressEscape(); await ui.settle();
  expect(ui.editor.plainText).toBe("/zzqx");
  expect(ui.picker.visible).toBe(false);
});
