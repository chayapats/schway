import { expect, test } from "bun:test";
import { createContextManager } from "../src/context/manager.ts";
import { TuiController } from "../src/tui/controller.ts";
import { createSession } from "../src/session/session.ts";
import type { ConversationItem } from "../src/conversation/types.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { withTempDir } from "./helpers.ts";
import { createJsonlSession, loadJsonlSession } from "../src/session/jsonl.ts";
import { join } from "node:path";
import { mkdir, mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createTestRenderer } from "@opentui/core/testing";
import { createConversationView } from "../src/tui/view.ts";
import type { Model } from "../src/model/model.ts";
import { getEffectiveConversation, getEffectiveSummary, SUMMARY_SYSTEM_PROMPT } from "../src/context/compaction.ts";
import { shortenEarlierTurnToolResults } from "../src/context/replay.ts";
import { estimateSessionTokens, estimateTextTokens } from "../src/context/tokens.ts";
import { activityDetail } from "../src/tui/presentation.ts";
import { loadConfigEditor } from "../src/config/editing.ts";
import { handleSlashCommand } from "../src/tui/app.ts";
import { formatInvariantFailure, screenInvariantFailures } from "./helpers/screen-invariants.ts";

function history(count = 8): ConversationItem[] {
  return Array.from({ length: count }, (_, i) => [
    { type: "user" as const, id: `u${i}`, content: [{ type: "text" as const, text: `original ${i}` }] },
    { type: "assistant" as const, id: `a${i}`, content: [{ type: "text" as const, text: `answer ${i}` }] },
  ]).flat();
}

test("manual summary failure is failed, preserves history, and permits retry", async () => {
  await withTempDir(async home => {
    const workspace = { root: home, launchCwd: home, extraRoots: [] };
    const session = createSession(history());
    const controller = new TuiController({ session, workspace, sessionId: "failure", provider: "scripted", modelId: "scripted",
      model: createScriptedModel({ responses: [{ error: "summary unavailable" }, { text: "summary" }] }),
      contextManager: createContextManager(workspace, { home, keepTurns: 2 }) });
    expect(await controller.compact()).toBe(false);
    expect(session.items).toEqual(history());
    expect(controller.snapshot().transcript.at(-1)?.text).toContain("failed");
    expect(controller.inspectNoticeDetails()).toBe(true);
    expect(controller.snapshot().transcript.at(-1)?.text).toContain("/compact");
    expect(controller.running).toBe(false);
    expect(await controller.compact()).toBe(true);
    controller.dispose();
  });
});

test("persisted summary write failure requires explicit resume before compaction can recover", async () => {
  await withTempDir(async home => {
    const workspace = { root: home, launchCwd: home, extraRoots: [] };
    const directory = join(home, "sessions");
    const session = await createJsonlSession({ directory, workspace });
    session.append(...history(12));
    const path = join(directory, `${session.header.id}.jsonl`);
    const saved = `${path}.saved`;
    const durable = await readFile(path, "utf8");
    const controller = new TuiController({ session, workspace, sessionId: session.header.id, provider: "scripted", modelId: "scripted",
      model: createScriptedModel({ responses: [{ text: "first summary" }, { text: "retry summary" }, { text: "recovered summary" }] }),
      contextManager: createContextManager(workspace, { home, keepTurns: 2 }) });
    await rename(path, saved);
    await mkdir(path);
    expect(await controller.compact()).toBe(false);
    expect(controller.snapshot().transcript.at(-1)?.text).toBe("Compaction failed · F2 repair details");
    expect(controller.snapshot().transcript.map(row => row.text).join("\n")).not.toContain("EISDIR");
    expect(controller.inspectNoticeDetails()).toBe(true);
    expect(controller.snapshot().transcript.at(-1)?.text).toContain(`/resume ${session.header.id}`);
    expect(session.items).toEqual(history(12));
    await rm(path, { recursive: true });
    await rename(saved, path);
    expect(await controller.compact()).toBe(false); // Restoring storage does not un-fence the old handle.
    expect(await readFile(path, "utf8")).toBe(durable);
    const config = await loadConfigEditor({ home, workspaceRoot: home });
    expect(await handleSlashCommand("resume", session.header.id, {
      controller, home, workspaceRoot: home, skillScope: { workspaceRoot: home }, sessionsDir: directory,
      settings: () => config.settings, env: {}, secrets: [], finishQuit: () => {}, stderr: { write: () => {} },
    })).toBe(true);
    expect(await controller.compact()).toBe(true);
    const resumed = await loadJsonlSession({ directory, id: session.header.id });
    expect(resumed.items.filter(item => item.type !== "compaction")).toEqual(history(12));
    expect(resumed.items.filter(item => item.type === "compaction")).toHaveLength(1);
    expect(controller.running).toBe(false);
    controller.dispose();
  });
});

