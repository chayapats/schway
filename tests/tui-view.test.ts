import { escPhraseProblems } from "./helpers/esc-verbs.ts";
import { noticeConfigDeprecations } from "../src/tui/app.ts";
import { reviewScopeDetails } from "../src/tui/review-scope.ts";
import { beforeAll, afterAll, afterEach, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { BoxRenderable, RGBA, TextareaRenderable, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { createConversationView, type ConversationViewOptions } from "../src/tui/view.ts";
import { TuiController, buildTranscriptFromSession, MAX_TOOL_DISPLAY_CHARS, type CodexLoginRunner, type TuiControllerOptions } from "../src/tui/controller.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { handleSlashCommand } from "../src/tui/app.ts";
import { dispatchEditorInput } from "../src/tui/commands.ts";
import { fitLine } from "../src/tui/presentation.ts";
import { mixColor, resolveTheme, tint, TUI_THEMES } from "../src/tui/theme.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { credentialStoreError } from "../src/auth/store.ts";
import { codexSubscriptionIdentity } from "../src/auth/store.ts";
import { loadConfigEditor } from "../src/config/editing.ts";
import { withTempDir } from "./helpers.ts";
import { join } from "node:path";
import { realpath, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { InteractiveMemory } from "../src/config/interactive-memory.ts";
import { pathToFileURL } from "node:url";
import { loadExtensions } from "../src/extensions/loader.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { BUILT_IN_COMMAND_ORDER } from "../src/tui/command-catalog.ts";
import { resolveWorkspace } from "../src/workspace/workspace.ts";
import { readTool } from "../src/tools/read.ts";
import { editTool } from "../src/tools/edit.ts";
import { writeTool } from "../src/tools/write.ts";
import { bashTool } from "../src/tools/bash.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

/** Build a real disposable conversation renderer with optional workspace and view dependencies. */
async function setup(width = 80, height = 28, credentialEnv: Record<string, string> = {}, codexLogin?: CodexLoginRunner, overrides: Partial<TuiControllerOptions> = {}, submitOverride?: ConversationViewOptions["submit"], viewEnv: Record<string, string> = {}, viewOptions: Partial<ConversationViewOptions> = {}) {
  const terminal = await createTestRenderer({ width, height, kittyKeyboard: true });
  const session = overrides.session ?? createSession();
  const workspace = { root: "/project", launchCwd: "/project", extraRoots: [] };
  const controller = new TuiController({
    session, workspace, provider: "scripted", modelId: "test-model", sessionId: "private-session-id",
    model: createScriptedModel({ responses: [{ text: "## Result\n\nHello **world**.\n\n```ts\nconst answer = 42;\n```" }] }),
    contextManager: createContextManager(workspace), secrets: ["secret-sentinel"],
    credentials: { store: fakeCredentialStore(), env: credentialEnv, reload: async () => ({ model: createScriptedModel() }), codexLogin },
    appearanceEnvironment: viewEnv.SCHWAY_THEME === "dark" || viewEnv.SCHWAY_THEME === "light" ? viewEnv.SCHWAY_THEME : undefined,
    ...overrides,
  });
  let quit = false;
  const copied: string[] = [];
  const opened: string[] = [];
  terminal.renderer.copyToClipboardOSC52 = text => { copied.push(text); return true; };
  const view = createConversationView(terminal.renderer, {
    controller, workspaceRoot: "/project", home: "/home/test", env: viewEnv, secrets: ["secret-sentinel"],
    ...viewOptions,
    quit: () => { quit = true; },
    openUrl: async url => { opened.push(url); },
    submit: submitOverride ?? ((value, accepted) => dispatchEditorInput(value, controller, async command => {
      if (command.name === "model") return controller.openModelPicker();
      if (command.name === "config") return controller.configCommand(command.args);
      if (command.name === "login") return controller.login(command.args);
      if (command.name === "help") { controller.notice("Help text"); return true; }
      return false;
    }, accepted)),
  });
  cleanups.push(() => { view.destroy(); controller.dispose(); terminal.renderer.destroy(); });
  await terminal.flush();
  const editor = terminal.renderer.root.findDescendantById("prompt") as TextareaRenderable;
  const transcript = terminal.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable;
  return { ...terminal, controller, view, session, editor, transcript, copied, opened, didQuit: () => quit };
}

async function settle(ui: TestRendererSetup & { view: ReturnType<typeof createConversationView> }) {
  await Bun.sleep(5);
  ui.view.refresh();
  await ui.flush();
}

async function waitForUiState(
  ui: TestRendererSetup & { view: ReturnType<typeof createConversationView> },
  predicate: () => boolean,
  label: string,
) {
  const deadline = Date.now() + 10_000;
  while (!predicate() && Date.now() < deadline) await settle(ui);
  if (!predicate()) throw new Error(`Timed out waiting for ${label}\n${ui.captureCharFrame()}`);
}

test("not-connected copy and neutral pill survive no-color, narrow widths and resize", async () => {
  for (const env of [{}, { NO_COLOR: "1" }] as Record<string, string>[]) {
    const ui = await setup(120, 24, {}, undefined, { provider: "openai", modelId: "", model: undefined }, undefined, env);
    for (const [width, height] of [[120, 24], [80, 24], [50, 24], [120, 24], [44, 18], [24, 18], [80, 9]] as const) {
      ui.resize(width, height);
      await settle(ui);
      expect(ui.captureCharFrame()).toContain(width < 30 || height < 14 ? "Auto · Alt+L sign in" : "○ Not connected");
      expect(ui.captureCharFrame()).toContain("Auto");
      if (height >= 10) expect(ui.captureCharFrame()).toContain("Alt+L sign in");
      const empty = ui.renderer.root.findDescendantById("empty-conversation") as TextRenderable;
      // Narrow cards wrap the action line at its separator, keeping Alt+L with its verb.
      expect(empty.chunks.map(chunk => chunk.text).join("")).toContain(width < 36 ? "Not connected\nConnect a provider\nAlt+L sign in" : "Not connected\nConnect a provider · Alt+L sign in");
      if (height < 10) expect(empty.chunks.map(chunk => chunk.text).join("")).toStartWith("/project\n");
      if (width >= 44) {
        expect(ui.captureCharFrame()).toContain("Not connected");
        expect(ui.captureCharFrame()).toContain("Connect a provider · Alt+L sign in");
      }
      for (const copy of ["gpt-", "openai/", "claude", "anthropic", "No model yet", "Ready", "Attention", "ctx", "Ctrl+I failure details", "Enter send"]) expect(ui.captureCharFrame()).not.toContain(copy);
    }
  }
});

test("rejected draft survives connect cancellation and recovery keys run only the saved turn", async () => {
  const missing = await setup(80, 24, {}, undefined, { model: undefined });
  await missing.mockInput.pasteBracketedText("unsent task");
  missing.mockInput.pressEnter();
  await settle(missing);
  expect(missing.editor.plainText).toBe("unsent task");
  expect(missing.session.items).toHaveLength(0);
  expect(missing.controller.snapshot().recovery?.actions).toContain("connect");
  missing.mockInput.pressKey("l", { meta: true });
  await settle(missing);
  expect(missing.controller.snapshot().loginChooser).toBeDefined();
  missing.mockInput.pressEscape();
  await settle(missing);
  expect(missing.controller.snapshot().loginChooser).toBeUndefined();
  expect(missing.editor.plainText).toBe("unsent task");

  const accepted = await setup(80, 24, {}, undefined, { model: createScriptedModel({ responses: [
    { error: "offline", code: "ENETUNREACH" }, { error: "offline", code: "ENETUNREACH" },
    { error: "offline", code: "ENETUNREACH" }, { text: "continued once" },
  ] }), agentClock: { now: () => 0, sleep: async () => {} } });
  await accepted.mockInput.pasteBracketedText("accepted task");
  accepted.mockInput.pressEnter();
  await accepted.controller.waitForIdle();
  await settle(accepted);
  expect(accepted.controller.snapshot().recovery?.actions).toContain("continue");
  accepted.mockInput.pressKey("r", { ctrl: true });
  await accepted.controller.waitForIdle();
  await settle(accepted);
  expect(accepted.session.items.filter(item => item.type === "user")).toHaveLength(1);
  expect(accepted.captureCharFrame()).toContain("continued once");
});

test("credential-store retry uses real keyboard input and leaves the draft unsent", async () => {
  let locked = true;
  const ui = await setup(80, 24, {}, undefined, {
    model: undefined, startupError: credentialStoreError("read"),
    credentials: { store: fakeCredentialStore(), env: {}, reload: async () => locked
      ? { error: credentialStoreError("read") } : { model: createScriptedModel({ text: "ready" }) } },
  });
  await ui.mockInput.pasteBracketedText("draft after unlock");
  ui.mockInput.pressEnter();
  await settle(ui);
  expect(ui.session.items).toHaveLength(0);
  expect(ui.editor.plainText).toBe("draft after unlock");
  expect(ui.controller.snapshot().recovery?.category).toBe("credential-store");
  ui.mockInput.pressKey("r", { ctrl: true });
  await settle(ui);
  expect(ui.session.items).toHaveLength(0);
  expect(ui.controller.snapshot().recovery?.category).toBe("credential-store");
  locked = false;
  ui.mockInput.pressKey("r", { ctrl: true });
  await settle(ui);
  expect(ui.session.items).toHaveLength(0);
  expect(ui.editor.plainText).toBe("draft after unlock");
  ui.mockInput.pressEnter();
  await ui.controller.waitForIdle();
  expect(ui.session.items.filter(item => item.type === "user")).toHaveLength(1);
});

test("multiline paste and Ctrl+J submit one prompt; Markdown renders with stable message objects", async () => {
  const ui = await setup();
  await ui.mockInput.pasteBracketedText("ช่วยแก้ไข\nบรรทัดที่สอง");
  ui.mockInput.pressKey("j", { ctrl: true });
  await ui.mockInput.typeText("last line");
  expect(ui.session.items).toHaveLength(0);
  expect(ui.editor.plainText).toBe("ช่วยแก้ไข\nบรรทัดที่สอง\nlast line");
  ui.mockInput.pressEnter();
  await settle(ui);
  await ui.controller.waitForIdle();
  await settle(ui);
  expect(ui.session.items[0]).toMatchObject({ type: "user", content: [{ type: "text", text: "ช่วยแก้ไข\nบรรทัดที่สอง\nlast line" }] });
  expect(ui.editor.plainText).toBe("");
  const frame = ui.captureCharFrame();
  expect(frame).toContain("Result");
  expect(frame).toContain("Hello world.");
  expect(frame).not.toContain("**world**");
  expect(frame).toContain("const answer = 42;");
  expect(frame).not.toContain("private-session-id");
  const userRow = ui.transcript.getChildren().find(row => row.id.startsWith("message-"));
  ui.controller.notice("A later status update");
  await settle(ui);
  expect(userRow).toBeDefined();
  expect(ui.transcript.getChildren()).toContain(userRow!);
  ui.mockInput.pressArrow("up");
  expect(ui.editor.plainText).toContain("บรรทัดที่สอง");
});

test("missing credentials retain a Thai multiline prompt and cursor through real Enter", async () => {
  const ui = await setup(44, 18, {}, undefined, { model: undefined });
  await ui.mockInput.pasteBracketedText("ช่วยแก้ไข\nบรรทัดที่สอง");
  ui.editor.cursorOffset = 3;
  const before = ui.editor.cursorOffset;
  ui.mockInput.pressEnter();
  await settle(ui);
  expect(ui.editor.plainText).toBe("ช่วยแก้ไข\nบรรทัดที่สอง");
  expect(ui.editor.cursorOffset).toBe(before);
  expect(ui.editor.focused).toBe(true);
  expect(ui.session.items).toHaveLength(0);
  expect(ui.controller.snapshot().status).toBe("error");
  ui.controller.setModel(createScriptedModel({ text: "ready" }), "scripted", "ready");
  ui.mockInput.pressEnter();
  ui.mockInput.pressEnter();
  await ui.controller.waitForIdle();
  await settle(ui);
  expect(ui.session.items.filter(item => item.type === "user")).toHaveLength(1);
  expect(ui.session.items[0]).toMatchObject({ content: [{ type: "text", text: "ช่วยแก้ไข\nบรรทัดที่สอง" }] });
  expect(ui.editor.plainText).toBe("");
});

test("failed session append retains the editor and never starts the model", async () => {
  let requests = 0;
  const session = createSession([], [], { writeOperation: () => { throw new Error("disk full"); } });
  const ui = await setup(44, 18, {}, undefined, {
    session,
    model: createScriptedModel({ responses: [() => { requests++; return { text: "unexpected" }; }] }),
  });
  await ui.mockInput.pasteBracketedText("  เก็บข้อความ\nและบรรทัดนี้  ");
  ui.editor.cursorOffset = 4;
  const before = ui.editor.cursorOffset;
  ui.mockInput.pressEnter();
  await settle(ui);
  expect(ui.editor.plainText).toBe("  เก็บข้อความ\nและบรรทัดนี้  ");
  expect(ui.editor.cursorOffset).toBe(before);
  expect(ui.editor.focused).toBe(true);
  expect(ui.session.items).toHaveLength(0);
  expect(requests).toBe(0);
  const guidance = ui.controller.snapshot().transcript.at(-1)?.text ?? "";
  expect(guidance).toContain("Could not save your prompt");
  expect(guidance).toContain("draft is still in the editor");
  expect(guidance).toContain("Open a new or repaired session");
  expect(guidance).not.toContain("send the draft again");
  ui.mockInput.pressEnter();
  await settle(ui);
  expect(ui.editor.plainText).toBe("  เก็บข้อความ\nและบรรทัดนี้  ");
  expect(ui.session.items).toHaveLength(0);
  expect(requests).toBe(0);
  expect(ui.controller.snapshot().transcript.at(-1)?.text).toContain("cannot safely save another turn");
});

test("invalid local command remains editable after Enter", async () => {
  const ui = await setup();
  await ui.mockInput.typeText("/theme wrong");
  ui.editor.cursorOffset = 5;
  const before = ui.editor.cursorOffset;
  ui.mockInput.pressEnter();
  await waitForUiState(ui, () => ui.controller.snapshot().status === "error", "invalid command result");
  expect(ui.editor.plainText).toBe("/theme wrong");
  expect(ui.editor.cursorOffset).toBe(before);
  expect(ui.controller.snapshot().status).toBe("error");
});

test("busy built-in command keeps text and cursor through renderer dispatch", async () => {
  const ui = await setup();
  ui.controller.setModel(createScriptedModel({ waitForAbort: true }), "scripted", "waiting");
  const running = ui.controller.submit("running");
  await ui.mockInput.typeText("/model unavailable");
  ui.editor.cursorOffset = 7;
  const before = ui.editor.cursorOffset;
  ui.mockInput.pressEnter();
  await settle(ui);
  expect(ui.editor.plainText).toBe("/model unavailable");
  expect(ui.editor.cursorOffset).toBe(before);
  expect(ui.controller.snapshot().transcript.some(entry => entry.text === "Wait for this turn · Esc stop")).toBe(true);
  ui.controller.cancel();
  await running;
});

test("late command acceptance leaves a newer draft through picker restoration", async () => {
  let complete!: (value: boolean) => void;
  let controller!: TuiController;
  const ui = await setup(44, 18, {}, undefined, {}, (value, accepted) => dispatchEditorInput(value, controller, async () => {
    return new Promise<boolean>(resolve => { complete = resolve; });
  }, accepted));
  controller = ui.controller;
  await ui.mockInput.typeText("/help");
  ui.mockInput.pressEnter();
  await settle(ui);
  ui.editor.setText("newer draft");
  ui.editor.cursorOffset = 5;
  ui.controller.openModelPicker();
  await settle(ui);
  complete(true);
  await settle(ui);
  ui.controller.closeModelPicker();
  await settle(ui);
  expect(ui.editor.plainText).toBe("newer draft");
  expect(ui.editor.cursorOffset).toBe(5);
});

test("a real extension command releases input at handoff and cannot clear a newer draft on finish", async () => {
  await withTempDir(async root => {
    const path = join(root, "commands.ts");
    await Bun.write(path, `export let finish; export default ctx => ctx.registerCommand({ name: 'delay', description: 'Wait', execute(args, command) { command.submitPrompt('generated prompt'); return new Promise(resolve => { finish = resolve; }); } });`);
    const module = await import(pathToFileURL(await realpath(path)).href);
    const workspace = await resolveWorkspace(root);
    const loaded = await loadExtensions({ modules: [path], workspace, tools: createToolRegistry(), home: join(root, "home") });
    const ui = await setup(44, 18, {}, undefined, { workspace, extensions: loaded.runtime, home: join(root, "home") });
    await ui.mockInput.typeText("/delay");
    ui.mockInput.pressEnter();
    await waitForUiState(ui, () => typeof module.finish === "function", "extension command handoff");
    await settle(ui);
    expect(ui.controller.running).toBe(true);
    expect(ui.editor.plainText).toBe("");
    await ui.mockInput.typeText("new work while waiting");
    ui.editor.cursorOffset = 4;
    module.finish("Done");
    await ui.controller.waitForIdle();
    await settle(ui);
    expect(ui.editor.plainText).toBe("new work while waiting");
    expect(ui.editor.cursorOffset).toBe(4);
    expect(ui.session.items.filter(item => item.type === "user")).toHaveLength(1);
  });
});

test("model failure after acceptance remains one failed turn, not a restored draft", async () => {
  const ui = await setup(80, 24, {}, undefined, { model: createScriptedModel({ error: "offline" }) });
  await ui.mockInput.typeText("one saved turn");
  ui.mockInput.pressEnter();
  await ui.controller.waitForIdle();
  await settle(ui);
  expect(ui.session.items.filter(item => item.type === "user")).toHaveLength(1);
  expect(ui.editor.plainText).toBe("");
  expect(ui.controller.snapshot().status).toBe("error");
});

test("dragging transcript text copies it; Ctrl+C copies selection instead of quitting", async () => {
  const ui = await setup();
  ui.controller.notice("Copy this sentence");
  await settle(ui);
  const row = ui.transcript.getChildren().find(row => row.id.startsWith("message-"))!;
  await ui.mockMouse.drag(row.x, row.y, row.x + 8, row.y);
  await settle(ui);
  expect(ui.renderer.getSelection()?.getSelectedText()).toBe("Copy this");
  expect(ui.copied).toContain("Copy this");
  ui.mockInput.pressKey("c", { ctrl: true });
  expect(ui.didQuit()).toBe(false);
  expect(ui.copied.at(-1)).toBe("Copy this");
});

test("clicking a Markdown link opens its destination; dragging over it only selects", async () => {
  const ui = await setup();
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "Read [Documentation](https://example.test/docs) for details." } });
  await settle(ui);
  const lines = ui.captureCharFrame().split("\n");
  const y = lines.findIndex(line => line.includes("Documentation"));
  const x = lines[y]!.indexOf("Documentation");
  await ui.mockMouse.click(x + 1, y);
  expect(ui.opened).toEqual(["https://example.test/docs"]);
  await ui.mockMouse.drag(x, y, x + 5, y);
  expect(ui.opened).toHaveLength(1);
});

test("plain wrapped URLs open in full, while non-web Markdown targets never launch", async () => {
  const ui = await setup(44, 22);
  const url = `https://example.test/long/path?token=${"a".repeat(600)}`;
  ui.controller.notice(`Open ${url}`);
  await settle(ui);
  const lines = ui.captureCharFrame().split("\n");
  const y = lines.findIndex(line => line.includes("aaaa"));
  const x = lines[y]!.indexOf("aaaa");
  expect(y).toBeGreaterThanOrEqual(0);
  await ui.mockMouse.click(x + 1, y);
  expect(ui.opened).toEqual([url]);
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "[Unsafe](javascript:alert%281%29) [File](file:///tmp/secret)" } });
  await settle(ui);
  ui.mockInput.pressKey("END", { ctrl: true });
  await settle(ui);
  for (const label of ["Unsafe", "File"]) {
    const frame = ui.captureCharFrame().split("\n");
    const row = frame.findIndex(line => line.includes(label));
    await ui.mockMouse.click(frame[row]!.indexOf(label), row);
  }
  expect(ui.opened).toEqual([url]);
});

test("copying tool headings does not expand them or copy redacted secrets", async () => {
  const ui = await setup();
  ui.controller.applyEvent({ type: "tool.started", toolCallId: "copy", name: "bash" });
  ui.controller.applyEvent({ type: "tool.finished", toolCallId: "copy", name: "bash", status: "success", content: "summary\nhidden output" });
  await settle(ui);
  const row = ui.transcript.getChildren().find(row => row.id.startsWith("message-"))!;
  await ui.mockMouse.drag(row.x, row.y, row.x + 7, row.y);
  await settle(ui);
  expect(ui.captureCharFrame()).not.toContain("hidden output");
  expect(ui.copied.length).toBeGreaterThan(0);
  ui.controller.notice("Visible secret-sentinel");
  await settle(ui);
  const frame = ui.captureCharFrame().split("\n");
  const y = frame.findIndex(line => line.includes("Visible"));
  const x = frame[y]!.indexOf("Visible");
  await ui.mockMouse.drag(x, y, x + 10, y);
  expect(ui.copied.at(-1)).toContain("***");
  expect(ui.copied.join("\n")).not.toContain("secret-sentinel");
});

test("copy works on scrolled multiline output and does not cancel a running turn", async () => {
  const streamed = Promise.withResolvers<void>();
  const ui = await setup(60, 18, {}, undefined, { onRuntimeEvent: event => {
    if (event.type === "model.delta" && event.content.type === "text" && event.content.text.includes("Line 59")) streamed.resolve();
  } });
  ui.controller.setModel(createScriptedModel({ text: Array.from({ length: 60 }, (_, i) => `Line ${String(i).padStart(2, "0")} ข้อความภาษาไทย\n\n`).join(""), waitForAbort: true }), "scripted", "streaming");
  const turn = ui.controller.submit("Produce long output");
  await streamed.promise;
  expect(ui.controller.snapshot().transcript.at(-1)?.text).toContain("Line 59");
  await settle(ui);
  await ui.mockInput.pressKeys(["\u001b[5~"]);
  await settle(ui);
  const lines = ui.captureCharFrame().split("\n");
  const y = lines.findIndex((line, index) => index >= ui.transcript.y + 4 && line.includes("Line "));
  const x = lines[y]!.indexOf("Line ");
  await ui.mockMouse.drag(x, y, x + 6, y + 1);
  expect(ui.copied.at(-1)).toContain("Line");
  expect(ui.copied.at(-1)).toContain("ข้อความภาษาไทย");
  ui.mockInput.pressKey("c", { ctrl: true });
  expect(ui.controller.running).toBe(true);
  expect(ui.didQuit()).toBe(false);
  ui.controller.cancel();
  await turn;
});

test("tool success collapses, errors stay visible, and expanded diffs preserve colors and secrets", async () => {
  const ui = await setup();
  ui.controller.applyEvent({ type: "tool.started", toolCallId: "read", name: "read" });
  ui.controller.applyEvent({ type: "tool.finished", toolCallId: "read", name: "read", status: "success", content: "file.ts\nHIDDEN OUTPUT secret-sentinel" });
  ui.controller.applyEvent({ type: "tool.started", toolCallId: "edit", name: "edit" });
  ui.controller.applyEvent({ type: "tool.finished", toolCallId: "edit", name: "edit", status: "success", content: "Edited file.ts", details: { path: "file.ts", hunks: [{ startLine: 1, oldText: "before", newText: "after secret-sentinel" }] } });
  ui.controller.applyEvent({ type: "tool.started", toolCallId: "bad", name: "bash" });
  ui.controller.applyEvent({ type: "tool.finished", toolCallId: "bad", name: "bash", status: "error", content: "Command failed\nexit code: 1\nFix the missing file" });
  await settle(ui);
  expect(ui.captureCharFrame()).not.toContain("HIDDEN OUTPUT");
  expect(ui.captureCharFrame()).toContain("exit code: 1");
  ui.mockInput.pressKey("o", { ctrl: true });
  await settle(ui);
  expect(ui.captureCharFrame()).toContain("HIDDEN OUTPUT");
  expect(ui.captureCharFrame()).not.toContain("secret-sentinel");
  expect(ui.captureCharFrame()).toContain("1 │+after ***");
  expect(ui.captureCharFrame()).toContain("1 │-before");
  const editEntry = ui.controller.snapshot().transcript.find(entry => entry.toolCallId === "edit")!;
  expect(JSON.stringify(editEntry)).not.toContain("secret-sentinel");
  const diffBody = ui.renderer.root.findDescendantById(`message-${editEntry.id}`)!.getChildren()[1]!.getChildren()[0] as TextRenderable;
  expect(diffBody.chunks.find(chunk => chunk.text.includes("+after"))?.fg).toEqual(RGBA.fromHex(TUI_THEMES.dark.success));
  const readRow = ui.transcript.getChildren().find(row => row.id === `message-${ui.controller.snapshot().transcript[0]!.id}`)!;
  await ui.mockMouse.click(readRow.x + 1, readRow.y);
  await settle(ui);
  expect(ui.captureCharFrame()).not.toContain("HIDDEN OUTPUT");
  expect(ui.captureCharFrame()).toContain("1 │+after ***");
});

