import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { RGBA, TextRenderable } from "@opentui/core";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { TuiController, type TuiControllerOptions } from "../src/tui/controller.ts";
import { createConversationView } from "../src/tui/view.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { toolPresentation } from "../src/tui/presentation.ts";
import { TUI_THEMES } from "../src/tui/theme.ts";
import type { TuiToolStatus } from "../src/tui/controller-types.ts";
import type { RuntimeEvent } from "../src/agent/events.ts";
import { bashTool } from "../src/tools/bash.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { withTempDir } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

/** Render shell results through the real controller with fixed duration and animation clocks. */
async function setup(env: Record<string, string> = {}, overrides: Partial<TuiControllerOptions> = {}) {
  const terminal = await createTestRenderer({ width: 120, height: 24, kittyKeyboard: true });
  const session = overrides.session ?? createSession();
  const workspace = { root: "/project", launchCwd: "/project", extraRoots: [] };
  let time = 0;
  const controller = new TuiController({ session, sessionId: "shell-test", workspace, model: createScriptedModel(), provider: "scripted", modelId: "scripted",
    contextManager: createContextManager(workspace), activityClock: () => time, ...overrides });
  const view = createConversationView(terminal.renderer, { controller, workspaceRoot: workspace.root, home: "/home/test", env,
    motion: "off", splash: "none", now: () => 0, secrets: [], quit() {}, submit: value => controller.submit(value) });
  let disposed = false;
  const dispose = () => { if (disposed) return; disposed = true; view.destroy(); controller.dispose(); terminal.renderer.destroy(); };
  cleanups.push(dispose);
  const settle = async () => { view.refresh(); await terminal.flush(); };
  await settle();
  const label = (callId: string) => {
    const entry = controller.snapshot().transcript.find(entry => entry.toolCallId === callId)!;
    return terminal.renderer.root.findDescendantById(`message-${entry.id}`)!.getChildren()[0] as TextRenderable;
  };
  return { ...terminal, session, controller, view, settle, label, dispose, advance: () => { time += 1200; } };
}

test("a normally executed nonzero command keeps its outcome and disclosure before clipping its target", async () => {
  for (const env of [{ SCHWAY_THEME: "dark" }, { SCHWAY_THEME: "light" }, { NO_COLOR: "1" }] as Record<string, string>[]) {
    const ui = await setup(env);
    const command = `printf '${"long command ".repeat(20)}'; exit 1`;
    ui.session.append({ type: "assistant", id: "calls", content: [{ type: "tool_call", id: "shell", name: "bash", arguments: { command } }] });
    ui.controller.applyEvent({ type: "tool.started", toolCallId: "shell", name: "bash" });
    ui.advance();
    ui.controller.applyEvent({ type: "tool.finished", toolCallId: "shell", name: "bash", status: "success", content: "Exit code: 1\nFull output stays inspectable", details: { exitCode: 1 } });
    for (const width of [120, 80, 50, 40, 120]) {
      ui.resize(width, 24); await ui.settle();
      const label = ui.label("shell").plainText;
      expect(label).toMatch(/! +BASH/);
      expect(label).toContain("Exit 1");
      expect(label).toContain("▸");
      expect(label).not.toContain("✓");
      expect(ui.controller.snapshot().transcript.find(entry => entry.toolCallId === "shell")?.toolStatus).toBe("success");
    }
    ui.mockInput.pressKey("o", { ctrl: true }); await ui.settle();
    expect(ui.label("shell").plainText).toContain("Exit 1");
    expect(ui.label("shell").plainText).toContain("▾");
    expect(ui.captureCharFrame()).toContain("Full output stays inspectable");
  }
});