test("selected-model context keeps unknowns, separates reported usage and follows capacity changes", async () => {
  await withTempDir(async home => {
    const workspace = { root: home, launchCwd: home, extraRoots: [] };
    const controller = new TuiController({ session: createSession(history()), workspace, sessionId: "estimate", provider: "scripted", modelId: "custom",
      model: createScriptedModel(), contextManager: createContextManager(workspace, { home }) });
    expect(controller.snapshot().context).toMatchObject({ capacity: null, providerUsage: null });
    expect(controller.describeContext()).toContain("excludes system prompt");
    expect(controller.describeContext()).toContain("input unknown (cached unknown), output unknown (reasoning unknown)");
    controller.applyEvent({ type: "model.usage", phase: "turn", usage: { inputTokens: 42, outputTokens: null }, complete: true });
    expect(controller.describeContext()).toContain("input 42 (cached unknown), output unknown (reasoning unknown)");
    controller.applyEvent({ type: "model.usage", phase: "turn", usage: { inputTokens: 1200, outputTokens: 40, cachedInputTokens: 1024, reasoningTokens: 0 }, complete: true });
    expect(controller.describeContext()).toContain("input 1200 (cached 1024), output 40 (reasoning 0). Not a billing total");
    controller.applyEvent({ type: "model.usage", phase: "turn", usage: { inputTokens: 1200, outputTokens: 40, cachedInputTokens: null, reasoningTokens: 30 }, complete: true });
    expect(controller.describeContext()).toContain("input 1200 (cached unknown), output 40 (reasoning 30)");
    controller.setModel(createScriptedModel(), "openai", "gpt-5.4");
    expect(controller.snapshot().context.capacity).toBe(256_000);
    expect(controller.snapshot().context.providerUsage).toBeNull();
    controller.setModel(createScriptedModel(), "openai-compatible", "gpt-4o");
    expect(controller.snapshot().context.capacity).toBe(128_000);
    controller.dispose();
  });
});

test("a long earlier-turn tool result lowers the context meter on the next turn", async () => {
  await withTempDir(async home => {
    const workspace = { root: home, launchCwd: home, extraRoots: [] };
    const big = "x".repeat(20_000);
    const session = createSession([
      { type: "user", id: "u0", content: [{ type: "text", text: "read the log" }] },
      { type: "assistant", id: "a0", content: [{ type: "tool_call", id: "c0", name: "read", arguments: { path: "log" } }] },
      { type: "tool_result", id: "r0", toolCallId: "c0", content: big, isError: false },
    ]);
    const controller = new TuiController({ session, workspace, sessionId: "meter", provider: "scripted", modelId: "custom",
      model: createScriptedModel(), contextManager: createContextManager(workspace, { home }) });
    const meter = () => {
      const items = session.items;
      const summary = estimateTextTokens(getEffectiveSummary(items) ?? "");
      return {
        shown: controller.snapshot().context.estimatedTokens,
        full: estimateSessionTokens(getEffectiveConversation(items)) + summary,
        shortened: estimateSessionTokens(shortenEarlierTurnToolResults(getEffectiveConversation(items))) + summary,
      };
    };
    // The turn in progress stays full, so a long result there does not lower the meter.
    const current = meter();
    expect(current.shown).toBe(current.full);
    expect(current.shown).toBe(current.shortened);
    session.append({ type: "user", id: "u1", content: [{ type: "text", text: "what changed" }] });
    const next = meter();
    expect(next.shortened).toBeLessThan(next.full);
    expect(next.shown).toBe(next.shortened);
    expect(controller.describeContext()).toContain(`Estimated conversation + summary: ~${next.shortened} tokens`);
    session.append({ type: "assistant", id: "a1", content: [{ type: "tool_call", id: "c1", name: "read", arguments: { path: "log" } }] });
    const beforeResult = meter().shown;
    const inProgress = { type: "tool_result" as const, id: "r1", toolCallId: "c1", content: big, isError: false };
    session.append(inProgress);
    const during = meter();
    expect(during.shown).toBe(during.shortened);
    expect(during.shown - beforeResult).toBe(estimateSessionTokens([inProgress]));
    controller.dispose();
  });
});

