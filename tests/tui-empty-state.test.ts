import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { TextareaRenderable, TextRenderable } from "@opentui/core";
import { createConversationView } from "../src/tui/view.ts";
import { TuiController, type TuiControllerOptions, type TuiSnapshot } from "../src/tui/controller.ts";
import { TASK_EXAMPLES, TASK_EXAMPLES_HEADING, taskExampleLines, taskExamplesEligible } from "../src/tui/empty-guidance.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { dispatchEditorInput } from "../src/tui/commands.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { ConfigEditor } from "../src/config/editing.ts";
import type { Model } from "../src/model/model.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const THEMES: Record<string, string>[] = [{ SCHWAY_THEME: "dark" }, { SCHWAY_THEME: "light" }, { SCHWAY_THEME: "dark", NO_COLOR: "1" }];

/** Count model streams and tool executions so rendering can prove it starts no work. */
function countingDependencies() {
  const calls = { model: 0, tool: 0 };
  const scripted = createScriptedModel({ id: "test-model", responses: [{ text: "Started." }] });
  const model: Model = { ...scripted, stream: request => { calls.model++; return scripted.stream(request); } };
  const tools = createToolRegistry([{ name: "read", description: "Counting fixture", execution: "parallel", inputSchema: { type: "object", properties: {} },
    execute: async () => { calls.tool++; return { content: "unused" }; } }]);
  return { calls, model, tools };
}

async function setup(width = 80, height = 30, env: Record<string, string> = THEMES[0]!, overrides: Partial<TuiControllerOptions> = {}) {
  const terminal = await createTestRenderer({ width, height, kittyKeyboard: true });
  const dependencies = countingDependencies();
  const workspace = { root: "/project", launchCwd: "/project", extraRoots: [] };
  const controller = new TuiController({
    session: createSession(), workspace, provider: "scripted", modelId: "test-model", sessionId: "empty-state-session",
    model: dependencies.model, tools: dependencies.tools, contextManager: createContextManager(workspace),
    credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ model: dependencies.model }) },
    appearanceEnvironment: env.SCHWAY_THEME === "light" ? "light" : "dark",
    configEditor: new ConfigEditor({}, { user: "/home/test/.config/schway/config.json", project: "/project/.schway/config.json" }),
    ...overrides,
  });
  const view = createConversationView(terminal.renderer, {
    controller, workspaceRoot: "/project", home: "/home/test", env, secrets: [], quit() {},
    submit: (value, accepted) => dispatchEditorInput(value, controller, async () => false, accepted),
  });
  cleanups.push(() => { view.destroy(); controller.dispose(); terminal.renderer.destroy(); });
  const editor = terminal.renderer.root.findDescendantById("prompt") as TextareaRenderable;
  const examples = terminal.renderer.root.findDescendantById("task-examples") as TextRenderable;
  const settle = async () => { await Bun.sleep(5); view.refresh(); await terminal.flush(); };
  await settle();
  return { ...terminal, controller, view, editor, examples, settle, calls: dependencies.calls };
}

type Ui = Awaited<ReturnType<typeof setup>>;
const frameRows = (ui: Ui) => ui.captureCharFrame().split("\n");
const rowOf = (ui: Ui, text: string) => frameRows(ui).findIndex(row => row.includes(text));
const shown = (ui: Ui) => ui.examples.visible && ui.captureCharFrame().includes(TASK_EXAMPLES_HEADING);
/** Every visible example is whole, sits between readiness and the composer, and the next action stays visible. */
function expectSafeLayout(ui: Ui) {
  const rows = frameRows(ui);
  const composer = rowOf(ui, "Ask Schway…");
  expect(composer).toBeGreaterThan(0);
  if (!shown(ui)) return 0;
  const action = rowOf(ui, "Type a task · Enter sends"), heading = rowOf(ui, TASK_EXAMPLES_HEADING);
  expect(action).toBeGreaterThanOrEqual(0);
  expect(heading).toBeGreaterThan(action);
  let visible = 0;
  for (const example of TASK_EXAMPLES) {
    const row = rows.findIndex(line => line.includes(example));
    if (row < 0) continue;
    visible++;
    expect(row).toBeGreaterThan(heading);
    expect(row).toBeLessThan(composer - 1);
  }
  // A partial example would leave its first word without the full sentence.
  for (const word of ["Explain how", "Find a bug", "Add a test"]) {
    const row = rows.find(line => line.includes(word));
    if (row) expect(TASK_EXAMPLES.some(example => row.includes(example))).toBe(true);
  }
  expect(visible).toBeGreaterThan(0);
  return visible;
}

