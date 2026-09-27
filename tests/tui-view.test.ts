import { afterEach, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { TextareaRenderable, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { createConversationView } from "../src/tui/view.ts";
import { TuiController, buildTranscriptFromSession } from "../src/tui/controller.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { dispatchEditorInput } from "../src/tui/commands.ts";
import { fitLine } from "../src/tui/presentation.ts";
import { resolveTheme, TUI_THEMES } from "../src/tui/theme.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function setup(width = 80, height = 28, credentialEnv: Record<string, string> = {}) {
  const terminal = await createTestRenderer({ width, height, kittyKeyboard: true });
  const session = createSession();
  const workspace = { root: "/project", launchCwd: "/project", extraRoots: [] };
  const controller = new TuiController({
    session, workspace, provider: "scripted", modelId: "test-model", sessionId: "private-session-id",
    model: createScriptedModel({ responses: [{ text: "## Result\n\nHello **world**.\n\n```ts\nconst answer = 42;\n```" }] }),
    contextManager: createContextManager(workspace), secrets: ["secret-sentinel"],
    credentials: { store: fakeCredentialStore(), env: credentialEnv, reload: async () => ({ model: createScriptedModel() }) },
  });
  let quit = false;
  const copied: string[] = [];
  const opened: string[] = [];
  terminal.renderer.copyToClipboardOSC52 = text => { copied.push(text); return true; };
  const view = createConversationView(terminal.renderer, {
    controller, workspaceRoot: "/project", home: "/home/test", env: {}, secrets: ["secret-sentinel"],
    quit: () => { quit = true; },
    openUrl: async url => { opened.push(url); },
    submit: (value, accepted) => dispatchEditorInput(value, controller, async command => {
      if (command.name === "model") controller.openModelPicker();
      else if (command.name === "login") await controller.login(command.args);
      else if (command.name === "help") controller.notice("Help text");
    }, accepted),
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

test("multiline paste and Ctrl+J submit one prompt; Markdown renders with stable message objects", async () => {
  const ui = await setup();
  await ui.mockInput.pasteBracketedText("ช่วยแก้ไข\nบรรทัดที่สอง");
  ui.mockInput.pressKey("j", { ctrl: true });
  await ui.mockInput.typeText("last line");
  expect(ui.session.items).toHaveLength(0);
  expect(ui.editor.plainText).toBe("ช่วยแก้ไข\nบรรทัดที่สอง\nlast line");
  ui.mockInput.pressEnter();
  await settle(ui);
  await ui.waitFor(() => !ui.controller.running);
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
  const ui = await setup(60, 18);
  ui.controller.setModel(createScriptedModel({ text: Array.from({ length: 60 }, (_, i) => `Line ${String(i).padStart(2, "0")} ข้อความภาษาไทย\n\n`).join(""), waitForAbort: true }), "scripted", "streaming");
  const turn = ui.controller.submit("Produce long output");
  await ui.waitFor(async () => {
    await Bun.sleep(5);
    return ui.controller.snapshot().transcript.at(-1)?.text.includes("Line 59") === true;
  }, { maxPasses: 100 });
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
    ui.controller.searchModels("claude");
    await settle(ui);
    expect(ui.captureCharFrame()).toContain("Login required");
  }
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
  expect(mark.fg.toInts().slice(0, 3)).toEqual([7, 89, 133]);
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
  for (const theme of Object.values(TUI_THEMES)) for (const background of [theme.background, theme.surface]) {
    for (const foreground of [theme.text, theme.muted, theme.accent, theme.success, theme.warning, theme.error, theme.code]) {
      const values = [luminance(background), luminance(foreground)].sort((a, b) => a - b);
      expect((values[1]! + 0.05) / (values[0]! + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
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
  ui.mockInput.pressArrow("down");
  ui.mockInput.pressArrow("down");
  ui.mockInput.pressEnter();
  await settle(ui);
  await ui.mockInput.pasteBracketedText("callback-secret-sentinel");
  await settle(ui);
  expect(ui.captureCharFrame()).not.toContain("callback-secret-sentinel");
  expect(JSON.stringify(ui.controller.snapshot())).not.toContain("callback-secret-sentinel");
  ui.resize(36, 16);
  await settle(ui);
  ui.mockInput.pressEscape();
  await settle(ui);
  expect(ui.editor.plainText).toBe("continue this task\nsecond line");
  expect(ui.editor.cursorOffset).toBe(8);
  expect(ui.session.items).toHaveLength(0);
});

test("/login without arguments reaches the chooser through editor dispatch", async () => {
  const ui = await setup();
  await ui.mockInput.typeText("/login");
  ui.mockInput.pressEnter();
  await settle(ui);
  expect(ui.controller.snapshot().loginChooser).toBeDefined();
  expect(ui.captureCharFrame()).toContain("ChatGPT");
  ui.mockInput.pressEscape();
  await settle(ui);
  expect(ui.editor.plainText).toBe("");
  expect(ui.session.items).toHaveLength(0);
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
  await ui.waitFor(() => !ui.controller.running);
  await settle(ui);
  const originalBranch = ui.session.activeBranchId;
  await ui.mockInput.typeText("keep this draft");
  expect(ui.controller.openBranchTree()).toBe(true);
  await settle(ui);
  expect(ui.captureCharFrame()).toContain("Conversation branches");
  expect(ui.editor.plainText).toBe("");
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
    expect(ui.captureCharFrame(), `status at ${width}x${height}`).toContain("Ready");
  }
  ui.mockInput.pressEscape();
  await settle(ui);
  expect(ui.editor.plainText).toBe("draft line\n".repeat(8));
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
  const ui = await setup(70, 20);
  ui.controller.setModel(createScriptedModel({ text: Array.from({ length: 60 }, (_, i) => `Paragraph ${i}\n\n`).join(""), waitForAbort: true }), "scripted", "streaming-model");
  const turn = ui.controller.submit("Stream a long answer");
  await ui.waitFor(async () => {
    await Bun.sleep(5);
    return ui.controller.snapshot().transcript.at(-1)?.text.includes("Paragraph 59") === true;
  }, { maxPasses: 100 });
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