test("advertised reasoning support alone never turns fallback capacity into known context", async () => {
  await withTempDir(async home => {
    const workspace = { root: home, launchCwd: home, extraRoots: [] };
    const configEditor = await loadConfigEditor({ home, workspaceRoot: home, cli: { provider: "openai", model: "account-model", openaiAuth: "codex" } });
    configEditor.setModelCapabilities([{ id: "account-model", supportedThinking: ["high"] }]);
    const controller = new TuiController({ session: createSession(), workspace, configEditor, sessionId: "capability", provider: "openai", modelId: "account-model",
      model: createScriptedModel({ provider: "codex-subscription" }), contextManager: createContextManager(workspace, { home }) });
    expect(controller.snapshot().context.capacity).toBeNull();
    configEditor.setModelCapabilities([{ id: "account-model", supportedThinking: ["high"], contextWindow: 150_000 }]);
    expect(controller.snapshot().context.capacity).toBe(150_000);
    controller.dispose();
  });
});

test("overflow compaction and retry remain visible through the real controller loop", async () => {
  await withTempDir(async home => {
    const workspace = { root: home, launchCwd: home, extraRoots: [] };
    const controller = new TuiController({ session: createSession(history()), workspace, sessionId: "overflow", provider: "scripted", modelId: "scripted",
      model: createScriptedModel({ responses: [{ error: "prompt is too long: 213418 tokens > 200000 maximum", status: 400 }, { text: "older goals" }, { text: "continued after overflow" }] }),
      contextManager: createContextManager(workspace, { home, keepTurns: 2 }) });
    await controller.submit("continue");
    const rows = controller.snapshot().transcript.map(row => row.text);
    expect(rows.join("\n")).not.toContain("Esc stop");
    expect(rows.filter(text => text === "Context compacted · /context inspect summary")).toHaveLength(1);
    expect(rows.join("\n")).toContain("continued after overflow");
    expect(rows.filter(text => text === "original 0")).toHaveLength(1);
    expect(controller.snapshot().context.summaryId).toBeDefined();
    expect(controller.snapshot().outcome?.reason).toBe("completed");
    controller.dispose();
  });
});

test("an interrupted summary stream cannot commit partial text as a successful summary", async () => {
  await withTempDir(async home => {
    const workspace = { root: home, launchCwd: home, extraRoots: [] };
    const session = createSession(history());
    const controller = new TuiController({ session, workspace, sessionId: "partial", provider: "scripted", modelId: "scripted",
      model: { provider: "scripted", id: "scripted", async *stream() { yield { type: "text_delta", text: "unfinished summary" }; } },
      contextManager: createContextManager(workspace, { home, keepTurns: 2 }) });
    expect(await controller.compact()).toBe(false);
    expect(controller.snapshot().transcript.at(-1)?.text).toBe("Compaction failed · F2 repair details");
    expect(session.items).toEqual(history());
    controller.dispose();
  });
});

test("manual compaction, readonly inspection, branch switching and disk resume preserve original history", async () => {
  await withTempDir(async home => {
    const workspace = { root: home, launchCwd: home, extraRoots: [] };
    const directory = join(home, "sessions");
    const session = await createJsonlSession({ directory, workspace });
    session.append(...history());
    const primary = session.activeBranchId;
    const sibling = session.forkBranch(session.entries.at(-1)!.item.id, "sibling");
    session.selectBranch(primary);
    let calls = 0;
    const model: Model = { provider: "scripted", id: "scripted", async *stream() { calls++; yield { type: "message_complete", message: { type: "assistant", id: "summary", content: [{ type: "text", text: "remember older work" }] } }; } };
    const manager = createContextManager(workspace, { home, keepTurns: 2 });
    const controller = new TuiController({ session, workspace, sessionId: session.header.id, provider: "scripted", modelId: "scripted", model, contextManager: manager });
    expect(await controller.compact()).toBe(true);
    const estimated = controller.snapshot().context;
    expect(estimated.firstKeptId).toBe("u6");
    const texts = controller.snapshot().transcript.map(row => row.text);
    expect(texts.filter(text => text === "original 0")).toHaveLength(1);
    expect(texts.findIndex(text => text.includes("Active summary boundary"))).toBe(texts.indexOf("original 6") - 1);
    const file = join(directory, `${session.header.id}.jsonl`);
    const before = await readFile(file, "utf8");
    for (let i = 0; i < 5; i++) { controller.snapshot(); expect(controller.describeContext()).toContain("remember older work"); }
    expect(await readFile(file, "utf8")).toBe(before);
    expect(calls).toBe(1);
    expect(session.activeBranchId).toBe(primary);
    expect(controller.branchCommand(`switch ${sibling}`)).toBe(true);
    expect(controller.snapshot().context.summaryId).toBeUndefined();
    expect(controller.snapshot().context.estimatedTokens).toBeGreaterThan(estimated.estimatedTokens);
    const resumedSibling = await loadJsonlSession({ directory, id: session.header.id });
    expect(resumedSibling.items.some(item => item.type === "compaction")).toBe(false);
    expect(controller.branchCommand(`switch ${primary}`)).toBe(true);
    const resumed = await loadJsonlSession({ directory, id: session.header.id });
    const next = new TuiController({ session: resumed, workspace, sessionId: session.header.id, provider: "scripted", modelId: "scripted", model, contextManager: manager });
    expect(next.snapshot().context).toEqual(estimated);
    expect(next.snapshot().transcript.filter(row => row.text === "original 0")).toHaveLength(1);
    const prepared = await manager.prepare(resumed);
    expect(prepared.items.map(item => item.id)).toEqual(["u6", "a6", "u7", "a7"]);
    expect(calls).toBe(1);
    next.dispose(); controller.dispose();
  });
});

