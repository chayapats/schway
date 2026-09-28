import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { BoxRenderable, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { createConversationView } from "../src/tui/view.ts";
import { TuiController } from "../src/tui/controller.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession, type Session } from "../src/session/session.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function setup(session: Session = createSession(), width = 70, height = 20) {
  const terminal = await createTestRenderer({ width, height, kittyKeyboard: true });
  const workspace = { root: "/fixture", launchCwd: "/fixture", extraRoots: [] };
  let modelCalls = 0;
  let submits = 0;
  const controller = new TuiController({
    session, sessionId: "search-fixture", workspace, provider: "scripted", modelId: "test-model",
    contextManager: createContextManager(workspace), secrets: ["secret-sentinel"],
    model: createScriptedModel({ responses: [() => { modelCalls++; return { text: "unexpected" }; }] }),
    credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ model: createScriptedModel() }) },
  });
  const view = createConversationView(terminal.renderer, {
    controller, workspaceRoot: workspace.root, home: "/home/test", env: {}, secrets: ["secret-sentinel"],
    submit: async () => { submits++; return false; }, quit: () => {},
  });
  cleanups.push(() => { view.destroy(); controller.dispose(); terminal.renderer.destroy(); });
  await terminal.flush();
  const editor = terminal.renderer.root.findDescendantById("prompt") as TextareaRenderable;
  const transcript = terminal.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable;
  const settle = async () => { view.refresh(); await terminal.flush(); };
  return { ...terminal, controller, view, session, editor, transcript, settle, modelCalls: () => modelCalls, submits: () => submits };
}

const user = (id: string, text: string) => ({ type: "user" as const, id, content: [{ type: "text" as const, text }] });
const assistant = (id: string, text: string) => ({ type: "assistant" as const, id, content: [{ type: "text" as const, text }] });

test("find navigates literal matches in user, assistant and bounded tool rows through keyboard input", async () => {
  const session = createSession([
    user("u1", "needle in user"), assistant("a1", "assistant needle"),
    ...Array.from({ length: 24 }, (_, i) => i % 2 ? assistant(`padding-a-${i}`, `other answer ${i}`) : user(`padding-u-${i}`, `other request ${i}`)),
    user("u-tool", "read a file"),
    { type: "assistant", id: "call", content: [{ type: "tool_call", id: "read-1", name: "read", arguments: { path: "needle.txt" } }] },
    { type: "tool_result", id: "result", toolCallId: "read-1", content: "hidden details", isError: false },
  ]);
  const ui = await setup(session);
  const before = JSON.stringify(session.items);
  await ui.mockInput.pasteBracketedText("draft to preserve");
  ui.mockInput.pressKey("f", { ctrl: true });
  await ui.mockInput.typeText("needle");
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("Find 1/3");
  ui.mockInput.pressArrow("down");
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("Find 2/3");
  ui.mockInput.pressArrow("down");
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("Find 3/3");
  expect(ui.captureCharFrame()).toContain("needle.txt");
  const toolId = ui.controller.snapshot().transcript.find(entry => entry.kind === "tool")!.id;
  expect((ui.renderer.root.findDescendantById(`message-${toolId}`) as BoxRenderable).backgroundColor).toBeDefined();
  ui.mockInput.pressArrow("up");
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("Find 2/3");
  ui.mockInput.pressEnter();
  await ui.settle();
  expect(ui.editor.plainText).toBe("draft to preserve");
  expect(ui.captureCharFrame()).toContain("assistant needle");
  expect(JSON.stringify(session.items)).toBe(before);
  expect(ui.modelCalls()).toBe(0);
  expect(ui.submits()).toBe(0);
});

