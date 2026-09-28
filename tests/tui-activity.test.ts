import { expect, test } from "bun:test";
import { createContextManager } from "../src/context/manager.ts";
import type { Model, ModelRequest } from "../src/model/model.ts";
import { createSession } from "../src/session/session.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import type { ToolDefinition } from "../src/tools/types.ts";
import { TuiController } from "../src/tui/controller.ts";
import { statusPill } from "../src/tui/presentation.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { withTempDir } from "./helpers.ts";

class Gate {
  private release!: () => void;
  readonly promise = new Promise<void>(resolve => { this.release = resolve; });
  open(): void { this.release(); }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("activity did not reach expected phase");
}

test("preparation, quiet provider wait, streaming and cancellation keep one operation visible", async () => {
  await withTempDir(async dir => {
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const base = createContextManager(workspace);
    const prepare = new Gate();
    const first = new Gate();
    const finish = new Gate();
    let now = 1_000;
    const model: Model = {
      provider: "scripted", id: "gated",
      async *stream(request: ModelRequest) {
        await first.promise;
        yield { type: "text_delta", text: "partial answer" };
        await finish.promise;
        if (request.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        yield { type: "message_complete", message: { type: "assistant", id: "a1", content: [{ type: "text", text: "partial answer" }] } };
      },
    };
    const controller = new TuiController({
      session: createSession(), model, contextManager: { ...base, prepare: async (...args) => { await prepare.promise; return base.prepare(...args); } },
      workspace, provider: "scripted", modelId: "gated", sessionId: "activity", activityClock: () => now,
    });
    const task = controller.submit("work");
    expect(controller.snapshot().activity?.phase).toBe("preparing");
    now = 4_000;
    expect(controller.snapshot().activity?.elapsedMs).toBe(3_000);
    now = 3_000;
    expect(controller.snapshot().activity?.elapsedMs).toBe(3_000);
    prepare.open();
    await until(() => controller.snapshot().activity?.phase === "waiting");
    expect(statusPill(controller.snapshot()).label).toContain("WAITING");
    first.open();
    await until(() => controller.snapshot().activity?.phase === "streaming");
    expect(controller.snapshot().transcript.some(entry => entry.text.includes("partial answer"))).toBe(true);
    controller.cancel();
    controller.cancel();
    expect(controller.snapshot().activity).toMatchObject({ phase: "stopping", cancellation: "requested" });
    controller.acknowledgeCancellationFrame(controller.snapshot().activity!.operationId);
    expect(controller.snapshot().activity?.cancellation).toBe("settling");
    expect(controller.snapshot().status).toBe("running");
    finish.open();
    await task;
    expect(controller.snapshot().activity).toBeUndefined();
    expect(controller.snapshot().status).toBe("idle");
    expect(controller.snapshot().transcript.some(entry => entry.text.includes("partial answer"))).toBe(true);
  });
});

test("cancel during a quiet first-token wait keeps the turn owned until provider settlement", async () => {
  await withTempDir(async dir => {
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const first = new Gate();
    const model: Model = {
      provider: "scripted", id: "quiet",
      async *stream(request) {
        await first.promise;
        if (request.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        yield { type: "text_delta", text: "too late" };
      },
    };
    const controller = new TuiController({
      session: createSession(), model, contextManager: createContextManager(workspace), workspace,
      provider: "scripted", modelId: "quiet", sessionId: "quiet",
    });
    const task = controller.submit("wait for first token");
    await until(() => controller.snapshot().activity?.phase === "waiting");
    expect(controller.snapshot().transcript.some(entry => entry.kind === "assistant")).toBe(false);
    controller.cancel();
    expect(statusPill(controller.snapshot()).label).toBe("CANCEL REQUESTED");
    expect(controller.snapshot().activity?.cancellation).toBe("requested");
    controller.acknowledgeCancellationFrame(controller.snapshot().activity!.operationId);
    expect(statusPill(controller.snapshot()).label).toContain("STOPPING");
    expect(controller.snapshot().activity?.cancellation).toBe("settling");
    expect(controller.snapshot().status).toBe("running");
    first.open();
    await task;
    expect(controller.snapshot().activity).toBeUndefined();
    expect(controller.snapshot().status).toBe("idle");
    expect(controller.snapshot().transcript.some(entry => entry.kind === "assistant")).toBe(false);
    expect(controller.snapshot().transcript.some(entry => entry.text === "Cancelled.")).toBe(true);
  });
});

test("retry countdown uses the emitted delay and injected clock, then clears on next attempt", async () => {
  await withTempDir(async dir => {
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const wake = new Gate();
    const second = new Gate();
    let now = 10_000;
    const scripted = createScriptedModel({ responses: [{ error: "busy", status: 503, headers: { "Retry-After": "3" } }, { text: "done" }] });
    let attempts = 0;
    const model: Model = { ...scripted, async *stream(request) { attempts++; if (attempts === 2) await second.promise; yield* scripted.stream(request); } };
    const controller = new TuiController({
      session: createSession(), model, contextManager: createContextManager(workspace), workspace,
      provider: "scripted", modelId: "retry", sessionId: "retry", activityClock: () => now,
      agentClock: { now: () => now, sleep: async () => { await wake.promise; } },
    });
    const task = controller.submit("retry");
    await until(() => controller.snapshot().activity?.phase === "retry");
    expect(controller.snapshot().activity?.retry).toMatchObject({ failedAttempt: 1, maxAttempts: 3, remainingMs: 3_000 });
    now += 1_200;
    expect(controller.snapshot().activity?.retry?.remainingMs).toBe(1_800);
    expect(statusPill(controller.snapshot()).label).toBe("RETRY 2/3 · 2s");
    wake.open();
    await until(() => controller.snapshot().activity?.phase === "waiting");
    expect(controller.snapshot().activity?.retry).toBeUndefined();
    second.open();
    await task;
    expect(controller.snapshot().status).toBe("idle");
  });
});

test("cancel during retry backoff replaces countdown with stopping and prevents another attempt", async () => {
  await withTempDir(async dir => {
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    let attempts = 0;
    const scripted = createScriptedModel({ responses: [{ error: "busy", status: 503 }, { text: "must not run" }] });
    const model: Model = { ...scripted, async *stream(request) { attempts++; yield* scripted.stream(request); } };
    const settlement = new Gate();
    const controller = new TuiController({
      session: createSession(), model, contextManager: createContextManager(workspace), workspace,
      provider: "scripted", modelId: "backoff", sessionId: "backoff", activityClock: () => 0,
      agentClock: { now: () => 0, sleep: (_ms, signal) => new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => { void settlement.promise.then(() => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))); }, { once: true });
      }) },
    });
    const task = controller.submit("retry then cancel");
    await until(() => controller.snapshot().activity?.phase === "retry");
    expect(attempts).toBe(1);
    controller.cancel();
    expect(controller.snapshot().activity).toMatchObject({ phase: "stopping", cancellation: "requested" });
    controller.acknowledgeCancellationFrame(controller.snapshot().activity!.operationId);
    expect(controller.snapshot().activity?.cancellation).toBe("settling");
    expect(controller.snapshot().activity?.retry).toBeUndefined();
    settlement.open();
    await task;
    expect(attempts).toBe(1);
    expect(controller.snapshot().status).toBe("idle");
  });
});