test("actual pressure loop distinguishes failed summarization from no-op and continues the task", async () => {
  await withTempDir(async home => {
    const workspace = { root: home, launchCwd: home, extraRoots: [] };
    const session = createSession(history());
    const wait = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const scripted = createScriptedModel({ responses: [request => { expect(request.systemPrompt).toBe(SUMMARY_SYSTEM_PROMPT); return { error: "summary unavailable" }; }, { text: "task continued" }] });
    const controller = new TuiController({ session, workspace, sessionId: "pressure", provider: "scripted", modelId: "scripted",
      model: { ...scripted, async *stream(request) { if (request.systemPrompt !== SUMMARY_SYSTEM_PROMPT) { started.resolve(); await wait.promise; } yield* scripted.stream(request); } },
      contextManager: createContextManager(workspace, { home, keepTurns: 2, contextWindow: 1 }) });
    const task = controller.submit("continue");
    await started.promise;
    expect(activityDetail(controller.snapshot().activity!)).toContain("Compaction failed");
    expect(controller.snapshot().activity?.phase).toBe("waiting");
    wait.resolve();
    await task;
    const transcript = controller.snapshot().transcript.map(row => row.text).join("\n");
    expect(transcript).not.toContain("Esc stop");
    expect(transcript.split("Compaction failed · F2 repair details")).toHaveLength(2);
    expect(transcript).not.toContain("After a storage failure");
    expect(controller.inspectNoticeDetails()).toBe(true);
    expect(controller.snapshot().transcript.at(-1)?.text).toContain("After a storage failure");
    expect(transcript).toContain("task continued");
    expect(session.items.some(item => item.type === "compaction")).toBe(false);
    controller.dispose();
  });
});

test("manual cancellation reports cancelled and no-op is distinct", async () => {
  await withTempDir(async home => {
    const workspace = { root: home, launchCwd: home, extraRoots: [] };
    const session = createSession(history());
    let started!: () => void;
    const wait = new Promise<void>(resolve => { started = resolve; });
    const model: Model = { provider: "scripted", id: "scripted", async *stream(request) { started(); await new Promise<void>(resolve => request.signal!.addEventListener("abort", () => resolve(), { once: true })); yield { type: "text_delta", text: "late partial summary" }; } };
    const controller = new TuiController({ session, workspace, sessionId: "cancel", provider: "scripted", modelId: "scripted", model, contextManager: createContextManager(workspace, { home, keepTurns: 2 }) });
    const pending = controller.compact(); await wait; controller.cancel(); await pending;
    expect(controller.snapshot().transcript.at(-1)?.text).toBe("Compaction cancelled · /compact retry");
    expect(session.items).toEqual(history());
    controller.replaceSession(createSession(), "empty", { contextManager: createContextManager(workspace, { home }) });
    expect(await controller.compact()).toBe(false);
    expect(controller.snapshot().transcript.map(row => row.text)).toEqual(["Context unchanged · /compact retry after more turns"]);
    controller.dispose();
  });
});

