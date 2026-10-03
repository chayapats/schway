import { afterEach, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { ScrollBoxRenderable } from "@opentui/core";
import { createConversationView } from "../src/tui/view.ts";
import { TuiController, buildTranscriptFromSession } from "../src/tui/controller.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import type { Model } from "../src/model/model.ts";
import type { RuntimeEvent } from "../src/agent/events.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MARKDOWN_ANSWER, MARKDOWN_CHUNKS, MARKDOWN_CODE_LINES, MARKDOWN_TABLE_ROWS } from "./helpers/markdown-answer.ts";

const cells = ["Module", "State", "Count", "Owner", "Alpha", "Ready", "Seven", "Ada", "Beta", "Done", "Nine", "Lin"];
const codeLines = ['const first = "alpha";', 'const second = "beta";', 'console.log(first, second);'];
const chunks = [
  "Resize report\n\n",
  "| Module | State | Count | Owner |\n| --- | --- | --- | --- |\n| Alpha | Ready | Seven | Ada |\n| Beta | Done | Nine | Lin |\n\n",
  "```ts\n" + codeLines.join("\n") + "\n```\n\nEnd of answer",
];
const answer = chunks.join("");
const interruptedChunks = [
  "Resize report\n\n| Module | State | Count | Owner |\n",
  '| --- | --- | --- | --- |\n| Alpha | Ready | Seven | Ada |\n| Beta | Done | Nine | Lin |\n\n```ts\nconst first = "al',
  'pha";\nconst second = "beta";\nconsole.log(first, second);\n```\n\nEnd of answer',
];
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

/** Build an isolated real renderer and scripted controller at the requested terminal dimensions. */
async function setup(width = 110, height = 60, model: Model = createScriptedModel({ text: answer }), session = createSession()) {
  const terminal = await createTestRenderer({ width, height, kittyKeyboard: true });
  const workspace = { root: "/project", launchCwd: "/project", extraRoots: [] };
  const controller = new TuiController({ session, workspace, sessionId: "resize-session", provider: "scripted", modelId: "test-model", model, secrets: [],
    contextManager: createContextManager(workspace), changeTracking: "off", activityClock: () => 0,
    credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ model }) },
  });
  const view = createConversationView(terminal.renderer, { controller, workspaceRoot: "/project", home: "/home/test", env: {}, secrets: [],
    motion: "reduced", splash: "none", now: () => 0, quit: () => {}, submit: value => controller.submit(value),
  });
  cleanups.push(() => { view.destroy(); controller.dispose(); terminal.renderer.destroy(); });
  const transcript = terminal.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable;
  await terminal.flush();
  return { ...terminal, controller, view, session, transcript };
}

/** Paint pending controller and layout changes before observing terminal output. */
async function settle(ui: TestRendererSetup & { view: ReturnType<typeof createConversationView> }) {
  await Bun.sleep(5);
  ui.view.refresh();
  await ui.flush();
}

/** Ignore display wrapping whitespace while preserving every visible content character. */
function compact(text: string) { return text.replace(/\s+/g, ""); }

/** Capture the settled screen and optionally retain diagnostic evidence for one named scenario. */
async function frame(ui: Awaited<ReturnType<typeof setup>>, scenario: string) {
  await settle(ui);
  const text = ui.captureCharFrame();
  if (process.env.SCHWAY_RESIZE_FRAMES) {
    await mkdir(process.env.SCHWAY_RESIZE_FRAMES, { recursive: true });
    await writeFile(join(process.env.SCHWAY_RESIZE_FRAMES, `${scenario}.txt`), text);
  }
  return text;
}

/** Require all short-fixture cells, code lines and inspection controls in captured terminal text. */
function expectAnswer(text: string) {
  for (const value of [...cells, ...codeLines, "End of answer"]) expect(compact(text), `Missing ${value}\n${text}`).toContain(compact(value));
  expect(text).toMatch(/\bts\s+Alt\+I inspect/);
  expect(text.split("\n").filter(line => line.trim()).length).toBeGreaterThan(10);
}

