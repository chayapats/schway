import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { BoxRenderable, ScrollBoxRenderable, TextareaRenderable, TextRenderable } from "@opentui/core";
import { createConversationView } from "../src/tui/view.ts";
import { TuiController, type TuiControllerOptions } from "../src/tui/controller.ts";
import { conversationFindStatus, fitFindStatus } from "../src/tui/find-hints.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession, type Session } from "../src/session/session.ts";
import { ConfigEditor } from "../src/config/editing.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { editTool } from "../src/tools/edit.ts";
import { withTempDir } from "./helpers.ts";
import { escPhraseProblems } from "./helpers/esc-verbs.ts";
import { createScriptedModel, type ScriptedTurnFactory } from "./helpers/scripted-model.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function setup(session: Session = createSession(), width = 70, height = 20, overrides: Partial<TuiControllerOptions> = {}) {
  const terminal = await createTestRenderer({ width, height, kittyKeyboard: true, exitOnCtrlC: false });
  const workspace = { root: "/fixture", launchCwd: "/fixture", extraRoots: [] };
  let modelCalls = 0;
  let submits = 0;
  const controller = new TuiController({
    session, sessionId: "search-fixture", workspace, provider: "scripted", modelId: "test-model",
    contextManager: createContextManager(workspace), secrets: ["secret-sentinel"],
    model: createScriptedModel({ responses: [() => { modelCalls++; return { text: "unexpected" }; }] }),
    credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ model: createScriptedModel() }) }, ...overrides,
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
  const plain = (id: string) => (terminal.renderer.root.findDescendantById(id) as TextRenderable).plainText;
  const rows = {
    /** Conversation find status (activity row), hint row, status bar and the reader's find row (its last line). */
    status: () => plain("activity"), hints: () => plain("hints"), footer: () => plain("footer"),
    readerFind: () => plain("reader-text").split("\n").at(-1)!,
    reading: () => !!(terminal.renderer.root.findDescendantById("reader-panel") as { visible: boolean }).visible,
  };
  return { ...terminal, ...rows, controller, view, session, editor, transcript, settle, modelCalls: () => modelCalls, submits: () => submits };
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
  expect(ui.captureCharFrame()).toContain("this branch");
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