test("manual summary persistence failure settles controller and preserves durable history", async () => {
  await withTempDir(async home => {
    const workspace = { root: home, launchCwd: home, extraRoots: [] };
    const session = createSession(history(), [], { writeOperation: () => { throw new Error("disk full"); } });
    const controller = new TuiController({ session, workspace, sessionId: "persistence", provider: "scripted", modelId: "scripted",
      model: createScriptedModel({ text: "summary" }), contextManager: createContextManager(workspace, { home, keepTurns: 2 }) });
    expect(await controller.compact()).toBe(false);
    expect(session.items).toEqual(history());
    expect(controller.running).toBe(false);
    expect(controller.snapshot().transcript.at(-1)?.text).toContain("failed");
    controller.dispose();
  });
});

/** A controller painted by the real view, so assertions see the same frame a user sees. */
async function renderedCompaction(options: { session: ReturnType<typeof createSession>; model: Model; contextWindow?: number }) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "compaction-end-")));
  const workspace = { root: home, launchCwd: home, extraRoots: [] };
  const controller = new TuiController({ session: options.session, workspace, sessionId: "end-state", provider: "scripted", modelId: "scripted", model: options.model,
    contextManager: createContextManager(workspace, { home, keepTurns: 2, ...(options.contextWindow ? { contextWindow: options.contextWindow } : {}) }) });
  const terminal = await createTestRenderer({ width: 120, height: 60 });
  const view = createConversationView(terminal.renderer, { controller, home, workspaceRoot: home, env: { NO_COLOR: "1" }, secrets: [], motion: "off", quit() {}, submit: async () => false });
  const settle = async () => { await Bun.sleep(2); view.refresh(); await terminal.flush(); };
  const waitFor = async (ready: () => boolean) => {
    const start = performance.now();
    while (!ready()) { if (performance.now() - start > 5000) throw new Error(`Timed out\n${terminal.captureCharFrame()}`); await settle(); }
  };
  await settle();
  return {
    controller, settle, waitFor, pressEscape: () => terminal.mockInput.pressEscape(),
    /** Settle the view, then return the idle frame after asserting no row still offers the compaction stop. */
    settledFrame: async () => {
      await settle(); await settle();
      const snapshot = controller.snapshot();
      expect(snapshot.status).not.toBe("running");
      expect(snapshot.activity).toBeUndefined();
      expect(snapshot.transcript.filter(row => row.text.includes("Esc stop"))).toEqual([]);
      const frame = terminal.captureCharFrame();
      expect(frame).not.toContain("Esc stop");
      // The same frame passes the catalog's I3 invariant: nothing offers a stop while nothing runs (#304).
      const text = frame.split("\n");
      const golden = { screen: "compaction-end", title: "", description: "", variant: "nocolor-dark-120", cols: 120, rows: text.length, text, styles: [], cursor: { x: 1, y: 1, visible: false } };
      expect(snapshot.readiness).not.toBe("loading");
      expect(screenInvariantFailures(golden, { panel: "", idle: true }).map(formatInvariantFailure)).toEqual([]);
      return frame;
    },
    dispose: async () => { view.destroy(); controller.dispose(); terminal.renderer.destroy(); await controller.waitForIdle(); await rm(home, { recursive: true, force: true }); },
  };
}
const occurrences = (frame: string, text: string) => frame.split(text).length - 1;
/** A summary request that stays open until Esc aborts it, after announcing that compaction is underway. */
function abortableSummary(next?: Model) {
  const started = Promise.withResolvers<void>();
  const model: Model = { provider: "scripted", id: "scripted", async *stream(request) {
    if (request.systemPrompt !== SUMMARY_SYSTEM_PROMPT && next) { yield* next.stream(request); return; }
    started.resolve();
    await new Promise<void>(resolve => request.signal!.addEventListener("abort", () => resolve(), { once: true }));
    request.signal!.throwIfAborted();
  } };
  return { model, started: started.promise };
}

for (const [label, model, session, result] of [
  ["completed", () => createScriptedModel({ text: "remember older work" }), () => createSession(history()), "Context compacted · /context inspect summary"],
  ["failed", () => createScriptedModel({ error: "summary unavailable" }), () => createSession(history()), "Compaction failed · F2 repair details"],
  ["no-op", () => createScriptedModel({ text: "unused" }), () => createSession(history(1)), "Context unchanged · /compact retry after more turns"],
] as const) test(`manual compaction ${label} leaves one result row and no stale stop action`, async () => {
  const ui = await renderedCompaction({ session: session(), model: model() });
  try {
    const pending = ui.controller.compact();
    await ui.settle();
    await pending;
    const frame = await ui.settledFrame();
    expect(occurrences(frame, result)).toBe(1);
    expect(ui.controller.snapshot().transcript.filter(row => row.text === result)).toHaveLength(1);
    expect(frame).not.toContain("Compacting");
  } finally { await ui.dispose(); }
});