test("real read, edit, write and bash results render summaries with deterministic durations and inline limits", async () => {
  await withTempDir(async root => {
    for (const limit of [12, 0]) {
      const workspace = { root, launchCwd: root, extraRoots: [] };
      await writeFile(join(root, "clamp.ts"), "before\nold\nafter\n");
      const path = `created-${limit}.txt`;
      const content = Array.from({ length: 42 }, (_, i) => `created line ${i + 1}`).join("\n") + "\n";
      let clock = 1000, tick = 0;
      const configEditor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, cli: { ui: { inlineDiffLines: limit } } });
      const ui = await setup(120, 40, {}, undefined, {
        workspace, contextManager: createContextManager(workspace), configEditor,
        tools: createToolRegistry([readTool, editTool, writeTool, bashTool]), activityClock: () => clock,
        onRuntimeEvent: event => { if (event.type === "tool.finished") clock += 1200; },
        // Tool rows show the scheduler's measured duration: its start and settlement reads are 1.2s apart.
        agentClock: { now: () => Date.parse("2026-01-15T09:30:00.000Z"), monotonicNow: () => (tick += 1200), sleep: async () => {} },
        model: createScriptedModel({ responses: [
          { toolCalls: [{ id: "read", name: "read", arguments: { path: "clamp.ts" } }] },
          { toolCalls: [{ id: "edit", name: "edit", arguments: { path: "clamp.ts", edits: [{ oldText: "old", newText: "new" }] } }] },
          { toolCalls: [{ id: "write", name: "write", arguments: { path, content } }] },
          { toolCalls: [{ id: "bash", name: "bash", arguments: { command: "printf 'checked\\n'" } }] },
          { text: "Finished." },
        ] }),
      });
      await ui.controller.submit("Update the file"); await settle(ui);
      const frame = ui.captureCharFrame();
      for (const summary of ["3 lines", "+1 −1", "new · 42 lines", "Exit 0 · 1.2s"]) expect(frame).toContain(summary);
      expect(frame.includes("2 │-old")).toBe(limit > 0);
      expect(frame.includes("2 │+new")).toBe(limit > 0);
      expect(frame).not.toContain("created line 1");
      ui.mockInput.pressKey("o", { ctrl: true }); await settle(ui);
      expect(ui.captureCharFrame()).toContain("2 │-old");
      expect(ui.captureCharFrame()).toContain("2 │+new");
      expect(ui.captureCharFrame()).toContain("1 │+created line 1");
      expect(ui.session.items.filter(item => item.type === "tool_result").some(item => item.type === "tool_result" && item.content.includes("│"))).toBe(false);
    }
  });
});

test("raw tool output keeps its own ` · ` separators at narrow widths; only web_fetch's status line rewraps", async () => {
  const ui = await setup(40, 30);
  const output = "README.md:72:Good: `1 file changed · Esc back` and more text · here · there";
  ui.controller.applyEvent({ type: "tool.started", toolCallId: "grep", name: "bash" });
  await settle(ui);
  ui.controller.applyEvent({ type: "tool.finished", toolCallId: "grep", name: "bash", status: "error", content: output });
  await settle(ui);
  const entry = ui.controller.snapshot().transcript.find(item => item.kind === "tool")!;
  const texts: string[] = [];
  const visit = (node: { getChildren(): unknown[] }) => {
    for (const child of node.getChildren() as { getChildren(): unknown[] }[]) { if (child instanceof TextRenderable) texts.push(child.plainText); visit(child); }
  };
  visit(ui.renderer.root.findDescendantById(`message-${entry.id}`)!);
  // The body is the tool's text as written: no separator is dropped and no row break is inserted.
  expect(texts.some(text => text.split("\n").includes(output)), texts.join("\n---\n")).toBe(true);
});

test("inline edit and created-write rows ignore mouse, inspection Enter and Ctrl+O toggles", async () => {
  const session = createSession();
  const ui = await setup(80, 30, {}, undefined, { session });
  session.append({ type: "assistant", id: "calls", content: [{ type: "tool_call", id: "write", name: "write", arguments: { path: "new.ts", content: "created secret-sentinel\n" } }] });
  for (const [id, name, details] of [
    ["edit", "edit", { path: "file.ts", hunks: [{ startLine: 2, oldText: "old", newText: "new secret-sentinel" }] }],
    ["write", "write", { created: true, lineCount: 1 }],
  ] as const) {
    ui.controller.applyEvent({ type: "tool.started", toolCallId: id, name });
    await settle(ui);
    ui.controller.applyEvent({ type: "tool.finished", toolCallId: id, name, status: "success", content: "Applied", details });
  }
  await settle(ui);
  const entries = ui.controller.snapshot().transcript.filter(entry => entry.kind === "tool");
  const assertInline = () => {
    for (const entry of entries) {
      const label = ui.renderer.root.findDescendantById(`message-${entry.id}`)!.getChildren()[0] as TextRenderable;
      expect(label.plainText).not.toMatch(/[▸▾]/);
    }
    expect(ui.captureCharFrame()).toContain("2 │+new ***");
    expect(ui.captureCharFrame()).toContain("1 │+created ***");
    expect(ui.captureCharFrame()).not.toContain("secret-sentinel");
  };
  assertInline();
  for (const entry of entries) {
    const row = ui.renderer.root.findDescendantById(`message-${entry.id}`)!;
    await ui.mockMouse.click(row.x + 1, row.y); await settle(ui); assertInline();
  }
  ui.mockInput.pressKey("i", { meta: true }); await settle(ui);
  ui.mockInput.pressEnter(); await settle(ui); assertInline();
  ui.mockInput.pressArrow("down"); ui.mockInput.pressEnter(); await settle(ui); assertInline();
  ui.mockInput.pressKey("o", { ctrl: true }); await settle(ui); assertInline();
  ui.mockInput.pressKey("o", { ctrl: true }); await settle(ui); assertInline();
});

test("write overwrites and rewritten-content count mismatches never display a diff", async () => {
  const session = createSession();
  const ui = await setup(80, 28, {}, undefined, { session });
  session.append({ type: "assistant", id: "writes", content: [
    { type: "tool_call", id: "overwrite", name: "write", arguments: { path: "old.ts", content: "must stay hidden\n" } },
    { type: "tool_call", id: "mismatch", name: "write", arguments: { path: "new.ts", content: "must stay hidden\n" } },
  ] });
  for (const [toolCallId, created, lineCount] of [["overwrite", false, 1], ["mismatch", true, 2]] as const) {
    ui.controller.applyEvent({ type: "tool.started", toolCallId, name: "write" });
    ui.controller.applyEvent({ type: "tool.finished", toolCallId, name: "write", status: "success", content: "Wrote file", details: { created, lineCount } });
  }
  await settle(ui);
  expect(ui.captureCharFrame()).toContain("overwritten · 1 line");
  expect(ui.captureCharFrame()).toContain("new · 2 lines");
  expect(ui.controller.snapshot().transcript.filter(entry => entry.kind === "tool").every(entry => entry.diffRows === undefined)).toBe(true);
  ui.mockInput.pressKey("o", { ctrl: true }); await settle(ui);
  expect(ui.captureCharFrame()).not.toContain("│+");
  expect(ui.captureCharFrame()).not.toContain("must stay hidden");
});

test("failed bash starts expanded, toggles to six lines, and Ctrl+O restores its default", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const ui = await setup(100, 38, {}, undefined, { workspace, contextManager: createContextManager(workspace), tools: createToolRegistry([bashTool]),
      model: createScriptedModel({ responses: [
        { toolCalls: [{ id: "timeout", name: "bash", arguments: { command: "printf 'line 1\\nline 2\\nline 3\\nline 4\\nline 5\\nline 6\\nline 7\\nline 8\\n'; sleep 2", timeout: 100 } }] },
        { text: "Inspect the failure." },
      ] }),
    });
    await ui.controller.submit("Run the command"); await settle(ui);
    const entry = ui.controller.snapshot().transcript.find(entry => entry.toolCallId === "timeout")!;
    const label = ui.renderer.root.findDescendantById(`message-${entry.id}`)!.getChildren()[0] as TextRenderable;
    const body = ui.renderer.root.findDescendantById(`message-${entry.id}`)!.getChildren()[1]!.getChildren()[0] as TextRenderable;
    expect(label.plainText).toContain("▾");
    expect(ui.captureCharFrame()).toContain("line 8");
    expect(ui.captureCharFrame()).toContain("Tool failed. Inspect this result before continuing.");
    ui.mockInput.pressKey("i", { meta: true }); ui.mockInput.pressEnter(); await settle(ui);
    expect(label.plainText).toContain("▸");
    expect(body.plainText.split("\n")).toHaveLength(7);
    expect(body.plainText).toContain("line 2");
    expect(body.plainText).not.toContain("line 7");
    expect(ui.captureCharFrame()).toContain("… Ctrl+O to expand output");
    ui.mockInput.pressKey("o", { ctrl: true }); await settle(ui);
    expect(ui.captureCharFrame()).toContain("line 8");
    ui.mockInput.pressKey("o", { ctrl: true }); await settle(ui);
    expect(label.plainText).toContain("▾");
    expect(ui.captureCharFrame()).toContain("line 8");
  });
});

test("result summaries drop before long targets clip and return after resize", async () => {
  const ui = await setup(120, 30);
  const path = "src/components/long-directory/example-file.ts";
  ui.session.append({ type: "assistant", id: "long-target", content: [{ type: "tool_call", id: "read-long", name: "read", arguments: { path } }] });
  ui.controller.applyEvent({ type: "tool.started", toolCallId: "read-long", name: "read" });
  ui.controller.applyEvent({ type: "tool.finished", toolCallId: "read-long", name: "read", status: "success", content: "Read file", details: { lineCount: 3, startLine: 1, endLine: 3, truncated: false } });
  for (const width of [120, 80, 50, 120]) {
    ui.resize(width, 30); await settle(ui);
    const frame = ui.captureCharFrame();
    expect(frame.includes("3 lines")).toBe(width > 50);
    if (width > 50) expect(frame).toContain(path);
    else expect(frame).toContain("…");
  }
});

test("resumed successful edits show argument counts while writes have no result summary or diff", async () => {
  const session = createSession();
  session.append({ type: "assistant", id: "saved-calls", content: [
    { type: "tool_call", id: "saved-edit", name: "edit", arguments: { path: "file.ts", edits: [{ oldText: "old", newText: "new" }] } },
    { type: "tool_call", id: "saved-write", name: "write", arguments: { path: "new.ts", content: "created\n" } },
  ] }, { type: "tool_result", id: "edit-result", toolCallId: "saved-edit", content: "Edited file.ts", isError: false }, { type: "tool_result", id: "write-result", toolCallId: "saved-write", content: "Wrote new.ts", isError: false });
  const ui = await setup(80, 28, {}, undefined, { session });
  await settle(ui);
  const entries = buildTranscriptFromSession(session.items);
  expect(entries.find(entry => entry.toolCallId === "saved-edit")?.resultSummary).toBe("+1 −1");
  expect(entries.find(entry => entry.toolCallId === "saved-write")?.resultSummary).toBeUndefined();
  expect(entries.every(entry => entry.diffRows === undefined)).toBe(true);
  expect(ui.captureCharFrame()).toContain("+1 −1");
  expect(ui.captureCharFrame()).not.toContain("│+");
  expect(ui.captureCharFrame()).not.toContain("new ·");
});

test("effective inline limit changes redraw existing rows and secrets are redacted before expanded clipping", async () => {
  await withTempDir(async root => {
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root });
    const settings = editor.settings;
    let limit = 12;
    Object.defineProperty(editor, "settings", { get: () => ({ ...settings, inlineDiffLines: limit }) });
    const ui = await setup(80, 38, {}, undefined, { configEditor: editor });
    const oldText = "old secret-sentinel";
    const newText = `${"x".repeat(290)}secret-sentinel tail`;
    ui.controller.applyEvent({ type: "tool.started", toolCallId: "clipped-secret", name: "edit" });
    ui.controller.applyEvent({ type: "tool.finished", toolCallId: "clipped-secret", name: "edit", status: "success", content: "Edited file.ts", details: { path: "file.ts", hunks: [{ startLine: 2, oldText, newText }] } });
    await settle(ui);
    expect(ui.captureCharFrame()).toContain("2 │-old ***");
    const entry = ui.controller.snapshot().transcript.find(item => item.toolCallId === "clipped-secret")!;
    expect(entry.resultSummary).toBe("+1 −1");
    expect(entry.text).toContain("*** ta");
    expect(JSON.stringify(entry)).not.toContain("secret-sentinel");
    expect(entry.text).not.toContain("secret-");
    limit = 0; await settle(ui);
    expect(ui.captureCharFrame()).not.toContain("2 │-old ***");
    ui.mockInput.pressKey("o", { ctrl: true }); await settle(ui);
    expect(ui.captureCharFrame()).toContain("2 │-old ***");
    expect(ui.captureCharFrame()).toContain("*** ta");
    limit = 12; await settle(ui);
    const row = ui.renderer.root.findDescendantById(`message-${entry.id}`)!;
    expect((row.getChildren()[0] as TextRenderable).plainText).not.toMatch(/[▸▾]/);
    expect(ui.captureCharFrame()).toContain("2 │-old ***");
  });
});

test("inline edits and created writes bound rendered text without changing raw counts or toggle eligibility", async () => {
  await withTempDir(async root => {
    const longLine = `${"x".repeat(290)}secret-sentinel${"x".repeat(5000)}RAWTAIL`;
    for (const variant of ["edit", "write", "high-limit"] as const) {
      const highLimit = variant === "high-limit";
      const content = highLimit ? Array.from({ length: 30 }, (_, i) => `${String(i + 1).padStart(2, "0")}:${"x".repeat(100)}`).join("\n") : longLine;
      const editor = await loadConfigEditor({ home: join(root, variant), workspaceRoot: root, cli: { ui: { inlineDiffLines: highLimit ? 100 : 12 } } });
      const ui = await setup(80, 30, {}, undefined, { configEditor: editor });
      const name = variant === "edit" ? "edit" : "write";
      ui.session.append({ type: "assistant", id: variant, content: [{ type: "tool_call", id: variant, name, arguments: { path: "file.ts", content } }] });
      ui.controller.applyEvent({ type: "tool.started", toolCallId: variant, name });
      ui.controller.applyEvent({ type: "tool.finished", toolCallId: variant, name, status: "success", content: "Changed file.ts", details: name === "edit"
        ? { path: "file.ts", hunks: [{ startLine: 1, oldText: "old", newText: content }] }
        : { created: true, lineCount: highLimit ? 30 : 1 } });
      await settle(ui);
      const entry = ui.controller.snapshot().transcript.find(item => item.toolCallId === variant)!;
      expect(entry.resultSummary).toBe(name === "edit" ? "+1 −1" : highLimit ? "new · 30 lines" : "new · 1 line");
      expect(entry.diffRows).toHaveLength(name === "edit" ? 2 : highLimit ? 30 : 1);
      const row = ui.renderer.root.findDescendantById(`message-${entry.id}`)!;
      const body = row.getChildren()[1]!.getChildren()[0] as TextRenderable;
      const shown = body.plainText.split("\n").map(line => line.trimEnd()).join("\n");
      expect((row.getChildren()[0] as TextRenderable).plainText).not.toMatch(/[▸▾]/);
      expect(shown).not.toContain("RAWTAIL");
      expect(shown).not.toContain("secret-");
      if (highLimit) {
        expect(shown).toContain("… truncated. Full output is in the session file.");
        expect(shown.length).toBeLessThanOrEqual(MAX_TOOL_DISPLAY_CHARS + "\n… truncated. Full output is in the session file.".length);
        expect(shown).not.toContain("30 │+");
      } else {
        expect(shown).toContain("***");
        expect(shown.split("\n").every(line => line.length <= 300)).toBe(true);
        expect(entry.diffRows!.at(-1)!.text).toContain("RAWTAIL");
      }
      ui.mockInput.pressKey("o", { ctrl: true }); await settle(ui);
      expect(body.plainText.split("\n").map(line => line.trimEnd()).join("\n")).toBe(shown);
      expect((row.getChildren()[0] as TextRenderable).plainText).not.toMatch(/[▸▾]/);
    }
  });
});

test("model picker preserves draft, owns navigation, and closes before cancelling a turn", async () => {
  const ui = await setup();
  await ui.mockInput.pasteBracketedText("my draft\nsecond line");
  ui.mockInput.pressKey("m", { meta: true });
  await settle(ui);
  expect(ui.captureCharFrame()).toContain("Choose model");
  expect(ui.editor.plainText).toBe("");
  ui.mockInput.pressArrow("down");
  await ui.mockInput.typeText("openai");
  expect(ui.controller.snapshot().modelPicker?.query).toBe("openai");
  ui.mockInput.pressEscape();
  await settle(ui);
  expect(ui.controller.snapshot().modelPicker).toBeUndefined();
  expect(ui.editor.plainText).toBe("my draft\nsecond line");
});

test("model picker hides disconnected routes and offers one connection action at narrow widths", async () => {
  for (const width of [80, 44]) {
    const ui = await setup(width, 28, { OPENAI_API_KEY: "picker-secret" });
    ui.controller.openModelPicker();
    await settle(ui);
    expect(ui.controller.snapshot().modelPicker!.entries.some(entry => entry.kind === "sign-in" || entry.authRoute === "codex")).toBe(false);
    expect(ui.controller.snapshot().modelPicker!.entries.filter(entry => entry.kind === "connect")).toHaveLength(1);
    expect(ui.captureCharFrame()).toContain("API key");
    expect(ui.captureCharFrame()).not.toContain("picker-secret");
    ui.controller.searchModels("gpt-4o");
    await settle(ui);
    expect(ui.captureCharFrame()).toContain("GPT-4o");
  }
});

test("keyboard connection at 44×18 restores the picker search and ordinary draft", async () => {
  const ui = await setup(44, 18);
  await ui.mockInput.pasteBracketedText("ordinary draft");
  ui.mockInput.pressKey("m", { meta: true });
  await waitForUiState(ui, () => !ui.controller.snapshot().modelPicker?.accessLoading, "model access discovery");
  ui.mockInput.pressEnter(); await settle(ui);
  await ui.mockInput.typeText("OpenAI API key");
  await settle(ui);
  expect(ui.captureCharFrame()).toContain("Connect a provider");
  ui.mockInput.pressEnter();
  await waitForUiState(ui, () => !!ui.controller.snapshot().credentialEntry, "credential entry");
  await ui.mockInput.pasteBracketedText("masked-route-secret");
  ui.mockInput.pressEnter();
  await waitForUiState(ui, () => !!ui.controller.snapshot().modelPicker && !ui.controller.snapshot().modelPicker?.loading, "model picker reload");
  await settle(ui);
  expect(ui.controller.snapshot().modelPicker?.query).toBe("OpenAI API key");
  expect(ui.captureCharFrame()).toContain("API key");
  expect(ui.captureCharFrame()).not.toContain("masked-route-secret");
  ui.mockInput.pressEscape();
  await settle(ui);
  expect(ui.editor.plainText).toBe("ordinary draft");
});

test("active OpenAI billing route stays visible at 80×24 and 44×18 after keyboard resize", async () => {
  const ui = await setup(80, 24, { OPENAI_API_KEY: "route-secret" });
  ui.controller.setModel(createScriptedModel({ provider: "openai", id: "gpt-5.4" }), "openai", "gpt-5.4");
  await settle(ui);
  expect(ui.captureCharFrame()).toContain("OpenAI API key");
  ui.mockInput.pressKey("m", { meta: true });
  await waitForUiState(ui, () => !ui.controller.snapshot().modelPicker?.accessLoading, "model access discovery");
  await ui.mockInput.typeText("gpt-5.4");
  await settle(ui);
  expect(ui.captureCharFrame()).not.toContain("configured, unverified");
  ui.resize(44, 18);
  await settle(ui);
  expect(ui.captureCharFrame()).toContain("OpenAI API key");
  expect(ui.captureCharFrame()).toContain("API key");
  expect(ui.captureCharFrame()).not.toContain("route-secret");
});

test("explicit API preference changes only through keyboard route selection at both terminal sizes", async () => {
  await withTempDir(async root => {
    const configEditor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root,
      cli: { provider: "openai", model: "gpt-5.4", openaiAuth: "api-key" } });
    const store = fakeCredentialStore();
    await store.set(codexSubscriptionIdentity(), "account-fixture");
    const env = { OPENAI_API_KEY: "environment-override-secret" };
    const workspace = { root: "/project", launchCwd: "/project", extraRoots: [] };
    const ui = await setup(80, 24, env, undefined, {
      provider: "openai", modelId: "gpt-5.4", openaiAuth: "api-key", configEditor,
      model: createScriptedModel({ provider: "openai", id: "gpt-5.4" }),
      credentials: { store, env, reload: async () => ({ error: "unused" }), listSubscriptionCatalog: async () => [{ id: "gpt-5.4", supportedThinking: [] }] },
      stageSettings: async settings => ({ model: createScriptedModel({ provider: settings.openaiAuth === "codex" ? "codex-subscription" : "openai", id: settings.model }), contextManager: createContextManager(workspace) }),
    });
    expect(ui.controller.snapshot().activeRoute).toBe("OpenAI API key");
    ui.mockInput.pressKey("m", { meta: true });
    await waitForUiState(ui, () => !ui.controller.snapshot().modelPicker?.loading, "model picker loading");
    await ui.mockInput.typeText("gpt-5.4");
    await settle(ui);
    expect(configEditor.settings.openaiAuth).toBe("api-key");
    expect(ui.captureCharFrame()).toContain("API key");
    expect(ui.captureCharFrame()).toContain("ChatGPT");
    ui.mockInput.pressArrow("up");
    ui.mockInput.pressEnter();
    await waitForUiState(ui, () => !ui.controller.snapshot().modelPicker, "model picker close");
    expect(ui.controller.snapshot().activeRoute).toBe("ChatGPT subscription");
    expect(configEditor.settings.openaiAuth).toBe("codex");
    ui.resize(44, 18);
    ui.mockInput.pressKey("m", { meta: true });
    await waitForUiState(ui, () => !ui.controller.snapshot().modelPicker?.loading, "model picker loading");
    await ui.mockInput.typeText("gpt-5.4");
    await settle(ui);
    expect(ui.captureCharFrame()).toContain("ChatGPT");
    ui.mockInput.pressArrow("down");
    ui.mockInput.pressEnter();
    await waitForUiState(ui, () => !ui.controller.snapshot().modelPicker, "model picker close");
    await settle(ui);
    expect(ui.controller.snapshot().activeRoute).toBe("OpenAI API key");
    expect(configEditor.settings.openaiAuth).toBe("api-key");
    expect(ui.captureCharFrame()).not.toContain("environment-override-secret");
  });
});

test("retry shortcut leaves ordinary r available in a failed-catalog search", async () => {
  const store = fakeCredentialStore();
  await store.set(codexSubscriptionIdentity(), "account-fixture");
  let calls = 0;
  const ui = await setup(44, 18, {}, undefined, {
    credentials: { store, env: {}, reload: async () => ({ error: "unused" }), listSubscriptionCatalog: async () => {
      calls++;
      if (calls === 1) throw new Error("network offline");
      return [];
    } },
  });
  ui.mockInput.pressKey("m", { meta: true });
  await waitForUiState(ui, () => !ui.controller.snapshot().modelPicker?.loading, "model picker loading");
  expect(ui.controller.snapshot().modelPicker?.error).toContain("Ctrl+R");
  await ui.mockInput.typeText("openroute");
  ui.mockInput.pressKey("r");
  await settle(ui);
  expect(ui.controller.snapshot().modelPicker?.query).toBe("openrouter");
  expect(calls).toBe(1);
  ui.mockInput.pressKey("r", { ctrl: true });
  await waitForUiState(ui, () => calls === 2 && !ui.controller.snapshot().modelPicker?.loading, "model picker retry");
  expect(ui.controller.snapshot().modelPicker?.query).toBe("openrouter");
});

test("slash completion uses Tab without sending a prompt; light theme updates a narrow terminal", async () => {
  const ui = await setup(44, 18);
  await ui.mockInput.typeText("/the");
  await settle(ui);
  expect(ui.captureCharFrame()).toContain("/theme");
  ui.mockInput.pressTab();
  expect(ui.editor.plainText).toBe("/theme ");
  await ui.mockInput.typeText("light");
  ui.mockInput.pressEnter();
  await settle(ui);
  expect(ui.session.items).toHaveLength(0);
  const mark = ui.renderer.root.findDescendantById("composer")?.getChildren()[0] as TextRenderable;
  await waitForUiState(ui, () => mark.fg.equals(RGBA.fromHex(TUI_THEMES.light.accent)), "light theme render");
  expect((ui.renderer.root.findDescendantById("composer") as BoxRenderable).backgroundColor.equals(RGBA.fromHex(TUI_THEMES.light.surface))).toBe(true);
  expect(ui.captureCharFrame()).toContain("Enter send");
  ui.resize(100, 30);
  await settle(ui);
  // The wide hint adds / commands; Ctrl+O tools waits for a tool row (tests/tui-tools-hint.test.ts).
  expect(ui.captureCharFrame()).toContain("Ctrl+F find · Alt+I inspect · / commands");
});

test("scrollback remains anchored while new messages arrive and Ctrl+End resumes following", async () => {
  const ui = await setup(70, 20);
  for (let i = 0; i < 30; i++) ui.controller.notice(`Message ${i}\nMore detail ${i}`);
  await settle(ui);
  ui.mockInput.pressKey("END", { ctrl: true });
  await settle(ui);
  await ui.mockInput.pressKeys(["\u001b[5~"]);
  await settle(ui);
  const top = ui.transcript.scrollTop;
  ui.controller.notice("NEW MESSAGE");
  await settle(ui);
  expect(ui.transcript.scrollTop).toBe(top);
  expect(ui.captureCharFrame()).toContain("New activity");
  ui.mockInput.pressKey("END", { ctrl: true });
  await settle(ui);
  expect(ui.captureCharFrame()).toContain("NEW MESSAGE");
  expect(ui.captureCharFrame()).not.toContain("New activity");
});

test("semantic text remains readable on both surfaces and Unicode clipping preserves graphemes", () => {
  function luminance(hex: string) {
    const rgb = hex.slice(1).match(/../g)!.map(channel => parseInt(channel, 16) / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
  }
  const contrast = (foreground: string, background: string) => {
    const values = [luminance(background), luminance(foreground)].sort((a, b) => a - b);
    return (values[1]! + 0.05) / (values[0]! + 0.05);
  };
  for (const theme of Object.values(TUI_THEMES)) {
    const semantic = [theme.accent, theme.success, theme.warning, theme.error, theme.code, theme.cyan, theme.violet];
    for (const background of [theme.background, theme.surface, theme.surface2]) {
      for (const foreground of [theme.text, theme.muted, ...semantic]) expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
    }
    // Tinted blocks (pills, diffs, selection) carry only body text or their own semantic color.
    for (const color of semantic) for (const base of [theme.surface, theme.surface2]) {
      expect(contrast(color, tint(theme, color, base))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.text, tint(theme, color, base))).toBeGreaterThanOrEqual(4.5);
    }
    for (const fill of [theme.accent, theme.warning, theme.error]) expect(contrast(theme.onFill, fill)).toBeGreaterThanOrEqual(4.5);
    const errorBlock = mixColor(theme.background, theme.error, 0.12);
    expect(contrast(theme.error, errorBlock)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(theme.text, errorBlock)).toBeGreaterThanOrEqual(4.5);
  }
  expect(resolveTheme("auto", "light", {})).toBe(TUI_THEMES.light);
  expect(resolveTheme("dark", "light", {})).toBe(TUI_THEMES.dark);
  expect(resolveTheme("auto", null, { COLORFGBG: "0;15" })).toBe(TUI_THEMES.light);
  expect(resolveTheme("dark", null, { NO_COLOR: "1" }).error).toBe(TUI_THEMES.dark.text);
  expect(Bun.stringWidth(fitLine("ข้อความภาษาไทย 👩‍💻 界界界", 12))).toBeLessThanOrEqual(12);
});