test("live shell labels use structured evidence even without a start event or measurable duration", async () => {
  const cases: { status: TuiToolStatus; details?: unknown; label: string; marker: string; tone: "success" | "warning" | "muted" | "error" }[] = [
    { status: "success", details: { exitCode: 0 }, label: "Exit 0", marker: "✓", tone: "success" },
    { status: "success", details: { exitCode: 7 }, label: "Exit 7", marker: "!", tone: "warning" },
    { status: "success", details: { exitCode: Number.MAX_SAFE_INTEGER }, label: "Exit 9007199254740991", marker: "!", tone: "warning" },
    { status: "success", details: { exitCode: null }, label: "Stopped", marker: "−", tone: "muted" },
    ...[undefined, null, {}, [], "Exit code: 0", { exitCode: "0" }, { exitCode: NaN }, { exitCode: -1 }, { exitCode: 0, timedOut: "true" }]
      .map(details => ({ status: "success" as const, details, label: "No exit observed", marker: "−", tone: "muted" as const })),
    { status: "error", details: { timedOut: true, exitCode: null }, label: "Timed out", marker: "!", tone: "error" },
    { status: "error", details: { exitCode: 0 }, label: "Tool error", marker: "!", tone: "error" },
    { status: "error", label: "Tool error", marker: "!", tone: "error" },
    { status: "cancelled", details: { exitCode: 0 }, label: "Stopped", marker: "−", tone: "muted" },
  ];
  for (const [index, item] of cases.entries()) {
    const ui = await setup();
    const callId = `case-${index}`;
    ui.controller.applyEvent({ type: "tool.finished", toolCallId: callId, name: "bash", status: item.status === "running" ? "success" : item.status,
      content: "all tests passed\nExit code: 0", details: item.details });
    ui.resize(40, 24); await ui.settle();
    const label = ui.label(callId);
    expect(label.plainText).toContain(item.label);
    expect(label.plainText).toContain(item.marker);
    expect(label.plainText).toMatch(/[▸▾]/);
    const entry = ui.controller.snapshot().transcript.find(entry => entry.toolCallId === callId)!;
    expect(toolPresentation(entry, false).tone).toBe(item.tone);
    expect(label.chunks.find(chunk => chunk.text === item.marker)?.fg).toEqual(RGBA.fromHex(TUI_THEMES.dark[item.tone]));
    expect(entry.resultSummary).toBeUndefined();
    ui.dispose();
  }
});

test("real shell exits and failures preserve tool status, model results and whole-turn totals", async () => withTempDir(async root => {
  const workspace = { root, launchCwd: root, extraRoots: [] };
  const events: RuntimeEvent[] = [];
  const calls = [
    { id: "zero", arguments: { command: "printf 'process completed\\n'; exit 0" } },
    { id: "one", arguments: { command: "printf 'all tests passed\\n'; exit 1" } },
    { id: "seven", arguments: { command: "exit 7" } },
    { id: "signal", arguments: { command: "kill -TERM $$" } },
    { id: "timeout", arguments: { command: "printf 'waiting\\n'; sleep 5", timeout: 50 } },
    { id: "error", arguments: { command: "printf 'not reached'", timeout: 0 } },
  ];
  const ui = await setup({}, { workspace, contextManager: createContextManager(workspace), tools: createToolRegistry([bashTool]),
    onRuntimeEvent: event => { events.push(event); },
    model: createScriptedModel({ responses: [...calls.map(call => ({ toolCalls: [{ ...call, name: "bash" }] })), { text: "Observed the command outcomes." }] }) });
  expect(await ui.controller.submit("Run the local shell fixtures")).toBe(true);
  await ui.settle();
  for (const [callId, label] of [["zero", "Exit 0"], ["one", "Exit 1"], ["seven", "Exit 7"], ["signal", "Stopped"], ["timeout", "Timed out"], ["error", "Tool error"]]) {
    expect(ui.label(callId!).plainText).toContain(label!);
  }
  const finished = events.filter(event => event.type === "tool.finished");
  expect(finished.map(event => event.status)).toEqual(["success", "success", "success", "success", "error", "error"]);
  expect(events.some(event => event.type === "tool.delta" && event.text.includes("all tests passed"))).toBe(true);
  expect(ui.session.items.filter(item => item.type === "tool_result").map(item => item.isError)).toEqual([false, false, false, false, true, true]);
  expect(ui.controller.snapshot().outcome).toMatchObject({ reason: "completed", commandCounts: { exitZero: 1, nonzero: 2, unknown: 3 }, toolResults: 6, failedTools: 2 });
  expect(JSON.stringify(finished)).not.toContain("shellOutcome");
  expect(JSON.stringify(ui.session.items)).not.toContain("shellOutcome");
}));