/** Pause the scripted model after each delivered text delta so resizes occur between chunks. */
function gatedModel(pieces: readonly string[] = chunks, completion?: string) {
  const scripted = createScriptedModel({ chunks: [...pieces], ...(completion === undefined ? {} : { message: {
    type: "assistant" as const, id: "canonical-completion", content: [{ type: "text" as const, text: completion }],
  } }) });
  const gates = pieces.map(() => Promise.withResolvers<void>());
  const delivered = pieces.map(() => Promise.withResolvers<void>());
  const model: Model = { ...scripted,
    /** Forward the real scripted events, waiting for the corresponding gate after each text delta. */
    async *stream(request) {
    let index = 0;
    for await (const event of scripted.stream(request)) {
      yield event;
      if (event.type === "text_delta") {
        delivered[index]!.resolve();
        await gates[index++]!.promise;
      }
    }
  } };
  cleanups.push(() => gates.forEach(gate => gate.resolve()));
  return { model, gates, delivered };
}

test("completed table and code answer stays visible after 110 to 60 columns", async () => {
  const ui = await setup();
  await ui.controller.submit("Compare the modules");
  expectAnswer(await frame(ui, "completed-110"));
  ui.resize(60, 60);
  expectAnswer(await frame(ui, "completed-60"));
});

test("table and code survive resize between gated streaming deltas and again after model.finished", async () => {
  const gated = gatedModel();
  const ui = await setup(110, 60, gated.model);
  const turn = ui.controller.submit("Compare the modules");
  try {
    for (let index = 0; index < chunks.length; index++) {
      await gated.delivered[index]!.promise;
      for (const width of [110, 60, 110]) {
        ui.resize(width, 60);
        const text = await frame(ui, `streaming-${index}-${width}`);
        if (index >= 1) for (const cell of cells) expect(compact(text)).toContain(compact(cell));
        if (index === 2) expectAnswer(text);
      }
      gated.gates[index]!.resolve();
    }
    await turn;
    for (const width of [110, 60]) {
      ui.resize(width, 60);
      expectAnswer(await frame(ui, `streaming-completed-${width}`));
    }
  } finally { gated.gates.forEach(gate => gate.resolve()); await turn; }
});

test("partly off-screen table and code reappear while paging a long transcript after 110 to 60 resize", async () => {
  const ui = await setup(110, 18);
  for (let index = 0; index < 35; index++) ui.controller.notice(`Earlier message ${index}: context before the answer`);
  await ui.controller.submit("Compare the modules");
  const before = await frame(ui, "scrolling-partly-offscreen-110");
  expect(ui.transcript.scrollHeight).toBeGreaterThan(ui.transcript.viewport.height);
  expect(before).not.toContain("Resize report");
  ui.resize(60, 18);
  await frame(ui, "scrolling-partly-offscreen-60");
  ui.mockInput.pressKey("HOME", { ctrl: true });
  await settle(ui);
  let captured = "";
  for (let page = 0; page < 30; page++) {
    captured += await frame(ui, `scrolling-60-page-${page}`);
    const top = ui.transcript.scrollTop;
    await ui.mockInput.pressKeys(["\u001b[6~"]);
    await settle(ui);
    if (ui.transcript.scrollTop === top) break;
  }
  expectAnswer(captured);
});

test("resumed session table and code remain visible after 110 to 60 columns", async () => {
  const session = createSession();
  session.append({ type: "user", id: "resume-user", content: [{ type: "text", text: "Compare the modules" }] });
  session.append({ type: "assistant", id: "resume-answer", content: [{ type: "text", text: answer }] });
  expect(buildTranscriptFromSession(session.items).at(-1)?.text).toBe(answer);
  const ui = await setup(110, 60, createScriptedModel(), session);
  expectAnswer(await frame(ui, "resumed-110"));
  ui.resize(60, 60);
  expectAnswer(await frame(ui, "resumed-60"));
});