test("manual compaction reports stopping until the owned operation settles", async () => {
  await withTempDir(async dir => {
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const base = createContextManager(workspace);
    const gate = new Gate();
    const controller = new TuiController({
      session: createSession(), model: createScriptedModel({ text: "summary" }),
      contextManager: { ...base, compact: async () => { await gate.promise; return null; } },
      workspace, provider: "scripted", modelId: "compact", sessionId: "compact",
    });
    const task = controller.compact();
    expect(controller.snapshot().activity?.phase).toBe("compacting");
    controller.cancel();
    controller.cancel();
    expect(controller.snapshot().activity).toMatchObject({ phase: "stopping", cancellation: "requested" });
    controller.acknowledgeCancellationFrame(controller.snapshot().activity!.operationId);
    expect(controller.snapshot().activity?.cancellation).toBe("settling");
    expect(controller.snapshot().status).toBe("running");
    gate.open();
    expect(await task).toBe(false);
    expect(controller.snapshot().activity).toBeUndefined();
    expect(controller.snapshot().status).toBe("idle");
  });
});

test("cancel during parallel tools retains settled results and stale completion cannot settle a new operation", async () => {
  await withTempDir(async dir => {
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const a = new Gate();
    const b = new Gate();
    const tool: ToolDefinition<{ key: string }> = {
      name: "probe", description: "gated fixture", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] }, execution: "parallel",
      async execute(input) { await (input.key === "a" ? a : b).promise; return { content: input.key }; },
    };
    const controller = new TuiController({
      session: createSession(), model: createScriptedModel({ responses: [
        { toolCalls: [{ id: "a", name: "probe", arguments: { key: "a" } }, { id: "b", name: "probe", arguments: { key: "b" } }] },
        { waitForAbort: true, text: "unused" },
      ] }), contextManager: createContextManager(workspace), workspace, tools: createToolRegistry([tool]),
      provider: "scripted", modelId: "tools", sessionId: "tools", maxConcurrentTools: 2,
    });
    const first = controller.submit("tools");
    await until(() => controller.snapshot().activity?.activeTools === 2);
    const oldId = controller.snapshot().activity!.operationId;
    expect(controller.snapshot().activity?.phase).toBe("tools");
    a.open();
    await until(() => controller.snapshot().activity?.activeTools === 1);
    expect(controller.snapshot().status).toBe("running");
    controller.cancel();
    expect(controller.snapshot().activity).toMatchObject({ phase: "stopping", activeTools: 1, cancellation: "requested" });
    controller.acknowledgeCancellationFrame(controller.snapshot().activity!.operationId);
    expect(controller.snapshot().activity?.cancellation).toBe("settling");
    b.open();
    await first;
    expect(controller.snapshot().transcript.find(entry => entry.toolCallId === "a")?.toolStatus).toBe("success");
    expect(controller.snapshot().status).toBe("idle");
    const second = controller.submit("second");
    await until(() => controller.snapshot().activity?.phase === "streaming");
    controller.applyEvent({ type: "agent.finished", reason: "completed" }, oldId);
    expect(controller.snapshot().status).toBe("running");
    expect(controller.snapshot().activity?.operationId).not.toBe(oldId);
    controller.cancel();
    await second;
  });
});
