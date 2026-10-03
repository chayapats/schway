import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { createConversationView } from "../src/tui/view.ts";
import { TuiController, boundDisplay } from "../src/tui/controller.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function setup(width = 80, height = 24, env: Record<string, string | undefined> = {}) {
  const ui = await createTestRenderer({ width, height, kittyKeyboard: true, exitOnCtrlC: false });
  const workspace = { root: "/project", launchCwd: "/project", extraRoots: [] };
  const controller = new TuiController({
    session: createSession(), workspace, provider: "scripted", modelId: "test-model", sessionId: "inspection-session",
    model: createScriptedModel(), contextManager: createContextManager(workspace), secrets: ["secret-sentinel"],
    credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ model: createScriptedModel() }) },
  });
  const copied: string[] = [];
  const opened: string[] = [];
  let clipboardWorks: boolean | "throw" = true;
  let quit = false;
  ui.renderer.copyToClipboardOSC52 = text => { if (clipboardWorks === "throw") throw new Error("Clipboard unavailable"); if (clipboardWorks) copied.push(text); return clipboardWorks; };
  const view = createConversationView(ui.renderer, {
    controller, workspaceRoot: "/project", home: "/home/test", env, secrets: ["secret-sentinel"],
    quit: () => { quit = true; }, submit: async () => {}, openUrl: async url => { opened.push(url); },
  });
  cleanups.push(() => { view.destroy(); controller.dispose(); ui.renderer.destroy(); });
  await ui.flush();
  const editor = ui.renderer.root.findDescendantById("prompt") as TextareaRenderable;
  const transcript = ui.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable;
  const settle = async () => { view.refresh(); await ui.flush(); };
  return { ...ui, controller, view, editor, transcript, copied, opened, settle, setClipboard: (works: boolean | "throw") => { clipboardWorks = works; }, didQuit: () => quit };
}

test("keyboard inspects one collapsed result and returns to the original draft and cursor", async () => {
  const ui = await setup();
  await ui.mockInput.pasteBracketedText("draft ภาษาไทย");
  ui.editor.cursorOffset = 3;
  const cursor = ui.editor.cursorOffset;
  for (const id of ["first", "second"]) {
    ui.controller.applyEvent({ type: "tool.started", toolCallId: id, name: "read" });
    ui.controller.applyEvent({ type: "tool.finished", toolCallId: id, name: "read", status: "success", content: `${id}\nผลลัพธ์ ${id}` });
  }
  await ui.settle();
  expect(ui.captureCharFrame()).not.toContain("ผลลัพธ์ first");
  ui.mockInput.pressKey("i", { meta: true });
  await ui.settle();
  expect(ui.editor.focused).toBe(false);
  ui.mockInput.pressEnter();
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("ผลลัพธ์ first");
  expect(ui.captureCharFrame()).not.toContain("ผลลัพธ์ second");
  ui.mockInput.pressArrow("down");
  ui.mockInput.pressEnter();
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("ผลลัพธ์ second");
  ui.mockInput.pressEscape();
  await ui.settle();
  expect(ui.editor.plainText).toBe("draft ภาษาไทย");
  expect(ui.editor.cursorOffset).toBe(cursor);
  expect(ui.editor.focused).toBe(true);
  expect(ui.controller.snapshot().transcript).toHaveLength(2);
  ui.mockInput.pressKey("o", { ctrl: true });
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("ผลลัพธ์ first");
  expect(ui.captureCharFrame()).toContain("ผลลัพธ์ second");
});

test("inspection starts at the visible code and retains that target when returning", async () => {
  const ui = await setup(80, 18);
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "```txt\nfirst\n```\n\n" + "Earlier prose\n\n".repeat(20) + "```txt\nเป้าหมาย 😀\nบรรทัดสอง\n```\n\n" + "Later prose\n\n".repeat(20) } });
  await ui.settle();
  const id = ui.controller.snapshot().transcript[0]!.id;
  const later = ui.transcript.findDescendantById(`code-${id}-1`)!;
  ui.transcript.scrollTo(ui.transcript.scrollTop + later.y - ui.transcript.viewport.y);
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("เป้าหมาย");
  expect(ui.captureCharFrame()).not.toContain("first");
  const originalScroll = ui.transcript.scrollTop;
  ui.mockInput.pressKey("i", { meta: true });
  expect(ui.copied).toEqual([]);
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("› txt");
  ui.mockInput.pressKey("c");
  expect(ui.copied).toEqual(["เป้าหมาย 😀\nบรรทัดสอง"]);
  ui.mockInput.pressEscape();
  await ui.settle();
  expect(ui.transcript.scrollTop).toBe(originalScroll);
  ui.transcript.scrollTo(0);
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("first");
  ui.mockInput.pressKey("i", { meta: true });
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("เป้าหมาย");
  ui.mockInput.pressEnter();
  expect(ui.copied).toEqual(["เป้าหมาย 😀\nบรรทัดสอง", "เป้าหมาย 😀\nบรรทัดสอง"]);
});