test("masked credential entry intercepts paste and restores a multiline draft without leaking input", async () => {
  const ui = await setup();
  await ui.mockInput.pasteBracketedText("keep my\ndraft");
  expect(ui.controller.beginLogin("openai")).toBe(true);
  await settle(ui);
  await ui.mockInput.pasteBracketedText("secret-sentinel");
  await settle(ui);
  expect(ui.captureCharFrame()).toContain("•");
  expect(ui.captureCharFrame()).not.toContain("secret-sentinel");
  expect(ui.editor.plainText).toBe("");
  ui.mockInput.pressEscape();
  await settle(ui);
  expect(ui.editor.plainText).toBe("keep my\ndraft");
  expect(ui.session.items).toHaveLength(0);
});

test("browser callback entry names Enter sign in · Esc cancel in the panel, hint row and compact status bar, and Esc changes nothing", async () => {
  for (const [width, height] of [[80, 24], [60, 12]] as const) {
    const ui = await setup(width, height);
    await ui.mockInput.pasteBracketedText("keep this draft");
    expect(await ui.controller.login("")).toBe(true);
    await settle(ui);
    ui.mockInput.pressTab(); await settle(ui);
    while (ui.controller.snapshot().loginChooser!.selectedId !== "chatgpt-callback") ui.mockInput.pressArrow("down");
    ui.mockInput.pressEnter(); await settle(ui);
    expect(ui.controller.snapshot().loginCallbackEntry).toBeDefined();
    const frame = ui.captureCharFrame();
    const rows = frame.trimEnd().split("\n").map(line => line.trim());
    expect(frame.replace(/\s+/g, " ")).toContain("Enter sign in · Esc cancel");
    expect(frame).not.toContain("Esc back");
    expect(frame).not.toContain("Esc cancels");
    expect(frame).not.toContain("Enter confirm");
    // The hint row repeats the panel's keys; below 14 rows the compact status bar names the same Esc verb.
    expect(rows.at(-1)).toBe(height < 14 ? "Auto · Esc cancel" : "Enter sign in · Esc cancel");
    ui.mockInput.pressEscape(); await settle(ui);
    expect(ui.controller.snapshot().loginCallbackEntry).toBeUndefined();
    expect(ui.controller.snapshot().transcript.at(-1)?.text).toBe("Callback entry cancelled; no credential was changed.");
    // Esc goes back to the chooser; leaving it returns the draft untouched.
    expect(ui.controller.snapshot().loginChooser).toMatchObject({ selectedId: "chatgpt-callback" });
    while (ui.controller.snapshot().loginChooser) { ui.mockInput.pressEscape(); await settle(ui); }
    expect(ui.editor.plainText).toBe("keep this draft");
  }
});

test("login chooser and masked callback use real keyboard and paste input while preserving a draft", async () => {
  const ui = await setup(48, 18);
  await ui.mockInput.pasteBracketedText("continue this task\nsecond line");
  ui.editor.cursorOffset = 8;
  expect(await ui.controller.login("")).toBe(true);
  await settle(ui);
  expect(ui.captureCharFrame()).toContain("Sign in");
  expect(ui.editor.plainText).toBe("");
  ui.mockInput.pressTab(); await settle(ui);
  while (ui.controller.snapshot().loginChooser!.selectedId !== "chatgpt-callback") ui.mockInput.pressArrow("down");
  ui.mockInput.pressEnter();
  await settle(ui);
  await ui.mockInput.pasteBracketedText("callback-secret-sentinel");
  await settle(ui);
  expect(ui.captureCharFrame()).not.toContain("callback-secret-sentinel");
  expect(JSON.stringify(ui.controller.snapshot())).not.toContain("callback-secret-sentinel");
  ui.resize(36, 16);
  await settle(ui);
  ui.mockInput.pressEscape(); await settle(ui);
  expect(ui.controller.snapshot().loginChooser).toMatchObject({ level: "chatgpt", selectedId: "chatgpt-callback" });
  ui.mockInput.pressEscape(); await settle(ui);
  expect(ui.controller.snapshot().loginChooser).toMatchObject({ level: "main", selectedId: "chatgpt" });
  ui.mockInput.pressEscape(); await settle(ui);
  expect(ui.editor.plainText).toBe("continue this task\nsecond line");
  expect(ui.editor.cursorOffset).toBe(8);
  expect(ui.session.items).toHaveLength(0);
  ui.mockInput.pressEnter();
  await ui.controller.waitForIdle();
  expect(ui.controller.running).toBe(false);
  await settle(ui);
  ui.mockInput.pressArrow("up");
  expect(ui.editor.plainText).toBe("continue this task\nsecond line");
  expect(ui.editor.plainText).not.toContain("callback-secret-sentinel");
});

test("xAI API key sits under OpenAI API key and Esc restores the draft at both sizes", async () => {
  for (const [width, height] of [[80, 24], [36, 16]] as const) {
    const ui = await setup(width, height);
    await ui.mockInput.pasteBracketedText("keep this draft");
    ui.editor.cursorOffset = 5;
    expect(await ui.controller.login("")).toBe(true);
    await settle(ui);
    while (ui.controller.snapshot().loginChooser!.selectedId !== "xai") ui.mockInput.pressArrow("down");
    await settle(ui);
    const frame = ui.captureCharFrame();
    const openai = frame.indexOf("OpenAI");
    const xai = frame.indexOf("xAI");
    expect(openai).toBeGreaterThanOrEqual(0);
    expect(xai).toBeGreaterThan(openai);
    ui.mockInput.pressEnter();
    await settle(ui);
    expect(ui.captureCharFrame()).toContain("API key · xAI");
    expect(ui.captureCharFrame()).toContain("Enter save · Esc cancel");
    // The hint row names the same Enter and Esc verbs as the entry, never the generic panel keys.
    const credentialRows = ui.captureCharFrame().split("\n").map(line => line.trim());
    expect(credentialRows.filter(line => line === "Enter save · Esc cancel")).toHaveLength(2);
    expect(ui.captureCharFrame()).not.toContain("Esc back");
    expect(ui.captureCharFrame()).not.toContain("Enter confirm");
    ui.mockInput.pressEscape();
    await settle(ui);
    expect(ui.controller.snapshot().loginChooser).toMatchObject({ level: "main", selectedId: "xai" });
    ui.mockInput.pressEscape(); await settle(ui);
    expect(ui.editor.plainText).toBe("keep this draft");
    expect(ui.editor.cursorOffset).toBe(5);
    expect(ui.controller.snapshot().credentialEntry).toBeUndefined();
  }
});

test("short API key entry names Esc cancel in the compact status bar, and Esc still saves nothing", async () => {
  const ui = await setup(60, 12);
  await ui.mockInput.pasteBracketedText("keep this draft");
  expect(await ui.controller.login("")).toBe(true);
  await settle(ui);
  while (ui.controller.snapshot().loginChooser!.selectedId !== "xai") ui.mockInput.pressArrow("down");
  ui.mockInput.pressEnter(); await settle(ui);
  expect(ui.controller.snapshot().credentialEntry).toBeDefined();
  const frame = ui.captureCharFrame();
  expect(frame.trimEnd().split("\n").at(-1)!.trim()).toBe("Auto · Esc cancel");
  expect(frame).not.toContain("Esc back");
  ui.mockInput.pressEscape(); await settle(ui);
  expect(ui.controller.snapshot().credentialEntry).toBeUndefined();
  expect(ui.controller.snapshot().loginChooser).toMatchObject({ level: "main", selectedId: "xai" });
  expect(ui.controller.snapshot().transcript.at(-1)?.text).toBe("Credential entry cancelled; nothing saved.");
});

test("/login without arguments reaches the chooser through editor dispatch", async () => {
  const ui = await setup();
  await ui.mockInput.typeText("/login");
  ui.mockInput.pressEnter();
  await waitForUiState(ui, () => !!ui.controller.snapshot().loginChooser, "login chooser");
  expect(ui.controller.snapshot().loginChooser).toBeDefined();
  expect(ui.captureCharFrame()).toContain("ChatGPT");
  ui.mockInput.pressEscape();
  await settle(ui);
  expect(ui.editor.plainText).toBe("");
  expect(ui.session.items).toHaveLength(0);
});

test("device approval code remains visible on a narrow terminal without entering notices", async () => {
  const ui = await setup(36, 16, {}, async ({ signal, onProgress }) => {
    onProgress("Enter this code at https://auth.openai.com/codex/device: ABCD-1234");
    await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    throw new Error("unreachable");
  });
  const pending = ui.controller.login("codex --device");
  await settle(ui);
  const flat = () => ui.captureCharFrame().replace(/\s+/g, "");
  // The address step comes before the code step, each with its verb, at every width.
  expect(ui.captureCharFrame()).toContain("2 Enter ABCD-1234");
  expect(flat().indexOf("1Openauth.openai.com/codex/device")).toBeGreaterThan(-1);
  expect(flat().indexOf("1Openauth.openai.com/codex/device")).toBeLessThan(flat().indexOf("2EnterABCD-1234"));
  ui.resize(24, 8);
  await settle(ui);
  expect(ui.captureCharFrame()).toContain("ABCD-1234");
  expect(flat().indexOf("1Openauth.openai.com/codex/device")).toBeGreaterThan(-1);
  expect(flat().indexOf("1Openauth.openai.com/codex/device")).toBeLessThan(flat().indexOf("2EnterABCD-1234"));
  expect(JSON.stringify(ui.controller.snapshot().transcript)).not.toContain("ABCD-1234");
  ui.mockInput.pressEscape();
  expect(await pending).toBe(false);
});

test("streaming Markdown renders lists, links, and tables offline before and after finalization", async () => {
  const ui = await setup(100, 35);
  const text = "## Progress\n\n- **Checked** the file\n- `status` is ready\n\n> A readable quote\n\n[Documentation](https://example.test)\n\n| Name | Result |\n| --- | --- |\n| Check | Passed |";
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text } });
  await settle(ui);
  const frame = ui.captureCharFrame();
  for (const expected of ["Progress", "Checked", "status", "A readable quote", "Documentation", "https://example.test", "Passed"]) expect(frame).toContain(expected);
  expect(frame).not.toContain("**Checked**");
  ui.controller.applyEvent({ type: "model.finished" });
  await settle(ui);
  expect(ui.captureCharFrame()).toContain("Passed");
});

test("branch navigation keeps draft separate from its preview and returns to the conversation", async () => {
  const ui = await setup();
  await ui.mockInput.typeText("first prompt");
  ui.mockInput.pressEnter();
  await ui.controller.waitForIdle();
  await settle(ui);
  const originalBranch = ui.session.activeBranchId;
  await ui.mockInput.typeText("keep this draft");
  expect(ui.controller.openBranchTree()).toBe(true);
  await settle(ui);
  expect(ui.captureCharFrame()).toContain("Conversation branches");
  expect(ui.editor.plainText).toBe("");
  ui.mockInput.pressTab();
  await settle(ui);
  const before = ui.controller.snapshot().branchTree?.selectedId;
  ui.mockInput.pressArrow("up");
  await settle(ui);
  expect(ui.controller.snapshot().branchTree?.selectedId).not.toBe(before);
  expect(ui.session.activeBranchId).toBe(originalBranch);
  ui.mockInput.pressEscape();
  await settle(ui);
  expect(ui.editor.plainText).toBe("keep this draft");
  expect(ui.captureCharFrame()).not.toContain("Conversation branches");
  expect(ui.captureCharFrame()).toContain("first prompt");
});

test("live and resumed tool targets redact secrets before display clipping", async () => {
  const ui = await setup(44, 18);
  const command = `${"a".repeat(148)} secret-sentinel`;
  ui.session.append({ type: "assistant", id: "call-record", content: [{ type: "tool_call", id: "long-call", name: "bash", arguments: { command } }] });
  ui.controller.applyEvent({ type: "tool.started", toolCallId: "long-call", name: "bash" });
  expect(ui.controller.snapshot().transcript.at(-1)?.toolSummary).toBe(`${"a".repeat(148)} ***`);
  expect(buildTranscriptFromSession(ui.session.items).at(-1)?.toolSummary).toBe(command);
  await settle(ui);
  expect(ui.captureCharFrame()).not.toContain("secret");
  expect(ui.captureCharFrame()).toContain("running");
});

test("resize keeps the editor and status inside the viewport with a populated transcript and open picker", async () => {
  const ui = await setup(100, 32);
  for (let i = 0; i < 25; i++) ui.controller.notice(`Message ${i}: ${"wrapped output ".repeat(15)}`);
  await ui.mockInput.pasteBracketedText("draft line\n".repeat(8));
  ui.mockInput.pressKey("m", { meta: true });
  await settle(ui);
  for (const [width, height] of [[60, 20], [42, 12], [24, 8], [30, 10], [40, 14], [100, 32], [42, 12], [120, 40]]) {
    ui.resize(width!, height!);
    await settle(ui);
    const composer = ui.renderer.root.findDescendantById("composer")!;
    const footer = ui.renderer.root.findDescendantById("footer")!;
    expect(composer.y + composer.height, `composer at ${width}x${height}`).toBeLessThanOrEqual(height!);
    expect(footer.y + footer.height, `footer at ${width}x${height}`).toBeLessThanOrEqual(height!);
    expect(ui.captureCharFrame(), `mode at ${width}x${height}`).toContain("Auto");
    expect(ui.captureCharFrame(), `panel exit at ${width}x${height}`).toContain("Esc back");
  }
  ui.mockInput.pressEscape();
  await settle(ui);
  expect(ui.editor.plainText).toBe("draft line\n".repeat(8));
});

test("retry and cancellation stay visible at 44×18 while a future draft survives paste, scroll and resize", async () => {
  const retryStarted = Promise.withResolvers<void>();
  let releaseSettlement!: () => void;
  const settlement = new Promise<void>(resolve => { releaseSettlement = resolve; });
  const ui = await setup(80, 24, {}, undefined, {
    onRuntimeEvent: event => { if (event.type === "model.retry") retryStarted.resolve(); },
    model: createScriptedModel({ error: "temporary outage", status: 503, headers: { "Retry-After": "30" } }),
    agentClock: {
      now: () => 0,
      sleep: (_ms, signal) => new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          void settlement.then(() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }, { once: true });
      }),
    },
  }, undefined, { NO_COLOR: "1" });
  await ui.mockInput.typeText("start work");
  ui.mockInput.pressEnter();
  await retryStarted.promise;
  expect(ui.controller.snapshot().activity?.phase).toBe("retry");
  await ui.mockInput.pasteBracketedText("future draft\nsecond line");
  await ui.mockInput.pressKeys(["\u001b[5~"]);
  ui.resize(44, 18);
  await settle(ui);
  const operationId = ui.controller.snapshot().activity?.operationId;
  const draftCursor = ui.editor.cursorOffset;
  ui.renderer.emit("theme_mode");
  await settle(ui);
  expect(ui.controller.snapshot().activity?.operationId).toBe(operationId);
  expect(ui.editor.cursorOffset).toBe(draftCursor);
  expect(ui.captureCharFrame()).toContain("Attempt 2/3");
  expect(ui.captureCharFrame()).not.toContain("Retry 2/3");
  // The visible hint row owns the stop key; the status bar spends that width on the model.
  expect((ui.renderer.root.findDescendantById("footer") as TextRenderable).plainText).not.toContain("Esc");
  expect((ui.renderer.root.findDescendantById("hints") as TextRenderable).plainText).toContain("Esc stop");
  expect(ui.editor.plainText).toBe("future draft\nsecond line");
  ui.mockInput.pressEscape();
  await ui.flush();
  expect(ui.captureCharFrame()).toContain("Stop requested");
  expect(ui.controller.snapshot().activity?.cancellation).toBe("settling");
  ui.view.refresh();
  await ui.flush();
  expect(ui.captureCharFrame()).toContain("Stopping");
  expect(ui.captureCharFrame()).not.toContain("Cancel requested");
  releaseSettlement();
  await ui.controller.waitForIdle();
  await settle(ui);
  expect(ui.editor.plainText).toBe("future draft\nsecond line");
  expect(ui.captureCharFrame()).toContain("Ready");
});

test("real renderer replaces failed stream and preserves an earlier reading position", async () => {
  let releaseRetry!: () => void;
  const retry = new Promise<void>(resolve => { releaseRetry = resolve; });
  const retryStarted = Promise.withResolvers<void>();
  const ui = await setup(80, 24, {}, undefined, {
    onRuntimeEvent: event => { if (event.type === "model.retry") retryStarted.resolve(); },
    model: createScriptedModel({ responses: [
      { chunks: ["Hel"], error: "busy", status: 503, throwAfter: "chunks" },
      { chunks: ["Hello world"] },
    ] }),
    agentClock: { now: () => 0, sleep: async () => { await retry; } },
  });
  for (let i = 0; i < 65; i++) ui.controller.notice(`Earlier message ${i}`);
  await ui.mockInput.pasteBracketedText("hello");
  ui.mockInput.pressEnter();
  await retryStarted.promise;
  await settle(ui);
  expect(ui.captureCharFrame()).toContain("Hel");
  expect(ui.controller.snapshot().transcript.filter(entry => entry.kind === "assistant")).toMatchObject([{ text: "Hel", incomplete: true }]);
  for (let i = 0; i < 3; i++) await ui.mockInput.pressKeys(["\u001b[5~"]);
  await settle(ui);
  const visible = () => ui.captureCharFrame().split("\n").slice(ui.transcript.y, ui.transcript.y + ui.transcript.height).map(line => line.slice(ui.transcript.x, ui.transcript.x + ui.transcript.viewport.width)).join("\n");
  const before = visible();
  const top = ui.transcript.scrollTop;
  expect(before).toContain("Earlier message");
  ui.resize(44, 18);
  await settle(ui);
  releaseRetry();
  await ui.controller.waitForIdle();
  await settle(ui);
  expect(ui.controller.snapshot().transcript.filter(entry => entry.kind === "assistant").map(entry => entry.text)).toEqual(["Hello world"]);
  expect(ui.captureCharFrame()).not.toContain("HelHello world");
  expect(ui.transcript.scrollTop).toBeLessThan(ui.transcript.scrollHeight - ui.transcript.viewport.height);
  ui.resize(80, 24);
  await settle(ui);
  expect(ui.transcript.scrollTop).toBe(top);
  expect(visible()).toBe(before);
  ui.mockInput.pressKey("END", { ctrl: true });
  await settle(ui);
  expect(ui.captureCharFrame()).toContain("Hello world");
  expect(ui.captureCharFrame()).not.toContain("HelHello world");
});

test("overflow does not change the conversation width or rewrap earlier messages", async () => {
  const ui = await setup(70, 20);
  ui.controller.notice("A short first message");
  await settle(ui);
  const width = ui.transcript.viewport.width;
  for (let i = 0; i < 30; i++) ui.controller.notice(`Message ${i}`);
  await settle(ui);
  expect(ui.transcript.viewport.width).toBe(width);
});

test("mouse and keyboard scrolling keep a long Markdown transcript stable across idle refreshes", async () => {
  const ui = await setup(80, 28);
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: Array.from({ length: 100 }, (_, i) => `Paragraph ${String(i).padStart(3, "0")} — ${"content ".repeat(12)}\n\n`).join("") } });
  ui.controller.applyEvent({ type: "model.finished" });
  await settle(ui);
  ui.mockInput.pressKey("END", { ctrl: true });
  await settle(ui);
  for (let i = 0; i < 15; i++) {
    if (i % 2) await ui.mockInput.pressKeys(["\u001b[5~"]);
    else await ui.mockMouse.scroll(ui.transcript.x + 5, ui.transcript.y + 5, "up");
    await settle(ui);
    const top = ui.transcript.scrollTop;
    const frame = ui.captureCharFrame();
    for (let tick = 0; tick < 4; tick++) await settle(ui);
    expect(ui.transcript.scrollTop, `scroll position at step ${i}`).toBe(top);
    expect(ui.captureCharFrame(), `frame at step ${i}`).toBe(frame);
    expect(ui.editor.plainText).toBe("");
  }
});

test("scrolling through a streaming answer preserves the visible text while its tail grows", async () => {
  const streamed = Promise.withResolvers<void>();
  const ui = await setup(70, 20, {}, undefined, { onRuntimeEvent: event => {
    if (event.type === "model.delta" && event.content.type === "text" && event.content.text.includes("Paragraph 59")) streamed.resolve();
  } });
  ui.controller.setModel(createScriptedModel({ text: Array.from({ length: 60 }, (_, i) => `Paragraph ${i}\n\n`).join(""), waitForAbort: true }), "scripted", "streaming-model");
  const turn = ui.controller.submit("Stream a long answer");
  await streamed.promise;
  expect(ui.controller.snapshot().transcript.at(-1)?.text).toContain("Paragraph 59");
  await settle(ui);
  expect(ui.controller.snapshot().status).toBe("running");
  await ui.mockInput.pressKeys(["\u001b[5~"]);
  await settle(ui);
  // The scrollbar thumb changes size as content grows; the text must not move.
  const visible = () => ui.captureCharFrame().split("\n").slice(ui.transcript.y, ui.transcript.y + ui.transcript.height).map(line => line.slice(ui.transcript.x, ui.transcript.x + ui.transcript.viewport.width)).join("\n");
  const before = visible();
  expect(before).toContain("Paragraph");
  const top = ui.transcript.scrollTop;
  for (let i = 0; i < 10; i++) {
    ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: `More content ${i}\n\n` } });
    await settle(ui);
    expect(ui.transcript.scrollTop).toBe(top);
    expect(visible()).toBe(before);
  }
  ui.controller.cancel();
  await turn;
});

test("wheel scrolling over the footer navigates the conversation without moving the draft", async () => {
  const ui = await setup(70, 20);
  for (let i = 0; i < 30; i++) ui.controller.notice(`Message ${i}`);
  await ui.mockInput.pasteBracketedText("keep my draft");
  await settle(ui);
  const before = ui.transcript.scrollTop;
  const footer = ui.renderer.root.findDescendantById("footer")!;
  await ui.mockMouse.scroll(footer.x + 5, footer.y, "up");
  await settle(ui);
  expect(ui.transcript.scrollTop).toBeLessThan(before);
  expect(ui.editor.plainText).toBe("keep my draft");
});

test("Ctrl+L resets terminal output without losing the draft, scrollback or picker", async () => {
  const ui = await setup();
  for (let i = 0; i < 30; i++) ui.controller.notice(`Message ${i}`);
  await ui.mockInput.pasteBracketedText("เก็บข้อความนี้\nsecond line");
  await settle(ui);
  await ui.mockInput.pressKeys(["\u001b[5~"]);
  await settle(ui);
  const top = ui.transcript.scrollTop;
  const frame = ui.captureCharFrame();
  ui.mockInput.pressKey("l", { ctrl: true });
  await settle(ui);
  expect(ui.editor.plainText).toBe("เก็บข้อความนี้\nsecond line");
  expect(ui.transcript.scrollTop).toBe(top);
  expect(ui.captureCharFrame()).toBe(frame);
  ui.mockInput.pressKey("m", { meta: true });
  await settle(ui);
  ui.mockInput.pressKey("l", { ctrl: true });
  await settle(ui);
  expect(ui.controller.snapshot().modelPicker).toBeDefined();
  ui.mockInput.pressEscape();
  await settle(ui);
  expect(ui.editor.plainText).toBe("เก็บข้อความนี้\nsecond line");
});


/** Build isolated preferences with a scripted model and real keyboard renderer. */
async function preferenceFixture(root: string, extra: Partial<TuiControllerOptions> = {}, cli: Parameters<typeof loadConfigEditor>[0]["cli"] = {}, viewEnv: Record<string, string> = {}) {
  const home = join(root, "home"), workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const workspace = { root: workspaceRoot, launchCwd: workspaceRoot, extraRoots: [] };
  const configEditor = await loadConfigEditor({ home, workspaceRoot, cli, interactiveMemory: true });
  const settings = configEditor.settings;
  const ui = await setup(80, 28, {}, undefined, { workspace, configEditor, provider: settings.provider, modelId: settings.model,
    model: createScriptedModel({ provider: settings.provider, id: settings.model }),
    stageSettings: async next => ({ model: createScriptedModel({ provider: next.provider, id: next.model }), contextManager: createContextManager(workspace) }), ...extra }, undefined, viewEnv);
  return { ...ui, home, workspaceRoot, configEditor };
}

/** Press Enter and wait for preference staging or confirmation to settle. */
async function preferenceEnter(ui: Awaited<ReturnType<typeof preferenceFixture>>) {
  ui.mockInput.pressEnter();
  // Renderer-idle passes do not wait for filesystem fsync/rename or model staging.
  await ui.controller.waitForIdle();
  expect(ui.controller.running).toBe(false);
  ui.view.refresh();
  await ui.flush();
}

/** Open Advanced through the same keyboard action available to users. */
async function advancedPreferences(ui: Awaited<ReturnType<typeof preferenceFixture>>) {
  const panel = ui.controller.snapshot().preferences!;
  const index = panel.rows.findIndex(row => row.action === "advanced");
  for (let n = panel.selectedIndex; n < index; n++) ui.mockInput.pressArrow("down");
  await preferenceEnter(ui);
  expect(ui.controller.snapshot().preferences?.page).toBe("advanced");
}