test("notice between streamed table and code deltas does not permanently split Markdown blocks", async () => {
  const pieces = interruptedChunks;
  const gated = gatedModel(pieces);
  const ui = await setup(110, 60, gated.model);
  const turn = ui.controller.submit("Compare the modules");
  try {
    await gated.delivered[0]!.promise;
    await frame(ui, "notice-before-110");
    const active = ui.controller.snapshot().streamingAssistantId;
    expect(active).toBeDefined();
    ui.controller.notice("Busy: /x was not run.");
    expect(ui.controller.snapshot().streamingAssistantId).toBe(active);
    ui.resize(60, 60);
    await frame(ui, "notice-appended-60");
    for (let index = 1; index < pieces.length; index++) {
      gated.gates[index - 1]!.resolve();
      await gated.delivered[index]!.promise;
      await frame(ui, `notice-delta-${index}-60`);
    }
    gated.gates.at(-1)!.resolve();
    await turn;
    expect(ui.controller.snapshot().streamingAssistantId).toBeUndefined();
    ui.resize(60, 60);
    const text = await frame(ui, "notice-completed-60");
    expectAnswer(text);
    expect(text).not.toContain("|");
    expect(text.match(/\bts\s+Alt\+I inspect/g)).toHaveLength(1);
  } finally { gated.gates.forEach(gate => gate.resolve()); await turn; }
});

/** Crop captured terminal output to the latest assistant row for fresh-versus-resized comparisons. */
function answerRegion(ui: Awaited<ReturnType<typeof setup>>) {
  const entry = ui.controller.snapshot().transcript.findLast(entry => entry.kind === "assistant")!;
  const row = ui.renderer.root.findDescendantById(`message-${entry.id}`)!;
  return ui.captureCharFrame().split("\n").slice(row.y, row.y + row.height)
    .map(line => line.slice(row.x, row.x + row.width).trimEnd()).join("\n").trimEnd();
}

/** Verify aligned table cells, lossless wrapped text and render bounds within the transcript. */
function expectWrapping(ui: Awaited<ReturnType<typeof setup>>, hasCode = true) {
  const text = ui.captureCharFrame();
  const lines = text.split("\n");
  const first = lines.findIndex(line => /\bA\b/.test(line) && /\bB\b/.test(line) && /\bC\b/.test(line) && /\bD\b/.test(line));
  const second = lines.findIndex(line => /\bE\b/.test(line) && /\bF\b/.test(line) && /\bG\b/.test(line) && /\bH\b/.test(line));
  expect(first, text).toBeGreaterThan(0);
  expect(second, text).toBeGreaterThan(first);
  const starts = ["A", "B", "C", "D"].map(marker => lines[first]!.indexOf(marker));
  expect(starts).toEqual([...starts].sort((a, b) => a - b));
  const end = lines.findIndex((line, index) => index > second && !line.trim());
  const header = lines.findIndex(line => line.includes("Name") && line.includes("State"));
  expect(header, text).toBeGreaterThan(0);
  for (const [index, row] of MARKDOWN_TABLE_ROWS.entries()) {
    const [from, to] = [[header, first], [first, second], [second, end]][index]!;
    for (const [column, cell] of row.entries()) {
      const rendered = lines.slice(from, to).map(line => line.slice(starts[column], starts[column + 1] ?? ui.transcript.x + ui.transcript.viewport.width)).join("");
      expect(compact(rendered), `Missing table cell ${cell}\n${text}`).toContain(compact(cell));
    }
  }
  if (hasCode) {
    expect(text).toContain("Alt+I inspect");
    expect(text).toMatch(/\bts\s+Alt\+I inspect/);
    for (const code of MARKDOWN_CODE_LINES) expect(compact(text), text).toContain(compact(code));
  }
  const entry = ui.controller.snapshot().transcript.findLast(entry => entry.kind === "assistant")!;
  const root = ui.renderer.root.findDescendantById(`message-${entry.id}`)!;
  /** Require every rendered descendant to remain inside the transcript's horizontal viewport. */
  const checkBounds = (node: typeof root) => {
    expect(node.x).toBeGreaterThanOrEqual(ui.transcript.x);
    expect(node.x + node.width).toBeLessThanOrEqual(ui.transcript.x + ui.transcript.viewport.width);
    for (const child of node.getChildren()) checkBounds(child);
  };
  checkBounds(root);
}