test("manual compaction stopped with Esc reports one cancelled result in the transcript and frees the activity row", async () => {
  const summary = abortableSummary();
  const ui = await renderedCompaction({ session: createSession(history()), model: summary.model });
  try {
    const pending = ui.controller.compact();
    await summary.started;
    await ui.waitFor(() => ui.controller.snapshot().activity?.phase === "compacting");
    // While running, only live surfaces name the stop action; the transcript has no progress row.
    expect(ui.controller.snapshot().transcript.some(row => row.text.includes("Compacting") || row.text.includes("Esc stop"))).toBe(false);
    ui.pressEscape();
    await pending;
    const frame = await ui.settledFrame();
    expect(occurrences(frame, "Compaction cancelled · /compact retry")).toBe(1);
    expect(ui.controller.snapshot().transcript.at(-1)?.text).toBe("Compaction cancelled · /compact retry");
  } finally { await ui.dispose(); }
});

test("pressure compaction inside a turn leaves its result once and no stale stop action after the turn completes", async () => {
  const ui = await renderedCompaction({ session: createSession(history()), contextWindow: 1,
    model: createScriptedModel({ responses: [{ text: "remember older work" }, { text: "task continued" }] }) });
  try {
    await ui.controller.submit("continue");
    const frame = await ui.settledFrame();
    expect(occurrences(frame, "Context compacted · /context inspect summary")).toBe(1);
    expect(frame).toContain("task continued");
    expect(ui.controller.snapshot().outcome?.reason).toBe("completed");
  } finally { await ui.dispose(); }
});

test("stopping a turn during pressure compaction shows one stopped result whose next action is Ctrl+R continue", async () => {
  const summary = abortableSummary(createScriptedModel({ text: "unused" }));
  const ui = await renderedCompaction({ session: createSession(history()), contextWindow: 1, model: summary.model });
  try {
    const pending = ui.controller.submit("continue");
    await summary.started;
    await ui.waitFor(() => ui.controller.snapshot().activity?.phase === "compacting");
    expect(ui.controller.snapshot().transcript.some(row => row.text.includes("Esc stop"))).toBe(false);
    ui.pressEscape();
    await pending;
    const frame = await ui.settledFrame();
    const rows = ui.controller.snapshot().transcript.map(row => row.text);
    expect(rows.filter(text => text.startsWith("Stopped"))).toEqual(["Stopped · Completed results kept\nCtrl+R continue · Esc keep editing"]);
    expect(occurrences(frame, "Ctrl+R continue")).toBe(1);
    expect(frame).not.toContain("/compact retry");
    expect(rows.some(text => text.startsWith("Compaction cancelled"))).toBe(false);
    expect(ui.controller.snapshot().outcome?.reason).toBe("cancelled");
  } finally { await ui.dispose(); }
});

test("overflow compaction leaves its result once and no stale stop action after the retried turn completes", async () => {
  const ui = await renderedCompaction({ session: createSession(history()),
    model: createScriptedModel({ responses: [{ error: "prompt is too long: 213418 tokens > 200000 maximum", status: 400 }, { text: "older goals" }, { text: "continued after overflow" }] }) });
  try {
    await ui.controller.submit("continue");
    const frame = await ui.settledFrame();
    expect(occurrences(frame, "Context compacted · /context inspect summary")).toBe(1);
    expect(frame).toContain("continued after overflow");
  } finally { await ui.dispose(); }
});

test("stopping a turn during overflow compaction also shows only the stopped result", async () => {
  const overflow = createScriptedModel({ error: "prompt is too long: 213418 tokens > 200000 maximum", status: 400 });
  const summary = abortableSummary(overflow);
  const ui = await renderedCompaction({ session: createSession(history()), model: summary.model });
  try {
    const pending = ui.controller.submit("continue");
    await summary.started;
    await ui.waitFor(() => ui.controller.snapshot().activity?.phase === "compacting");
    ui.pressEscape();
    await pending;
    const frame = await ui.settledFrame();
    const rows = ui.controller.snapshot().transcript.map(row => row.text);
    expect(rows.filter(text => text.startsWith("Stopped"))).toEqual(["Stopped · Completed results kept\nCtrl+R continue · Esc keep editing"]);
    expect(frame).not.toContain("/compact retry");
    expect(rows.some(text => text.startsWith("Compaction"))).toBe(false);
  } finally { await ui.dispose(); }
});
