import { beforeAll, afterAll, afterEach, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { BoxRenderable, RGBA, TextareaRenderable, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { createConversationView, type ConversationViewOptions } from "../src/tui/view.ts";
import { TuiController, buildTranscriptFromSession, type CodexLoginRunner, type TuiControllerOptions } from "../src/tui/controller.ts";
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
import { resolveWorkspace } from "../src/workspace/workspace.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function setup(width = 80, height = 28, credentialEnv: Record<string, string> = {}, codexLogin?: CodexLoginRunner, overrides: Partial<TuiControllerOptions> = {}, submitOverride?: ConversationViewOptions["submit"], viewEnv: Record<string, string> = {}) {
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
      expect(ui.captureCharFrame()).toContain("○ NOT CONNECTED");
      if (height >= 10) expect(ui.captureCharFrame()).toContain("Alt+L sign in");
      const empty = ui.renderer.root.findDescendantById("empty-conversation") as TextRenderable;
      expect(empty.chunks.map(chunk => chunk.text).join("")).toContain("Not connected\nSign in to choose a model · Alt+L");
      if (height < 10) expect(empty.chunks.map(chunk => chunk.text).join("")).toStartWith("/project\n");
      if (width >= 44) {
        expect(ui.captureCharFrame()).toContain("Not connected");
        expect(ui.captureCharFrame()).toContain("Sign in to choose a model · Alt+L");
      }
      for (const copy of ["gpt-", "openai/", "claude", "anthropic", "No model yet", "READY", "ATTENTION", "ctx", "Ctrl+I failure details", "Enter send"]) expect(ui.captureCharFrame()).not.toContain(copy);
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
  expect(ui.controller.snapshot().transcript.some(entry => entry.text.includes("Already running"))).toBe(true);
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
  ui.controller.applyEvent({ type: "tool.finished", toolCallId: "edit", name: "edit", status: "success", content: "Edited file.ts", details: { path: "file.ts", hunks: [{ startLine: 1, oldText: "before", newText: "after" }] } });
  ui.controller.applyEvent({ type: "tool.started", toolCallId: "bad", name: "bash" });
  ui.controller.applyEvent({ type: "tool.finished", toolCallId: "bad", name: "bash", status: "error", content: "Command failed\nexit code: 1\nFix the missing file" });
  await settle(ui);
  expect(ui.captureCharFrame()).not.toContain("HIDDEN OUTPUT");
  expect(ui.captureCharFrame()).toContain("exit code: 1");
  ui.mockInput.pressKey("o", { ctrl: true });
  await settle(ui);
  expect(ui.captureCharFrame()).toContain("HIDDEN OUTPUT");
  expect(ui.captureCharFrame()).not.toContain("secret-sentinel");
  expect(ui.captureCharFrame()).toContain("+ after");
  expect(ui.captureCharFrame()).toContain("- before");
  const readRow = ui.transcript.getChildren().find(row => row.id === `message-${ui.controller.snapshot().transcript[0]!.id}`)!;
  await ui.mockMouse.click(readRow.x + 1, readRow.y);
  await settle(ui);
  expect(ui.captureCharFrame()).not.toContain("HIDDEN OUTPUT");
  expect(ui.captureCharFrame()).toContain("+ after");
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

test("model picker renders credential labels and puts configured providers first at narrow widths", async () => {
  for (const width of [80, 44]) {
    const ui = await setup(width, 28, { OPENAI_API_KEY: "picker-secret" });
    ui.controller.openModelPicker();
    await settle(ui);
    expect(ui.controller.snapshot().modelPicker!.entries[0]).toMatchObject({ provider: "openai", access: "API key" });
    expect(ui.captureCharFrame()).toContain("API key");
    expect(ui.captureCharFrame()).not.toContain("picker-secret");
    ui.controller.searchModels("gpt-4o");
    await settle(ui);
    expect(ui.captureCharFrame()).toContain("Login required");
  }
});

test("keyboard connection at 44×18 restores the picker search and ordinary draft", async () => {
  const ui = await setup(44, 18);
  await ui.mockInput.pasteBracketedText("ordinary draft");
  ui.mockInput.pressKey("m", { meta: true });
  await waitForUiState(ui, () => !ui.controller.snapshot().modelPicker?.accessLoading, "model access discovery");
  await ui.mockInput.typeText("openai/gpt-5.4");
  await settle(ui);
  expect(ui.captureCharFrame()).toContain("connect needed");
  ui.mockInput.pressEnter();
  await waitForUiState(ui, () => !!ui.controller.snapshot().credentialEntry, "credential entry");
  await ui.mockInput.pasteBracketedText("masked-route-secret");
  ui.mockInput.pressEnter();
  await waitForUiState(ui, () => !!ui.controller.snapshot().modelPicker && !ui.controller.snapshot().modelPicker?.loading, "model picker reload");
  await settle(ui);
  expect(ui.controller.snapshot().modelPicker?.query).toBe("openai/gpt-5.4");
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
  expect(ui.captureCharFrame()).toContain("configured, unverified");
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
    ui.mockInput.pressArrow("down");
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
  expect(ui.captureCharFrame()).toContain("Ctrl+O tools");
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
    expect(ui.captureCharFrame()).toContain("API key · xai");
    ui.mockInput.pressEscape();
    await settle(ui);
    expect(ui.controller.snapshot().loginChooser).toMatchObject({ level: "main", selectedId: "xai" });
    ui.mockInput.pressEscape(); await settle(ui);
    expect(ui.editor.plainText).toBe("keep this draft");
    expect(ui.editor.cursorOffset).toBe(5);
    expect(ui.controller.snapshot().credentialEntry).toBeUndefined();
  }
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
  expect(ui.captureCharFrame()).toContain("ABCD-1234");
  expect(ui.captureCharFrame().replace(/\s+/g, "")).toContain("https://auth.openai.com/codex/device");
  ui.resize(24, 8);
  await settle(ui);
  expect(ui.captureCharFrame()).toContain("ABCD-1234");
  expect(ui.captureCharFrame().replace(/\s+/g, "")).toContain("https://auth.openai.com/codex/device");
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
    expect(ui.captureCharFrame(), `status at ${width}x${height}`).toContain("READY");
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
  expect(ui.captureCharFrame()).toContain("RETRY 2/3");
  expect(ui.captureCharFrame()).toContain("Esc stops");
  expect(ui.editor.plainText).toBe("future draft\nsecond line");
  ui.mockInput.pressEscape();
  await ui.flush();
  expect(ui.captureCharFrame()).toContain("CANCEL REQUESTED");
  expect(ui.controller.snapshot().activity?.cancellation).toBe("settling");
  ui.view.refresh();
  await ui.flush();
  expect(ui.captureCharFrame()).toContain("Stopping");
  expect(ui.captureCharFrame()).not.toContain("Cancel requested");
  releaseSettlement();
  await ui.controller.waitForIdle();
  await settle(ui);
  expect(ui.editor.plainText).toBe("future draft\nsecond line");
  expect(ui.captureCharFrame()).toContain("READY");
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

async function preferenceEnter(ui: Awaited<ReturnType<typeof preferenceFixture>>) {
  ui.mockInput.pressEnter();
  // Renderer-idle passes do not wait for filesystem fsync/rename or model staging.
  await ui.controller.waitForIdle();
  expect(ui.controller.running).toBe(false);
  ui.view.refresh();
  await ui.flush();
}

test("appearance preference persists across launch and environment override keeps its source visible", async () => {
  await withTempDir(async root => {
    const ui = await preferenceFixture(root);
    await ui.mockInput.pasteBracketedText("ไทย 中文 👩‍💻 e\u0301 draft");
    ui.editor.cursorOffset = 4;
    ui.mockInput.pressKey("p", { meta: true }); await settle(ui);
    ui.mockInput.pressTab(); ui.mockInput.pressTab(); await settle(ui);
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
    reopened.mockInput.pressTab(); reopened.mockInput.pressTab();
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
    expect(frame).toContain("› thinking");
    expect(frame).toContain("Choice:");
    ui.mockInput.pressArrow("down"); await settle(ui);
    expect(ui.captureCharFrame()).toContain("› maxTurns");
    ui.resize(80, 24); await settle(ui);
    ui.mockInput.pressArrow("right"); await preferenceEnter(ui);
    ui.resize(32, 12); await settle(ui);
    expect(ui.captureCharFrame()).toContain("› maxTurns");
    expect(ui.captureCharFrame()).toContain("Enter saves");
    ui.mockInput.pressEscape(); ui.mockInput.pressEscape(); await settle(ui);
    expect(ui.editor.plainText).toBe("draft 日本語");
    expect(ui.editor.cursorOffset).toBe(3);
    ui.editor.setText("/theme wrong");
    ui.mockInput.pressEscape(); await settle(ui);
    ui.mockInput.pressEnter(); await settle(ui);
    expect(ui.captureCharFrame()).toContain("! ATTENTION");
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
    expect(ui.captureCharFrame()).toContain("› model");
    expect(ui.captureCharFrame()).toContain("Choice:");
  });
});

test("compact preferences show project scope and confirmation before a write", async () => {
  await withTempDir(async root => {
    const ui = await preferenceFixture(root);
    ui.resize(24, 8);
    ui.mockInput.pressKey("p", { meta: true }); await settle(ui);
    ui.mockInput.pressTab(); await settle(ui);
    expect(ui.controller.snapshot().preferences?.scope).toBe("memory");
    ui.mockInput.pressTab(); ui.mockInput.pressTab(); await settle(ui);
    expect(ui.controller.snapshot().preferences?.scope).toBe("project");
    expect(ui.captureCharFrame()).toContain("project");
    ui.mockInput.pressArrow("right");
    await preferenceEnter(ui);
    expect(ui.controller.snapshot().preferences?.preview).toContain("Enter confirms");
    expect(ui.captureCharFrame()).toContain("Enter saves");
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
    ui.mockInput.pressTab(); ui.mockInput.pressTab(); ui.mockInput.pressTab();
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
    ui.mockInput.pressTab(); ui.mockInput.pressTab();
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
    ui.mockInput.pressKey("p", { meta: true }); await settle(ui);
    expect(ui.captureCharFrame()).toContain("Preferences");
    ui.mockInput.pressArrow("down"); ui.mockInput.pressArrow("right");
    await preferenceEnter(ui);
    expect(ui.configEditor.settings.maxTurns).toBe(7);
    expect(ui.controller.snapshot().preferences?.preview).toContain("Session only");
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
    ui.mockInput.pressEscape(); await settle(ui);
    expect(ui.editor.plainText).toBe("pending\nThai ไทย draft"); expect(ui.editor.cursorOffset).toBe(4);
    expect(ui.editor.focused).toBe(true);
    ui.mockInput.pressKey("p", { meta: true }); await settle(ui);
    expect(ui.controller.snapshot().preferences?.rows.find(row => row.key === "maxTurns")).toMatchObject({ value: "7", origin: "CLI" });
    ui.mockInput.pressEscape(); await settle(ui);
    expect(ui.editor.plainText).toContain("Thai ไทย");
  });
});

test("preferences workspace memory is an explicit complete choice, isolated and reset without clearing session", async () => {
  await withTempDir(async root => {
    const ui = await preferenceFixture(root, {}, { provider: "openai", model: "gpt-5.4" });
    await ui.controller.configCommand("set thinking low");
    ui.mockInput.pressKey("p", { meta: true }); ui.mockInput.pressTab();
    await preferenceEnter(ui);
    expect((await InteractiveMemory.load(ui.home, ui.workspaceRoot)).choice).toBeUndefined();
    await preferenceEnter(ui);
    const memory = await InteractiveMemory.load(ui.home, ui.workspaceRoot);
    expect(memory.choice).toMatchObject({ provider: ui.configEditor.settings.provider, model: ui.configEditor.settings.model });
    const other = join(root, "other"); await mkdir(other);
    expect((await InteractiveMemory.load(ui.home, other)).choice).toBeUndefined();
    expect((await loadConfigEditor({ home: ui.home, workspaceRoot: ui.workspaceRoot, interactiveMemory: true })).origins.model).toBe("interactive memory");
    expect((await loadConfigEditor({ home: ui.home, workspaceRoot: ui.workspaceRoot })).origins.model).toBeUndefined();
    ui.mockInput.pressArrow("right"); await preferenceEnter(ui); await preferenceEnter(ui);
    expect((await InteractiveMemory.load(ui.home, ui.workspaceRoot)).choice).toBeUndefined();
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
    ui.mockInput.pressKey("p", { meta: true });
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
    ui.mockInput.pressEscape(); await settle(ui);
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
    ui.mockInput.pressKey("p", { meta: true }); ui.mockInput.pressArrow("down"); ui.mockInput.pressArrow("right");
    ui.mockInput.pressEnter(); await waitForUiState(ui, () => ui.controller.running, "active turn");
    ui.mockInput.pressEscape(); release(); await ui.controller.waitForIdle(); await settle(ui);
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
    ui.mockInput.pressKey("p", { meta: true }); await settle(ui);
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
    ui.mockInput.pressKey("p", { meta: true }); ui.mockInput.pressTab();
    await preferenceEnter(ui);
    expect(ui.controller.snapshot().preferences?.preview).toContain(`${ui.configEditor.settings.provider}/${ui.configEditor.settings.model}`);
    const concurrent = await InteractiveMemory.load(ui.home, ui.workspaceRoot);
    await concurrent.write({ provider: "openai", model: "gpt-5.4", openaiAuth: "api-key" });
    await preferenceEnter(ui);
    expect(ui.controller.snapshot().preferences?.error).toContain("changed in another process");
    expect((await InteractiveMemory.load(ui.home, ui.workspaceRoot)).choice?.provider).toBe("openai");
    expect(ui.configEditor.settings.provider).toBe("openai");
  });
});

test("preferences picker has no guessed Codex effort and never saves credential fields", async () => {
  await withTempDir(async root => {
    const ui = await preferenceFixture(root, {}, { provider: "openai", model: "gpt-5.4", openaiAuth: "codex" });
    ui.mockInput.pressKey("p", { meta: true }); await settle(ui);
    expect(ui.controller.snapshot().preferences!.rows[0]!.choices).toEqual([undefined]);
    ui.mockInput.pressTab(); ui.mockInput.pressTab(); ui.mockInput.pressTab();
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
    expect(ui.captureCharFrame()).toContain("Esc cancels");
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
    ui.mockInput.pressKey("p", { meta: true }); await settle(ui);
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
    expect(ui.captureCharFrame()).toContain("project skill");
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
    await writeFile(join(dir, "a-text.txt"), "after\n" + "long-line\n".repeat(3000));
    await rm(join(dir, "b-deleted.txt"));
    await git("mv", "old-name.txt", "c-renamed.txt");
    await writeFile(join(dir, "d-binary.bin"), Buffer.from([0, 1, 2, 3]));
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const ui = await setup(80, 24, {}, undefined, { workspace, contextManager: createContextManager(workspace) });
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
    expect(ui.captureCharFrame()).toContain("Turn completed");
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
    expect(ui.controller.snapshot().changeReview!.detail).toContain("-deleted evidence");
    ui.mockInput.pressArrow("down");
    await awaitReview();
    await settle(ui);
    expect(ui.controller.snapshot().changeReview!.files[2]?.origPath).toBe("old-name.txt");
    expect(ui.controller.snapshot().changeReview!.detail).toContain("rename to c-renamed.txt");
    ui.resize(44, 18);
    await settle(ui);
    ui.mockInput.pressArrow("down");
    await awaitReview();
    await settle(ui);
    expect(ui.controller.snapshot().changeReview!.detail).toContain("binary file");
    expect(ui.controller.snapshot().changeReview!.detail).toContain("not shown");
    await ui.mockInput.pressKeys(["\u001b[6~"]);
    await settle(ui);
    await ui.mockInput.pressKeys(["\u001b[6~"]);
    await settle(ui);
    expect(ui.captureCharFrame()).toContain("binary");
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
  expect(ui.captureCharFrame()).toContain("1 nonzero");
  ui.mockInput.pressKey("r", { meta: true });
  await waitForUiState(ui, () => !!ui.controller.snapshot().changeReview && !ui.controller.snapshot().changeReview?.loading, "change review");
  await settle(ui);
  const heading = ui.controller.snapshot().changeReview!.heading;
  expect(heading).toContain("50 exit 0 / 1 nonzero / 0 unknown");
  expect(heading).toContain("latest 50");
  expect(heading).not.toContain("check-0:");
  expect(heading).toContain("check-50:");
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
    expect(narrow).toContain("TOOLS 1");
    expect(narrow).toContain("Esc stops");
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
    expect(ui.captureCharFrame()).toContain("Turn completed");
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
  ui.mockInput.pressEscape(); await settle(ui);
  expect(ui.editor.plainText).toBe("keep me");
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
    expect(ui.captureCharFrame()).toContain(device ? "Open x.ai/device and enter ABCD-EFGH · Esc cancel" : "Waiting for approval in your browser… · Esc cancel");
    if (device) { ui.resize(24, 8); await settle(ui); expect(ui.captureCharFrame()).toContain("x.ai/device"); expect(ui.captureCharFrame()).toContain("ABCD-EFGH"); }
    expect(ui.controller.snapshot().transcript.some(entry => entry.text.includes("ABCD-EFGH"))).toBe(false);
    ui.mockInput.pressEscape(); await ui.controller.waitForIdle(); await settle(ui);
    expect(ui.controller.snapshot().loginChooser).toMatchObject(device ? { level: "grok", selectedId: "grok-device" } : { level: "main", selectedId: "grok" });
    if (device) { ui.mockInput.pressEscape(); await settle(ui); }
    ui.mockInput.pressEscape(); await settle(ui);
    expect(ui.editor.plainText).toBe("Keep my Thai ไทย draft"); expect(ui.editor.cursorOffset).toBe(5); expect(ui.session.items).toHaveLength(0);
  }
});
test("Grok success and failure restore the composer, and plan rejection opens the chooser with Alt+L", async () => {
  const { grokSubscriptionIdentity } = await import("../src/auth/store.ts");
  for (const outcome of ["success", "failure", "plan"] as const) await withTempDir(async root => {
    const store = fakeCredentialStore(), workspace = { root, launchCwd: root, extraRoots: [] };
    const editor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, cli: { provider: "openai", model: "gpt-6-astra" } });
    let finish!: () => void;
    const ui = await setup(80, 24, {}, undefined, { configEditor: editor, workspace, provider: "openai", modelId: "gpt-6-astra", credentials: { store, env: {}, reload: async () => ({ model: createScriptedModel() }), grokLogin: async ({ onSaved, onApproval }) => {
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
      // The exact instruction wraps naturally at 80 columns; compare visible text without cell padding.
      expect(ui.controller.snapshot().transcript.at(-1)?.text).toBe("Your Grok plan doesn't include API access. Use an xAI API key instead · Alt+L");
      expect(ui.captureCharFrame()).toContain("Your Grok plan doesn't include API access.");
      expect(ui.captureCharFrame()).toContain("Alt+L"); expect(await store.get(grokSubscriptionIdentity())).toBe("saved-grok-token");
      ui.mockInput.pressKey("l", { meta: true }); await settle(ui); expect(ui.controller.snapshot().loginChooser).toBeDefined();
    }
    if (outcome === "success") expect(ui.captureCharFrame()).toContain("Signed in. Using xai/grok-4.7.");
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
  expect(hints.plainText).toBe("↑↓ select · Enter · Tab more options · Esc back");
  await selectRenderedLoginRow(ui, "openai"); expect(hints.plainText).toBe("↑↓ select · Enter · Esc back");
  await selectRenderedLoginRow(ui, "chatgpt"); ui.mockInput.pressTab(); await settle(ui);
  expect(picker.getChildren().filter((row): row is TextRenderable => row instanceof TextRenderable).map(row => row.plainText.trim())).toEqual(["ChatGPT · more options", "› Device approval", "Paste browser callback"]);
  expect(hints.plainText).toBe("↑↓ select · Enter · Esc back");
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
      expect(ui.captureCharFrame()).toContain("Endpoint URL · http://localhost:8787/v1");
      const hints = ui.renderer.root.findDescendantById("hints") as TextRenderable; expect(hints.plainText).toBe("Enter confirm · Esc back");
      await ui.mockInput.pasteBracketedText("http://localhost:8787/v1"); ui.mockInput.pressEnter(); await settle(ui); await ui.mockInput.pasteBracketedText("private-endpoint-key");
      expect(ui.editor.plainText).toBe("");
      ui.mockInput.pressEscape(); await settle(ui); expect(ui.controller.snapshot().endpointUrlEntry!.value).toBe("http://localhost:8787/v1");
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
    expect(ui.editor.plainText).not.toContain("http://localhost:8787/v1");
    // Recall the submitted ordinary task: ephemeral URL/key/callback input never becomes a prompt.
    ui.mockInput.pressEnter(); await ui.controller.waitForIdle(); await settle(ui); ui.mockInput.pressArrow("up");
    expect(ui.editor.plainText).toBe(draft);
  });
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
      await terminal.mockInput.pasteBracketedText("http://localhost:8787/v1"); view.flushDraft();
      expect(editor.plainText).toBe(""); expect(openDraftStore({ home, workspaceRoot: root, sessionId: session.header.id }).checkpoint?.text).not.toContain("http://localhost:8787/v1");
      terminal.mockInput.pressEnter(); await settle(ui); await terminal.mockInput.pasteBracketedText("ephemeral-private-key"); view.flushDraft();
      terminal.mockInput.pressEscape(); await settle(ui); expect(controller.snapshot().endpointUrlEntry!.value).toBe("http://localhost:8787/v1");
      terminal.mockInput.pressEscape(); await settle(ui); expect(controller.snapshot().loginChooser).toMatchObject({ level: "main", selectedId: "compatible" });
      terminal.mockInput.pressEscape(); await settle(ui); view.flushDraft();
      expect(editor.plainText).toBe(draft); expect(editor.cursorOffset).toBe(cursor); expect(session.items).toEqual([]);
      expect(openDraftStore({ home, workspaceRoot: root, sessionId: session.header.id }).checkpoint?.text).toBe(draft);
      const artifacts = await Promise.all((await readdir(join(home, ".schway/drafts"))).map(name => readFile(join(home, ".schway/drafts", name), "utf8")));
      expect(artifacts.join("\n")).not.toContain("http://localhost:8787/v1"); expect(artifacts.join("\n")).not.toContain("ephemeral-private-key");
      const savedSession = await Bun.file(join(sessionsDirectory(home), `${session.header.id}.jsonl`)).text();
      expect(savedSession).not.toContain("http://localhost:8787/v1"); expect(savedSession).not.toContain("ephemeral-private-key");
    } finally { view.destroy(); controller.dispose(); terminal.renderer.destroy(); }
  });
});