test("search scope excludes sibling branches and truncated or collapsed tool output", async () => {
  const session = createSession([user("u", "start"), assistant("a", "done")]);
  const sibling = session.forkBranch("a");
  session.append(user("sibling", "sibling-only-token"), assistant("sibling-answer", "other branch"));
  session.selectBranch("main");
  session.append(
    { type: "assistant", id: "call", content: [{ type: "tool_call", id: "long", name: "read", arguments: { path: "visible.txt" } }] },
    { type: "tool_result", id: "long-result", toolCallId: "long", content: `${"v".repeat(2100)}truncated-only-token`, isError: false },
  );
  const ui = await setup(session);
  ui.mockInput.pressKey("f", { ctrl: true });
  await ui.mockInput.typeText("sibling-only-token");
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("No matches");
  expect(ui.captureCharFrame()).toContain("active branch");
  ui.mockInput.pressArrow("down");
  await ui.settle();
  expect(session.activeBranchId).toBe("main");
  ui.mockInput.pressEscape();
  ui.mockInput.pressKey("f", { ctrl: true });
  await ui.mockInput.typeText("truncated-only-token");
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("No matches");
  ui.mockInput.pressEscape();
  ui.mockInput.pressKey("f", { ctrl: true });
  await ui.mockInput.typeText("vvv");
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("No matches");
  ui.mockInput.pressEscape();
  ui.mockInput.pressKey("o", { ctrl: true });
  await ui.settle();
  ui.mockInput.pressKey("f", { ctrl: true });
  await ui.mockInput.typeText("vvv");
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("Find 1/");
  expect(session.activeBranchId).toBe("main");
  expect(sibling).not.toBe(session.activeBranchId);
});

test("Escape restores scrolled position and multiline draft while search navigation owns arrow keys", async () => {
  const ui = await setup();
  for (let i = 0; i < 70; i++) ui.controller.notice(`Needle ${i} · ${"content ".repeat(5)}`);
  await ui.mockInput.pasteBracketedText("first line\nsecond line");
  await ui.settle();
  ui.editor.cursorOffset = 3;
  ui.mockInput.pressKey("END", { ctrl: true });
  await ui.mockInput.pressKeys(["\u001b[5~"]);
  await ui.settle();
  const originalTop = ui.transcript.scrollTop;
  ui.mockInput.pressKey("f", { ctrl: true });
  await ui.mockInput.typeText("Needle");
  ui.mockInput.pressArrow("down");
  ui.mockInput.pressArrow("down");
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("Find 3/70");
  expect(ui.session.items).toHaveLength(0);
  ui.mockInput.pressEscape();
  await ui.settle();
  expect(ui.transcript.scrollTop).toBe(originalTop);
  expect(ui.editor.plainText).toBe("first line\nsecond line");
  expect(ui.editor.cursorOffset).toBe(3);
  ui.controller.notice("new streamed text");
  await ui.settle();
  expect(ui.transcript.scrollTop).toBe(originalTop);
  ui.mockInput.pressKey("f", { ctrl: true });
  await ui.mockInput.typeText("Needle");
  ui.mockInput.pressKey("END", { ctrl: true });
  ui.controller.notice("latest after explicit follow");
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("latest after explicit follow");
});

test("a match deep inside one wrapped answer is in view when accepted", async () => {
  const answer = Array.from({ length: 70 }, (_, i) => `Paragraph ${i} has ${i === 35 ? "deep-answer-token" : "ordinary"} text.\n\n`).join("");
  const ui = await setup(createSession([user("u", "question"), assistant("a", answer)]), 44, 18);
  ui.mockInput.pressKey("f", { ctrl: true });
  await ui.mockInput.typeText("deep-answer-token");
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("Find 1/1");
  ui.mockInput.pressEnter();
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("deep-answer-token");
});

test("search indexes rendered Markdown text without hidden image URLs or syntax", async () => {
  const answer = "**visible emphasis**\n\n![visible alt](https://hidden.example/hidden-url-token)\n\n[shown link](https://shown.example/visible-url-token)";
  const ui = await setup(createSession([user("u", "question"), assistant("a", answer)]));
  ui.mockInput.pressKey("f", { ctrl: true });
  await ui.mockInput.typeText("hidden-url-token");
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("No matches");
  ui.mockInput.pressEscape();
  ui.mockInput.pressKey("f", { ctrl: true });
  await ui.mockInput.typeText("**");
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("No matches");
  ui.mockInput.pressEscape();
  ui.mockInput.pressKey("f", { ctrl: true });
  await ui.mockInput.typeText("visible-url-token");
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("Find 1/1");
  expect(ui.modelCalls()).toBe(0);
});

