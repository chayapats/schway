import { expect, test } from "bun:test";
import { createContextManager } from "../src/context/manager.ts";
import { createJsonlSession, loadJsonlSession } from "../src/session/jsonl.ts";
import { createSession } from "../src/session/session.ts";
import { TuiController, buildTranscriptFromSession } from "../src/tui/controller.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { withTempDir } from "./helpers.ts";
import { join } from "node:path";
import { createToolRegistry } from "../src/tools/registry.ts";
import type { ToolDefinition } from "../src/tools/types.ts";

test("a partial failed attempt is absent from the accepted live and resumed answer", async () => {
  await withTempDir(async dir => {
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const sessions = join(dir, "sessions");
    const session = await createJsonlSession({ directory: sessions, workspace });
    const controller = new TuiController({
      session,
      model: createScriptedModel({ responses: [
        { chunks: ["Hel"], error: "overloaded", status: 503, throwAfter: "chunks" },
        { chunks: ["Hello world"] },
      ] }),
      contextManager: createContextManager(workspace), workspace,
      provider: "scripted", modelId: "retry", sessionId: "retry",
      agentClock: { now: () => 0, sleep: async () => {} },
    });
    expect(await controller.submit("hello")).toBe(true);
    const live = controller.snapshot().transcript.filter(entry => entry.kind === "assistant").map(entry => entry.text);
    const loaded = await loadJsonlSession({ directory: sessions, id: session.header.id });
    const resumed = buildTranscriptFromSession(loaded.items).filter(entry => entry.kind === "assistant").map(entry => entry.text);
    expect(live).toEqual(["Hello world"]);
    expect(resumed).toEqual(live);
    expect(session.items.filter(item => item.type === "assistant")).toHaveLength(1);
    controller.dispose();
  });
});

test("exhausted partial attempts leave one labelled preview and a recovery error", async () => {
  await withTempDir(async dir => {
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const session = createSession();
    const controller = new TuiController({
      session,
      model: createScriptedModel({ responses: ["one", "two", "three"].map(text => ({
        chunks: [text], error: "overloaded", status: 503, throwAfter: "chunks" as const,
      })) }),
      contextManager: createContextManager(workspace), workspace,
      provider: "scripted", modelId: "retry", sessionId: "exhausted",
      agentClock: { now: () => 0, sleep: async () => {} },
    });
    await controller.submit("hello");
    const transcript = controller.snapshot().transcript;
    expect(transcript.filter(entry => entry.kind === "assistant")).toMatchObject([{ text: "three", incomplete: true }]);
    expect(transcript.filter(entry => entry.kind === "system" && entry.text.includes("Retrying"))).toHaveLength(0);
    expect(transcript.find(entry => entry.kind === "error")?.text).toContain("continue this session");
    expect(session.items.filter(item => item.type === "assistant")).toHaveLength(0);
    controller.dispose();
  });
});

test("cancellation during a partial stream labels only an unsaved preview", async () => {
  await withTempDir(async dir => {
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const session = createSession();
    const controller = new TuiController({
      session,
      model: createScriptedModel({ chunks: ["Hel"], waitForAbort: true }),
      contextManager: createContextManager(workspace), workspace,
      provider: "scripted", modelId: "cancel", sessionId: "cancel",
    });
    const task = controller.submit("hello");
    for (let i = 0; i < 100 && !controller.snapshot().transcript.some(entry => entry.kind === "assistant"); i++) await Bun.sleep(1);
    expect(controller.snapshot().transcript.some(entry => entry.text === "Hel")).toBe(true);
    controller.cancel();
    await task;
    expect(controller.snapshot().transcript.filter(entry => entry.kind === "assistant")).toMatchObject([{ text: "Hel", incomplete: true }]);
    expect(session.items.filter(item => item.type === "assistant")).toHaveLength(0);
    controller.dispose();
  });
});

test("cancellation during retry backoff does not start a new attempt", async () => {
  await withTempDir(async dir => {
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const session = createSession();
    let attempts = 0;
    const scripted = createScriptedModel({ responses: [
      { chunks: ["Hel"], error: "overloaded", status: 503, throwAfter: "chunks" },
      { text: "should not run" },
    ] });
    const controller = new TuiController({
      session,
      model: { ...scripted, async *stream(request) { attempts++; yield* scripted.stream(request); } },
      contextManager: createContextManager(workspace), workspace,
      provider: "scripted", modelId: "backoff", sessionId: "backoff",
      agentClock: { now: () => 0, sleep: (_ms, signal) => new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      }) },
    });
    const task = controller.submit("hello");
    for (let i = 0; i < 100 && controller.snapshot().activity?.phase !== "retry"; i++) await Bun.sleep(1);
    expect(controller.snapshot().activity?.phase).toBe("retry");
    controller.cancel();
    await task;
    expect(attempts).toBe(1);
    expect(controller.snapshot().transcript.filter(entry => entry.kind === "assistant")).toMatchObject([{ text: "Hel", incomplete: true }]);
    expect(session.items.filter(item => item.type === "assistant")).toHaveLength(0);
    controller.dispose();
  });
});

test("overflow recovery keeps accepted tool results once and drops the failed preview", async () => {
  await withTempDir(async dir => {
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const session = createSession();
    for (let i = 0; i < 12; i++) {
      session.append({ type: "user", id: `u${i}`, content: [{ type: "text", text: `Earlier step ${i}` }] });
      session.append({ type: "assistant", id: `a${i}`, content: [{ type: "text", text: `Done ${i}` }] });
    }
    let executions = 0;
    const tool: ToolDefinition = {
      name: "count", description: "Count an accepted call", inputSchema: { type: "object" }, execution: "parallel",
      async execute() { executions++; return { content: "counted" }; },
    };
    const summary = [
      "## Goal", "finish turn", "## Constraints", "keep tool results", "## Progress", "counted once",
      "## Key Decisions", "continue", "## Current State", "recovering", "## Next Steps", "answer",
      "## Files", "### Read", "none", "### Modified", "none",
    ].join("\n");
    const controller = new TuiController({
      session,
      model: createScriptedModel({ responses: [
        { toolCalls: [{ id: "call-1", name: "count", arguments: {} }] },
        { chunks: ["Old prefix"], error: "context length exceeded", status: 400, code: "context_length_exceeded", throwAfter: "chunks" },
        { text: summary },
        { text: "Recovered answer" },
      ] }),
      contextManager: createContextManager(workspace, { keepTurns: 10 }),
      tools: createToolRegistry([tool]), workspace,
      provider: "scripted", modelId: "overflow", sessionId: "overflow",
    });
    await controller.submit("finish");
    expect(executions).toBe(1);
    expect(session.items.filter(item => item.type === "tool_result" && item.toolCallId === "call-1")).toHaveLength(1);
    expect(session.items.filter(item => item.type === "compaction")).toHaveLength(1);
    expect(controller.snapshot().transcript.filter(entry => entry.kind === "assistant").at(-1)?.text).toBe("Recovered answer");
    expect(JSON.stringify(controller.snapshot().transcript)).not.toContain("Old prefix");
    expect(JSON.stringify(session.items)).not.toContain("Old prefix");
    controller.dispose();
  });
});