test("copy waits for visible focus after opening, navigation, scrolling and resize", async () => {
  const ui = await setup(80, 18);
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "```txt\nfirst\n```\n\n" + "Prose\n\n".repeat(20) + "```txt\nsecond\n```" } });
  await ui.settle();
  ui.transcript.scrollTo(0);
  await ui.settle();
  ui.mockInput.pressKey("i", { meta: true });
  ui.mockInput.pressKey("c");
  expect(ui.copied).toEqual([]);
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("› txt");
  ui.mockInput.pressKey("c");
  expect(ui.copied).toEqual(["first"]);
  ui.mockInput.pressArrow("down");
  ui.mockInput.pressEnter();
  expect(ui.copied).toEqual(["first"]);
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("second");
  ui.mockInput.pressEnter();
  expect(ui.copied).toEqual(["first", "second"]);
  ui.transcript.scrollTo(0);
  ui.mockInput.pressKey("c");
  expect(ui.copied).toHaveLength(2);
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("second");
  ui.mockInput.pressKey("c");
  expect(ui.copied).toHaveLength(3);
  ui.resize(50, 18);
  ui.mockInput.pressKey("c");
  expect(ui.copied).toHaveLength(3);
  await ui.settle();
  ui.mockInput.pressKey("c");
  expect(ui.copied).toEqual(["first", "second", "second", "second"]);
});

test("same-index replacement clears active and retained inspection instead of copying a substituted block", async () => {
  const ui = await setup();
  const session = (text: string) => createSession([{ type: "assistant", id: "same-message", content: [{ type: "text", text }] }]);
  ui.controller.replaceSession(session("```txt\noriginal\n```"), "inspection-session");
  await ui.settle();
  ui.mockInput.pressKey("i", { meta: true });
  await ui.settle();
  ui.mockInput.pressKey("c");
  expect(ui.copied).toEqual(["original"]);
  ui.controller.replaceSession(session("```txt\nreplacement\n```"), "inspection-session");
  ui.mockInput.pressKey("c");
  expect(ui.copied).toEqual(["original"]);
  await ui.settle();
  expect(ui.captureCharFrame()).not.toContain("› txt");
  expect(ui.editor.focused).toBe(true);
  ui.mockInput.pressKey("i", { meta: true });
  await ui.settle();
  ui.mockInput.pressKey("c");
  expect(ui.copied).toEqual(["original", "replacement"]);
  ui.mockInput.pressEscape();
  ui.controller.replaceSession(session("No code remains"), "inspection-session");
  await ui.settle();
  ui.mockInput.pressKey("i", { meta: true });
  await ui.settle();
  expect(ui.editor.focused).toBe(true);
  expect(ui.captureCharFrame()).toContain("Nothing to inspect");
  expect(ui.copied).toHaveLength(2);
});

test("inspection chooses the nearest target on either side of a prose-only viewport", async () => {
  for (const side of ["above", "below"] as const) {
    const ui = await setup(80, 18);
    ui.controller.applyEvent({ type: "tool.started", toolCallId: "first", name: "read" });
    ui.controller.applyEvent({ type: "tool.finished", toolCallId: "first", name: "read", status: "success", content: "first result" });
    for (let index = 0; index < 30; index++) ui.controller.notice(`Prose ${index}`);
    ui.controller.applyEvent({ type: "tool.started", toolCallId: "last", name: "read" });
    ui.controller.applyEvent({ type: "tool.finished", toolCallId: "last", name: "read", status: "success", content: "last result" });
    await ui.settle();
    const tools = ui.controller.snapshot().transcript.filter(entry => entry.kind === "tool");
    const node = ui.transcript.findDescendantById(`message-${tools[side === "above" ? 0 : 1]!.id}`)!;
    const top = ui.transcript.scrollTop + node.y - ui.transcript.viewport.y;
    ui.transcript.scrollTo(side === "above" ? top + node.height + 2 : top - ui.transcript.viewport.height - 2);
    await ui.settle();
    expect(ui.captureCharFrame()).not.toContain("read");
    ui.mockInput.pressKey("i", { meta: true });
    await ui.settle();
    expect(ui.captureCharFrame()).toContain("›");
    ui.mockInput.pressKey("c");
    expect(ui.copied).toEqual([side === "above" ? "first result" : "last result"]);
  }
});