test("nonuniform Markdown scrolls to the exact wrapped block and immediate Enter keeps it in view", async () => {
  const answer = [
    "## Opening", "**a** ".repeat(900),
    "```txt\n" + "code-data ".repeat(260) + "\n```",
    "- first item\n- second item with target-after-code and more words",
    ...Array.from({ length: 30 }, (_, i) => `Tail paragraph ${i} has ordinary text.`),
  ].join("\n\n");
  const ui = await setup(createSession([user("u", "question"), assistant("a", answer)]), 44, 18);
  await ui.mockInput.pasteBracketedText("future draft\nsecond line");
  ui.mockInput.pressKey("f", { ctrl: true });
  await ui.mockInput.typeText("target-after-code");
  ui.mockInput.pressEnter();
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("target-after-code");
  expect(ui.editor.plainText).toBe("future draft\nsecond line");
  expect(ui.submits()).toBe(0);
  expect(ui.modelCalls()).toBe(0);
});

test("a match inside one very long wrapped paragraph reaches its visual line", async () => {
  const answer = `Opening ${"brief ".repeat(18)} ${"longer-word ".repeat(320)} inside-paragraph-token ${"tail ".repeat(120)}`;
  const ui = await setup(createSession([user("u", "question"), assistant("a", answer)]), 44, 18);
  ui.mockInput.pressKey("f", { ctrl: true });
  await ui.mockInput.typeText("inside-paragraph-token");
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("inside-paragraph-token");
  ui.mockInput.pressEnter();
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("inside-");
  expect(ui.captureCharFrame()).toContain("paragraph-token");
});

test("a match in a late row of a tall Markdown table lands on that row", async () => {
  const table = ["| Item | Detail |", "| --- | --- |", ...Array.from({ length: 55 }, (_, i) => `| row-${i} | ${i === 43 ? "late-hit-43" : i % 5 === 0 ? `ordinary-${i} repeated words across a wrapped table cell` : `ordinary-${i}`} |`)].join("\n");
  const ui = await setup(createSession([user("u", "show table"), assistant("a", table)]), 44, 18);
  ui.mockInput.pressKey("f", { ctrl: true });
  await ui.mockInput.typeText("late-hit-43");
  ui.mockInput.pressEnter();
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("late-hit-43");
  expect(ui.submits()).toBe(0);
});

test("Unicode wraps logically, empty/no-match states stay usable, and live row changes preserve selection", async () => {
  const ui = await setup(createSession([user("u", "ข้อความภาษาไทย e\u0301 match"), assistant("a", "ไทย e\u0301 match")]), 44, 18);
  ui.mockInput.pressKey("f", { ctrl: true });
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("Find in active branch");
  await ui.mockInput.typeText("é match");
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("Find 1/2");
  ui.mockInput.pressArrow("down");
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("Find 2/2");
  ui.resize(70, 20);
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("Find 2/2");
  const top = ui.transcript.scrollTop;
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "new é match" } });
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("Find 2/3");
  expect(ui.transcript.scrollTop).toBe(top);
  ui.controller.applyEvent({ type: "model.retry", attempt: 1, maxAttempts: 2, delayMs: 1, message: "retry" });
  ui.controller.applyEvent({ type: "model.started", provider: "scripted", model: "test-model" });
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "changed row" } });
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("Find 2/2");
  expect(ui.transcript.scrollTop).toBe(top);
  ui.mockInput.pressEscape();
  ui.mockInput.pressKey("f", { ctrl: true });
  await ui.mockInput.typeText("ไทย");
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("Find 1/2");
  ui.mockInput.pressEscape();
  ui.mockInput.pressKey("f", { ctrl: true });
  await ui.mockInput.typeText("missing literal");
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("No matches");
});

test("thousands of rows remain cancellable without model, submit, or session changes", async () => {
  const ui = await setup();
  for (let i = 0; i < 2500; i++) ui.controller.notice(`row ${i}: local-token`);
  await ui.settle();
  const before = JSON.stringify(ui.session.items);
  ui.mockInput.pressKey("f", { ctrl: true });
  await ui.mockInput.typeText("local-token");
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("Find 1/2500");
  ui.mockInput.pressArrow("down");
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("Find 2/2500");
  ui.mockInput.pressEscape();
  await ui.settle();
  expect(JSON.stringify(ui.session.items)).toBe(before);
  expect(ui.modelCalls()).toBe(0);
  expect(ui.submits()).toBe(0);
});