test("basic preferences list ordinary settings and open model or connections before login", async () => {
  await withTempDir(async root => {
    const ui = await preferenceFixture(root, { model: undefined, stageSettings: undefined }, {}, { NO_COLOR: "1" });
    await ui.mockInput.pasteBracketedText("keep this task ไทย");
    ui.editor.cursorOffset = 4;
    ui.mockInput.pressKey("p", { meta: true }); await settle(ui);
    const frame = ui.captureCharFrame();
    for (const label of ["Model", "Thinking", "Connections", "Appearance", "Welcome screen", "Advanced"]) expect(frame).toContain(label);
    for (const key of ["maxOutput", "openaiAuth", "xaiAuth", "maxTurns", "profile"]) expect(frame).not.toContain(key);
    await preferenceEnter(ui);
    expect(ui.controller.snapshot().modelPicker).toBeDefined();
    ui.mockInput.pressEscape(); await settle(ui);
    ui.mockInput.pressKey("p", { meta: true });
    ui.mockInput.pressArrow("down"); ui.mockInput.pressArrow("down"); await preferenceEnter(ui);
    expect(ui.controller.snapshot().loginChooser).toBeDefined();
    ui.mockInput.pressEscape(); await settle(ui);
    expect(ui.editor.plainText).toBe("keep this task ไทย"); expect(ui.editor.cursorOffset).toBe(4);
    ui.mockInput.pressKey("p", { meta: true });
    for (let n = 0; n < 3; n++) ui.mockInput.pressArrow("down");
    ui.mockInput.pressArrow("right"); ui.mockInput.pressArrow("right");
    await preferenceEnter(ui);
    expect(ui.configEditor.settings.appearance).toBe("auto");
    await preferenceEnter(ui);
    expect(ui.configEditor.settings.appearance).toBe("dark");
    expect(await readdir(ui.workspaceRoot)).toEqual([]);
  });
});

test("basic Thinking previews and applies a supported effort without duplicating model rows", async () => {
  await withTempDir(async root => {
    const ui = await preferenceFixture(root, {}, { provider: "openai", model: "gpt-5.4" });
    ui.mockInput.pressKey("p", { meta: true }); ui.mockInput.pressArrow("down"); await settle(ui);
    const panel = ui.controller.snapshot().preferences!;
    const row = panel.rows[panel.selectedIndex]!;
    expect(row.key).toBe("thinking");
    expect(panel.rows.filter(item => item.key === "model")).toHaveLength(1);
    const low = row.choices.indexOf("low");
    expect(low).toBeGreaterThan(0);
    for (let n = 0; n < low; n++) ui.mockInput.pressArrow("right");
    await preferenceEnter(ui);
    expect(ui.controller.snapshot().preferences?.preview).toContain("Thinking: low");
    expect(ui.configEditor.settings.thinking).toBeUndefined();
    await preferenceEnter(ui);
    expect(ui.configEditor.settings.thinking).toBe("low");
    expect(ui.captureCharFrame()).toContain("Saved here: low");
    for (let n = 0; n < low; n++) ui.mockInput.pressArrow("left");
    await preferenceEnter(ui); await preferenceEnter(ui);
    expect(ui.configEditor.settings.thinking).toBeUndefined();
  });
});

test("Basic preview explains ineffective saves plainly while Advanced keeps source evidence", async () => {
  await withTempDir(async root => {
    const ui = await preferenceFixture(root, {}, { appearance: "dark" });
    ui.mockInput.pressKey("p", { meta: true }); ui.mockInput.pressTab();
    for (let n = 0; n < 3; n++) ui.mockInput.pressArrow("down");
    for (let n = 0; n < 3; n++) ui.mockInput.pressArrow("right");
    await preferenceEnter(ui);
    const preview = ui.controller.snapshot().preferences?.preview;
    expect(preview).toContain("Save for all workspaces");
    expect(preview).toContain("Appearance: light");
    expect(preview).toContain("Effective after save: dark");
    expect(preview).toContain("Saved but not effective: overridden by launch options");
    for (const raw of ["CLI", "user-global", "current-session override", "["]) expect(preview).not.toContain(raw);
    expect(ui.configEditor.settings.appearance).toBe("dark");
    ui.mockInput.pressEscape();
    await advancedPreferences(ui);
    const index = ui.controller.snapshot().preferences!.rows.findIndex(row => row.key === "appearance");
    for (let n = 0; n < index; n++) ui.mockInput.pressArrow("down");
    for (let n = 0; n < 3; n++) ui.mockInput.pressArrow("right");
    await preferenceEnter(ui);
    expect(ui.controller.snapshot().preferences?.preview).toContain("Effective after save: dark [CLI]");
    expect(ui.controller.snapshot().preferences?.preview).toContain("Saved but not effective: shadowed by CLI");
  });
});

test("advanced model choice agrees with panel and footer hints while reset previews", async () => {
  await withTempDir(async root => {
    const ui = await preferenceFixture(root, {}, { provider: "openai", model: "gpt-5.4" });
    ui.mockInput.pressKey("p", { meta: true });
    await advancedPreferences(ui);
    const index = ui.controller.snapshot().preferences!.rows.findIndex(row => row.key === "model");
    for (let n = 0; n < index; n++) ui.mockInput.pressArrow("down");
    await settle(ui);
    expect(ui.captureCharFrame().match(/Enter preview/g)?.length).toBeGreaterThanOrEqual(2);
    await preferenceEnter(ui);
    expect(ui.controller.snapshot().preferences?.preview).toContain("Reset (inherit)");
    expect(ui.controller.snapshot().modelPicker).toBeUndefined();
    ui.mockInput.pressEscape(); ui.mockInput.pressArrow("right"); await settle(ui);
    const frame = ui.captureCharFrame();
    expect(frame.match(/Enter open/g)?.length).toBeGreaterThanOrEqual(2);
    expect(frame).not.toContain("Enter preview");
    await preferenceEnter(ui);
    expect(ui.controller.snapshot().preferences).toBeUndefined();
    expect(ui.controller.snapshot().modelPicker).toBeDefined();
    expect(ui.configEditor.settings.model).toBe("gpt-5.4");
  });
});

test("advanced preferences return to basic and keep numeric settings out of the basic list", async () => {
  await withTempDir(async root => {
    const ui = await preferenceFixture(root);
    ui.mockInput.pressKey("p", { meta: true });
    await advancedPreferences(ui);
    ui.mockInput.pressArrow("down"); await settle(ui);
    expect(ui.captureCharFrame()).toContain("› Turn limit");
    expect(ui.controller.snapshot().preferences?.rows.some(row => row.key === "maxOutput")).toBe(true);
    ui.mockInput.pressTab(); await settle(ui);
    expect(ui.controller.snapshot().preferences?.scope).toBe("memory");
    ui.mockInput.pressEscape(); await settle(ui);
    expect(ui.controller.snapshot().preferences?.page).toBe("basic");
    expect(ui.controller.snapshot().preferences?.scope).toBe("session");
    for (const scope of ["user", "project", "session"] as const) {
      ui.mockInput.pressTab(); await settle(ui);
      expect(ui.controller.snapshot().preferences?.scope).toBe(scope);
      expect(ui.controller.snapshot().preferences?.rows[0]?.label).toBe("Model");
    }
    ui.mockInput.pressTab({ shift: true }); await settle(ui);
    expect(ui.controller.snapshot().preferences?.scope).toBe("project");
    expect(ui.controller.snapshot().preferences?.rows.some(row => row.key === "maxOutput")).toBe(false);
    ui.mockInput.pressEscape(); await settle(ui);
    expect(ui.controller.snapshot().preferences).toBeUndefined();
  });
});

test("appearance preference persists across launch and environment override keeps its source visible", async () => {
  await withTempDir(async root => {
    const ui = await preferenceFixture(root);
    await ui.mockInput.pasteBracketedText("ไทย 中文 👩‍💻 e\u0301 draft");
    ui.editor.cursorOffset = 4;
    ui.mockInput.pressKey("p", { meta: true }); await settle(ui);
    ui.mockInput.pressTab(); await settle(ui);
    const rowIndex = ui.controller.snapshot().preferences?.rows.findIndex(row => row.key === "appearance");
    expect(rowIndex).toBeGreaterThanOrEqual(0);
    for (let index = 0; index < rowIndex!; index++) ui.mockInput.pressArrow("down");
    ui.mockInput.pressArrow("right"); ui.mockInput.pressArrow("right");
    await preferenceEnter(ui); await preferenceEnter(ui);
    expect(ui.configEditor.settings.appearance).toBe("dark");
    expect((ui.renderer.root.findDescendantById("conversation") as BoxRenderable).backgroundColor.equals(RGBA.fromHex(TUI_THEMES.dark.background))).toBe(true);
    expect(JSON.parse(await readFile(join(ui.home, ".schway/config.json"), "utf8")).appearance).toBe("dark");
    ui.resize(32, 12); await settle(ui);
    ui.mockInput.pressEscape(); await settle(ui);
    expect(ui.editor.plainText).toBe("ไทย 中文 👩‍💻 e\u0301 draft");
    expect(ui.editor.cursorOffset).toBe(4);

    const reopened = await preferenceFixture(root, {}, {}, { SCHWAY_THEME: "light" });
    expect(reopened.configEditor.settings.appearance).toBe("dark");
    expect((reopened.renderer.root.findDescendantById("conversation") as BoxRenderable).backgroundColor.equals(RGBA.fromHex(TUI_THEMES.light.background))).toBe(true);
    reopened.mockInput.pressKey("p", { meta: true }); await settle(reopened);
    const appearance = reopened.controller.snapshot().preferences?.rows.find(row => row.key === "appearance");
    expect(appearance).toMatchObject({ value: "light", origin: "environment", saved: expect.stringContaining("user config=dark") });
    reopened.mockInput.pressTab();
    for (let index = 0; index < rowIndex!; index++) reopened.mockInput.pressArrow("down");
    await preferenceEnter(reopened); await preferenceEnter(reopened);
    expect(JSON.parse(await readFile(join(reopened.home, ".schway/config.json"), "utf8")).appearance).toBeUndefined();
    expect(reopened.configEditor.settings.appearance).toBe("auto");
    reopened.mockInput.pressArrow("right");
    await preferenceEnter(reopened); await preferenceEnter(reopened);
    expect(JSON.parse(await readFile(join(reopened.home, ".schway/config.json"), "utf8")).appearance).toBe("auto");
    reopened.mockInput.pressArrow("right"); reopened.mockInput.pressArrow("right");
    await preferenceEnter(reopened); await preferenceEnter(reopened);
    expect(JSON.parse(await readFile(join(reopened.home, ".schway/config.json"), "utf8")).appearance).toBe("light");
  });
});

test("narrow preferences keep the selected field and keyboard choice visible without color", async () => {
  await withTempDir(async root => {
    const ui = await preferenceFixture(root, {}, {}, { NO_COLOR: "1" });
    await ui.mockInput.pasteBracketedText("draft 日本語");
    ui.editor.cursorOffset = 3;
    ui.resize(32, 12);
    ui.mockInput.pressKey("p", { meta: true }); await settle(ui);
    const frame = ui.captureCharFrame();
    expect(frame).toContain("› Model");
    expect(frame).toContain("Enter open");
    ui.mockInput.pressArrow("down"); await settle(ui);
    expect(ui.captureCharFrame()).toContain("› Thinking");
    ui.resize(80, 24); await settle(ui);
    ui.mockInput.pressArrow("right"); await preferenceEnter(ui);
    ui.resize(32, 12); await settle(ui);
    expect(ui.captureCharFrame()).toContain("› Thinking");
    expect(ui.captureCharFrame()).toContain("Enter save ·");
    ui.mockInput.pressEscape(); ui.mockInput.pressEscape(); await settle(ui);
    expect(ui.editor.plainText).toBe("draft 日本語");
    expect(ui.editor.cursorOffset).toBe(3);
    ui.editor.setText("/theme wrong");
    ui.mockInput.pressEscape(); await settle(ui);
    ui.mockInput.pressEnter(); await settle(ui);
    expect(ui.captureCharFrame()).toContain("! Error");
    expect(ui.captureCharFrame()).toContain("Usage: /theme [");
    expect(ui.captureCharFrame()).toContain("auto|dark|light]");
    expect(ui.captureCharFrame()).toContain("Auto · Enter send");
    expect(ui.editor.plainText).toBe("/theme wrong");
  });
});

test("long configured values do not hide the keyboard choice on the smallest panel", async () => {
  await withTempDir(async root => {
    await mkdir(join(root, "home/.schway"), { recursive: true });
    await writeFile(join(root, "home/.schway/config.json"), JSON.stringify({ model: "very-long-" + "model-id-".repeat(16) }));
    const ui = await preferenceFixture(root);
    ui.resize(24, 8);
    ui.mockInput.pressKey("p", { meta: true }); await settle(ui);
    const modelIndex = ui.controller.snapshot().preferences!.rows.findIndex(row => row.key === "model");
    for (let index = 0; index < modelIndex; index++) ui.mockInput.pressArrow("down");
    await settle(ui);
    expect(ui.captureCharFrame()).toContain("› Model");
    expect(ui.captureCharFrame()).toContain("Enter open");
  });
});

test("compact preferences show project scope and confirmation before a write", async () => {
  await withTempDir(async root => {
    const ui = await preferenceFixture(root);
    ui.resize(24, 8);
    ui.mockInput.pressKey("p", { meta: true }); await settle(ui);
    ui.mockInput.pressTab(); await settle(ui);
    expect(ui.controller.snapshot().preferences?.scope).toBe("user");
    ui.mockInput.pressTab(); await settle(ui);
    expect(ui.controller.snapshot().preferences?.scope).toBe("project");
    expect(ui.captureCharFrame()).toContain("project");
    ui.mockInput.pressArrow("down"); ui.mockInput.pressArrow("right");
    await preferenceEnter(ui);
    expect(ui.controller.snapshot().preferences?.preview).not.toContain("Esc");
    expect(ui.captureCharFrame()).toContain("Enter save ·");
    await preferenceEnter(ui);
    const applied = ui.controller.snapshot().transcript.at(-1)?.text ?? "";
    expect(applied).toEndWith(" Applied.");
    expect(applied).not.toContain("Esc cancel");
  });
});

test("a staged preference preview names Esc cancel on every row and the status bar, once per row, until Esc clears it", async () => {
  await withTempDir(async root => {
    const ui = await preferenceFixture(root);
    ui.mockInput.pressKey("p", { meta: true }); await settle(ui);
    ui.mockInput.pressArrow("down"); ui.mockInput.pressArrow("right"); await preferenceEnter(ui);
    expect(ui.controller.snapshot().preferences?.preview).toContain("Effective after save:");
    for (const [width, height] of [[80, 28], [60, 12]] as const) {
      ui.resize(width, height); await settle(ui);
      const rows = ui.captureCharFrame().split("\n").map(line => line.trim()).filter(Boolean);
      // Esc clears only the staged preview, so no row may promise that it leaves the panel.
      expect(rows.join("\n")).toContain("Esc cancel");
      expect(rows.join("\n")).not.toContain("Esc back");
      expect(rows.join("\n")).not.toContain("Enter preview");
      expect(rows.some((line, index) => index > 0 && line === rows[index - 1])).toBe(false);
      if (height < 14) expect(rows.at(-1)).toBe("Auto · Esc cancel");
    }
    ui.resize(80, 28); await settle(ui);
    expect(ui.captureCharFrame().split("\n").filter(line => line.trim() === "Enter confirm · Esc cancel")).toHaveLength(2);
    ui.mockInput.pressEscape(); await settle(ui);
    expect(ui.controller.snapshot().preferences).toBeDefined();
    expect(ui.controller.snapshot().preferences?.preview).toBeUndefined();
    expect(ui.captureCharFrame()).not.toContain("Esc cancel");
    expect(ui.captureCharFrame()).toContain("↑↓ select · Tab scope · Esc back");
    ui.mockInput.pressEscape(); await settle(ui);
    expect(ui.controller.snapshot().preferences).toBeUndefined();
  });
});

test("a staged preview at 36 columns never clips an Esc verb against the preferences scrollbar", async () => {
  await withTempDir(async root => {
    const ui = await preferenceFixture(root);
    ui.resize(36, 16);
    ui.mockInput.pressKey("p", { meta: true }); await settle(ui);
    ui.mockInput.pressArrow("down"); ui.mockInput.pressArrow("right"); await preferenceEnter(ui);
    for (const page of [0, 1]) {
      if (page) { ui.mockInput.pressKey("pagedown"); await settle(ui); }
      // Strip the scrollbar column so a phrase that word-wraps is read across its line break.
      const rows = ui.captureCharFrame().split("\n").map(line => line.replace(/[\s█▀▄]+$/, ""));
      expect(rows.join("\n")).not.toMatch(/Esc cance(?!l)/);
      expect(escPhraseProblems(rows)).toEqual([]);
    }
    expect(ui.captureCharFrame().replace(/\s+/g, " ")).toContain("Tab scope · Esc cancel");
  });
});

test("appearance edit rejects externally changed runtime settings", async () => {
  await withTempDir(async root => {
    const ui = await preferenceFixture(root);
    const path = join(ui.workspaceRoot, ".schway/config.json");
    await mkdir(join(ui.workspaceRoot, ".schway"));
    const external = '{"provider":"openai-compatible","baseUrl":"http://127.0.0.1:1/v1"}';
    await writeFile(path, external);
    expect(await ui.controller.configCommand("set appearance dark --scope project")).toBe(false);
    expect(ui.configEditor.settings.provider).toBe("openai");
    expect(ui.configEditor.settings.appearance).toBe("auto");
    expect(await readFile(path, "utf8")).toBe(external);
    expect(ui.controller.snapshot().transcript.at(-1)?.text).toContain("Reload");
    ui.resize(24, 8);
    ui.mockInput.pressKey("p", { meta: true }); await settle(ui);
    ui.mockInput.pressTab(); ui.mockInput.pressTab();
    const appearanceIndex = ui.controller.snapshot().preferences!.rows.findIndex(row => row.key === "appearance");
    for (let index = 0; index < appearanceIndex; index++) ui.mockInput.pressArrow("down");
    ui.mockInput.pressArrow("right"); ui.mockInput.pressArrow("right");
    await preferenceEnter(ui); await preferenceEnter(ui);
    expect(ui.controller.snapshot().preferences?.error).toContain("Reload");
    expect(ui.captureCharFrame()).toContain("! Not saved: dark");
    expect(ui.configEditor.settings.provider).toBe("openai");
    expect(await readFile(path, "utf8")).toBe(external);
  });
});

test("session theme command and preferences share the effective source without requiring a model", async () => {
  await withTempDir(async root => {
    const ui = await preferenceFixture(root, { model: undefined,
      stageSettings: async () => { throw new Error("appearance must not load a model"); } }, {}, { SCHWAY_THEME: "dark" });
    await ui.mockInput.pasteBracketedText("/theme light");
    ui.mockInput.pressEnter();
    await ui.controller.waitForIdle(); await settle(ui);
    expect(ui.configEditor.settings.appearance).toBe("light");
    expect((ui.renderer.root.findDescendantById("conversation") as BoxRenderable).backgroundColor.equals(RGBA.fromHex(TUI_THEMES.dark.background))).toBe(true);
    expect(await ui.controller.configCommand("show")).toBe(true);
    expect(ui.controller.snapshot().transcript.at(-1)?.text).toContain("appearance: dark [environment] (configured: light [current-session override])");
    ui.mockInput.pressKey("p", { meta: true }); await settle(ui);
    expect(ui.controller.snapshot().preferences?.rows.find(row => row.key === "appearance")).toMatchObject({
      value: "dark", origin: "environment", saved: expect.stringContaining("session=light"),
    });
    expect((await loadConfigEditor({ home: ui.home, workspaceRoot: ui.workspaceRoot })).settings.appearance).toBe("auto");
    ui.mockInput.pressTab();
    const appearanceIndex = ui.controller.snapshot().preferences!.rows.findIndex(row => row.key === "appearance");
    for (let index = 0; index < appearanceIndex; index++) ui.mockInput.pressArrow("down");
    for (let index = 0; index < 3; index++) ui.mockInput.pressArrow("right");
    await preferenceEnter(ui); await preferenceEnter(ui);
    expect((await loadConfigEditor({ home: ui.home, workspaceRoot: ui.workspaceRoot })).settings.appearance).toBe("light");
  });
});

test("preferences real keyboard scopes preview save reset and restart preserve the pending draft", async () => {
  await withTempDir(async root => {
    const ui = await preferenceFixture(root, {}, { maxTurns: 7 });
    await ui.mockInput.pasteBracketedText("pending\nThai ไทย draft");
    ui.editor.cursorOffset = 4;
    ui.mockInput.pressKey("p", { meta: true }); await advancedPreferences(ui); await settle(ui);
    expect(ui.captureCharFrame()).toContain("Preferences");
    ui.mockInput.pressArrow("down"); ui.mockInput.pressArrow("right");
    await preferenceEnter(ui);
    expect(ui.configEditor.settings.maxTurns).toBe(7);
    expect(ui.controller.snapshot().preferences?.preview).toContain("This session only");
    await preferenceEnter(ui);
    expect(ui.configEditor.settings.maxTurns).toBe(8);
    expect((await loadConfigEditor({ home: ui.home, workspaceRoot: ui.workspaceRoot, cli: { maxTurns: 7 }, interactiveMemory: true })).settings.maxTurns).toBe(7);
    ui.mockInput.pressArrow("left"); await preferenceEnter(ui); await preferenceEnter(ui);
    expect(ui.configEditor.settings.maxTurns).toBe(7);
    // User and project are explicit scopes; lower-priority persistence does not claim a live switch.
    for (const [tabs, scope, path] of [[2, "user", join(ui.home, ".schway/config.json")], [1, "project", join(ui.workspaceRoot, ".schway/config.json")]] as const) {
      for (let n = 0; n < tabs; n++) ui.mockInput.pressTab();
      ui.mockInput.pressArrow("down"); ui.mockInput.pressArrow("right");
      await preferenceEnter(ui);
      expect(ui.controller.snapshot().preferences?.scope).toBe(scope);
      expect(ui.controller.snapshot().preferences?.preview).toContain("Saved but not effective: shadowed by CLI");
      await preferenceEnter(ui);
      expect(JSON.parse(await readFile(path, "utf8")).maxTurns).toBe(8);
      expect(ui.configEditor.settings.maxTurns).toBe(7);
      const restarted = await loadConfigEditor({ home: ui.home, workspaceRoot: ui.workspaceRoot, interactiveMemory: true });
      expect(restarted.settings.maxTurns).toBe(8);
      ui.mockInput.pressArrow("left"); await preferenceEnter(ui); await preferenceEnter(ui);
      expect(JSON.parse(await readFile(path, "utf8")).maxTurns).toBeUndefined();
    }
    ui.resize(36, 16); await settle(ui);
    expect(ui.editor.y + ui.editor.height).toBeLessThanOrEqual(16);
    ui.mockInput.pressEscape(); ui.mockInput.pressEscape(); await settle(ui);
    expect(ui.editor.plainText).toBe("pending\nThai ไทย draft"); expect(ui.editor.cursorOffset).toBe(4);
    expect(ui.editor.focused).toBe(true);
    ui.mockInput.pressKey("p", { meta: true }); await advancedPreferences(ui); await settle(ui);
    expect(ui.controller.snapshot().preferences?.rows.find(row => row.key === "maxTurns")).toMatchObject({ value: "7", origin: "CLI" });
    ui.mockInput.pressEscape(); ui.mockInput.pressEscape(); await settle(ui);
    expect(ui.editor.plainText).toContain("Thai ไทย");
  });
});

test("preferences memory shares the complete choice with new workspaces and resets locally without clearing session", async () => {
  await withTempDir(async root => {
    const ui = await preferenceFixture(root, {}, { provider: "openai", model: "gpt-5.4" });
    await ui.controller.configCommand("set thinking low");
    ui.mockInput.pressKey("p", { meta: true }); await advancedPreferences(ui); ui.mockInput.pressTab();
    await preferenceEnter(ui);
    expect((await InteractiveMemory.load(ui.home, ui.workspaceRoot)).choice).toBeUndefined();
    await preferenceEnter(ui);
    const memory = await InteractiveMemory.load(ui.home, ui.workspaceRoot);
    expect(memory.choice).toMatchObject({ provider: ui.configEditor.settings.provider, model: ui.configEditor.settings.model });
    const other = join(root, "other"); await mkdir(other);
    expect((await InteractiveMemory.load(ui.home, other)).choice).toEqual(memory.choice);
    expect((await loadConfigEditor({ home: ui.home, workspaceRoot: ui.workspaceRoot, interactiveMemory: true })).origins.model).toBe("interactive memory");
    expect((await loadConfigEditor({ home: ui.home, workspaceRoot: ui.workspaceRoot })).origins.model).toBeUndefined();
    ui.mockInput.pressArrow("right"); await preferenceEnter(ui); await preferenceEnter(ui);
    expect((await InteractiveMemory.load(ui.home, ui.workspaceRoot)).choice).toBeUndefined();
    expect((await InteractiveMemory.load(ui.home, other)).choice).toEqual(memory.choice);
    expect(await readdir(ui.workspaceRoot)).toEqual([]);
    expect(ui.configEditor.settings.thinking).toBe("low");
  });
});

test("preferences staged conflict malformed files unavailable model and Escape retain previous runtime and composer", async () => {
  await withTempDir(async root => {
    let unavailable = false;
    const ui = await preferenceFixture(root, { stageSettings: async (settings, _signal, workspace) => {
      if (unavailable) throw new Error("Fixture model unavailable");
      return { model: createScriptedModel({ provider: settings.provider, id: settings.model }), contextManager: createContextManager(workspace!) };
    } });
    await ui.mockInput.pasteBracketedText("never discard");
    ui.mockInput.pressKey("p", { meta: true }); await advancedPreferences(ui);
    ui.mockInput.pressTab(); ui.mockInput.pressTab(); ui.mockInput.pressTab();
    ui.mockInput.pressArrow("down"); ui.mockInput.pressArrow("right");
    await preferenceEnter(ui);
    const path = join(ui.workspaceRoot, ".schway/config.json");
    await mkdir(join(ui.workspaceRoot, ".schway")); await writeFile(path, '{"maxTurns":17}');
    await preferenceEnter(ui);
    expect(ui.configEditor.settings.maxTurns).toBe(32);
    expect(await readFile(path, "utf8")).toBe('{"maxTurns":17}');
    expect(ui.controller.snapshot().preferences?.error).toContain("Not applied");
    ui.mockInput.pressEscape(); // dismiss failed preview, keep choice
    await writeFile(path, '{broken');
    await preferenceEnter(ui);
    expect(ui.controller.snapshot().preferences?.error).toContain("malformed JSON");
    expect(await readFile(path, "utf8")).toBe('{broken');
    await writeFile(path, '{}'); unavailable = true;
    await preferenceEnter(ui);
    expect(ui.controller.snapshot().preferences?.error).toContain("unavailable");
    expect(ui.controller.snapshot().preferences?.choiceIndex).toBe(1);
    unavailable = false; await preferenceEnter(ui);
    ui.mockInput.pressEscape(); await settle(ui);
    expect(await readFile(path, "utf8")).toBe('{}');
    ui.mockInput.pressEscape(); ui.mockInput.pressEscape(); await settle(ui);
    expect(ui.editor.plainText).toBe("never discard");
    expect(ui.configEditor.settings.maxTurns).toBe(32);
  });
});