test("session and branch changes clear retained selection even when message IDs collide", async () => {
  for (const change of ["session", "branch"] as const) {
    const ui = await setup(80, 18);
    const session = createSession([
      { type: "user", id: "user", content: [{ type: "text", text: "Task" }] },
      { type: "assistant", id: "same-message", content: [{ type: "text", text: "```txt\nfirst\n```\n\n" + "Prose\n\n".repeat(20) + "```txt\nlast\n```" }] },
    ]);
    ui.controller.replaceSession(session, "inspection-session");
    await ui.settle();
    ui.mockInput.pressKey("i", { meta: true });
    await ui.settle();
    ui.mockInput.pressKey("c");
    expect(ui.copied).toEqual(["last"]);
    ui.mockInput.pressEscape();
    if (change === "branch") session.forkBranch("same-message");
    ui.controller.replaceSession(session, change === "session" ? "another-session" : "inspection-session");
    await ui.settle();
    ui.transcript.scrollTo(0);
    await ui.settle();
    ui.mockInput.pressKey("i", { meta: true });
    ui.mockInput.pressKey("c");
    expect(ui.copied).toEqual(["last"]);
    await ui.settle();
    expect(ui.captureCharFrame()).toContain("first");
    ui.mockInput.pressKey("c");
    expect(ui.copied).toEqual(["last", "first"]);
    if (change === "branch") session.selectBranch("main");
    ui.controller.replaceSession(session, "inspection-session");
    ui.mockInput.pressKey("c");
    expect(ui.copied).toEqual(["last", "first"]);
    await ui.settle();
    expect(ui.editor.focused).toBe(true);
    expect(ui.captureCharFrame()).not.toContain("› txt");
  }
});

test("clipboard false and thrown errors preserve code selection, Thai multiline draft and cursor", async () => {
  const ui = await setup(80, 24);
  await ui.mockInput.pasteBracketedText("งานภาษาไทย\nอีกบรรทัด 😀");
  ui.editor.cursorOffset = 3;
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "```txt\nภาษาไทย 😀\n漢字\n```" } });
  await ui.settle();
  ui.mockInput.pressKey("i", { meta: true });
  await ui.settle();
  for (const result of [false, "throw"] as const) {
    ui.setClipboard(result);
    ui.mockInput.pressKey("c");
    await ui.settle();
    expect(ui.copied).toEqual([]);
    expect(ui.captureCharFrame()).toContain("Clipboard unavailable");
    expect(ui.captureCharFrame()).not.toContain("Copied code");
    expect(ui.captureCharFrame()).toContain("› txt");
    expect(ui.editor.plainText).toBe("งานภาษาไทย\nอีกบรรทัด 😀");
    expect(ui.editor.cursorOffset).toBe(3);
  }
  ui.setClipboard(true);
  ui.mockInput.pressEnter();
  await ui.settle();
  expect(ui.copied).toEqual(["ภาษาไทย 😀\n漢字"]);
  expect(ui.captureCharFrame()).toContain("Copied code");
  ui.mockInput.pressEscape();
  expect(ui.editor.focused).toBe(true);
  expect(ui.editor.cursorOffset).toBe(3);
});

test("long code keeps a visible non-color focus marker across themes and standard widths", async () => {
  const code = Array.from({ length: 30 }, (_, index) => `ภาษาไทย ${index} 😀`).join("\n");
  for (const env of [{ SCHWAY_THEME: "dark" }, { SCHWAY_THEME: "light" }, { NO_COLOR: "1" }]) {
    const ui = await setup(80, 18, env);
    ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: `\`\`\`txt\n${code}\n\`\`\`` } });
    await ui.settle();
    // The initial viewport intersects the block's tail, while its header is offscreen.
    expect(ui.captureCharFrame()).not.toContain("Alt+I copy");
    ui.mockInput.pressKey("i", { meta: true });
    await ui.settle();
    for (const width of [120, 80, 50]) {
      ui.resize(width, 18);
      await ui.settle();
      expect(ui.captureCharFrame()).toContain("› txt");
      expect(ui.captureCharFrame()).toContain("C copy");
      ui.mockInput.pressKey("c");
      expect(ui.copied.at(-1)).toBe(code);
    }
    if (!env.SCHWAY_THEME) {
      ui.renderer.emit("theme_mode", "light");
      await ui.settle();
      expect(ui.editor.focused).toBe(false);
      expect(ui.captureCharFrame()).toContain("› txt");
      ui.mockInput.pressKey("c");
      expect(ui.copied).toHaveLength(4);
      expect(ui.copied.at(-1)).toBe(code);
    }
  }
});