for (const width of [120, 80, 50]) test(`completed table cells and long code lines wrap without loss at ${width} columns`, async () => {
  const ui = await setup(width, 80, createScriptedModel({ text: MARKDOWN_ANSWER }));
  await ui.controller.submit("Show wrapping");
  await frame(ui, `wrapping-${width}`);
  expectWrapping(ui);
});

test("completed wrapped answer matches fresh session renders after resizing in both directions", async () => {
  for (const start of [120, 80]) {
    const ui = await setup(start, 80, createScriptedModel({ text: MARKDOWN_ANSWER }));
    await ui.controller.submit("Show wrapping");
    for (const width of [start, 50, start]) {
      ui.resize(width, 80); await settle(ui);
      expectWrapping(ui);
      const fresh = await setup(width, 80, createScriptedModel(), ui.session);
      await settle(fresh);
      expect(answerRegion(ui)).toBe(answerRegion(fresh));
    }
  }
});

test("gated streaming table and long code wrap through 120 and 80 to 50 and back", async () => {
  for (const start of [120, 80]) {
    const gated = gatedModel(MARKDOWN_CHUNKS);
    const ui = await setup(start, 80, gated.model);
    const turn = ui.controller.submit("Show wrapping");
    try {
      for (let index = 0; index < MARKDOWN_CHUNKS.length; index++) {
        await gated.delivered[index]!.promise;
        for (const width of [start, 50, start]) {
          ui.resize(width, 80); await settle(ui);
          expectWrapping(ui, index === MARKDOWN_CHUNKS.length - 1);
        }
        gated.gates[index]!.resolve();
      }
      await turn;
      expect(ui.controller.snapshot().streamingAssistantId).toBeUndefined();
    } finally { gated.gates.forEach(gate => gate.resolve()); await turn; }
  }
});

test("abandoned previews stop streaming and a retry owns a new assistant row", async () => {
  const ui = await setup();
  ui.controller.applyEvent({ type: "model.started", provider: "scripted", model: "test-model" });
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "```ts\nconst abandoned = 1;" } });
  const abandoned = ui.controller.snapshot().streamingAssistantId;
  expect(abandoned).toBeDefined();
  ui.controller.notice("Busy: /x was not run.");
  expect(ui.controller.snapshot().streamingAssistantId).toBe(abandoned);
  ui.controller.applyEvent({ type: "model.retry", attempt: 1, maxAttempts: 2, delayMs: 1, message: "retry" });
  expect(ui.controller.snapshot().streamingAssistantId).toBeUndefined();
  ui.resize(60, 60); await settle(ui);
  expect(ui.captureCharFrame()).toContain("Incomplete response");
  ui.controller.applyEvent({ type: "model.started", provider: "scripted", model: "test-model" });
  expect(ui.controller.snapshot().transcript.some(entry => entry.id === abandoned)).toBe(false);
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: answer } });
  expect(ui.controller.snapshot().streamingAssistantId).not.toBe(abandoned);
  expect(ui.controller.snapshot().streamingAssistantId).toBeDefined();
  ui.controller.applyEvent({ type: "model.finished" });
  ui.controller.notice("A later tool notice");
  expect(ui.controller.snapshot().streamingAssistantId).toBeUndefined();
  expectAnswer(await frame(ui, "retry-replacement-60"));
});

test("completion can extend the last delta without freezing a partial Markdown block", async () => {
  const partial = "| Module | State | Count | Owner |\n";
  const gated = gatedModel([partial], answer);
  const ui = await setup(60, 60, gated.model);
  const turn = ui.controller.submit("Compare the modules");
  try {
    await gated.delivered[0]!.promise;
    await settle(ui);
    gated.gates[0]!.resolve();
    await turn;
    expectAnswer(await frame(ui, "canonical-completion-60"));
    expect(ui.controller.snapshot().streamingAssistantId).toBeUndefined();
  } finally { gated.gates.forEach(gate => gate.resolve()); await turn; }
});