test("preferences cancellation during provider staging never commits or loses the draft", async () => {
  await withTempDir(async root => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ui = await preferenceFixture(root, { stageSettings: async (settings, _signal, workspace) => {
      await gate;
      return { model: createScriptedModel({ provider: settings.provider, id: settings.model }), contextManager: createContextManager(workspace!) };
    } });
    await ui.mockInput.pasteBracketedText("cancel me safely");
    ui.mockInput.pressKey("p", { meta: true }); await advancedPreferences(ui); ui.mockInput.pressArrow("down"); ui.mockInput.pressArrow("right");
    ui.mockInput.pressEnter(); await waitForUiState(ui, () => ui.controller.running, "active turn");
    ui.mockInput.pressEscape(); ui.mockInput.pressEscape(); release(); await ui.controller.waitForIdle(); await settle(ui);
    expect(ui.configEditor.settings.maxTurns).toBe(32);
    expect(ui.editor.plainText).toBe("cancel me safely");
    expect(ui.controller.snapshot().preferences).toBeUndefined();
  });
});

test("preferences inspect actual origins and lower memory while omitting connection secrets", async () => {
  await withTempDir(async root => {
    const home = join(root, "home"), workspaceRoot = join(root, "workspace");
    await mkdir(join(home, ".schway"), { recursive: true }); await mkdir(join(workspaceRoot, ".schway"), { recursive: true });
    await writeFile(join(home, ".schway/config.json"), JSON.stringify({ maxTurns: 11, maxConcurrentTools: 2 }));
    await writeFile(join(workspaceRoot, ".schway/config.json"), JSON.stringify({ maxTurns: 13 }));
    const memory = await InteractiveMemory.load(home, workspaceRoot);
    await memory.write({ provider: "openai", openaiAuth: "api-key", model: "gpt-5.4", thinking: "low" });
    const ui = await preferenceFixture(root, {}, { maxTurns: 17, baseUrl: "https://fixture-user:fixture-password@example.com", headers: { Authorization: "Bearer header-secret" }, extraBody: { token: "body-secret" } });
    await ui.controller.configCommand("set maxTurns 19");
    ui.mockInput.pressKey("p", { meta: true }); await advancedPreferences(ui); await settle(ui);
    const rows = ui.controller.snapshot().preferences!.rows;
    expect(rows.find(row => row.key === "maxTurns")).toMatchObject({ value: "19", origin: "current-session override", saved: "user config=11; project config=13; CLI=17; session=19" });
    expect(rows.find(row => row.key === "model")).toMatchObject({ value: "gpt-5.4", origin: "interactive memory" });
    expect(rows.find(row => row.key === "maxConcurrentTools")?.origin).toBe("user-global");
    const artifacts = JSON.stringify(ui.controller.snapshot().preferences) + ui.captureCharFrame();
    for (const secret of ["fixture-user", "fixture-password", "header-secret", "body-secret", "Authorization"]) expect(artifacts).not.toContain(secret);
    ui.mockInput.pressArrow("down"); ui.mockInput.pressArrow("right"); await preferenceEnter(ui); await preferenceEnter(ui);
    expect((await InteractiveMemory.load(home, workspaceRoot)).choice?.thinking).toBe("low");
    // Unsupported textual values remain errors and ordinary secrets are never accepted as preferences.
    expect(await ui.controller.configCommand("set thinking impossible")).toBe(false);
    expect(await ui.controller.configCommand("set apiKey never-store-this")).toBe(false);
    expect(await readFile(join(home, ".schway/config.json"), "utf8")).toBe(JSON.stringify({ maxTurns: 11, maxConcurrentTools: 2 }));
  });
});


test("preferences memory conflicts preserve the newer workspace choice and expose the specific failure", async () => {
  await withTempDir(async root => {
    const ui = await preferenceFixture(root, {}, { provider: "openai", model: "gpt-4o" });
    ui.mockInput.pressKey("p", { meta: true }); await advancedPreferences(ui); ui.mockInput.pressTab();
    await preferenceEnter(ui);
    expect(ui.controller.snapshot().preferences?.preview).toContain(`${ui.configEditor.settings.provider}/${ui.configEditor.settings.model}`);
    const concurrent = await InteractiveMemory.load(ui.home, ui.workspaceRoot);
    await concurrent.write({ provider: "openai", model: "gpt-5.4", openaiAuth: "api-key" });
    await preferenceEnter(ui);
    expect(ui.controller.snapshot().preferences?.error).toContain("Workspace choice changed");
    expect((await InteractiveMemory.load(ui.home, ui.workspaceRoot)).choice?.provider).toBe("openai");
    expect(ui.configEditor.settings.provider).toBe("openai");
  });
});

test("preferences picker has no guessed Codex effort and never saves credential fields", async () => {
  await withTempDir(async root => {
    const ui = await preferenceFixture(root, {}, { provider: "openai", model: "gpt-5.4", openaiAuth: "codex" });
    ui.mockInput.pressKey("p", { meta: true }); await settle(ui);
    expect(ui.controller.snapshot().preferences!.rows.find(row => row.key === "thinking")!.choices).toEqual([undefined]);
    ui.mockInput.pressTab(); ui.mockInput.pressTab();
    const path = join(ui.workspaceRoot, ".schway/config.json");
    await mkdir(join(ui.workspaceRoot, ".schway")); await writeFile(path, '{"apiKey":"secret-not-loaded"}');
    ui.mockInput.pressArrow("down"); ui.mockInput.pressArrow("right"); await preferenceEnter(ui);
    expect(ui.controller.snapshot().preferences?.error).toContain("API keys must not be stored");
    expect(JSON.stringify(ui.controller.snapshot().preferences)).not.toContain("secret-not-loaded");
    expect(await readFile(path, "utf8")).toBe('{"apiKey":"secret-not-loaded"}');
    await writeFile(path, '{}');
    ui.mockInput.pressEscape(); await settle(ui);
  });
});

test("preferences at narrow width scroll preview and Escape keeps pasted task and cursor; textual forms stay available", async () => {
  await withTempDir(async root => {
    const ui = await preferenceFixture(root);
    await ui.mockInput.pasteBracketedText("my original task"); ui.editor.cursorOffset = 3;
    ui.mockInput.pressKey("p", { meta: true }); ui.resize(36, 16); await settle(ui);
    ui.mockInput.pressArrow("down"); ui.mockInput.pressArrow("right"); await preferenceEnter(ui);
    ui.mockInput.pressKey("pagedown"); await settle(ui);
    expect(ui.controller.snapshot().preferences?.preview).not.toContain("Esc");
    expect(ui.captureCharFrame().replace(/\s+/g, " ")).toContain("Esc cancel");
    expect(ui.editor.y + ui.editor.height).toBeLessThanOrEqual(16);
    await ui.mockInput.pasteBracketedText("paste while viewing");
    ui.mockInput.pressEscape(); ui.mockInput.pressEscape(); await settle(ui);
    expect(ui.editor.plainText).toBe("my original task"); expect(ui.editor.cursorOffset).toBe(3);
    ui.editor.setText("/config"); ui.mockInput.pressEnter();
    await waitForUiState(ui, () => !!ui.controller.snapshot().preferences, "preferences command");
    expect(ui.controller.snapshot().preferences).toBeDefined();
    ui.mockInput.pressEscape(); await settle(ui);
    expect(ui.editor.plainText).toBe("");
    expect(await ui.controller.configCommand("show")).toBe(true);
    expect(await ui.controller.configCommand("set maxTurns 15")).toBe(true);
    expect(ui.configEditor.settings.maxTurns).toBe(15);
    expect(await ui.controller.configCommand("reset maxTurns")).toBe(true);
    expect(ui.configEditor.settings.maxTurns).toBe(32);
  });
});


test("preferences reset inherits the latest remembered model and preserves unrelated saved configuration", async () => {
  await withTempDir(async root => {
    const ui = await preferenceFixture(root);
    expect(await ui.controller.selectModel("openai/gpt-5.4-mini")).toBe(true);
    ui.mockInput.pressKey("p", { meta: true }); await advancedPreferences(ui); await settle(ui);
    expect(ui.controller.snapshot().preferences?.rows.find(row => row.key === "model")?.saved).toContain("workspace memory=gpt-5.4-mini");
    // Model is row eight; reset current-session model using the bounded reset action.
    for (let n = 0; n < 7; n++) ui.mockInput.pressArrow("down");
    await preferenceEnter(ui); await preferenceEnter(ui);
    expect(ui.configEditor.settings.model).toBe("gpt-5.4-mini");
    expect(ui.configEditor.origins.model).toBe("interactive memory");
    ui.mockInput.pressTab(); ui.mockInput.pressTab();
    const path = join(ui.home, ".schway/config.json");
    await writeFile(path, JSON.stringify({ headers: { "X-Region": "west" }, extraBody: { temperature: 0.2 }, maxConcurrentTools: 3 }));
    ui.mockInput.pressArrow("down"); ui.mockInput.pressArrow("right"); await preferenceEnter(ui); await preferenceEnter(ui);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ headers: { "X-Region": "west" }, extraBody: { temperature: 0.2 }, maxConcurrentTools: 3, maxTurns: 8 });
  });
});


test("preferences refuse competing login and branch panels and restore the original task and cursor", async () => {
  await withTempDir(async root => {
    const ui = await preferenceFixture(root);
    await ui.mockInput.pasteBracketedText("retained task\nsecond line"); ui.editor.cursorOffset = 5;
    for (const panel of ["login", "branch"] as const) {
      if (panel === "login") ui.mockInput.pressKey("l", { meta: true });
      else expect(ui.controller.openBranchTree()).toBe(true);
      await settle(ui);
      const before = ui.controller.snapshot();
      expect(panel === "login" ? before.loginChooser : before.branchTree).toBeDefined();
      ui.mockInput.pressKey("p", { meta: true }); await settle(ui);
      expect(ui.controller.snapshot().preferences).toBeUndefined();
      expect(ui.controller.openPreferences()).toBe(false);
      expect(panel === "login" ? ui.controller.snapshot().loginChooser : ui.controller.snapshot().branchTree).toEqual(panel === "login" ? before.loginChooser : before.branchTree);
      ui.mockInput.pressEscape(); await settle(ui);
      expect(ui.controller.snapshot().loginChooser).toBeUndefined();
      expect(ui.controller.snapshot().branchTree).toBeUndefined();
      expect(ui.editor.plainText).toBe("retained task\nsecond line"); expect(ui.editor.cursorOffset).toBe(5);
      ui.mockInput.pressKey("p", { meta: true }); await settle(ui);
      expect(ui.controller.snapshot().preferences).toBeDefined();
      // Reverse shortcuts and direct entry points cannot stack an input owner.
      ui.mockInput.pressKey("l", { meta: true }); ui.mockInput.pressKey("m", { meta: true });
      expect(ui.controller.openLoginChooser()).toBe(false);
      expect(ui.controller.openBranchTree()).toBe(false);
      expect(ui.controller.openModelPicker()).toBe(false);
      expect(ui.controller.snapshot().loginChooser).toBeUndefined();
      expect(ui.controller.snapshot().branchTree).toBeUndefined();
      expect(ui.controller.snapshot().modelPicker).toBeUndefined();
      ui.mockInput.pressArrow("down"); ui.mockInput.pressArrow("right"); await preferenceEnter(ui);
      const preview = ui.controller.snapshot().preferences;
      ui.mockInput.pressKey("p", { meta: true }); await settle(ui);
      expect(ui.controller.snapshot().preferences).toEqual(preview);
      ui.mockInput.pressEscape(); ui.mockInput.pressEscape(); await settle(ui);
      expect(ui.editor.plainText).toBe("retained task\nsecond line"); expect(ui.editor.cursorOffset).toBe(5);
      expect(ui.editor.focused).toBe(true);
    }
  });
});


test("command help real keyboard search and Escape retain task cursor and transcript at 44x18", async () => {
  const ui = await setup(44, 18);
  await ui.mockInput.pasteBracketedText("retained task 日本語\nsecond line"); ui.editor.cursorOffset = 4;
  const entries = ui.controller.snapshot().transcript.length;
  for (let count = 0; count < 3; count++) {
    ui.mockInput.pressKey("h", { meta: true }); await settle(ui);
    expect(ui.controller.commandHelpOpen).toBe(true);
    await ui.mockInput.pasteBracketedText("no-such-command-zz"); await settle(ui);
    expect(ui.captureCharFrame()).toContain("No matches");
    ui.mockInput.pressEnter(); await settle(ui);
    expect(ui.session.items).toHaveLength(0);
    ui.mockInput.pressKey("m", { meta: true }); await settle(ui);
    expect(ui.controller.snapshot().modelPicker).toBeUndefined();
    ui.mockInput.pressEscape(); await settle(ui);
    expect(ui.editor.plainText).toBe("retained task 日本語\nsecond line"); expect(ui.editor.cursorOffset).toBe(4);
    expect(ui.controller.snapshot().transcript).toHaveLength(entries);
  }
  ui.mockInput.pressKey("h", { meta: true }); await settle(ui);
  await ui.mockInput.pasteBracketedText("appearance"); await settle(ui);
  expect(ui.captureCharFrame()).toContain("/theme");
  ui.mockInput.pressTab(); await settle(ui);
  expect(ui.editor.plainText).toBe("/theme ");
  expect(ui.session.items).toHaveLength(0);
  ui.mockInput.pressArrow("down"); ui.mockInput.pressTab(); await settle(ui);
  expect(ui.editor.plainText).toBe("/theme dark");
  expect(ui.session.items).toHaveLength(0);
  ui.mockInput.pressEscape(); await settle(ui);
  expect(ui.editor.plainText).toBe("retained task 日本語\nsecond line"); expect(ui.editor.cursorOffset).toBe(4);
});

test("dynamic skill refresh cannot transfer an active completion selection to its neighbor", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    for (const name of ["alpha", "alpine"]) {
      await mkdir(join(root, ".agents/skills", name), { recursive: true });
      await writeFile(join(root, ".agents/skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: Unicode 日本語 ${"description ".repeat(30)}\n---\nBODY`);
    }
    const ui = await setup(44, 18, {}, undefined, { workspace, home: join(root, "home") });
    await ui.controller.refreshCommands();
    await ui.mockInput.pasteBracketedText("/al"); await settle(ui);
    expect(ui.captureCharFrame()).toContain("Unicode 日本語");
    ui.mockInput.pressArrow("down"); await settle(ui);
    await rm(join(root, ".agents/skills/alpine"), { recursive: true });
    await ui.controller.refreshCommands(); await settle(ui);
    ui.mockInput.pressTab(); await settle(ui);
    expect(ui.editor.plainText).toBe("/al");
    ui.mockInput.pressArrow("down"); ui.mockInput.pressTab(); await settle(ui);
    expect(ui.editor.plainText).toBe("/alpha ");
    expect(ui.session.items).toHaveLength(0);
    ui.mockInput.pressEscape(); await settle(ui);
    await mkdir(join(root, ".agents/skills/alpine"), { recursive: true });
    await writeFile(join(root, ".agents/skills/alpine/SKILL.md"), "---\nname: alpine\ndescription: Returned\n---\nBODY");
    ui.editor.setText("/al"); await settle(ui); await ui.controller.refreshCommands(); await settle(ui);
    expect(ui.controller.commandChoices("/al").map(entry => entry.name)).toEqual(["alpha", "alpine"]);
  });
});

for (const width of [120, 50]) for (const noColor of [false, true]) {
  test(`command palette groups, aligned columns, ranked queries and destructive styling at ${width} columns${noColor ? " without color" : ""}`, async () => {
    await withTempDir(async root => {
      const home = join(root, "home"), workspace = { root, launchCwd: root, extraRoots: [] };
      await Bun.write(join(root, ".agents/skills/grill-me/SKILL.md"), "---\nname: grill-me\ndescription: Stress-test a plan\n---\nTask");
      await Bun.write(join(root, "node_modules/greeting-pkg/package.json"), JSON.stringify({ name: "greeting-pkg", schway: { extensions: ["main.ts"] } }));
      await Bun.write(join(root, "node_modules/greeting-pkg/main.ts"), "export default ctx => ctx.registerCommand({ name: 'greet', description: 'Say hello', execute() {} });");
      await Bun.write(join(root, ".schway/config.json"), JSON.stringify({ packages: ["greeting-pkg"] }));
      await Bun.write(join(root, "local.ts"), "export default ctx => ctx.registerCommand({ name: 'local', description: 'Local action', execute() {} });");
      const loaded = await loadExtensions({ modules: ["local.ts"], workspace, home, tools: createToolRegistry() });
      const ui = await setup(width, 30, {}, undefined, { workspace, home, tools: loaded.tools, extensions: loaded.runtime }, undefined, noColor ? { NO_COLOR: "1" } : {});
      await ui.controller.refreshCommands();
      const picker = () => ui.renderer.root.findDescendantById("picker") as BoxRenderable;
      const rows = () => picker().getChildren() as TextRenderable[];
      const selected = () => rows().find(row => row.plainText.startsWith("› "))!;
      await ui.mockInput.typeText("/"); await settle(ui);
      expect(selected().plainText).toContain("/model");
      expect(ui.controller.commandChoices("/").map(entry => entry.name)).toEqual([...BUILT_IN_COMMAND_ORDER.slice(0, -1), "grill-me", "greet", "local", "delete-session"]);
      const visited: string[] = [];
      for (let index = 0; index < ui.controller.commandChoices("/").length; index++) {
        visited.push(selected().plainText.match(/\/(\S+)/)![1]!);
        ui.mockInput.pressArrow("down"); await settle(ui);
        expect(rows().length).toBeLessThanOrEqual(6);
        expect(selected().plainText).not.toContain("Skills");
        expect(selected().plainText).not.toContain("Extensions");
      }
      expect(visited).toEqual(ui.controller.commandChoices("/").map(entry => entry.name));
      expect(selected().plainText).toContain("/model");
      ui.mockInput.pressArrow("up"); await settle(ui);
      const frame = ui.captureCharFrame();
      expect(frame).toContain("Skills"); expect(frame).toContain("Extensions");
      expect(frame).toContain("· greeting-pkg"); expect(frame).toContain("· local.ts");
      expect(frame).not.toContain("[built-in]"); expect(frame).not.toContain("[extension]"); expect(frame).not.toContain("project skill");
      expect(rows().at(-1)?.plainText).toEndWith(" · deletes");
      expect(selected().plainText).toContain("/delete-session");
      const theme = resolveTheme("dark", null, noColor ? { NO_COLOR: "1" } : {});
      expect(selected().bg?.equals(RGBA.fromHex(tint(theme, theme.accent)))).toBe(true);
      const descriptionStarts = rows().filter(row => row.plainText.includes("/")).map(row => row.chunks[0]!.text.search(/Stress-|Say |Local |Delete /));
      expect(new Set(descriptionStarts).size).toBe(1);
      await ui.mockInput.typeText("ses"); await settle(ui);
      expect(rows().map(row => row.plainText.match(/\/(\S+)/)?.[1])).toEqual(["sessions", "session", "delete-session"]);
      expect(ui.captureCharFrame()).not.toContain("Skills"); expect(ui.captureCharFrame()).not.toContain("Extensions");
      const deletion = rows().at(-1)!;
      expect(deletion.chunks[0]?.fg?.equals(RGBA.fromHex(theme.warning))).toBe(true);
      expect(deletion.chunks[1]?.fg?.equals(RGBA.fromHex(mixColor(theme.warning, theme.muted, 0.5)))).toBe(true);
      expect(deletion.plainText).toEndWith(" · deletes");
      ui.mockInput.pressBackspace(); ui.mockInput.pressBackspace(); ui.mockInput.pressBackspace(); await settle(ui);
      expect(ui.editor.plainText).toBe("/"); expect(selected().plainText).toContain("/model");
      ui.mockInput.pressArrow("up"); await settle(ui);
      expect(ui.captureCharFrame()).toContain("Skills"); expect(ui.captureCharFrame()).toContain("Extensions");
      ui.editor.setText("/logout"); await settle(ui);
      expect(rows()[0]?.plainText).toContain("/logout"); expect(rows()[0]?.plainText).not.toContain("· deletes");
      ui.mockInput.pressEscape(); ui.editor.setText(""); ui.mockInput.pressKey("h", { meta: true }); await settle(ui);
      expect(selected().plainText).toContain("/model");
      ui.mockInput.pressArrow("up"); await settle(ui);
      // Help places keyboard guidance between extensions and the final destructive command.
      expect(ui.captureCharFrame()).toContain("Alt+R"); expect(ui.captureCharFrame()).toContain("Destructive");
      await ui.mockInput.typeText("ses"); await settle(ui);
      expect(rows().slice(0, 3).map(row => row.plainText.match(/\/(\S+)/)?.[1])).toEqual(["sessions", "session", "delete-session"]);
      expect(ui.captureCharFrame()).not.toContain("Skills"); expect(ui.captureCharFrame()).not.toContain("Extensions");
      for (let count = 0; count < 3; count++) ui.mockInput.pressBackspace();
      await settle(ui); expect(selected().plainText).toContain("/model");
    });
  });
}

test("long command names clip to the capped column while Tab inserts the full name", async () => {
  await withTempDir(async root => {
    const name = "very-long-extension-command-name", home = join(root, "home"), workspace = { root, launchCwd: root, extraRoots: [] };
    await Bun.write(join(root, "long.ts"), `export default ctx => ctx.registerCommand({ name: '${name}', description: 'Long action', execute() {} });`);
    const loaded = await loadExtensions({ modules: ["long.ts"], workspace, home, tools: createToolRegistry() });
    const ui = await setup(50, 24, {}, undefined, { workspace, home, extensions: loaded.runtime });
    await ui.mockInput.typeText("/very"); await settle(ui);
    const picker = ui.renderer.root.findDescendantById("picker") as BoxRenderable;
    const row = picker.getChildren()[0] as TextRenderable;
    expect(row.plainText).toContain("/very-long-extension-c… Long");
    expect(row.plainText.indexOf("Long")).toBe(28);
    ui.mockInput.pressTab(); await settle(ui);
    expect(ui.editor.plainText).toBe(`/${name} `);
  });
});

test("dynamic extension and built-in collisions appear in Skills and Tab cannot insert either owner", async () => {
  await withTempDir(async root => {
    const home = join(root, "home"), workspace = { root, launchCwd: root, extraRoots: [] };
    await Bun.write(join(root, "ping.ts"), "export default ctx => ctx.registerCommand({ name: 'ping', description: 'Ping extension', execute() {} });");
    const loaded = await loadExtensions({ modules: ["ping.ts"], workspace, home, tools: createToolRegistry() });
    for (const name of ["ping", "help"]) await Bun.write(join(root, `.agents/skills/${name}/SKILL.md`), `---\nname: ${name}\ndescription: Conflicting skill\n---\nTask`);
    await Bun.write(join(root, ".agents/skills/invalid/SKILL.md"), "Invalid frontmatter");
    const ui = await setup(50, 30, {}, undefined, { workspace, home, extensions: loaded.runtime });
    await ui.controller.refreshCommands();
    const choices = ui.controller.commandChoices("/");
    expect(choices.filter(entry => entry.name === "ping" || entry.name === "help").every(entry => entry.group === "skills" && !entry.available)).toBe(true);
    const skillRows = choices.filter(entry => entry.group === "skills");
    expect(skillRows.at(-1)?.id).toStartWith("diagnostic:");
    for (const name of ["ping", "help"]) {
      ui.editor.setText(`/${name}`); await settle(ui);
      const picker = ui.renderer.root.findDescendantById("picker") as BoxRenderable;
      expect(picker.getChildren().filter(row => (row as TextRenderable).plainText.includes("! /"))).toHaveLength(2);
      ui.mockInput.pressTab(); await settle(ui);
      expect(ui.editor.plainText).toBe(`/${name}`);
    }
    ui.editor.setText("/"); await settle(ui); ui.mockInput.pressArrow("up"); await settle(ui);
    expect(ui.captureCharFrame()).toContain("! /ping");
    const picker = ui.renderer.root.findDescendantById("picker") as BoxRenderable;
    expect(picker.getChildren().filter(row => (row as TextRenderable).plainText.startsWith("› ")).map(row => (row as TextRenderable).plainText))
      .toHaveLength(1);
    ui.mockInput.pressArrow("up"); await settle(ui);
    expect(ui.captureCharFrame()).toContain("Skills");
    ui.mockInput.pressArrow("down"); await settle(ui);
    ui.mockInput.pressTab(); await settle(ui);
    expect(ui.editor.plainText).toBe("/delete-session ");
  });
});


test("reasoning argument completion lists the model's supported levels and never invents subscription levels", async () => {
  await withTempDir(async root => {
    const ui = await preferenceFixture(root, {}, { provider: "openai", model: "gpt-5.4", maxOutput: 2048 });
    expect(ui.controller.commandChoices("/thinking ").map(entry => entry.name)).toEqual(["thinking reset", "thinking off", "thinking low", "thinking medium", "thinking high"]);
    ui.controller.setModel(createScriptedModel({ provider: "codex-subscription", id: "unknown" }), "openai", "unknown");
    expect(ui.controller.commandChoices("/thinking ").map(entry => entry.name)).toEqual(["thinking reset"]);
    await ui.mockInput.pasteBracketedText("/thinking "); await settle(ui);
    expect(ui.captureCharFrame()).not.toContain("thinking high");
    ui.mockInput.pressTab(); await settle(ui);
    expect(ui.editor.plainText).toBe("/thinking reset");
    expect(ui.session.items).toHaveLength(0);
  });
});