test("an early copy is never queued after Escape, a modal panel or disposal", async () => {
  for (const action of ["escape", "panel", "dispose"] as const) {
    const ui = await setup();
    await ui.mockInput.pasteBracketedText("งานค้าง\nบรรทัดสอง");
    ui.editor.cursorOffset = 3;
    ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "```txt\ncode\n```" } });
    await ui.settle();
    ui.mockInput.pressKey("i", { meta: true });
    ui.mockInput.pressKey("c");
    if (action === "escape") ui.mockInput.pressEscape();
    else if (action === "panel") ui.controller.openPreferences();
    else ui.view.destroy();
    await ui.settle();
    expect(ui.copied).toEqual([]);
    if (action === "panel") { ui.mockInput.pressEscape(); await ui.settle(); }
    if (action !== "dispose") {
      expect(ui.editor.focused).toBe(true);
      expect(ui.editor.plainText).toBe("งานค้าง\nบรรทัดสอง");
      expect(ui.editor.cursorOffset).toBe(3);
      expect(ui.captureCharFrame()).not.toContain("› txt");
    }
  }
});

test("code and Unicode result copies use displayed content without fences or decoration", async () => {
  const ui = await setup(80, 28);
  ui.controller.applyEvent({ type: "tool.started", toolCallId: "unicode", name: "bash" });
  ui.controller.applyEvent({ type: "tool.finished", toolCallId: "unicode", name: "bash", status: "success", content: "ไทย\n漢字 😀\nsecret-sentinel" });
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "```ts\nconst emoji = '😀';\nsecret-sentinel\n```" } });
  await ui.settle();
  ui.mockInput.pressKey("i", { meta: true });
  await ui.settle();
  ui.mockInput.pressKey("c");
  expect(ui.copied.at(-1)).toBe("ไทย\n漢字 😀\n***");
  ui.mockInput.pressArrow("down");
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("C copy");
  ui.mockInput.pressKey("c");
  expect(ui.copied.at(-1)).toBe("const emoji = '😀';\n***");
  expect(ui.copied.join("\n")).not.toContain("secret-sentinel");
  expect(ui.copied.at(-1)).not.toContain("```");
});

test("bounded results and failed clipboard report exactly what happened while the draft survives", async () => {
  const ui = await setup(44, 18);
  await ui.mockInput.pasteBracketedText("keep this task");
  const raw = "x".repeat(12_000);
  ui.controller.applyEvent({ type: "tool.started", toolCallId: "large", name: "bash" });
  ui.controller.applyEvent({ type: "tool.finished", toolCallId: "large", name: "bash", status: "success", content: raw });
  await ui.settle();
  ui.mockInput.pressKey("i", { meta: true });
  await ui.settle();
  ui.mockInput.pressKey("c");
  await ui.settle();
  expect(ui.copied.at(-1)).toBe(boundDisplay(raw));
  expect(ui.captureCharFrame()).toContain("bounded result preview");
  ui.setClipboard(false);
  ui.mockInput.pressKey("c");
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("Clipboard unavailable");
  ui.mockInput.pressEscape();
  expect(ui.editor.plainText).toBe("keep this task");
  expect(ui.didQuit()).toBe(false);
});

test("inspection identity and reading position survive new output and tool completion", async () => {
  const ui = await setup(44, 18);
  for (let i = 0; i < 15; i++) ui.controller.notice(`Earlier ${i}\nsecond line`);
  ui.controller.applyEvent({ type: "tool.started", toolCallId: "live", name: "bash" });
  ui.controller.applyEvent({ type: "tool.delta", toolCallId: "live", name: "bash", stream: "stdout", text: "partial" });
  await ui.settle();
  ui.mockInput.pressKey("i", { meta: true });
  await ui.settle();
  const top = ui.transcript.scrollTop;
  ui.controller.applyEvent({ type: "tool.finished", toolCallId: "live", name: "bash", status: "success", content: "finished" });
  ui.controller.notice("New notice");
  await ui.settle();
  expect(ui.transcript.scrollTop).toBe(top);
  ui.mockInput.pressKey("c");
  expect(ui.copied.at(-1)).toBe("finished");
  expect(ui.editor.focused).toBe(false);
});