test("streamed shell output settles to a nonzero result and remains expandable", async () => {
  const ui = await setup();
  ui.controller.applyEvent({ type: "tool.started", toolCallId: "stream", name: "bash" });
  ui.controller.applyEvent({ type: "tool.delta", toolCallId: "stream", name: "bash", stream: "stdout", text: "all tests passed" });
  await ui.settle();
  expect(ui.label("stream").plainText).toContain("running…");
  expect(ui.captureCharFrame()).toContain("all tests passed");
  ui.advance();
  ui.controller.applyEvent({ type: "tool.finished", toolCallId: "stream", name: "bash", status: "success", content: "Exit code: 1\nFinal failure output", details: { exitCode: 1 } });
  await ui.settle();
  expect(ui.label("stream").plainText).toContain("Exit 1");
  expect(ui.label("stream").plainText).not.toMatch(/running|✓/);
  const label = ui.label("stream");
  await ui.mockMouse.click(label.x + 1, label.y); await ui.settle();
  expect(ui.label("stream").plainText).toContain("▾");
  expect(ui.captureCharFrame()).toContain("Final failure output");
  expect(ui.captureCharFrame()).not.toContain("all tests passed");
});

test("cancelling a real shell after its first output settles to a neutral stopped row", async () => withTempDir(async root => {
  const workspace = { root, launchCwd: root, extraRoots: [] };
  let cancel = () => {};
  const ui = await setup({}, { workspace, contextManager: createContextManager(workspace), tools: createToolRegistry([bashTool]),
    onRuntimeEvent: event => { if (event.type === "tool.delta" && event.text.includes("ready")) cancel(); },
    model: createScriptedModel({ responses: [{ toolCalls: [{ id: "cancelled", name: "bash", arguments: { command: "printf ready; sleep 5" } }] }] }) });
  cancel = () => ui.controller.cancel();
  await ui.controller.submit("Start and stop the local fixture"); await ui.settle();
  const entry = ui.controller.snapshot().transcript.find(entry => entry.toolCallId === "cancelled")!;
  expect(entry.toolStatus).toBe("cancelled");
  expect(toolPresentation(entry, false)).toMatchObject({ state: "Stopped", tone: "muted", marker: "−" });
  expect(ui.label("cancelled").plainText).toContain("Stopped");
  expect(ui.label("cancelled").plainText).not.toContain("✓");
  expect(ui.controller.snapshot().outcome?.commandCounts).toEqual({ exitZero: 0, nonzero: 0, unknown: 1 });
}));

test("an invalid measured duration does not discard a known command exit", async () => {
  const ui = await setup({}, { activityClock: () => NaN });
  ui.controller.applyEvent({ type: "tool.started", toolCallId: "untimed", name: "bash" });
  ui.controller.applyEvent({ type: "tool.finished", toolCallId: "untimed", name: "bash", status: "success", content: "Exit code: 7", details: { exitCode: 7 } });
  await ui.settle();
  expect(ui.label("untimed").plainText).toContain("Exit 7");
  expect(ui.label("untimed").plainText).not.toContain("NaN");
  expect(ui.controller.snapshot().transcript.find(entry => entry.toolCallId === "untimed")?.resultSummary).toBeUndefined();
});

test("resumed shell results remain neutral and inspectable without parsing saved prose", async () => {
  const session = createSession();
  for (const [index, content] of ["Exit code: 0\nall tests passed", "Exit code: 7\nsaved failure output"].entries()) {
    session.append({ type: "assistant", id: `call-${index}`, content: [{ type: "tool_call", id: `shell-${index}`, name: "bash", arguments: { command: "run saved command" } }] },
      { type: "tool_result", id: `result-${index}`, toolCallId: `shell-${index}`, content, isError: false });
  }
  const ui = await setup({}, { session });
  for (const index of [0, 1]) {
    expect(ui.label(`shell-${index}`).plainText).toContain("No exit observed");
    expect(ui.label(`shell-${index}`).plainText).not.toContain("✓");
  }
  ui.mockInput.pressKey("o", { ctrl: true }); await ui.settle();
  expect(ui.captureCharFrame()).toContain("Exit code: 0");
  expect(ui.captureCharFrame()).toContain("Exit code: 7");
  expect(ui.captureCharFrame()).toContain("saved failure output");
});