test("compatible reasoning conflict and verified subscription metadata constrain controller choices", async () => {
  await withTempDir(async root => {
    await mkdir(join(root, "home/.schway"), { recursive: true });
    await writeFile(join(root, "home/.schway/config.json"), JSON.stringify({ extraBody: { reasoning_effort: "high" } }));
    const ui = await preferenceFixture(root, {}, { provider: "openai-compatible", model: "custom", baseUrl: "http://localhost:1234/v1", auth: "none" });
    expect(ui.controller.commandChoices("/thinking ").map(entry => entry.name)).toEqual(["thinking reset"]);
  });
  await withTempDir(async root => {
    const ui = await preferenceFixture(root, {}, { provider: "openai", model: "account-model", openaiAuth: "codex" });
    ui.configEditor.setModelCapabilities([{ id: "account-model", supportedThinking: ["medium", "high"] }]);
    ui.controller.setModel(createScriptedModel({ provider: "codex-subscription", id: "account-model" }), "openai", "account-model");
    expect(ui.controller.commandChoices("/thinking ").map(entry => entry.name)).toEqual(["thinking reset", "thinking medium", "thinking high"]);
  });
});


test("/help uses the real application dispatcher without transcript spam; theme and session collisions retain input", async () => {
  await withTempDir(async root => {
    const ui = await preferenceFixture(root);
    const context = { controller: ui.controller, home: ui.home, workspaceRoot: ui.workspaceRoot,
      skillScope: { workspaceRoot: ui.workspaceRoot }, sessionsDir: join(root, "sessions"), settings: () => ui.configEditor.settings,
      env: {}, secrets: [], finishQuit: () => {}, stderr: { write() {} } };
    const before = ui.controller.snapshot().transcript.length;
    expect(await dispatchEditorInput("/help", ui.controller, (command, accepted) => handleSlashCommand(command.name, command.args, context, command.raw, accepted))).toBe(true);
    await settle(ui);
    expect(ui.controller.commandHelpOpen).toBe(true); expect(ui.controller.snapshot().transcript).toHaveLength(before);
    ui.mockInput.pressEscape(); await settle(ui);
    for (const name of ["theme", "session"]) {
      await mkdir(join(ui.workspaceRoot, ".agents/skills", name), { recursive: true });
      await writeFile(join(ui.workspaceRoot, ".agents/skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: collision\n---\nbody`);
      ui.editor.setText(`/${name}`); ui.mockInput.pressEnter();
      await waitForUiState(ui, () => ui.controller.snapshot().transcript.at(-1)?.text.includes("conflicts with skill") ?? false, "skill collision");
      expect(ui.editor.plainText).toBe(`/${name}`);
      expect(ui.controller.snapshot().transcript.at(-1)?.text).toContain("conflicts with skill");
    }
    expect(ui.session.items).toHaveLength(0);
  });
});


test("editing while view-local command validation waits preserves the newer draft", async () => {
  const ui = await setup();
  let finish!: (collision: boolean) => void;
  ui.controller.commandCollision = () => new Promise(resolve => { finish = resolve; });
  await ui.mockInput.pasteBracketedText("/theme light"); ui.mockInput.pressEnter();
  await ui.mockInput.pasteBracketedText(" changed"); await settle(ui);
  finish(false); await settle(ui);
  expect(ui.editor.plainText).toBe("/theme light changed");
  expect(ui.controller.snapshot().transcript).toHaveLength(0);
});


test("renaming skill metadata at the same path cannot silently change the selected invocation", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const path = join(root, ".agents/skills/alpha/SKILL.md");
    await mkdir(join(root, ".agents/skills/alpha"), { recursive: true });
    await writeFile(path, "---\nname: alpha\ndescription: Original\n---\nbody");
    const ui = await setup(44, 18, {}, undefined, { workspace, home: join(root, "home") });
    await ui.controller.refreshCommands();
    await ui.mockInput.pasteBracketedText("/al"); await settle(ui);
    await writeFile(path, "---\nname: alpine\ndescription: Renamed\n---\nbody");
    await ui.controller.refreshCommands(); await settle(ui);
    ui.mockInput.pressTab(); await settle(ui);
    expect(ui.editor.plainText).toBe("/al");
    ui.mockInput.pressArrow("down"); ui.mockInput.pressTab(); await settle(ui);
    expect(ui.editor.plainText).toBe("/alpine "); expect(ui.session.items).toHaveLength(0);
  });
});

test("change review real keyboard, paste and resize navigate bounded text/deleted/renamed/binary diffs and restore draft and scroll", async () => {
  await withTempDir(async dir => {
    const git = async (...args: string[]) => {
      const proc = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
      const code = await proc.exited;
      if (code) throw new Error(await new Response(proc.stderr).text());
    };
    await git("init", "-q");
    await writeFile(join(dir, "a-text.txt"), "before\n");
    await writeFile(join(dir, "b-deleted.txt"), "deleted evidence\n");
    await writeFile(join(dir, "old-name.txt"), "rename evidence\n");
    await git("add", ".");
    await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "baseline");
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const ui = await setup(80, 24, {}, undefined, { workspace, contextManager: createContextManager(workspace),
      model: createScriptedModel({ responses: [{ toolCalls: [{ id: "call_fixture_files", name: "fixture", arguments: {} }] }, { text: "done" }] }),
      tools: createToolRegistry([{ name: "fixture", description: "change fixture files", execution: "exclusive", inputSchema: { type: "object" }, execute: async () => {
        await writeFile(join(dir, "a-text.txt"), "after\n" + "long-line\n".repeat(3000));
        await rm(join(dir, "b-deleted.txt"));
        await git("mv", "old-name.txt", "c-renamed.txt");
        await writeFile(join(dir, "d-binary.bin"), Buffer.from([0, 1, 2, 3]));
        return { content: "changed" };
      } }]),
    });
    // Keyboard dispatch still starts each operation; await its actual Git I/O rather than visual frames.
    let reviewOperation: Promise<unknown> | undefined;
    const openReview = ui.controller.openChangeReview.bind(ui.controller);
    const selectFile = ui.controller.selectReviewFile.bind(ui.controller);
    ui.controller.openChangeReview = () => { const pending = openReview(); reviewOperation = pending; return pending; };
    ui.controller.selectReviewFile = delta => { const pending = selectFile(delta); reviewOperation = pending; return pending; };
    const awaitReview = async () => {
      expect(reviewOperation).toBeDefined();
      await reviewOperation;
      expect(ui.controller.snapshot().changeReview?.loading).toBe(false);
    };
    await ui.controller.submit("explain");
    for (let i = 0; i < 40; i++) ui.controller.notice(`Previous ${i}`);
    await settle(ui);
    await ui.mockInput.pasteBracketedText("keep this draft\nand cursor");
    ui.mockInput.pressArrow("left");
    await settle(ui);
    await ui.mockInput.pressKeys(["\u001b[5~"]);
    await settle(ui);
    const draft = ui.editor.plainText;
    const cursor = ui.editor.cursorOffset;
    const top = ui.transcript.scrollTop;
    ui.mockInput.pressKey("r", { meta: true });
    await awaitReview();
    await settle(ui);
    expect(ui.captureCharFrame()).toContain("✓ Done");
    expect(ui.controller.snapshot().changeReview!.detail).toContain("truncated");
    expect(ui.controller.snapshot().changeReview!.detail.length).toBeLessThanOrEqual(12000);
    // Review owns input: a paste must not submit or overwrite the saved draft.
    await ui.mockInput.pasteBracketedText("ignored while browsing");
    ui.mockInput.pressEnter();
    await settle(ui);
    expect(ui.session.items.filter(item => item.type === "user")).toHaveLength(1);
    ui.mockInput.pressArrow("down");
    await awaitReview();
    await settle(ui);
    expect(ui.controller.snapshot().changeReview!.detail).toContain("- deleted evidence");
    ui.mockInput.pressArrow("down");
    await awaitReview();
    await settle(ui);
    expect(ui.controller.snapshot().changeReview!.files[2]?.path).toBe("c-renamed.txt");
    expect(ui.controller.snapshot().changeReview!.detail).toContain("Renamed from old-name.txt to c-renamed.txt");
    ui.resize(44, 18);
    await settle(ui);
    ui.mockInput.pressArrow("down");
    await awaitReview();
    await settle(ui);
    expect(ui.controller.snapshot().changeReview!.detail).toContain("Binary file");
    expect(ui.controller.snapshot().changeReview!.detail).toContain("not shown");
    await ui.mockInput.pressKeys(["\u001b[6~"]);
    await settle(ui);
    await ui.mockInput.pressKeys(["\u001b[6~"]);
    await settle(ui);
    expect(ui.captureCharFrame()).toContain("Binary");
    ui.mockInput.pressEscape();
    ui.resize(80, 24);
    await settle(ui);
    expect(ui.controller.snapshot().changeReview).toBeUndefined();
    expect(ui.editor.plainText).toBe(draft);
    expect(ui.editor.cursorOffset).toBe(cursor);
    expect(ui.transcript.scrollTop).toBe(top);
  });
});

test("turn command totals retain an early failure beyond the latest fifty evidence rows", async () => {
  const ui = await setup(90, 24, {}, undefined, {
    model: createScriptedModel({ responses: [{ toolCalls: Array.from({ length: 51 }, (_, i) => ({ id: `check-${i}`, name: "bash", arguments: { command: i ? "pass" : "fail" } })) }, { text: "done" }] }),
    tools: createToolRegistry([{
      name: "bash", description: "fixture check", execution: "exclusive",
      inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      execute: async (input: unknown) => {
        const command = (input as { command: string }).command;
        return { content: "fixture result", details: { command, exitCode: command === "fail" ? 7 : 0 } };
      },
    }]),
  });
  await ui.mockInput.pasteBracketedText("run all checks");
  ui.mockInput.pressEnter();
  await ui.controller.waitForIdle();
  await settle(ui);
  expect(ui.controller.snapshot().outcome!.commands).toHaveLength(50);
  expect(ui.controller.snapshot().outcome!.toolResults).toBe(51);
  expect(ui.captureCharFrame()).toContain("1 command failed");
  ui.mockInput.pressKey("r", { meta: true });
  await waitForUiState(ui, () => !!ui.controller.snapshot().changeReview && !ui.controller.snapshot().changeReview?.loading, "change review");
  await settle(ui);
  ui.mockInput.pressKey("i", { ctrl: true }); await settle(ui);
  const heading = ui.controller.snapshot().changeReview!.details;
  expect(heading).toContain("50 exit 0 / 1 nonzero / 0 unknown");
  expect(heading).toContain("latest 50");
  expect(heading).not.toContain("check-0:");
  expect(heading).not.toContain("check-50:");
  expect(heading.match(/pass → exit 0/g)).toHaveLength(50);
});

test("context inspection uses keyboard input and retains draft and controls during narrow tool activity", async () => {
  await withTempDir(async home => {
    const workspace = { root: home, launchCwd: home, extraRoots: [] };
    const session = createSession();
    const contextManager = createContextManager(workspace, { home });
    const config = await loadConfigEditor({ home, workspaceRoot: home });
    let calls = 0;
    const releaseTool = Promise.withResolvers<void>();
    const ui = await setup(100, 26, {}, undefined, { session, workspace, contextManager,
      tools: createToolRegistry([{ name: "context_wait", execution: "exclusive", description: "Wait for fixture release", inputSchema: { type: "object", properties: {} }, execute: async () => { await releaseTool.promise; return { content: "done" }; } }]),
      model: { provider: "scripted", id: "fixture", async *stream() { calls++; yield { type: "message_complete", message: { type: "assistant", id: `a${calls}`, content: calls === 1 ? [{ type: "tool_call", id: "context-tool", name: "context_wait", arguments: {} }] : [{ type: "text", text: "done" }] } }; } },
    }, async (text, accepted) => dispatchEditorInput(text, ui.controller, command => handleSlashCommand(command.name, command.args, {
      controller: ui.controller, home, workspaceRoot: home, skillScope: { manager: contextManager, workspaceRoot: home },
      sessionsDir: join(home, "sessions"), settings: () => config.settings, env: {}, secrets: [], finishQuit: () => {}, stderr: { write: () => {} },
    }), accepted));
    await ui.mockInput.pasteBracketedText("/context");
    ui.mockInput.pressEnter();
    await waitForUiState(ui, () => ui.captureCharFrame().includes("Selected model context"), "context inspection");
    expect(ui.captureCharFrame()).toContain("Selected model context");
    expect(ui.captureCharFrame()).toContain("unknown");
    expect(calls).toBe(0);
    expect(session.items).toHaveLength(0);
    await ui.mockInput.pasteBracketedText("start tool");
    ui.mockInput.pressEnter();
    await waitForUiState(ui, () => ui.controller.snapshot().activity?.phase === "tools", "active tool phase");
    await ui.mockInput.pasteBracketedText("future draft");
    ui.resize(44, 18);
    await settle(ui);
    const narrow = ui.captureCharFrame();
    expect(narrow).toContain("ctx ~");
    expect(narrow).toContain("1 tool");
    expect((ui.renderer.root.findDescendantById("footer") as TextRenderable).plainText).not.toContain("Esc");
    expect((ui.renderer.root.findDescendantById("hints") as TextRenderable).plainText).toContain("Esc stop");
    expect(narrow).toContain("future draft");
    expect(narrow).not.toContain("% complete");
    expect(ui.editor.plainText).toBe("future draft");
    ui.resize(24, 8);
    await settle(ui);
    expect(ui.editor.visible).toBe(true);
    expect(ui.editor.plainText).toBe("future draft");
    expect(calls).toBe(1);
    releaseTool.resolve();
    await ui.controller.waitForIdle();
    ui.resize(80, 24);
    await settle(ui);
    expect(ui.captureCharFrame()).toContain("✓ Done");
  });
});

test("branch keyboard selects duplicate shared heads, names a separate fork, and preserves files and draft", async () => {
  await withTempDir(async dir => {
    const file = join(dir, "edited.txt");
    await writeFile(file, "edited outside conversation history");
    const session = createSession([
      { type: "user", id: "u", content: [{ type: "text", text: "initial task" }] },
      { type: "assistant", id: "a", content: [{ type: "text", text: "completed turn" }] },
    ]);
    const first = session.forkBranch("a", "same label");
    const second = session.forkBranch("a", "same label");
    session.selectBranch("main");
    const ui = await setup(80, 24, {}, undefined, { session });
    await ui.mockInput.pasteBracketedText("preserved task\nsecond line");
    ui.editor.cursorOffset = 4;
    ui.controller.openBranchTree(); await settle(ui);
    ui.mockInput.pressArrow("down"); await settle(ui);
    expect(ui.controller.snapshot().branchTree?.selectedBranchId).toBe(first);
    expect(session.activeBranchId).toBe("main");
    ui.mockInput.pressArrow("down"); await settle(ui);
    expect(ui.controller.snapshot().branchTree?.selectedBranchId).toBe(second);
    expect(ui.captureCharFrame()).toContain("3. same label");
    ui.resize(36, 16); await settle(ui);
    expect(ui.captureCharFrame()).toContain("Files/Git unchanged");
    ui.mockInput.pressEnter(); await settle(ui);
    expect(session.activeBranchId).toBe(second);
    expect(ui.editor.plainText).toBe("preserved task\nsecond line");
    ui.controller.openBranchTree(); await settle(ui);
    ui.mockInput.pressTab(); await settle(ui);
    expect(ui.controller.snapshot().branchTree?.selectedBranchId).toBeUndefined();
    expect(ui.captureCharFrame()).toContain("Files/Git unchanged");
    await ui.mockInput.pasteBracketedText("ทางเลือกใหม่");
    ui.mockInput.pressEnter(); await settle(ui);
    expect(session.listBranches().find(branch => branch.active)?.name).toBe("ทางเลือกใหม่");
    expect(session.items.map(item => item.id)).toEqual(["u", "a"]);
    expect(await readFile(file, "utf8")).toBe("edited outside conversation history");
    expect(ui.editor.plainText).toBe("preserved task\nsecond line");
    expect(ui.editor.cursorOffset).toBe(4);
  });
});

test("branch browsing pages Unicode duplicate labels beyond the cap at narrow width and cancels to reading position", async () => {
  const session = createSession([
    { type: "user", id: "u", content: [{ type: "text", text: "task\n".repeat(90) }] },
    { type: "assistant", id: "a", content: [{ type: "text", text: "done" }] },
  ]);
  const branches = Array.from({ length: 65 }, () => session.forkBranch("a", "日本語ไทย🙂".repeat(8)));
  const ui = await setup(44, 18, {}, undefined, { session });
  await ui.mockInput.pasteBracketedText("keep me");
  ui.editor.cursorOffset = 2;
  ui.transcript.scrollTo(12); await settle(ui);
  const before = ui.transcript.scrollTop;
  ui.controller.openBranchTree(); await settle(ui);
  expect(ui.controller.snapshot().branchTree?.selectedBranchId).toBe(branches.at(-1));
  expect(ui.controller.snapshot().branchTree!.branches.length).toBeLessThanOrEqual(12);
  expect(ui.captureCharFrame()).toContain("66.");
  for (let i = 0; i < 64; i++) ui.mockInput.pressArrow("up");
  await settle(ui);
  expect(ui.controller.snapshot().branchTree?.selectedBranchId).toBe(branches[0]);
  expect(session.activeBranchId).toBe(branches.at(-1)!);
  ui.resize(36, 16); await settle(ui);
  expect(ui.captureCharFrame()).toContain("Files/Git unchanged");
  // Where the hint row holds only the Files/Git note, the status bar names Esc back.
  ui.resize(31, 16); await settle(ui);
  const rows = ui.captureCharFrame().trimEnd().split("\n").map(row => row.trim());
  expect(rows.at(-1)).toBe("Files/Git unchanged");
  expect(rows.at(-2)).toEndWith("Esc back");
  ui.mockInput.pressEscape(); await settle(ui);
  expect(ui.editor.plainText).toBe("keep me");
  expect(ui.editor.cursorOffset).toBe(2);
  // Restore the original dimensions before comparing viewport position.
  ui.resize(44, 18); await settle(ui);
  expect(ui.transcript.scrollTop).toBe(before);
});

test("busy and failed branch confirmation retain ancestry and the saved draft", async () => {
  const ui = await setup(44, 18, {}, undefined, { model: createScriptedModel({ waitForAbort: true }) });
  const turn = ui.controller.submit("running task");
  await Bun.sleep(10);
  await ui.mockInput.pasteBracketedText("next task");
  ui.controller.openBranchTree(); await settle(ui);
  ui.mockInput.pressEnter(); await settle(ui);
  expect(ui.controller.isBranchTreeOpen()).toBe(true);
  expect(ui.session.activeBranchId).toBe("main");
  ui.mockInput.pressEscape(); await settle(ui);
  expect(ui.editor.plainText).toBe("next task");
  expect(ui.controller.running).toBe(true);
  ui.controller.cancel(); await turn;
  ui.controller.openBranchTree(); await settle(ui);
  const original = ui.session.selectBranch;
  ui.session.selectBranch = () => { throw new Error("fixture persistence failure"); };
  try {
    ui.mockInput.pressEnter(); await settle(ui);
    expect(ui.controller.isBranchTreeOpen()).toBe(true);
    expect(ui.session.activeBranchId).toBe("main");
    ui.mockInput.pressEscape(); await settle(ui);
    expect(ui.editor.plainText).toBe("next task");
  } finally { ui.session.selectBranch = original; }
});

test("short branch windows always display the exact highlighted existing path and fork point", async () => {
  const session = createSession([
    { type: "user", id: "u", content: [{ type: "text", text: "task" }] },
    { type: "assistant", id: "a", content: [{ type: "text", text: "FORK TARGET" }] },
  ]);
  const branch = session.forkBranch("a", "TARGET PATH");
  const ui = await setup(44, 18, {}, undefined, { session });
  ui.controller.openBranchTree(); await settle(ui);
  for (const [width, height] of [[44, 15], [36, 12], [24, 8]]) {
    ui.resize(width!, height!); await settle(ui);
    expect(ui.controller.snapshot().branchTree?.selectedBranchId).toBe(branch);
    expect(ui.captureCharFrame()).toContain("›● 2. TARGET PATH");
    expect(ui.captureCharFrame()).toContain("Files/Git unchanged");
    ui.mockInput.pressTab(); await settle(ui);
    expect(ui.controller.snapshot().branchTree?.selectedId).toBe("a");
    expect(ui.captureCharFrame()).toContain("FORK TARGET");
    ui.mockInput.pressArrow("up"); await settle(ui);
    expect(ui.controller.snapshot().branchTree?.selectedId).toBe(session.rootId);
    ui.mockInput.pressArrow("down"); await settle(ui);
    expect(ui.captureCharFrame()).toContain("FORK TARGET");
    ui.mockInput.pressTab(); await settle(ui);
  }
  expect(session.activeBranchId).toBe(branch);
});

test("Grok chooser, browser and device panels preserve drafts and show codes at 80x24 and 24x8", async () => {
  for (const device of [false, true]) {
    const store = fakeCredentialStore();
    const ui = await setup(80, 24, {}, undefined, { credentials: { store, env: {}, reload: async () => ({ model: createScriptedModel() }), grokLogin: async ({ signal, onApproval }) => {
      onApproval(device ? { kind: "device", verificationUri: "https://x.ai/device", userCode: "ABCD-EFGH" } : { kind: "browser" });
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); return { ok: false, message: "Cancelled" };
    } } });
    await ui.mockInput.pasteBracketedText("Keep my Thai ไทย draft"); ui.editor.cursorOffset = 5;
    ui.mockInput.pressKey("l", { meta: true }); await settle(ui);
    const choices = ui.controller.snapshot().loginChooser!.rows.filter(row => row.kind === "choice");
    expect(choices.map(row => row.id)).toEqual(["chatgpt", "grok", "openai", "xai", "compatible"]);
    while (ui.controller.snapshot().loginChooser!.selectedId !== "grok") ui.mockInput.pressArrow("down");
    if (device) { ui.mockInput.pressTab(); await settle(ui); expect(ui.controller.snapshot().loginChooser!.selectedId).toBe("grok-device"); }
    ui.mockInput.pressEnter(); await settle(ui);
    const panel = ui.captureCharFrame().split("\n").map(line => line.trim());
    expect(panel.slice(panel.indexOf("Sign in to Grok"), panel.indexOf("◌ Waiting for approval") + 1))
      .toEqual(["Sign in to Grok", ...(device ? ["1 Open x.ai/device", "2 Enter ABCD-EFGH"] : ["Approve in your browser"]), "◌ Waiting for approval"]);
    expect(panel.filter(line => line.includes("Esc"))).toEqual(["Esc cancel sign-in"]);
    if (device) { ui.resize(24, 8); await settle(ui); expect(ui.captureCharFrame()).toContain("x.ai/device"); expect(ui.captureCharFrame()).toContain("ABCD-EFGH"); }
    expect(ui.controller.snapshot().transcript.some(entry => entry.text.includes("ABCD-EFGH"))).toBe(false);
    ui.mockInput.pressEscape(); await ui.controller.waitForIdle(); await settle(ui);
    expect(ui.controller.snapshot().loginChooser).toMatchObject(device ? { level: "grok", selectedId: "grok-device" } : { level: "main", selectedId: "grok" });
    if (device) { ui.mockInput.pressEscape(); await settle(ui); }
    ui.mockInput.pressEscape(); await settle(ui);
    expect(ui.editor.plainText).toBe("Keep my Thai ไทย draft"); expect(ui.editor.cursorOffset).toBe(5); expect(ui.session.items).toHaveLength(0);
  }
});
test("first Grok success and failure restore the composer, and plan rejection opens the chooser with Alt+L", async () => {
  const { grokSubscriptionIdentity } = await import("../src/auth/store.ts");
  for (const outcome of ["success", "failure", "plan"] as const) await withTempDir(async root => {
    const store = fakeCredentialStore(), workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, cli: { provider: "openai", model: "gpt-6-astra" } });
    let finish!: () => void;
    const ui = await setup(80, 24, {}, undefined, { configEditor: editor, workspace, provider: "openai", modelId: "", model: undefined, credentials: { store, env: {}, reload: async () => ({ model: createScriptedModel() }), grokLogin: async ({ onSaved, onApproval }) => {
      onApproval({ kind: "browser" }); await new Promise<void>(resolve => { finish = resolve; });
      if (outcome === "failure") return { ok: false, message: "Grok sign-in was denied." };
      await store.set(grokSubscriptionIdentity(), "saved-grok-token"); onSaved?.(); return { ok: true, status: "Saved" };
    }, listGrokModels: async () => { if (outcome === "plan") throw Error("Your Grok plan doesn't include API access. Use an xAI API key instead."); return [{ id: "grok-4.7", recommended: true }]; } }, stageSettings: async next => ({ model: createScriptedModel({ provider: "xai", id: next.model }), contextManager: createContextManager(workspace) }) });
    await ui.mockInput.pasteBracketedText("My pending task"); ui.editor.cursorOffset = 4;
    ui.mockInput.pressKey("l", { meta: true }); await settle(ui);
    while (ui.controller.snapshot().loginChooser!.selectedId !== "grok") ui.mockInput.pressArrow("down"); ui.mockInput.pressEnter(); await settle(ui);
    finish(); await ui.controller.waitForIdle(); await settle(ui);
    expect(ui.editor.plainText).toBe("My pending task"); expect(ui.editor.cursorOffset).toBe(4); expect(ui.session.items).toHaveLength(0);
    if (outcome === "plan") {
      expect(ui.controller.snapshot().transcript.at(-1)?.text).toBe("Models unavailable; sign-in saved · /model retry · Alt+L sign in · F2 details");
      expect(ui.captureCharFrame()).toContain("Models unavailable; sign-in saved");
      expect(ui.captureCharFrame()).toContain("Alt+L"); expect(await store.get(grokSubscriptionIdentity())).toBe("saved-grok-token");
      ui.mockInput.pressKey("l", { meta: true }); await settle(ui); expect(ui.controller.snapshot().loginChooser).toBeDefined();
    }
    if (outcome === "success") expect(ui.captureCharFrame()).toContain("Grok model active · grok-4.7 · Enter send");
  });
});

const unguardedGrokFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = Object.assign((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") throw new Error("Rendered Grok fixtures must not use external network");
    return unguardedGrokFetch(input, init);
  }, { preconnect: unguardedGrokFetch.preconnect }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = unguardedGrokFetch; });


async function selectRenderedLoginRow(ui: Awaited<ReturnType<typeof setup>>, id: string) {
  const panel = ui.controller.snapshot().loginChooser!;
  const ids = panel.rows.filter(row => row.kind === "choice").map(row => row.id);
  expect(ids).toContain(id);
  while (ui.controller.snapshot().loginChooser!.selectedId !== id) ui.mockInput.pressArrow("down");
  await settle(ui);
}