test("a match starting inside lowercase expansion lands on the rendered line", async () => {
  const answer = `${"İ ".repeat(900)}İdeep-expansion-token first ${"tail ".repeat(500)}İdeep-expansion-token second ${"tail ".repeat(500)}`;
  const ui = await setup(createSession([user("u", "question"), assistant("a", answer)]), 44, 18);
  ui.mockInput.pressKey("f", { ctrl: true });
  await ui.mockInput.pasteBracketedText("\u0307deep-expansion-token");
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("Find 1/2");
  ui.mockInput.pressArrow("down");
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("Find 2/2");
  ui.mockInput.pressArrow("up");
  ui.mockInput.pressEnter();
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("deep-expansion-token");
  expect(ui.captureCharFrame()).toContain("first");
  expect(ui.modelCalls()).toBe(0);
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

test("a match deep in one wrapped table cell lands on its visual line after immediate Enter", async () => {
  const table = [
    "| Item | Detail |", "| --- | --- |", "| first | short |",
    `| target | ${"filler ".repeat(430)} deep-cell-hit ${"tail ".repeat(80)} |`,
    "| last | short |",
  ].join("\n");
  const ui = await setup(createSession([user("u", "show table"), assistant("a", table)]), 44, 18);
  ui.mockInput.pressKey("f", { ctrl: true });
  await ui.mockInput.typeText("deep-cell-hit");
  ui.mockInput.pressEnter();
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("deep-cell-hit");
  expect(ui.submits()).toBe(0);
});

test("Unicode wraps logically, empty/no-match states stay usable, and live row changes preserve selection", async () => {
  const ui = await setup(createSession([user("u", "ข้อความภาษาไทย e\u0301 match"), assistant("a", "ไทย e\u0301 match")]), 44, 18);
  ui.mockInput.pressKey("f", { ctrl: true });
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("this branch");
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

// #300: every find hint is read from the screen and checked against what its key does.

/** What each arrow does according to a rendered row (`↑↓ previous/next` or `↑ previous · ↓ next`); undefined when the row names no arrows. */
function arrowSteps(row: string): { up: number; down: number } | undefined {
  const step = (word: string | undefined) => word === "previous" ? -1 : word === "next" ? 1 : NaN;
  const pair = /↑↓ ([a-z]+)\/([a-z]+)/.exec(row);
  if (pair) return { up: step(pair[1]), down: step(pair[2]) };
  const up = /↑ ([a-z]+)/.exec(row)?.[1], down = /↓ ([a-z]+)/.exec(row)?.[1];
  return up || down ? { up: step(up), down: step(down) } : undefined;
}
const escPhrases = (row: string) => row.match(/Esc [a-z]+(?: to request)?/g) ?? [];
const statusWords = (status: string) => status.replace(/^⌕ /, "").split(" · ")[0]!.trim().split(/\s+/).length;
const codeAnswer = "Here is the file.\n\n```txt\nneedle one\nfiller\nneedle two\nfiller\nneedle three\nfiller\nneedle four\nend\n```";

async function openReader(ui: Awaited<ReturnType<typeof setup>>) {
  ui.mockInput.pressKey("i", { meta: true }); await ui.settle();
  ui.mockInput.pressKey("r"); await ui.settle();
  expect(ui.reading()).toBe(true);
}

test("conversation find hint names ↑ previous and ↓ next, and each arrow moves the count that way, wrapping at both ends", async () => {
  const ui = await setup(createSession([user("u1", "needle one"), assistant("a1", "needle two"), user("u2", "needle three")]), 80, 24);
  ui.mockInput.pressKey("f", { ctrl: true });
  await ui.mockInput.typeText("needle"); await ui.settle();
  const steps = arrowSteps(ui.hints());
  expect(steps).toEqual({ up: -1, down: 1 });
  const position = () => Number(/Find (\d+)\/3 /.exec(ui.status())?.[1]);
  expect(position()).toBe(1);
  // Up from the first match wraps to the last, down from the last wraps to the first.
  for (const key of ["up", "down", "down", "down", "down", "up"] as const) {
    const before = position();
    ui.mockInput.pressArrow(key); await ui.settle();
    expect(arrowSteps(ui.hints())).toEqual(steps);
    expect(position(), `${key} from ${before}`).toBe((before - 1 + steps![key] + 3) % 3 + 1);
  }
});

test("reader find hint row and status line name ↑ previous and ↓ next, and each arrow moves the count that way, wrapping at both ends", async () => {
  const ui = await setup(createSession([user("u", "show the file"), assistant("a", codeAnswer)]), 80, 24);
  await openReader(ui);
  ui.mockInput.pressKey("f", { ctrl: true });
  await ui.mockInput.typeText("needle"); await ui.settle();
  const steps = arrowSteps(ui.hints());
  expect(steps).toEqual({ up: -1, down: 1 });
  expect(arrowSteps(ui.readerFind())).toEqual(steps);
  const position = () => Number(/ · (\d+)\/4 · /.exec(ui.readerFind())?.[1]);
  expect(position()).toBe(1);
  for (const key of ["up", "down", "down", "down", "down", "down", "up"] as const) {
    const before = position();
    ui.mockInput.pressArrow(key); await ui.settle();
    expect(arrowSteps(ui.hints())).toEqual(steps);
    expect(arrowSteps(ui.readerFind())).toEqual(steps);
    expect(position(), `${key} from ${before}`).toBe((before - 1 + steps![key] + 4) % 4 + 1);
  }
});

test("with an empty query or no matches, conversation find hides the arrows and Enter keep, and Enter closes find in place", async () => {
  const ui = await setup(createSession(Array.from({ length: 40 }, (_, i) => i % 2 ? assistant(`a${i}`, `answer ${i}`) : user(`u${i}`, `request ${i}`))), 80, 24);
  ui.mockInput.pressKey("pageup"); await ui.settle();
  const top = ui.transcript.scrollTop;
  expect(top).toBeGreaterThan(0);
  for (const query of ["", "absent"]) {
    ui.mockInput.pressKey("f", { ctrl: true });
    if (query) await ui.mockInput.typeText(query);
    await ui.settle();
    for (const row of [ui.status(), ui.hints()]) {
      expect(arrowSteps(row), row).toBeUndefined();
      expect(row).not.toContain("Enter");
    }
    expect(ui.hints()).toContain("Esc restore");
    ui.mockInput.pressArrow("up"); ui.mockInput.pressArrow("down"); await ui.settle();
    expect(ui.transcript.scrollTop).toBe(top);
    ui.mockInput.pressEnter(); await ui.settle();
    expect(ui.editor.placeholder).not.toContain("Find");
    expect(ui.hints()).not.toContain("Esc restore");
    expect(ui.transcript.scrollTop).toBe(top);
  }
});

test("with an empty query or no matches, reader find hides the arrows and Enter keep, and Enter closes find in place", async () => {
  const ui = await setup(createSession([user("u", "show the file"), assistant("a", codeAnswer)]), 80, 12);
  await openReader(ui);
  ui.mockInput.pressArrow("down"); ui.mockInput.pressArrow("down"); await ui.settle();
  const body = () => ui.captureCharFrame().split("\n").filter(line => /^\s*\d+ /.test(line)).join("\n");
  const before = body();
  for (const query of ["", "absent"]) {
    ui.mockInput.pressKey("f", { ctrl: true });
    if (query) await ui.mockInput.typeText(query);
    await ui.settle();
    expect(ui.readerFind()).toContain(query ? "No matches" : "Type a query");
    for (const row of [ui.readerFind(), ui.hints()]) {
      expect(arrowSteps(row), row).toBeUndefined();
      expect(row).not.toContain("Enter");
    }
    ui.mockInput.pressArrow("up"); await ui.settle();
    ui.mockInput.pressEnter(); await ui.settle();
    expect(ui.reading()).toBe(true);
    expect(ui.readerFind()).not.toContain("Esc restore");
    expect(ui.hints()).toStartWith("Esc back");
    expect(body()).toBe(before);
  }
});

test("conversation find names Esc restore in its status, hint row and status bar for empty, matching and unmatched queries", async () => {
  const ui = await setup(createSession([user("u1", "needle one"), assistant("a1", "needle two")]), 80, 24);
  for (const query of ["", "needle", "absent"]) {
    ui.resize(80, 24);
    ui.mockInput.pressKey("f", { ctrl: true });
    if (query) await ui.mockInput.typeText(query);
    await ui.settle();
    expect(escPhrases(ui.status()), ui.status()).toEqual(["Esc restore"]);
    expect(escPhrases(ui.hints()), ui.hints()).toEqual(["Esc restore"]);
    expect(escPhrases(ui.footer()).filter(phrase => phrase !== "Esc restore")).toEqual([]);
    // Short layouts hide the hint row; the status bar then carries the same next action.
    ui.resize(80, 12); await ui.settle();
    expect(escPhrases(ui.status())).toEqual(["Esc restore"]);
    expect(escPhrases(ui.footer()), ui.footer()).toEqual(["Esc restore"]);
    ui.mockInput.pressEscape(); await ui.settle();
  }
});

test("reader find names Esc restore in its find row, hint row and status bar for empty, matching and unmatched queries", async () => {
  const ui = await setup(createSession([user("u", "show the file"), assistant("a", codeAnswer)]), 80, 24);
  await openReader(ui);
  for (const query of ["", "needle", "absent"]) {
    ui.resize(80, 24);
    ui.mockInput.pressKey("f", { ctrl: true });
    if (query) await ui.mockInput.typeText(query);
    await ui.settle();
    expect(escPhrases(ui.readerFind()), ui.readerFind()).toEqual(["Esc restore"]);
    expect(escPhrases(ui.hints()), ui.hints()).toEqual(["Esc restore"]);
    expect(escPhrases(ui.footer()).filter(phrase => phrase !== "Esc restore")).toEqual([]);
    ui.resize(80, 12); await ui.settle();
    expect(escPhrases(ui.readerFind())).toEqual(["Esc restore"]);
    expect(escPhrases(ui.footer()), ui.footer()).toEqual(["Esc restore"]);
    ui.mockInput.pressEscape(); await ui.settle();
    expect(ui.reading()).toBe(true);
  }
});

test("reader find keeps Esc back to request in its find row, hint row and status bar while an approval waits", async () => withTempDir(async root => {
  await Bun.write(join(root, "note.txt"), "before");
  const workspace = { root, launchCwd: root, extraRoots: [] };
  const responses: ScriptedTurnFactory[] = [
    { text: codeAnswer },
    { toolCalls: [{ id: "edit-call", name: "edit", arguments: { path: "note.txt", edits: [{ oldText: "before", newText: "after" }] } }] },
    { text: "done" },
  ];
  const ui = await setup(createSession(), 80, 24, {
    workspace, contextManager: createContextManager(workspace), model: createScriptedModel({ responses }), tools: createToolRegistry([editTool]),
    configEditor: new ConfigEditor({ cli: { approval: { mode: "ask" } } }, { user: join(root, "user-config"), project: join(root, "project-config") }),
  });
  await ui.controller.submit("show code"); await ui.settle();
  await openReader(ui);
  ui.mockInput.pressKey("f", { ctrl: true }); await ui.settle();
  const turn = ui.controller.submit("edit");
  for (let tries = 0; tries < 200 && !(ui.controller.snapshot().toolApproval && !ui.controller.snapshot().toolApproval!.loading); tries++) { await Bun.sleep(5); await ui.settle(); }
  expect(ui.controller.snapshot().toolApproval).toBeDefined();
  for (const query of ["", "needle", "absent"]) {
    if (query) await ui.mockInput.typeText(query);
    await ui.settle();
    expect(escPhrases(ui.readerFind()), ui.readerFind()).toEqual(["Esc back to request"]);
    expect(escPhrases(ui.hints()), ui.hints()).toEqual(["Esc back to request"]);
    expect(escPhrases(ui.footer()), ui.footer()).toEqual(["Esc back to request"]);
    for (let index = 0; index < query.length; index++) ui.mockInput.pressBackspace();
  }
  ui.mockInput.pressKey("c", { ctrl: true });
  await turn; await ui.settle();
  expect(await Bun.file(join(root, "note.txt")).text()).toBe("before");
}));

test("conversation find uses one scope phrase, this branch, in its placeholder and every status", async () => {
  const ui = await setup(createSession([user("u1", "needle one"), assistant("a1", "needle two")]), 80, 24);
  ui.mockInput.pressKey("f", { ctrl: true }); await ui.settle();
  expect(ui.editor.placeholder).toBe("Find in this branch…");
  const statuses: string[] = [ui.status()];
  await ui.mockInput.typeText("needle"); await ui.settle();
  statuses.push(ui.status());
  for (let index = 0; index < 6; index++) ui.mockInput.pressBackspace();
  await ui.mockInput.typeText("absent"); await ui.settle();
  statuses.push(ui.status());
  for (const limited of [false, true]) for (const [query, count] of [["", 0], ["needle", 3], ["absent", 0]] as const)
    statuses.push(conversationFindStatus({ query, selected: count ? 1 : -1, count, limited }));
  expect(statuses.slice(0, 3).map(status => status.split(" · ")[0])).toEqual(["⌕ Find in this branch", "⌕ Find 1/2 in this branch", "⌕ No matches in this branch"]);
  for (const status of statuses) {
    expect(status).toContain("in this branch");
    expect(status).not.toMatch(/conversation|active branch|displayed text|searched portion/);
    expect(statusWords(status), status).toBeLessThanOrEqual(6);
  }
  expect(conversationFindStatus({ query: "needle", selected: 1, count: 3, limited: true })).toStartWith("Find 2/3+ in this branch");
});

test("narrow find rows never end in a clipped Esc or a key without its verb", async () => {
  const ui = await setup(createSession([user("u1", "needle one"), assistant("a1", "needle two")]), 80, 30);
  expect(fitFindStatus("No matches in this branch · Edit query · Esc restore", 46)).toBe("No matches in this branch · Edit query");
  expect(fitFindStatus("No matches in this branch · Edit query · Esc restore", 30)).toBe("No matches in this branch");
  for (const query of ["", "needle", "absent"]) {
    ui.mockInput.pressKey("f", { ctrl: true });
    if (query) await ui.mockInput.typeText(query);
    for (const [width, height] of [[120, 30], [80, 30], [50, 30], [40, 30], [30, 30], [50, 8], [40, 8]] as const) {
      ui.resize(width, height); await ui.settle();
      const rows = ui.captureCharFrame().split("\n");
      expect(escPhraseProblems(rows), `${query} at ${width}x${height}\n${rows.join("\n")}`).toEqual([]);
      if (height >= 10) expect(ui.status(), `${query} at ${width}`).not.toMatch(/…$|· (?:Esc|Enter|Ctrl\+End)$/);
    }
    ui.mockInput.pressEscape(); await ui.settle();
  }
});