test("unrelated frames cannot authorize copying tool output that has not reached its row", async () => {
  const ui = await setup();
  ui.controller.applyEvent({ type: "tool.started", toolCallId: "live", name: "bash" });
  ui.controller.applyEvent({ type: "tool.delta", toolCallId: "live", name: "bash", stream: "stdout", text: "partial" });
  await ui.settle();
  ui.mockInput.pressKey("i", { meta: true });
  await ui.settle();
  ui.controller.applyEvent({ type: "tool.finished", toolCallId: "live", name: "bash", status: "success", content: "finished" });
  ui.renderer.requestRender();
  await ui.flush();
  ui.mockInput.pressKey("c");
  expect(ui.copied).toEqual([]);
  await ui.settle();
  ui.mockInput.pressKey("c");
  expect(ui.copied).toEqual(["finished"]);
});

test("multiple code blocks navigate individually through streaming and resize", async () => {
  const ui = await setup(44, 18);
  const second = `second 😀 ${"unbroken".repeat(18)}\nlast source line`;
  await ui.mockInput.pasteBracketedText("future draft");
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: `\`\`\`txt\nfirst ภาษาไทย\n\`\`\`\n\n\`\`\`txt\n${second}\n\`\`\`` } });
  await ui.settle();
  ui.transcript.scrollTo(0);
  await ui.settle();
  ui.mockInput.pressKey("i", { meta: true });
  await ui.settle();
  ui.mockInput.pressKey("c");
  expect(ui.copied.at(-1)).toBe("first ภาษาไทย");
  ui.mockInput.pressTab();
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("C copy");
  for (const width of [80, 50, 120, 50, 80]) {
    ui.resize(width, 24);
    await ui.settle();
    ui.mockInput.pressKey("c");
    expect(ui.copied.at(-1)).toBe(second);
  }
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "\nLater text" } });
  await ui.settle();
  ui.mockInput.pressKey("c");
  expect(ui.copied.at(-1)).toBe(second);
  ui.controller.applyEvent({ type: "model.finished" });
  ui.resize(50, 24); await ui.settle();
  ui.mockInput.pressKey("c");
  expect(ui.copied.at(-1)).toBe(second);
  ui.mockInput.pressKey("f", { ctrl: true });
  expect(ui.editor.plainText).toBe("future draft");
  ui.mockInput.pressEscape();
  expect(ui.editor.focused).toBe(true);
});

test("five streamed code blocks retain distinct focus IDs and copies", async () => {
  const ui = await setup(44, 18);
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "```js\n0\n```\n\n" } });
  await ui.settle();
  ui.mockInput.pressKey("i", { meta: true });
  for (let index = 1; index < 5; index++) {
    ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: `\`\`\`js\n${index}\n\`\`\`\n\n` } });
    await ui.settle();
  }
  expect(ui.editor.focused).toBe(false);
  ui.mockInput.pressKey("c");
  expect(ui.copied.at(-1)).toBe("0");
  for (let index = 1; index < 5; index++) {
    ui.mockInput.pressArrow("down");
    await ui.settle();
    ui.mockInput.pressKey("c");
    expect(ui.copied.at(-1)).toBe(String(index));
    expect(ui.transcript.findDescendantById(`code-${ui.controller.snapshot().transcript[0]!.id}-${index}`)).toBeDefined();
  }
  expect(ui.captureCharFrame()).toContain("› js");
});

test("nested list, quote and unfinished streamed fences use rendered code targets", async () => {
  const ui = await setup(60, 24);
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "- Nested\n\n  ```ts\n  const nested = 1;\n  ```\n\n> ```js\n> const quoted = 2;\n> ```\n\n```sh\necho unfinished" } });
  await ui.settle();
  const frame = ui.captureCharFrame();
  expect(frame).toContain("const nested = 1;");
  expect(frame).toContain("const quoted = 2;");
  expect(frame).toContain("echo unfinished");
  ui.mockInput.pressKey("i", { meta: true });
  await ui.settle();
  for (const expected of ["const nested = 1;", "const quoted = 2;", "echo unfinished"]) {
    ui.mockInput.pressKey("c");
    expect(ui.copied.at(-1)).toBe(expected);
    ui.mockInput.pressArrow("down");
    await ui.settle();
  }
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "\n```" } });
  await ui.settle();
  ui.mockInput.pressKey("c");
  expect(ui.copied.at(-1)).toBe("echo unfinished");
});