for (const width of [120, 80]) test(`grouped sign-in rows, muted details and global hints render at ${width} columns`, async () => {
  const ui = await setup(width, 30);
  ui.mockInput.pressKey("l", { meta: true }); await settle(ui);
  const picker = ui.renderer.root.findDescendantById("picker")!;
  const rows = picker.getChildren().filter((row): row is TextRenderable => row instanceof TextRenderable);
  expect(rows.map(row => row.plainText.trim())).toEqual([
    "Sign in", "Subscription", "› ChatGPT            recommended · browser", "Grok               browser", "API key", "OpenAI", "xAI", "Custom endpoint", "OpenAI-compatible  URL + key",
  ]);
  expect(rows[1]!.plainText.startsWith("  Subscription")).toBe(true);
  expect(rows[2]!.plainText.startsWith("    › ChatGPT")).toBe(true);
  expect(rows[2]!.bg.equals(RGBA.fromHex(tint(TUI_THEMES.dark, TUI_THEMES.dark.accent)))).toBe(true);
  const detailColumns = [rows[2]!.plainText.indexOf("recommended"), rows[3]!.plainText.indexOf("browser"), rows[8]!.plainText.indexOf("URL + key")];
  expect(new Set(detailColumns).size).toBe(1);
  expect(rows.some(row => row.plainText.includes("↑↓"))).toBe(false);
  const hints = ui.renderer.root.findDescendantById("hints") as TextRenderable;
  expect(hints.plainText).toBe("↑↓ select · Enter continue · Tab more options · Esc back");
  await selectRenderedLoginRow(ui, "openai"); expect(hints.plainText).toBe("↑↓ select · Enter continue · Esc back");
  await selectRenderedLoginRow(ui, "chatgpt"); ui.mockInput.pressTab(); await settle(ui);
  expect(picker.getChildren().filter((row): row is TextRenderable => row instanceof TextRenderable).map(row => row.plainText.trim())).toEqual(["ChatGPT · more options", "› Device approval", "Paste browser callback"]);
  expect(hints.plainText).toBe("↑↓ select · Enter continue · Esc back");
  ui.mockInput.pressEscape(); await settle(ui); await selectRenderedLoginRow(ui, "grok"); ui.mockInput.pressTab(); await settle(ui);
  expect(picker.getChildren().filter((row): row is TextRenderable => row instanceof TextRenderable).map(row => row.plainText.trim())).toEqual(["Grok · more options", "› Device code"]);
});

test("44 by 18 chooser omits the entire details column, skips headers and scrolls the selected label into view", async () => {
  const ui = await setup(44, 18);
  ui.mockInput.pressKey("l", { meta: true }); await settle(ui);
  const picker = ui.renderer.root.findDescendantById("picker")!;
  for (const id of ["chatgpt", "grok", "openai", "xai", "compatible"]) {
    await selectRenderedLoginRow(ui, id);
    const lines = picker.getChildren().filter((row): row is TextRenderable => row instanceof TextRenderable).map(row => row.plainText);
    expect(lines.length).toBeLessThanOrEqual(5); // Four budget rows plus the title; headers use the same budget.
    expect(lines.join("\n")).not.toContain("…"); expect(lines.join("\n")).not.toMatch(/recommended|browser|URL \+ key/);
    const selected = ui.controller.snapshot().loginChooser!.rows.find(row => row.kind === "choice" && row.id === id)!;
    expect(lines.some(line => line.trim() === `› ${selected.label}`)).toBe(true);
  }
});

for (const chain of ["more-options", "openai", "xai", "callback", "endpoint", "chatgpt-browser", "chatgpt-device", "grok-browser", "grok-device"] as const) test(`Thai draft and cursor survive the ${chain} Esc chain without entering session or recall`, async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const configEditor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root });
    const wait = async ({ signal }: { signal: AbortSignal }) => { await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); return { ok: false as const, message: "Cancelled" }; };
    const ui = await setup(80, 30, {}, wait, { configEditor, workspace,
      stageSettings: async settings => ({ model: createScriptedModel({ provider: settings.provider, id: settings.model }), contextManager: createContextManager(workspace) }),
      credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ model: createScriptedModel() }), codexLogin: wait, grokLogin: wait },
    });
    const draft = "ช่วยอ่านไฟล์นี้\nอธิบายเป็นภาษาไทย\nอย่าเพิ่งส่ง";
    await ui.mockInput.pasteBracketedText(draft); ui.mockInput.pressArrow("left"); const cursor = ui.editor.cursorOffset;
    ui.mockInput.pressKey("l", { meta: true }); await settle(ui);
    if (chain === "more-options" || chain === "callback") {
      ui.mockInput.pressTab(); await settle(ui);
      if (chain === "callback") { await selectRenderedLoginRow(ui, "chatgpt-callback"); ui.mockInput.pressEnter(); await settle(ui); await ui.mockInput.pasteBracketedText("private-browser-callback"); }
    } else if (chain === "openai" || chain === "xai") {
      await selectRenderedLoginRow(ui, chain); ui.mockInput.pressEnter(); await settle(ui); await ui.mockInput.pasteBracketedText("private-api-key");
    } else if (chain === "endpoint") {
      await selectRenderedLoginRow(ui, "compatible"); ui.mockInput.pressEnter(); await settle(ui);
      expect(ui.captureCharFrame()).toContain("Paste or type a URL…");
      const hints = ui.renderer.root.findDescendantById("hints") as TextRenderable; expect(hints.plainText).toBe("Enter continue · Esc cancel");
      await ui.mockInput.pasteBracketedText("http://localhost:8787"); ui.mockInput.pressEnter(); await settle(ui); await ui.mockInput.pasteBracketedText("private-endpoint-key");
      expect(ui.editor.plainText).toBe("");
      ui.mockInput.pressEscape(); await settle(ui); expect(ui.controller.snapshot().endpointUrlEntry!.value).toBe("http://localhost:8787");
      expect(ui.editor.plainText).toBe("");
    } else {
      const provider = chain.startsWith("grok") ? "grok" : "chatgpt";
      await selectRenderedLoginRow(ui, provider); if (chain.endsWith("device")) { ui.mockInput.pressTab(); await settle(ui); }
      ui.mockInput.pressEnter(); await settle(ui); expect(ui.controller.running).toBe(true);
    }
    for (let step = 0; step < 4 && (ui.controller.running || ui.controller.snapshot().loginChooser); step++) {
      ui.mockInput.pressEscape(); await ui.controller.waitForIdle(); await settle(ui);
    }
    expect(ui.editor.plainText).toBe(draft); expect(ui.editor.cursorOffset).toBe(cursor); expect(ui.session.items).toEqual([]);
    expect(ui.renderer.getCursorState().visible).toBe(true);
    expect(ui.editor.plainText).not.toContain("http://localhost:8787");
    // Recall the submitted ordinary task: ephemeral URL/key/callback input never becomes a prompt.
    ui.mockInput.pressEnter(); await ui.controller.waitForIdle(); await settle(ui); ui.mockInput.pressArrow("up");
    expect(ui.editor.plainText).toBe(draft);
  });
});


for (const route of ["codex", "grok"] as const) for (const browserSettled of [true, false]) test(`${route} picker browser failure (${browserSettled ? "settled" : "deferred"}) then device retry Esc restores the rendered picker and fences late OAuth callbacks`, async () => {
  let attempts = 0;
  const deferred: Array<{ options: Parameters<CodexLoginRunner>[0]; resolve: (result: Awaited<ReturnType<CodexLoginRunner>>) => void }> = [];
  const runner: CodexLoginRunner = async options => {
    if (++attempts === 1) {
      options.onProgress("The browser could not be opened automatically");
      if (browserSettled) return { ok: false, message: "Browser approval unavailable" };
    }
    return new Promise(resolve => deferred.push({ options, resolve }));
  };
  const ui = await setup(80, 30, {}, runner, { provider: "openai", modelId: "gpt-5.4",
    credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ model: createScriptedModel() }), codexLogin: runner, grokLogin: runner } });
  const label = route === "codex" ? "ChatGPT" : "Grok subscription", chooser = route === "codex" ? "chatgpt" : "grok";
  const retryIndex = browserSettled ? 0 : 1;
  try {
    ui.mockInput.pressKey("m", { meta: true }); await settle(ui);
    while (ui.controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
    ui.mockInput.pressEnter(); await settle(ui);
    ui.controller.searchModels(label); await settle(ui);
    const picker = ui.controller.snapshot().modelPicker!;
    const identity = picker.entries[picker.selectedIndex]!.identity;
    ui.mockInput.pressEnter(); if (browserSettled) await ui.controller.waitForIdle(); await settle(ui);
    expect(ui.controller.snapshot().loginChooser).toMatchObject({ level: chooser, selectedId: `${chooser}-device` });
    expect(ui.captureCharFrame()).toContain(`${route === "codex" ? "ChatGPT" : "Grok"} · more options`);
    ui.mockInput.pressEnter(); await settle(ui);
    expect(deferred).toHaveLength(retryIndex + 1); expect(deferred[retryIndex]!.options.device).toBe(true);
    if (!browserSettled) expect(deferred[0]!.options.signal.aborted).toBe(true);
    expect(ui.controller.running).toBe(true);
    ui.mockInput.pressEscape(); await settle(ui);
    expect(deferred[retryIndex]!.options.signal.aborted).toBe(true);
    expect(ui.controller.running).toBe(false); expect(ui.controller.snapshot().loginChooser).toBeUndefined();
    expect(ui.controller.snapshot().modelPicker?.query).toBe(label);
    const restored = ui.controller.snapshot().modelPicker!;
    expect(restored.entries[restored.selectedIndex]!.identity).toBe(identity);
    expect(ui.captureCharFrame()).toContain("Connect a provider");
    expect(ui.captureCharFrame()).not.toContain("· more options");
    expect(ui.controller.snapshot().modelId).toBe("gpt-5.4"); expect(ui.controller.snapshot().provider).toBe("openai");
    while (ui.controller.snapshot().modelPicker?.loading) await Bun.sleep(1);
    ui.mockInput.pressEnter(); await settle(ui); expect(deferred).toHaveLength(retryIndex + 2);
    const approval = ui.controller.snapshot().loginApproval;
    for (const old of deferred.slice(0, retryIndex + 1)) {
      old.options.onProgress("The browser could not be opened automatically"); old.options.onSaved?.();
      old.resolve({ ok: true, status: "Old saved result" });
    }
    await settle(ui);
    expect(ui.controller.running).toBe(true); expect(ui.controller.snapshot().loginApproval).toBe(approval);
    expect(ui.controller.snapshot().loginChooser).toBeUndefined(); expect(ui.controller.snapshot().modelPicker).toBeUndefined();
    ui.mockInput.pressEscape(); await settle(ui);
    deferred[retryIndex + 1]!.resolve({ ok: true, status: "Late retry result" }); await settle(ui);
    expect(ui.controller.snapshot().loginChooser).toBeUndefined(); expect(ui.controller.snapshot().modelPicker?.query).toBe(label);
    expect(ui.captureCharFrame()).toContain("Connect a provider"); expect(ui.controller.snapshot().modelId).toBe("gpt-5.4");
  } finally { for (const call of deferred) call.resolve({ ok: true, status: "Stopped" }); await ui.controller.waitForIdle(); }
});

for (const provider of ["chatgpt", "grok"] as const) test(`${provider} pending cancellation allows three Esc presses and restores the Thai draft after settlement`, async () => {
  let finish!: () => void;
  const wait = async () => {
    await new Promise<void>(resolve => { finish = resolve; });
    return { ok: false as const, message: "Cancelled" };
  };
  const ui = await setup(80, 30, {}, wait, {
    credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ model: createScriptedModel() }), codexLogin: wait, grokLogin: wait },
  });
  try {
    const draft = "ช่วยอ่านไฟล์นี้\nอธิบายเป็นภาษาไทย\nอย่าเพิ่งส่ง";
    await ui.mockInput.pasteBracketedText(draft); ui.mockInput.pressArrow("left"); const cursor = ui.editor.cursorOffset;
    ui.mockInput.pressKey("l", { meta: true }); await settle(ui);
    await selectRenderedLoginRow(ui, provider); ui.mockInput.pressTab(); await settle(ui);
    ui.mockInput.pressEnter(); await settle(ui);
    expect(ui.controller.running).toBe(true);
    ui.mockInput.pressEscape(); await settle(ui);
    expect(ui.controller.snapshot().loginChooser).toMatchObject({ level: provider, selectedId: `${provider}-device` });
    expect(ui.captureCharFrame()).toContain(`${provider === "chatgpt" ? "ChatGPT" : "Grok"} · more options`);
    ui.mockInput.pressEscape(); await settle(ui);
    expect(ui.controller.snapshot().loginChooser).toMatchObject({ level: "main", selectedId: provider });
    expect(ui.captureCharFrame()).toContain("Custom endpoint");
    ui.mockInput.pressEscape(); await settle(ui);
    expect(ui.controller.snapshot().loginChooser).toBeUndefined();
    expect(ui.controller.running).toBe(true);
    finish(); await ui.controller.waitForIdle(); await settle(ui);
    expect(ui.controller.snapshot().loginChooser).toBeUndefined();
    expect(ui.editor.plainText).toBe(draft); expect(ui.editor.cursorOffset).toBe(cursor); expect(ui.session.items).toEqual([]);
  } finally { finish?.(); await ui.controller.waitForIdle(); }
});

test("ephemeral endpoint URL never enters a durable draft checkpoint or deferred session file", async () => {
  await withTempDir(async root => {
    const { createJsonlSession, sessionsDirectory } = await import("../src/session/jsonl.ts");
    const { openDraftStore } = await import("../src/drafts/store.ts");
    const home = join(root, "home"), workspace = { root, launchCwd: root, extraRoots: [] };
    const session = await createJsonlSession({ directory: sessionsDirectory(home), workspace, deferred: true });
    const configEditor = await loadConfigEditor({ home, workspaceRoot: root });
    const controller = new TuiController({ session, sessionId: session.header.id, home, workspace, configEditor,
      provider: "openai", modelId: "", contextManager: createContextManager(workspace),
      credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ model: createScriptedModel() }) },
      stageSettings: async next => ({ model: createScriptedModel({ id: next.model }), contextManager: createContextManager(workspace) }),
    });
    const terminal = await createTestRenderer({ width: 80, height: 30, kittyKeyboard: true });
    const view = createConversationView(terminal.renderer, { controller, home, workspaceRoot: root, env: {}, secrets: [], draftPersistence: true,
      quit() {}, submit: (value, accepted) => dispatchEditorInput(value, controller, async () => false, accepted) });
    const ui = { ...terminal, view };
    const editor = terminal.renderer.root.findDescendantById("prompt") as TextareaRenderable;
    try {
      const draft = "เก็บร่างงานนี้\nยังไม่ต้องส่ง"; await terminal.mockInput.pasteBracketedText(draft); terminal.mockInput.pressArrow("left"); const cursor = editor.cursorOffset;
      view.flushDraft(); expect(openDraftStore({ home, workspaceRoot: root, sessionId: session.header.id }).checkpoint?.text).toBe(draft);
      terminal.mockInput.pressKey("l", { meta: true }); await settle(ui);
      while (controller.snapshot().loginChooser!.selectedId !== "compatible") terminal.mockInput.pressArrow("down");
      terminal.mockInput.pressEnter(); await settle(ui);
      await terminal.mockInput.pasteBracketedText("http://localhost:8787"); view.flushDraft();
      expect(editor.plainText).toBe(""); expect(openDraftStore({ home, workspaceRoot: root, sessionId: session.header.id }).checkpoint?.text).not.toContain("http://localhost:8787");
      terminal.mockInput.pressEnter(); await settle(ui); await terminal.mockInput.pasteBracketedText("ephemeral-private-key"); view.flushDraft();
      terminal.mockInput.pressEscape(); await settle(ui); expect(controller.snapshot().endpointUrlEntry!.value).toBe("http://localhost:8787");
      terminal.mockInput.pressEscape(); await settle(ui); expect(controller.snapshot().loginChooser).toMatchObject({ level: "main", selectedId: "compatible" });
      terminal.mockInput.pressEscape(); await settle(ui); view.flushDraft();
      expect(editor.plainText).toBe(draft); expect(editor.cursorOffset).toBe(cursor); expect(session.items).toEqual([]);
      expect(openDraftStore({ home, workspaceRoot: root, sessionId: session.header.id }).checkpoint?.text).toBe(draft);
      const artifacts = await Promise.all((await readdir(join(home, ".schway/drafts"))).map(name => readFile(join(home, ".schway/drafts", name), "utf8")));
      expect(artifacts.join("\n")).not.toContain("http://localhost:8787"); expect(artifacts.join("\n")).not.toContain("ephemeral-private-key");
      const savedSession = await Bun.file(join(sessionsDirectory(home), `${session.header.id}.jsonl`)).text();
      expect(savedSession).not.toContain("http://localhost:8787"); expect(savedSession).not.toContain("ephemeral-private-key");
    } finally { view.destroy(); controller.dispose(); terminal.renderer.destroy(); }
  });
});


for (const width of [120, 80, 50, 24]) test(`short model picker keeps route identity and details within the viewport at ${width} columns`, async () => {
  await withTempDir(async root => {
    const workspace = { root: "/project", launchCwd: "/project", extraRoots: [] };
    const configEditor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, cli: {
      provider: "openai", model: "gpt-6-astra", openaiAuth: "codex", baseUrl: "http://localhost:8787", auth: "none",
    } });
    const store = fakeCredentialStore(); await store.set(codexSubscriptionIdentity(), "fixture-token");
    const ui = await setup(width, width === 24 ? 8 : 30, {}, undefined, {
      configEditor, provider: "openai", modelId: "gpt-6-astra", model: createScriptedModel({ provider: "codex-subscription", id: "gpt-6-astra" }),
      credentials: { store, env: {}, reload: async () => ({ error: "unused" }),
        listSubscriptionCatalog: async () => [{ id: "gpt-6-astra", contextWindow: 1050000, maxOutput: 128000, supportedThinking: ["off", "high"] }],
        listRouteModels: async () => [{ id: "fake-coder", contextWindow: 32768 }] },
      contextManager: createContextManager(workspace),
    });
    ui.controller.openModelPicker(); await waitForUiState(ui, () => !ui.controller.snapshot().modelPicker?.loading, "grouped picker"); await settle(ui);
    const frame = ui.captureCharFrame();
    if (width >= 50) {
      expect(frame).toContain("API · localhost:8787"); expect(frame).toContain("GPT-6 Astra"); expect(frame).toContain("fake-coder");
      expect(frame).not.toContain("32k");
      expect(frame).not.toContain("reasoning");
      expect(frame).toContain("ChatGPT subscription");
      expect(frame).toContain("F2 details");
      expect(frame).not.toContain("✓ current");
      expect(frame).not.toContain("Ctrl+R retry");
    } else {
      expect(frame).toContain("Choose model");
      expect(ui.controller.snapshot().modelPicker!.entries.find(entry => entry.active)?.modelId).toBe("gpt-6-astra");
      expect(frame).toContain("Auto · Esc back"); expect(frame.split("\n").filter(line => line.trim()).length).toBeLessThanOrEqual(8);
    }
    ui.controller.searchModels("coder"); await settle(ui);
    const picker = ui.controller.snapshot().modelPicker!;
    expect(picker.entries.filter(entry => entry.kind === "model").map(entry => entry.modelId)).toEqual(["fake-coder"]);
    if (width >= 50) expect(ui.captureCharFrame()).toContain("fake-coder");
    expect(ui.captureCharFrame().split("Choose model")[1]!.split("▄")[0]).not.toContain("GPT-6 Astra");
  });
});

test("failed route list offers retry while capacity stays behind details", async () => {
  const ui = await setup(120, 30, {}, undefined, { provider: "openai", modelId: "gpt-5.4",
    credentials: { store: fakeCredentialStore(), env: { OPENAI_API_KEY: "fixture-key" }, reload: async () => ({ error: "unused" }), listRouteModels: async () => { throw Error("offline"); } } });
  ui.controller.openModelPicker(); await waitForUiState(ui, () => !ui.controller.snapshot().modelPicker?.loading, "failed list");
  ui.controller.searchModels("gpt-5.4"); await settle(ui);
  const frame = ui.captureCharFrame(); expect(frame.match(/OpenAI API models unavailable/g)).toHaveLength(1);
  expect(frame).not.toContain("256,000 context");
  expect(frame).toContain("Ctrl+R retry");
  expect(ui.controller.snapshot().modelPicker!.entries.filter(entry => entry.kind === "model")).toHaveLength(1);
});

test("completed outcome and responsive numbered review preserve draft and hide fixture call IDs", async () => {
  await withTempDir(async dir => {
    const git = async (...args: string[]) => {
      const proc = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
      if (await proc.exited) throw new Error(await new Response(proc.stderr).text());
    };
    await git("init", "-q");
    await writeFile(join(dir, "a.txt"), "before\n");
    await git("add", ".");
    await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "baseline");
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    let now = 0;
    const ui = await setup(80, 28, {}, undefined, { workspace, contextManager: createContextManager(workspace), activityClock: () => now,
      onRuntimeEvent: event => { if (event.type === "agent.finished") now = 14000; }, tools: createToolRegistry([editTool, bashTool]),
      model: createScriptedModel({ responses: [{ toolCalls: [
        { id: "call_fixture_1", name: "edit", arguments: { path: "a.txt", edits: [{ oldText: "before", newText: "after" }] } },
        { id: "call_fixture_2", name: "bash", arguments: { command: "printf ok" } },
      ] }, { text: "done" }, { toolCalls: [{ id: "call_fixture_3", name: "bash", arguments: { command: "printf changed > a.txt; printf generated > shell.txt" } }] }, { text: "generated" }] }),
    });
    await ui.controller.submit("edit and check");
    await settle(ui);
    expect(ui.captureCharFrame()).toContain("✓ Done · 1 file +1 −1 · 1 command ok");
    const outcomeRow = ui.renderer.root.findDescendantById("activity") as TextRenderable;
    expect(outcomeRow.chunks.find(chunk => chunk.text === "Done")?.fg).toEqual(RGBA.fromHex(TUI_THEMES.dark.success));
    expect(ui.captureCharFrame()).toContain("Alt+R review");
    expect(ui.captureCharFrame()).not.toContain("Turn completed");
    expect(ui.captureCharFrame()).not.toContain("exit 0 /");
    const count = ui.controller.snapshot().transcript.length;
    ui.mockInput.pressKey("i", { ctrl: true }); await settle(ui);
    expect(ui.controller.snapshot().transcript).toHaveLength(count);
    await ui.mockInput.pasteBracketedText("keep draft");
    ui.mockInput.pressKey("r", { meta: true });
    await waitForUiState(ui, () => !!ui.controller.snapshot().changeReview && !ui.controller.snapshot().changeReview!.loading, "numbered review");
    await settle(ui);
    const frame = ui.captureCharFrame();
    expect(frame).toContain("Review · turn 1");
    expect(frame).toContain("› a.txt");
    expect(frame).toContain("1 - before");
    expect(frame).toContain("1 + after");
    // Review owns Alt+R and F2, so the outcome strip names no action that is dead here.
    expect(frame).toContain("✓ Done · 1 file +1 −1 · 1 command ok");
    expect(frame).not.toContain("Alt+R review");
    const diffText = ui.renderer.root.findDescendantById("change-review-text") as TextRenderable;
    expect(diffText.chunks.find(chunk => chunk.text.includes("- before"))?.fg).toEqual(RGBA.fromHex(TUI_THEMES.dark.error));
    expect(diffText.chunks.find(chunk => chunk.text.includes("+ after"))?.fg).toEqual(RGBA.fromHex(TUI_THEMES.dark.success));
    for (const hidden of ["diff --git", "@@", "call_fixture_1", "call_fixture_2", "unattributed"]) expect(frame).not.toContain(hidden);
    const files = ui.renderer.root.findDescendantById("change-review-files")!;
    const diff = ui.renderer.root.findDescendantById("change-review-diff")!;
    expect(files.y).toBe(diff.y);
    expect(diff.x).toBeGreaterThan(files.x);
    expect(files.width).toBe(20);
    ui.resize(79, 28); await settle(ui);
    expect(diff.y).toBeGreaterThan(files.y);
    expect(diff.x).toBe(files.x);
    ui.resize(50, 28); await settle(ui);
    expect(ui.captureCharFrame()).toContain("Esc back");
    expect(ui.captureCharFrame()).toContain("F2 details");
    ui.resize(79, 28); await settle(ui);
    ui.mockInput.pressKey("i", { ctrl: true }); await settle(ui);
    expect(ui.controller.snapshot().changeReview!.showingDetails).toBe(true);
    expect(ui.captureCharFrame()).toContain("1 exit 0 / 0 nonzero / 0 unknown");
    expect(ui.captureCharFrame()).not.toContain("call_fixture_");
    ui.mockInput.pressEscape(); await settle(ui);
    expect(ui.controller.snapshot().changeReview!.showingDetails).toBe(false);
    expect(ui.captureCharFrame()).toContain("1 + after");
    ui.mockInput.pressEscape(); await settle(ui);
    expect(ui.editor.plainText).toBe("keep draft");
    await ui.controller.submit("generate files");
    ui.mockInput.pressKey("r", { meta: true });
    await waitForUiState(ui, () => !!ui.controller.snapshot().changeReview && !ui.controller.snapshot().changeReview!.loading, "shell review");
    ui.mockInput.pressArrow("down");
    await waitForUiState(ui, () => ui.controller.snapshot().changeReview?.selected === 1 && !ui.controller.snapshot().changeReview!.loading, "second shell file");
    await settle(ui);
    expect(ui.captureCharFrame()).toContain("› shell.txt");
    expect(ui.captureCharFrame()).toContain("Found by Git snapshot · not undoable");
    expect(ui.captureCharFrame()).toContain("1 + generated");
    expect(ui.captureCharFrame()).not.toContain("call_fixture_");
  });
});