test("task examples lay out whole sentences and drop rather than truncate", () => {
  expect(taskExampleLines(80, 5)).toEqual([TASK_EXAMPLES_HEADING, ...TASK_EXAMPLES.map(example => `  ${example}`)]);
  expect(taskExampleLines(80, 9)).toHaveLength(4);
  expect(taskExampleLines(80, 4)).toEqual([TASK_EXAMPLES_HEADING, `  ${TASK_EXAMPLES[0]}`, `  ${TASK_EXAMPLES[1]}`]);
  expect(taskExampleLines(80, 3)).toEqual([TASK_EXAMPLES_HEADING, `  ${TASK_EXAMPLES[0]}`]);
  expect(taskExampleLines(80, 2)).toEqual([]);
  // At 32 cells only the two shorter examples fit whole; the longer one is omitted, not clipped.
  expect(taskExampleLines(32, 5)).toEqual([TASK_EXAMPLES_HEADING, `  ${TASK_EXAMPLES[1]}`, `  ${TASK_EXAMPLES[2]}`]);
  expect(taskExampleLines(20, 5)).toEqual([]);
  expect(TASK_EXAMPLES.length).toBeLessThanOrEqual(3);
});

test("eligibility requires a ready, idle, empty conversation and leaves priority to every competing surface", () => {
  const base = { readiness: "ready", status: "idle", transcript: [] } as unknown as TuiSnapshot;
  const surface = { draft: "", owned: false, draftNotice: false };
  expect(taskExamplesEligible(base, surface)).toBe(true);
  const blocked: Partial<TuiSnapshot>[] = [
    { readiness: "loading" }, { readiness: "not-connected" }, { readiness: "connect" }, { readiness: "choose-model" }, { readiness: "repair" },
    { status: "running" }, { status: "error" }, { transcript: [{ id: "1", kind: "user", text: "Hi" }] },
    { activity: { phase: "streaming" } as TuiSnapshot["activity"] }, { toolApproval: {} as TuiSnapshot["toolApproval"] },
    { recovery: {} as TuiSnapshot["recovery"] }, { outcome: {} as TuiSnapshot["outcome"] },
    { recentSession: {} as TuiSnapshot["recentSession"] }, { restored: true },
  ];
  for (const change of blocked) expect(taskExamplesEligible({ ...base, ...change }, surface)).toBe(false);
  for (const change of [{ draft: "a" }, { draft: " " }, { draft: "\n" }, { draft: "อธิบาย" }, { owned: true }, { draftNotice: true }]) {
    expect(taskExamplesEligible(base, { ...surface, ...change })).toBe(false);
  }
});

test("ready empty conversation shows examples below readiness at 120/80/50 and omits them at safety sizes across themes", async () => {
  for (const env of THEMES) {
    const ui = await setup(120, 30, env);
    for (const [width, height, expected] of [[120, 30, 3], [80, 30, 3], [50, 30, 3], [80, 24, 3], [50, 14, -1], [40, 20, -1], [50, 8, 0], [40, 8, 0], [30, 8, 0], [24, 8, 0], [120, 9, 0], [80, 30, 3]] as const) {
      ui.resize(width, height);
      await ui.settle();
      const visible = expectSafeLayout(ui);
      if (expected >= 0) expect(visible).toBe(expected);
      if (height >= 14) expect(ui.captureCharFrame()).toContain("Enter send");
      expect(ui.captureCharFrame()).toContain("Auto");
      if (height >= 10) expect(ui.captureCharFrame()).toContain("Type a task · Enter sends");
    }
    expect(ui.calls).toEqual({ model: 0, tool: 0 });
  }
});

test("examples respect the visible mode and never claim a mode is required", async () => {
  const ui = await setup(80, 30);
  for (const mode of ["Ask", "Read-only", "Auto"]) {
    ui.mockInput.pressTab({ shift: true });
    await ui.settle();
    expect(ui.captureCharFrame()).toContain(mode);
    expect(expectSafeLayout(ui)).toBe(3);
  }
  const text = ui.examples.chunks.map(chunk => chunk.text).join("");
  for (const word of ["Auto", "Ask", "Read-only", "mode", "Shift+Tab"]) expect(text).not.toContain(word);
});

test("typing hides examples without changing text or cursor; clearing the draft reveals them", async () => {
  const ui = await setup(80, 30);
  expect(shown(ui)).toBe(true);
  await ui.mockInput.typeText("a");
  await ui.settle();
  expect(shown(ui)).toBe(false);
  expect(ui.editor.plainText).toBe("a");
  expect(ui.editor.cursorOffset).toBe(1);
  const thai = "อธิบายว่าโปรเจกต์นี้เริ่มอย่างไร\nแล้วสรุปสั้น ๆ";
  await ui.mockInput.pasteBracketedText(thai);
  ui.mockInput.pressArrow("left");
  await ui.settle();
  const cursor = ui.editor.cursorOffset;
  expect(shown(ui)).toBe(false);
  expect(ui.editor.plainText).toBe(`a${thai}`);
  ui.resize(50, 30);
  await ui.settle();
  expect(shown(ui)).toBe(false);
  expect(ui.editor.plainText).toBe(`a${thai}`);
  expect(ui.editor.cursorOffset).toBe(cursor);
  ui.editor.setText("");
  await ui.settle();
  expect(expectSafeLayout(ui)).toBe(3);
  await ui.mockInput.typeText(" ");
  await ui.settle();
  expect(shown(ui)).toBe(false);
  ui.mockInput.pressBackspace();
  await ui.settle();
  expect(shown(ui)).toBe(true);
  expect(ui.editor.plainText).toBe("");
  expect(ui.calls).toEqual({ model: 0, tool: 0 });
});

