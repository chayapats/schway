import { expect, test } from "bun:test";
import { createContextManager } from "../src/context/manager.ts";
import { TuiController } from "../src/tui/controller.ts";
import { createSession } from "../src/session/session.ts";
import type { SessionRecord } from "../src/conversation/types.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { withTempDir } from "./helpers.ts";
import { createJsonlSession, loadJsonlSession } from "../src/session/jsonl.ts";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { Model } from "../src/model/model.ts";
import { SUMMARY_SYSTEM_PROMPT } from "../src/context/compaction.ts";
import { activityDetail } from "../src/tui/presentation.ts";
import { loadConfigEditor } from "../src/config/editing.ts";

function history(): SessionRecord[] {
  return Array.from({ length: 8 }, (_, i) => [
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
    expect(controller.snapshot().transcript.at(-1)?.text).toContain("/compact");
    expect(controller.running).toBe(false);
    expect(await controller.compact()).toBe(true);
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
    expect(controller.describeContext()).toContain("input unknown, output unknown");
    controller.applyEvent({ type: "model.usage", phase: "turn", usage: { inputTokens: 42, outputTokens: null }, complete: true });
    expect(controller.describeContext()).toContain("input 42, output unknown");
    controller.setModel(createScriptedModel(), "openai", "gpt-5.4");
    expect(controller.snapshot().context.capacity).toBe(256_000);
    expect(controller.snapshot().context.providerUsage).toBeNull();
    controller.setModel(createScriptedModel(), "anthropic", "claude-sonnet-4-6");
    expect(controller.snapshot().context.capacity).toBe(200_000);
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
    expect(rows.join("\n")).toContain("Context overflow");
    expect(rows.join("\n")).toContain("Context compacted");
    expect(rows.join("\n")).toContain("continued after overflow");
    expect(rows.filter(text => text === "original 0")).toHaveLength(1);
    expect(controller.snapshot().context.summaryId).toBeDefined();
    expect(controller.snapshot().compactionNotice).toBeUndefined();
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
    expect(controller.snapshot().compactionNotice).toContain("failed");
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
    expect(transcript).toContain("Context pressure");
    expect(transcript).toContain("Compaction failed");
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
    expect(controller.snapshot().compactionNotice).toContain("cancelled");
    expect(session.items).toEqual(history());
    controller.replaceSession(createSession(), "empty", { contextManager: createContextManager(workspace, { home }) });
    expect(await controller.compact()).toBe(false);
    expect(controller.snapshot().compactionNotice).toContain("no-op");
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
