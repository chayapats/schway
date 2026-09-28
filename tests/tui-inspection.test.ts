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

async function setup(width = 80, height = 24) {
  const ui = await createTestRenderer({ width, height, kittyKeyboard: true });
  const workspace = { root: "/project", launchCwd: "/project", extraRoots: [] };
  const controller = new TuiController({
    session: createSession(), workspace, provider: "scripted", modelId: "test-model", sessionId: "inspection-session",
    model: createScriptedModel(), contextManager: createContextManager(workspace), secrets: ["secret-sentinel"],
    credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ model: createScriptedModel() }) },
  });
  const copied: string[] = [];
  const opened: string[] = [];
  let clipboardWorks = true;
  let quit = false;
  ui.renderer.copyToClipboardOSC52 = text => { if (clipboardWorks) copied.push(text); return clipboardWorks; };
  const view = createConversationView(ui.renderer, {
    controller, workspaceRoot: "/project", home: "/home/test", env: {}, secrets: ["secret-sentinel"],
    quit: () => { quit = true; }, submit: async () => {}, openUrl: async url => { opened.push(url); },
  });
  cleanups.push(() => { view.destroy(); controller.dispose(); ui.renderer.destroy(); });
  await ui.flush();
  const editor = ui.renderer.root.findDescendantById("prompt") as TextareaRenderable;
  const transcript = ui.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable;
  const settle = async () => { view.refresh(); await ui.flush(); };
  return { ...ui, controller, view, editor, transcript, copied, opened, settle, setClipboard: (works: boolean) => { clipboardWorks = works; }, didQuit: () => quit };
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

test("code and Unicode result copies use displayed content without fences or decoration", async () => {
  const ui = await setup(80, 28);
  ui.controller.applyEvent({ type: "tool.started", toolCallId: "unicode", name: "bash" });
  ui.controller.applyEvent({ type: "tool.finished", toolCallId: "unicode", name: "bash", status: "success", content: "ไทย\n漢字 😀\nsecret-sentinel" });
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "```ts\nconst emoji = '😀';\nsecret-sentinel\n```" } });
  await ui.settle();
  ui.mockInput.pressKey("i", { meta: true });
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

test("multiple code blocks navigate individually through streaming and resize", async () => {
  const ui = await setup(44, 18);
  await ui.mockInput.pasteBracketedText("future draft");
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "```txt\nfirst ภาษาไทย\n```\n\n```txt\nsecond 😀\n```" } });
  await ui.settle();
  ui.mockInput.pressKey("i", { meta: true });
  ui.mockInput.pressKey("c");
  expect(ui.copied.at(-1)).toBe("first ภาษาไทย");
  ui.mockInput.pressTab();
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("C copy");
  ui.resize(80, 24);
  await ui.settle();
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "\nLater text" } });
  await ui.settle();
  ui.mockInput.pressKey("c");
  expect(ui.copied.at(-1)).toBe("second 😀");
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
  ui.mockInput.pressKey("c");
  expect(ui.copied.at(-1)).toBe("Click result");
});