test("search, panels and command browsing own the surface; Esc restores examples and the empty composer", async () => {
  const ui = await setup(80, 30);
  const owners: [string, () => void, (s: TuiSnapshot) => boolean][] = [
    ["search", () => ui.mockInput.pressKey("f", { ctrl: true }), () => ui.editor.placeholder === "Find in this conversation…"],
    ["model", () => ui.mockInput.pressKey("m", { meta: true }), s => !!s.modelPicker],
    ["preferences", () => ui.mockInput.pressKey("p", { meta: true }), s => !!s.preferences],
    ["sign-in", () => ui.mockInput.pressKey("l", { meta: true }), s => !!s.loginChooser],
  ];
  for (const [label, open, opened] of owners) {
    open();
    await ui.settle();
    expect(opened(ui.controller.snapshot()), label).toBe(true);
    expect(shown(ui), label).toBe(false);
    ui.mockInput.pressEscape();
    await ui.settle();
    expect(shown(ui), label).toBe(true);
    expect(ui.editor.plainText, label).toBe("");
  }
  await ui.mockInput.typeText("/");
  await ui.settle();
  expect(ui.renderer.root.findDescendantById("picker")?.visible).toBe(true);
  expect(shown(ui)).toBe(false);
  expect(ui.calls).toEqual({ model: 0, tool: 0 });
});

test("restored workspace guidance keeps priority over examples", async () => {
  const ui = await setup(80, 30);
  expect(shown(ui)).toBe(true);
  ui.controller.markRestored();
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("Restored workspace: /project");
  expect(shown(ui)).toBe(false);
});

test("loading and recovery replace examples; a completed connection check reveals them", async () => {
  for (const env of THEMES) {
    let finish!: (result: { model: Model } | { error: string }) => void;
    const ui = await setup(80, 30, env, { provider: "openai", modelId: "fixture", model: undefined });
    const pending = ui.controller.initializeStartup(() => new Promise(resolve => { finish = resolve; }));
    await ui.settle();
    expect(ui.controller.snapshot().readiness).toBe("loading");
    expect(ui.captureCharFrame()).toContain("Checking connection · Type a task · Esc cancel");
    expect(shown(ui)).toBe(false);
    ui.resize(50, 30);
    await ui.settle();
    expect(shown(ui)).toBe(false);
    const { model, calls } = countingDependencies();
    finish({ model });
    await pending;
    await ui.settle();
    expect(ui.controller.snapshot().readiness).toBe("ready");
    expect(expectSafeLayout(ui)).toBe(3);
    ui.resize(120, 30);
    await ui.settle();
    expect(expectSafeLayout(ui)).toBe(3);
    expect(calls).toEqual({ model: 0, tool: 0 });

    const failed = await setup(80, 30, env, { provider: "openai", modelId: "fixture", model: undefined });
    await failed.controller.initializeStartup(async () => ({ error: "Missing API key" }));
    await failed.settle();
    expect(failed.captureCharFrame()).toContain("Connect to continue · Alt+L sign in");
    expect(failed.captureCharFrame()).toContain("F2 details");
    expect(shown(failed)).toBe(false);
    failed.resize(120, 30);
    await failed.settle();
    expect(shown(failed)).toBe(false);
  }
});

test("rendering examples starts no provider or tool work; only an explicit Enter sends one typed task", async () => {
  const ui = await setup(120, 30);
  for (const [width, height] of [[80, 30], [50, 30], [40, 8], [120, 30]] as const) { ui.resize(width, height); await ui.settle(); }
  expect(shown(ui)).toBe(true);
  expect(ui.calls).toEqual({ model: 0, tool: 0 });
  await ui.mockInput.typeText(TASK_EXAMPLES[0]!);
  await ui.settle();
  expect(ui.calls).toEqual({ model: 0, tool: 0 });
  ui.mockInput.pressEnter();
  const deadline = Date.now() + 5000;
  while (!ui.controller.snapshot().outcome && Date.now() < deadline) await ui.settle();
  expect(ui.calls).toEqual({ model: 1, tool: 0 });
  expect(ui.controller.snapshot().transcript.some(entry => entry.kind === "user" && entry.text === TASK_EXAMPLES[0])).toBe(true);
  expect(shown(ui)).toBe(false);
  expect(ui.captureCharFrame()).not.toContain(TASK_EXAMPLES_HEADING);
});