test("links, selection and mouse tool toggles still work during inspection", async () => {
  const ui = await setup(80, 24);
  ui.controller.applyEvent({ type: "tool.started", toolCallId: "mouse", name: "read" });
  ui.controller.applyEvent({ type: "tool.finished", toolCallId: "mouse", name: "read", status: "success", content: "Click result" });
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "[Documentation](https://example.test/docs)\n\n```txt\ncode\n```" } });
  await ui.settle();
  ui.mockInput.pressKey("i", { meta: true });
  await ui.settle();
  const toolRow = ui.transcript.getChildren().find(row => row.id.startsWith("message-") && row.id.includes("tool"))!;
  await ui.mockMouse.click(toolRow.x + 2, toolRow.y);
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("Click result");
  const lines = ui.captureCharFrame().split("\n");
  const y = lines.findIndex(line => line.includes("Documentation"));
  const x = lines[y]!.indexOf("Documentation");
  await ui.mockMouse.click(x + 1, y);
  expect(ui.opened).toEqual(["https://example.test/docs"]);
  await ui.mockMouse.drag(x, y, x + 5, y);
  await ui.settle();
  expect(ui.opened).toHaveLength(1);
  expect(ui.copied.length).toBeGreaterThan(0);
  expect(ui.editor.focused).toBe(false);
  const selectedText = ui.renderer.getSelection()!.getSelectedText();
  const beforeSelectionCopy = ui.copied.length;
  ui.mockInput.pressKey("c", { ctrl: true });
  expect(ui.copied).toHaveLength(beforeSelectionCopy + 1);
  expect(ui.copied.at(-1)).toBe(selectedText);
  expect(ui.copied.at(-1)).not.toBe("Click result");
  ui.mockInput.pressKey("c");
  expect(ui.copied.at(-1)).toBe("Click result");
});

test("selected-text Ctrl+C keeps precedence and recovery when the clipboard throws", async () => {
  const ui = await setup();
  await ui.mockInput.pasteBracketedText("keep draft");
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "Select this text\n\n```txt\ncode\n```" } });
  await ui.settle();
  ui.mockInput.pressKey("i", { meta: true });
  await ui.settle();
  const lines = ui.captureCharFrame().split("\n");
  const y = lines.findIndex(line => line.includes("Select this text"));
  const x = lines[y]!.indexOf("Select this text");
  ui.setClipboard(false);
  await ui.mockMouse.drag(x, y, x + 5, y);
  expect(ui.renderer.getSelection()?.getSelectedText()).toBeTruthy();
  ui.setClipboard("throw");
  expect(() => ui.mockInput.pressKey("c", { ctrl: true })).not.toThrow();
  expect(ui.renderer.getSelection()?.getSelectedText() ?? "").toBe("");
  await ui.settle();
  expect(ui.copied).toEqual([]);
  expect(ui.captureCharFrame()).toContain("native selection");
  expect(ui.editor.plainText).toBe("keep draft");
  expect(ui.editor.focused).toBe(false);
  expect(ui.didQuit()).toBe(false);
});

test("Ctrl+C cancels a running turn during inspection without copying or losing the draft", async () => {
  const ui = await setup();
  ui.controller.setModel(createScriptedModel({ waitForAbort: true }), "scripted", "waiting");
  const turn = ui.controller.submit("accepted task");
  await ui.waitFor(() => ui.controller.running);
  ui.controller.applyEvent({ type: "tool.started", toolCallId: "previous", name: "read" });
  ui.controller.applyEvent({ type: "tool.finished", toolCallId: "previous", name: "read", status: "success", content: "previous result" });
  await ui.mockInput.pasteBracketedText("future draft");
  await ui.settle();
  ui.mockInput.pressKey("i", { meta: true });
  await ui.settle();
  expect(ui.editor.focused).toBe(false);
  expect(ui.captureCharFrame()).toContain("C copy");
  ui.mockInput.pressKey("c", { ctrl: true });
  await turn;
  await ui.settle();
  expect(ui.controller.running).toBe(false);
  expect(ui.copied).toEqual([]);
  expect(ui.didQuit()).toBe(false);
  expect(ui.editor.plainText).toBe("future draft");
  expect(ui.controller.snapshot().transcript.some(entry => entry.text.includes("previous result"))).toBe(true);
  ui.mockInput.pressKey("c", { ctrl: true });
  expect(ui.copied.at(-1)).toBe("previous result");
});