test("failed outcome details append once and review details escape returns to the diff", async () => {
  const ui = await setup(80, 28, {}, undefined, { activityClock: () => 0,
    tools: createToolRegistry([{ ...bashTool, execute: async () => ({ content: "failed", isError: true, details: { command: "check", exitCode: 7 } }) }]),
    model: createScriptedModel({ responses: [{ toolCalls: [{ id: "call_fixture_failure", name: "bash", arguments: { command: "check" } }] }, { error: "fixture diagnostic" }] }),
  });
  await ui.controller.submit("try a check"); await settle(ui);
  expect(ui.captureCharFrame()).toContain("✗ Failed");
  expect(ui.captureCharFrame()).toContain("F2 details");
  ui.mockInput.pressEscape(); await settle(ui);
  expect(ui.controller.snapshot().recovery).toBeUndefined();
  expect(ui.captureCharFrame()).toContain("F2 details");
  const before = ui.controller.snapshot().transcript.length;
  ui.mockInput.pressKey("i", { ctrl: true }); await settle(ui);
  expect(ui.controller.snapshot().transcript).toHaveLength(before + 1);
  const details = ui.controller.snapshot().transcript.at(-1)!.text;
  expect(details).toContain("0 exit 0 / 1 nonzero / 0 unknown");
  expect(details).toContain("check → exit 7");
  expect(details).toContain("fixture diagnostic");
  expect(details).not.toContain("call_fixture_failure");
  // The cause leads the details, and open details ignore F2, so the strip names only the live Alt+R action.
  expect(details.split("\n")[0]).toBe("✗ Failed");
  expect(details.split("\n")[1]).toStartWith("Failure details: ");
  const strip = () => (ui.renderer.root.findDescendantById("activity") as TextRenderable).plainText;
  expect(strip()).toContain("Alt+R review");
  expect(strip()).not.toContain("F2 details");
  ui.mockInput.pressKey("r", { meta: true });
  await waitForUiState(ui, () => !!ui.controller.snapshot().changeReview && !ui.controller.snapshot().changeReview!.loading, "failed review");
  ui.mockInput.pressKey("i", { ctrl: true }); await settle(ui);
  expect(ui.controller.snapshot().changeReview!.showingDetails).toBe(true);
  // Review Details are the failed-turn Details plus review-only scope notes; the conversation copy stays unchanged.
  expect(ui.controller.snapshot().changeReview!.details).toBe(`${details}\n\n${reviewScopeDetails({ kind: "turn", turn: 1 })}`);
  expect(details).not.toContain("Review scope:");
  expect(ui.captureCharFrame()).not.toContain("call_fixture_failure");
  ui.mockInput.pressKey("i", { ctrl: true }); await settle(ui);
  expect(ui.controller.snapshot().changeReview!.showingDetails).toBe(false);
  ui.mockInput.pressKey("i", { ctrl: true }); await settle(ui);
  ui.mockInput.pressEscape(); await settle(ui);
  expect(ui.controller.snapshot().changeReview!.showingDetails).toBe(false);
  ui.mockInput.pressEscape(); await settle(ui);
  expect(ui.controller.snapshot().changeReview).toBeUndefined();
  // Opening review closed details, so F2 works again and the strip names it.
  expect(strip()).toContain("Alt+R review · F2 details");
});

test("review pages reveal long unbroken and Thai line tails at two-column and stacked widths", async () => {
  await withTempDir(async dir => {
    const git = Bun.spawn(["git", "init", "-q"], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    expect(await git.exited).toBe(0);
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    for (const width of [80, 79, 50]) {
      const ui = await setup(width, 22, {}, undefined, { workspace, contextManager: createContextManager(workspace), tools: createToolRegistry([writeTool]),
        model: createScriptedModel({ responses: [{ toolCalls: [{ id: "long-lines", name: "write", arguments: {
          path: "long.txt", content: `${"x".repeat(1200)}終\n${"ภาษาไทย".repeat(150)}尾\n`,
        } }] }, { text: "done" }] }),
      });
      await ui.controller.submit("write long lines");
      await ui.controller.openChangeReview(); await settle(ui);
      expect(ui.captureCharFrame()).toContain("1 + ");
      expect(ui.captureCharFrame()).not.toContain("終");
      const text = ui.renderer.root.findDescendantById("change-review-text") as TextRenderable;
      expect(text.chunks.find(chunk => chunk.text.includes("終"))?.fg).toEqual(RGBA.fromHex(TUI_THEMES.dark.success));
      const diff = ui.renderer.root.findDescendantById("change-review-diff") as ScrollBoxRenderable;
      let visible = ui.captureCharFrame();
      for (let page = 0; page < 60; page++) {
        const before = diff.scrollTop;
        await ui.mockInput.pressKeys(["\u001b[6~"]); await settle(ui);
        visible += ui.captureCharFrame();
        if (diff.scrollTop === before) break;
      }
      expect(visible).toContain("終");
      expect(visible).toContain("尾");
      expect(visible).toContain("2 + ");
    }
  });
});

test("review pages overlap without skipping numbered rows at two-column and stacked widths", async () => {
  await withTempDir(async dir => {
    const git = Bun.spawn(["git", "init", "-q"], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    expect(await git.exited).toBe(0);
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const content = Array.from({ length: 60 }, (_, index) => `ROW_${String(index).padStart(3, "0")}`).join("\n");
    for (const width of [80, 79, 50]) {
      const ui = await setup(width, 22, {}, undefined, { workspace, contextManager: createContextManager(workspace), tools: createToolRegistry([writeTool]),
        model: createScriptedModel({ responses: [{ toolCalls: Array.from({ length: 8 }, (_, index) => ({
          id: `page-file-${index}`, name: "write", arguments: { path: `${index}.txt`, content },
        })) }, { text: "done" }] }),
      });
      await ui.controller.submit("write numbered lines");
      await ui.controller.openChangeReview(); await settle(ui);
      const visibleRows = () => [...ui.captureCharFrame().matchAll(/ROW_(\d+)/g)].map(match => Number(match[1]));
      let previous = visibleRows();
      expect(previous[0]).toBe(0);
      const seen = new Set(previous);
      for (let page = 0; page < 60 && !seen.has(59); page++) {
        await ui.mockInput.pressKeys(["\u001b[6~"]); await settle(ui);
        const current = visibleRows();
        expect(current[0]).toBeLessThanOrEqual(previous.at(-1)!);
        expect(current.at(-1)).toBeGreaterThan(previous.at(-1)!);
        current.forEach(row => seen.add(row));
        previous = current;
      }
      expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 60 }, (_, index) => index));
      await ui.mockInput.pressKeys(["\u001b[5~"]); await settle(ui);
      const earlier = visibleRows();
      expect(earlier[0]).toBeLessThan(previous[0]!);
      expect(earlier.at(-1)).toBeGreaterThanOrEqual(previous[0]!);
    }
  });
});

test("new unaccepted recovery details take priority over retained completed and failed outcomes", async () => {
  for (const failed of [false, true]) {
    const ui = await setup(80, 28, {}, undefined, { changeTracking: "off",
      model: createScriptedModel(failed ? { error: "old accepted-turn diagnostic" } : { text: "done" }),
    });
    await ui.controller.submit("first turn"); await settle(ui);
    ui.controller.setModel(undefined, "openai", "fixture");
    await ui.controller.initializeStartup(async () => ({ error: "new unaccepted startup diagnostic" }));
    await ui.mockInput.pasteBracketedText("keep the new draft"); await settle(ui);
    expect(ui.controller.snapshot().recovery).toMatchObject({ accepted: false, actions: ["details", "keep-editing"] });
    expect(ui.captureCharFrame()).toContain("F2 details");
    const before = ui.controller.snapshot().transcript.length;
    ui.mockInput.pressKey("i", { ctrl: true }); await settle(ui);
    expect(ui.controller.snapshot().transcript).toHaveLength(before + 1);
    expect(ui.controller.snapshot().transcript.at(-1)!.text).toBe("Failure details: new unaccepted startup diagnostic");
    expect(ui.editor.plainText).toBe("keep the new draft");
    expect(ui.session.items.filter(item => item.type === "user")).toHaveLength(1);
    ui.controller.keepEditingRecovery();
    ui.resize(24, 28); await settle(ui);
    const activity = ui.renderer.root.findDescendantById("activity") as TextRenderable;
    expect(activity.plainText).not.toContain("F2 details");
    const dismissed = ui.controller.snapshot().transcript.length;
    ui.mockInput.pressKey("i", { ctrl: true }); await settle(ui);
    expect(ui.controller.snapshot().transcript).toHaveLength(dismissed);
  }
});

test("fresh review opens current changes and names an unavailable workspace without files", async () => {
  const ui = await setup();
  ui.mockInput.pressKey("r", { meta: true });
  for (let i = 0; i < 200 && ui.controller.snapshot().changeReview?.loading !== false; i++) await settle(ui);
  await settle(ui);
  expect(ui.controller.snapshot().changeReview!.heading).toBe("Review · current changes");
  expect(ui.controller.snapshot().changeReview!.files).toEqual([]);
  expect(ui.captureCharFrame()).toContain("Workspace unavailable · Ctrl+R reload");
  ui.mockInput.pressEscape(); await settle(ui);
  expect(ui.controller.snapshot().changeReview).toBeUndefined();
});


test("header shrinks the path before the branch and restores both on resize", async () => {
  await withTempDir(async temp => {
    const home = join(temp, "home", "test");
    const root = join(home, "Projects", "very-long-directory-name", "schway");
    await mkdir(join(root, ".git"), { recursive: true });
    const branch = "feature/a-very-long-branch-name-for-testing";
    await writeFile(join(root, ".git/HEAD"), `ref: refs/heads/${branch}\n`);
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const ui = await setup(120, 28, {}, undefined, { workspace }, undefined, {}, { home });
    const headers = new Map<number, string>();
    for (const width of [120, 80, 50, 40, 39, 120]) {
      ui.resize(width, 28); await settle(ui);
      const line = ui.captureCharFrame().split("\n")[0]!.trimEnd();
      expect(line).toContain("schway  ");
      expect(line.match(/schway/g)).toHaveLength(2);
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
      if (width >= 80) expect(line).toContain(` on ${branch}`);
      if (width === 50 || width === 40) { expect(line).toContain("…/schway on feature/"); expect(line).toEndWith("…"); }
      if (width < 40) expect(line).not.toContain(" on ");
      if (headers.has(width)) expect(line).toBe(headers.get(width)!);
      headers.set(width, line);
    }
    expect(headers.get(120)).toContain("~/Projects/very-long-directory-name/schway");
  });
});

test("detached SHA and wide Unicode branch stay whole when the header has room", async () => {
  for (const head of ["1234567abcdef1234567abcdef1234567abcdef1234", "ref: refs/heads/งาน/資料庫"]) await withTempDir(async home => {
    const root = join(home, "Projects", "ทดสอบ");
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git/HEAD"), head + "\n");
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const ui = await setup(80, 28, {}, undefined, { workspace }, undefined, {}, { home });
    const line = ui.captureCharFrame().split("\n")[0]!;
    expect(line).toContain("~/Projects/ทดสอบ");
    expect(line).toContain(head.startsWith("ref:") ? " on งาน/資料庫" : " on 1234567");
  });
});

test("splash preferences set and reset session and user fields without losing inline diff limits or loading a model", async () => {
  await withTempDir(async root => {
    const ui = await preferenceFixture(root, { model: undefined, stageSettings: async () => { throw new Error("Display settings must not load a model"); } });
    for (const scope of ["session", "user"] as const) {
      expect(await ui.controller.configCommand(`set ui {"inlineDiffLines":7} --scope ${scope}`)).toBe(true);
      ui.controller.openPreferences();
      if (scope === "user") { ui.controller.movePreference(1, "scope"); }
      const rows = ui.controller.snapshot().preferences!.rows;
      const index = rows.findIndex(row => row.key === "ui.splash");
      expect(rows[index]!.choices).toEqual([undefined, "always", "first-run", "never"]);
      ui.controller.movePreference(index);
      ui.controller.movePreference(3, "choice");
      expect(await ui.controller.selectPreference()).toBe(true);
      expect(await ui.controller.selectPreference()).toBe(true);
      if (scope === "session") expect(ui.configEditor.settings).toMatchObject({ splash: "never", inlineDiffLines: 7 });
      else expect(await Bun.file(join(ui.home, ".schway/config.json")).json()).toEqual({ ui: { splash: "never", inlineDiffLines: 7 } });
      ui.controller.movePreference(1, "choice");
      expect(await ui.controller.selectPreference()).toBe(true);
      expect(await ui.controller.selectPreference()).toBe(true);
      if (scope === "session") expect(ui.configEditor.settings).toMatchObject({ splash: "first-run", inlineDiffLines: 7 });
      else expect(await Bun.file(join(ui.home, ".schway/config.json")).json()).toEqual({ ui: { inlineDiffLines: 7 } });
      ui.controller.closePreferences();
    }
    expect(await ui.controller.configCommand('set ui {"splash":"never"}')).toBe(true);
    expect(ui.configEditor.settings).toMatchObject({ splash: "never", inlineDiffLines: 7 });
    expect(ui.controller.describeConfig()).toContain('ui: {"splash":"never","inlineDiffLines":7}');
    expect(await ui.controller.configCommand('set ui {"splash":"sometimes"}')).toBe(false);
  });
});


test("narrow header hides a detached SHA rather than shortening its identity", async () => {
  await withTempDir(async home => {
    const root = join(home, "Projects", "abcdefghijklmnop");
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git/HEAD"), "1234567abcdef1234567abcdef1234567abcdef1234\n");
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const ui = await setup(120, 28, {}, undefined, { workspace }, undefined, {}, { home });
    for (const width of [40, 44, 120, 40]) {
      ui.resize(width, 28); await settle(ui);
      const header = ui.captureCharFrame().split("\n")[0]!;
      expect(header).toContain("abcdefghijklmnop");
      if (width === 40) expect(header).not.toContain(" on ");
      else expect(header).toContain(" on 1234567");
      expect(header).not.toContain("1234…");
    }
  });
});


test("Ctrl+I reveals notice diagnostics without changing the draft or session", async () => {
  const session = createSession();
  const ui = await setup(80, 28, {}, undefined, { session });
  ui.controller.notice("Choice not remembered · Enter use model · F2 details", "Storage diagnostic secret-sentinel");
  ui.editor.setText("retained draft");
  await settle(ui);
  expect(ui.captureCharFrame()).not.toContain("Storage diagnostic");
  ui.mockInput.pressKey("i", { ctrl: true }); await settle(ui);
  expect(ui.captureCharFrame()).toContain("Storage diagnostic ***");
  expect(ui.editor.plainText).toBe("retained draft");
  expect(session.items).toEqual([]);
});


test("undo retention can be set as JSON, shown effectively, and reset", async () => {
  await withTempDir(async root => {
    const ui = await preferenceFixture(root);
    expect(await ui.controller.configCommand('set undo {"maxAgeDays":14}')).toBe(true);
    expect(ui.configEditor.settings).toMatchObject({ undoMaxAgeDays: 14, undoMaxSizeMB: 500 });
    expect(ui.controller.describeConfig()).toContain('undo: {"maxAgeDays":14,"maxSizeMB":500} [current-session override]');
    expect(ui.controller.snapshot().transcript.at(-1)?.text).toContain('Effective: {"maxAgeDays":14,"maxSizeMB":500}');
    expect(await ui.controller.configCommand('set undo {"maxSizeMB":250} --scope user')).toBe(true);
    expect(await Bun.file(join(ui.home, ".schway/config.json")).json()).toEqual({ undo: { maxSizeMB: 250 } });
    expect(await ui.controller.configCommand('reset undo')).toBe(true);
    expect(ui.configEditor.settings).toMatchObject({ undoMaxAgeDays: 30, undoMaxSizeMB: 250 });
    expect(await ui.controller.configCommand('set undo broken')).toBe(false);
    expect(ui.controller.snapshot().transcript.at(-1)?.text).toBe('Invalid undo settings · /config set undo {"maxAgeDays":14} retry');
  });
});

test("rendered config startup notice appears once even when configuration is reloaded", async () => {
  const ui = await setup(120, 40);
  const parsed = (await import("../src/config/config.ts")).parseConfigObject({ oldTurns: 7 }, "/config.json", [{ key: "oldTurns", replacement: "maxTurns", since: "1.1.0", removeIn: "2.0" }]);
  if ("error" in parsed) throw Error(parsed.error);
  noticeConfigDeprecations(ui.controller, parsed.deprecationWarnings!);
  noticeConfigDeprecations(ui.controller, structuredClone(parsed.deprecationWarnings!));
  await settle(ui);
  const text = parsed.deprecationWarnings![0]!.message;
  expect(ui.controller.snapshot().transcript.filter(entry => entry.text === text)).toHaveLength(1);
  expect(ui.captureCharFrame()).toContain('Config: "oldTurns" in /config.json is deprecated; use "maxTurns".');
  expect(ui.captureCharFrame()).toContain("It will be removed in 2.0.");
});

for (const action of ["keep-editing", "continue", "inspection-escape", "inspection-continue"] as const) test(`stopped streaming ${action} keeps Thai type-ahead and accepted-turn ownership`, async () => {
  const cleanup = Promise.withResolvers<void>();
  const partial = "```txt\nแรก 😀\n```\n\n" + "Earlier explanation.\n\n".repeat(20) + "```txt\nท้ายสุด 🧪\n```";
  const scripted = createScriptedModel({ responses: [{ text: partial, waitForAbort: true }, { text: "next explicit work" }] });
  const ui = await setup(50, 20, {}, undefined, { changeTracking: "off", model: { ...scripted, async *stream(request) {
    try { yield* scripted.stream(request); } finally { if (request.signal?.aborted) await cleanup.promise; }
  } } }, undefined, {}, { motion: "off" });
  try {
    await ui.mockInput.pasteBracketedText("accepted task"); ui.mockInput.pressEnter();
    await waitForUiState(ui, () => ui.controller.snapshot().transcript.some(row => row.text === partial), "partial streamed code");
    await ui.mockInput.pasteBracketedText("เก็บงานภาษาไทย\nอีกบรรทัด 😀");
    ui.editor.cursorOffset = 9; ui.editor.setSelection(3, 9);
    const draft = { text: ui.editor.plainText, cursor: ui.editor.cursorOffset, selection: ui.editor.getSelectedText() };
    ui.mockInput.pressEscape(); await ui.flush();
    expect(ui.captureCharFrame()).toContain("Stop requested");
    ui.mockInput.pressEscape(); await settle(ui);
    expect(ui.controller.running).toBe(true);
    expect(ui.controller.snapshot().activity?.phase).toBe("stopping");
    expect(ui.captureCharFrame()).toContain("Stopping");
    expect(ui.controller.snapshot().recovery).toBeUndefined();
    cleanup.resolve(); await ui.controller.waitForIdle(); await settle(ui);
    const stopped = ui.controller.snapshot();
    expect(stopped.outcome?.reason).toBe("cancelled");
    expect(stopped.transcript.filter(row => row.kind === "error")).toEqual([]);
    expect(stopped.transcript.filter(row => row.text.startsWith("Stopped ·"))).toHaveLength(1);
    expect(stopped.transcript.find(row => row.text === partial)?.incomplete).toBe(true);
    expect(ui.captureCharFrame()).toContain("Ready");
    expect(ui.captureCharFrame()).not.toContain("! Error");
    ui.transcript.scrollTo(0); await settle(ui);
    const scroll = ui.transcript.scrollTop;
    if (action.startsWith("inspection-")) {
      ui.mockInput.pressKey("i", { meta: true }); await settle(ui);
      ui.mockInput.pressTab(); await settle(ui);
      expect(ui.editor.focused).toBe(false);
      expect(ui.captureCharFrame()).toContain("C copy · Esc back");
      expect(ui.transcript.scrollTop).not.toBe(scroll);
    }
    if (action.endsWith("continue")) {
      ui.mockInput.pressKey("r", { ctrl: true }); await ui.controller.waitForIdle(); await settle(ui);
      expect(ui.controller.snapshot().outcome?.reason).toBe("completed");
      expect(ui.session.items.filter(row => row.type === "user")).toHaveLength(1);
      expect(ui.controller.snapshot().recovery).toBeUndefined();
    } else {
      ui.mockInput.pressEscape(); await settle(ui);
      expect(ui.editor.focused).toBe(true);
      expect(ui.transcript.scrollTop).toBe(scroll);
      expect(ui.controller.snapshot().recovery).toEqual(action === "inspection-escape" ? stopped.recovery : undefined);
    }
    expect(ui.editor.plainText).toBe(draft.text);
    expect(ui.editor.cursorOffset).toBe(draft.cursor);
    expect(ui.editor.getSelectedText()).toBe(draft.selection);
    expect(ui.copied).toEqual([]);
    if (action === "keep-editing") {
      ui.mockInput.pressEnter(); await ui.controller.waitForIdle(); await settle(ui);
      const users = ui.session.items.filter(row => row.type === "user");
      expect(users).toHaveLength(2);
      expect(users[1]?.content).toEqual([{ type: "text", text: draft.text }]);
      expect(ui.editor.plainText).toBe("");
    }
  } finally { cleanup.resolve(); ui.controller.cancel(); await ui.controller.waitForIdle(); }
});

for (const appearance of ["dark", "light", "no-color"] as const) test(`stopped and failed outcomes retain distinct meaning across ${appearance} widths and motion`, async () => {
  const env: Record<string, string> = appearance === "no-color" ? { SCHWAY_THEME: "dark", NO_COLOR: "1" } : { SCHWAY_THEME: appearance };
  for (const failed of [false, true]) {
    const ui = await setup(120, 30, {}, undefined, { changeTracking: "off", model: createScriptedModel(failed
      ? { error: "Provider rejected request", status: 400 }
      : { text: "คำตอบบางส่วน 🧪", waitForAbort: true }) }, undefined, env, { motion: failed ? "reduced" : "off" });
    try {
      await ui.mockInput.typeText("start work"); ui.mockInput.pressEnter();
      if (!failed) {
        await waitForUiState(ui, () => ui.controller.snapshot().transcript.some(row => row.text === "คำตอบบางส่วน 🧪"), "partial answer");
        ui.mockInput.pressEscape();
      }
      await ui.controller.waitForIdle(); await settle(ui);
      const theme = resolveTheme(appearance === "light" ? "light" : "dark", null, env);
      for (const [width, height] of [[120, 30], [80, 30], [50, 30], [40, 20], [44, 18], [40, 8], [50, 8]] as const) {
        ui.resize(width, height); await settle(ui);
        const outcome = ui.renderer.root.findDescendantById("activity") as TextRenderable;
        const label = failed ? "Failed" : "Stopped";
        expect(outcome.chunks.find(chunk => chunk.text === label)?.fg).toEqual(RGBA.fromHex(failed ? theme.error : theme.muted));
        expect(ui.controller.snapshot().outcome?.reason).toBe(failed ? "failed" : "cancelled");
        expect(ui.captureCharFrame()).toContain("Auto");
        if (height >= 10) expect(ui.captureCharFrame()).toContain(label);
        if (!failed) expect(ui.captureCharFrame()).not.toContain("! Error");
      }
    } finally { ui.controller.cancel(); await ui.controller.waitForIdle(); }
  }
});

test("keyboard stop retains a real write, exposes review and continues without replaying tools", async () => withTempDir(async root => {
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  await writeFile(join(root, "baseline.txt"), "before\n");
  for (const args of [["init", "-q"], ["add", "baseline.txt"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "baseline"]]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, env: gitEnv });
    if (result.exitCode) throw new Error(result.stderr.toString());
  }
  const workspace = { root, launchCwd: root, extraRoots: [] };
  let writes = 0;
  const ui = await setup(80, 28, {}, undefined, { workspace, contextManager: createContextManager(workspace),
    tools: createToolRegistry([{ ...writeTool, execute: async (...args: Parameters<typeof writeTool.execute>) => { writes++; return writeTool.execute(...args); } }, bashTool]),
    model: createScriptedModel({ responses: [
      { toolCalls: [{ id: "saved-file", name: "write", arguments: { path: "saved.txt", content: "completed ไทย 🧪\n" } }] },
      { toolCalls: [{ id: "active-shell", name: "bash", arguments: { command: "printf 'Ready to stop\\n'; sleep 30", timeout: 5_000 } }] },
      { text: "Continued saved work." },
    ] }),
  });
  try {
    await ui.mockInput.typeText("write then run a command"); ui.mockInput.pressEnter();
    await waitForUiState(ui, () => ui.controller.snapshot().transcript.some(row => row.toolCallId === "active-shell" && row.text.includes("Ready to stop")), "live shell output");
    await ui.mockInput.pasteBracketedText("งานถัดไป 🧪\nยังไม่ส่ง"); ui.editor.cursorOffset = 3;
    ui.mockInput.pressEscape(); await ui.controller.waitForIdle(); await settle(ui);
    expect(ui.controller.snapshot().outcome?.reason).toBe("cancelled");
    expect(ui.controller.snapshot().transcript.filter(row => row.kind === "error")).toEqual([]);
    expect(ui.controller.snapshot().transcript.find(row => row.toolCallId === "saved-file")?.toolStatus).toBe("success");
    expect(ui.controller.snapshot().transcript.find(row => row.toolCallId === "active-shell")?.toolStatus).toBe("cancelled");
    expect(await readFile(join(root, "saved.txt"), "utf8")).toBe("completed ไทย 🧪\n");
    ui.mockInput.pressKey("r", { meta: true }); await waitForUiState(ui, () => !!ui.controller.snapshot().changeReview && !ui.controller.snapshot().changeReview?.loading, "stopped turn review");
    expect(ui.captureCharFrame()).toContain("saved.txt");
    ui.mockInput.pressEscape(); await settle(ui);
    expect(ui.editor.plainText).toBe("งานถัดไป 🧪\nยังไม่ส่ง"); expect(ui.editor.cursorOffset).toBe(3);
    ui.mockInput.pressKey("r", { ctrl: true }); await ui.controller.waitForIdle(); await settle(ui);
    expect(ui.controller.snapshot().outcome?.reason).toBe("completed");
    expect(writes).toBe(1);
    expect(ui.session.items.filter(row => row.type === "tool_result")).toHaveLength(2);
    expect(ui.session.items.filter(row => row.type === "user")).toHaveLength(1);
    expect(ui.editor.plainText).toBe("งานถัดไป 🧪\nยังไม่ส่ง"); expect(ui.editor.cursorOffset).toBe(3);
  } finally { ui.controller.cancel(); await ui.controller.waitForIdle(); }
}));
