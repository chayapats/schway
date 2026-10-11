import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { TextRenderable } from "@opentui/core";
import { createConversationView, hasToggleableTools } from "../src/tui/view.ts";
import { TuiController, type TuiControllerOptions, type TuiTranscriptEntry } from "../src/tui/controller.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { DEFAULT_INLINE_DIFF_LINES } from "../src/config/config.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

/** Render a real conversation view wide enough for the full idle hint row. */
async function setup(overrides: Partial<TuiControllerOptions> = {}, width = 100) {
  const terminal = await createTestRenderer({ width, height: 30, kittyKeyboard: true });
  const session = createSession();
  const workspace = { root: "/project", launchCwd: "/project", extraRoots: [] };
  const controller = new TuiController({
    session, workspace, provider: "scripted", modelId: "test-model", sessionId: "tools-hint-session",
    model: createScriptedModel({ responses: [{ text: "Done." }] }), contextManager: createContextManager(workspace),
    credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ model: createScriptedModel() }) },
    ...overrides,
  });
  const view = createConversationView(terminal.renderer, {
    controller, workspaceRoot: "/project", home: "/home/test", env: {}, secrets: [],
    quit: () => {}, openUrl: async () => {}, submit: async () => false,
  });
  cleanups.push(() => { view.destroy(); controller.dispose(); terminal.renderer.destroy(); });
  const settle = async () => { await Bun.sleep(5); view.refresh(); await terminal.flush(); };
  const hint = () => (terminal.renderer.root.findDescendantById("hints") as TextRenderable).plainText;
  await settle();
  return { ...terminal, controller, session, settle, hint };
}

const tool = (id: string, patch: Partial<TuiTranscriptEntry> = {}): TuiTranscriptEntry =>
  ({ id, kind: "tool", text: "", toolName: "read", toolStatus: "success", ...patch }) as TuiTranscriptEntry;

test("only tool rows that expand or collapse count as Ctrl+O targets", () => {
  const inlineEdit = tool("edit", { toolName: "edit", diffRows: [{ sign: "+", line: 1, text: "new" }] });
  expect(hasToggleableTools([], DEFAULT_INLINE_DIFF_LINES)).toBe(false);
  expect(hasToggleableTools([{ id: "u", kind: "user", text: "hi" } as TuiTranscriptEntry, { id: "e", kind: "error", text: "failed" } as TuiTranscriptEntry], DEFAULT_INLINE_DIFF_LINES)).toBe(false);
  expect(hasToggleableTools([inlineEdit], DEFAULT_INLINE_DIFF_LINES)).toBe(false);
  // A diff larger than the inline limit collapses to a toggleable row.
  expect(hasToggleableTools([inlineEdit], 0)).toBe(true);
  expect(hasToggleableTools([inlineEdit, tool("read")], DEFAULT_INLINE_DIFF_LINES)).toBe(true);
  // A failed row always shows expanded, so Ctrl+O changes it only after the user collapsed that row.
  const failed = tool("bash", { toolName: "bash", toolStatus: "error" });
  expect(hasToggleableTools([failed], DEFAULT_INLINE_DIFF_LINES)).toBe(false);
  expect(hasToggleableTools([failed], DEFAULT_INLINE_DIFF_LINES, new Set([failed.id]))).toBe(true);
});

test("the idle hint offers Ctrl+O tools only once a tool row can toggle", async () => {
  const ui = await setup();
  expect(ui.hint()).toContain("Ctrl+F find · Alt+I inspect · / commands");
  expect(ui.hint()).not.toContain("Ctrl+O tools");

  ui.session.append({ type: "assistant", id: "calls", content: [{ type: "tool_call", id: "read-1", name: "read", arguments: { path: "README.md" } }] });
  ui.controller.applyEvent({ type: "tool.started", toolCallId: "read-1", name: "read" });
  ui.controller.applyEvent({ type: "tool.finished", toolCallId: "read-1", name: "read", status: "success", content: "line one\nline two" });
  await ui.settle();
  expect(ui.hint()).toContain("Ctrl+F find · Alt+I inspect · Ctrl+O tools · / commands");
  const entry = ui.controller.snapshot().transcript.find(item => item.kind === "tool")!;
  const label = () => (ui.renderer.root.findDescendantById(`message-${entry.id}`)!.getChildren()[0] as TextRenderable).plainText;
  expect(label()).toContain("▸");
  ui.mockInput.pressKey("o", { ctrl: true });
  await ui.settle();
  expect(label()).toContain("▾");
});

test("a failed turn without tool rows drops Ctrl+O tools", async () => {
  // The no-color catalog screen: a turn whose model fails every retry, rendered at 120 columns.
  const ui = await setup({ model: createScriptedModel({ responses: Array.from({ length: 3 }, () => ({ error: "Service unavailable", status: 503 })) }),
    agentClock: { now: () => 0, sleep: async () => {} } }, 120);
  await ui.controller.submit("Explain the build");
  await ui.controller.waitForIdle();
  await ui.settle();
  expect(ui.controller.snapshot().transcript.some(item => item.kind === "error")).toBe(true);
  expect(ui.hint()).toContain("Ctrl+R continue · F2 details · Shift+Tab change mode · Ctrl+F find · Alt+I inspect · / commands");
  expect(ui.hint()).not.toContain("Ctrl+O tools");
});

test("an inline diff alone does not offer Ctrl+O tools", async () => {
  const ui = await setup();
  ui.session.append({ type: "assistant", id: "calls", content: [{ type: "tool_call", id: "edit-1", name: "edit", arguments: { path: "file.ts" } }] });
  ui.controller.applyEvent({ type: "tool.started", toolCallId: "edit-1", name: "edit" });
  ui.controller.applyEvent({ type: "tool.finished", toolCallId: "edit-1", name: "edit", status: "success", content: "Applied",
    details: { path: "file.ts", hunks: [{ startLine: 2, oldText: "old", newText: "new" }] } });
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("2 │+new");
  expect(ui.hint()).not.toContain("Ctrl+O tools");
});