test("cancelled, failed, Grok-rejected and overflow-abandoned code previews stay finalized across resize", async () => {
  for (const event of [
    { type: "agent.finished", reason: "cancelled" },
    { type: "agent.finished", reason: "error" },
    { type: "compaction.started", reason: "overflow" },
    { type: "error", message: "Your Grok plan doesn't include API access. Use an xAI API key instead." },
  ] satisfies RuntimeEvent[]) {
    const ui = await setup();
    ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "```ts\nconst abandoned = 1;" } });
    expect(ui.controller.snapshot().streamingAssistantId).toBeDefined();
    ui.controller.applyEvent(event);
    expect(ui.controller.snapshot().streamingAssistantId).toBeUndefined();
    for (const width of [50, 80]) {
      ui.resize(width, 60); await settle(ui);
      expect(ui.captureCharFrame()).toContain("Incomplete response");
      expect(ui.captureCharFrame()).toContain("const abandoned = 1;");
      expect(ui.controller.snapshot().streamingAssistantId).toBeUndefined();
    }
  }
});

test("a local diagnostic does not finalize an answer that is still receiving deltas", async () => {
  const gated = gatedModel(interruptedChunks);
  const ui = await setup(60, 60, gated.model);
  const turn = ui.controller.submit("Compare the modules");
  try {
    await gated.delivered[0]!.promise;
    await settle(ui);
    const active = ui.controller.snapshot().streamingAssistantId;
    ui.controller.fail("A local diagnostic; the model is still responding.");
    await settle(ui);
    expect(ui.controller.snapshot().status).toBe("error");
    expect(ui.controller.snapshot().streamingAssistantId).toBe(active);
    for (let index = 1; index < interruptedChunks.length; index++) {
      gated.gates[index - 1]!.resolve();
      await gated.delivered[index]!.promise;
      await settle(ui);
    }
    gated.gates.at(-1)!.resolve();
    await turn;
    const text = await frame(ui, "diagnostic-completed-60");
    expectAnswer(text);
    expect(text).not.toContain("|");
    expect(text.match(/\bts\s+Alt\+I inspect/g)).toHaveLength(1);
  } finally { gated.gates.forEach(gate => gate.resolve()); await turn; }
});

test("searching a tall table after resize lands on the matching cell", async () => {
  const table = ["| Item | Detail |", "| --- | --- |", ...Array.from({ length: 55 }, (_, index) =>
    `| row-${index} | ${index === 43 ? "resize-cell-target" : `ordinary-${index} words in a wrapped cell`} |`)].join("\n");
  const ui = await setup(110, 18, createScriptedModel({ text: table }));
  await ui.controller.submit("Show table");
  await settle(ui);
  ui.resize(50, 18); await settle(ui);
  expect(ui.captureCharFrame()).not.toContain("resize-cell-target");
  ui.mockInput.pressKey("f", { ctrl: true });
  await ui.mockInput.typeText("resize-cell-target");
  ui.mockInput.pressEnter(); await settle(ui);
  expect(ui.captureCharFrame()).toContain("resize-cell-target");
  expect(ui.captureCharFrame()).toContain("row-43");
  expect(ui.session.items.filter(item => item.type === "user")).toHaveLength(1);
});

test("empty abandoned deltas do not leave an active preview or a stale streaming caret", async () => {
  for (const event of [
    { type: "agent.finished", reason: "cancelled" },
    { type: "agent.finished", reason: "error" },
    { type: "compaction.started", reason: "overflow" },
    { type: "model.retry", attempt: 1, maxAttempts: 2, delayMs: 1, message: "retry" },
  ] satisfies RuntimeEvent[]) {
    const ui = await setup();
    ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "" } });
    ui.controller.applyEvent(event);
    expect(ui.controller.snapshot().streamingAssistantId).toBeUndefined();
    await settle(ui);
    expect(ui.captureCharFrame()).not.toContain("▍");
  }
});
