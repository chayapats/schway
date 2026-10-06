import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent } from "../src/agent/events.ts";
import { runAgentLoop } from "../src/agent/loop.ts";
import { streamModelTurn, type AgentClock, type ModelTurnOutcome } from "../src/agent/retry.ts";
import { scheduleToolCalls } from "../src/agent/scheduler.ts";
import { createContextManager } from "../src/context/manager.ts";
import type { AssistantMessage, ToolCallContent } from "../src/conversation/types.ts";
import { createHistoryCollector, historyTurnIdentity } from "../src/history/collector.ts";
import { openHistoryStore } from "../src/history/store.ts";
import { createHistoryTelemetryFold } from "../src/history/telemetry.ts";
import type { Model, ModelRequest, ModelStreamEvent } from "../src/model/model.ts";
import { createJsonlSession, sessionsDirectory } from "../src/session/jsonl.ts";
import { createSession } from "../src/session/session.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import type { ToolDefinition } from "../src/tools/types.ts";
import type { Workspace } from "../src/workspace/workspace.ts";

const WALL = Date.parse("2026-01-15T09:30:00.000Z");
const iso = (ms: number) => new Date(WALL + ms).toISOString();

/** Fake clock whose sleeps advance time at once, for sequential model attempts. */
function steppedClock() {
  let t = 0;
  const clock: AgentClock = { now: () => WALL + t, monotonicNow: () => t, sleep: async ms => { t += ms; } };
  return { clock, advance: (ms: number) => { t += ms; }, now: () => t };
}

/** Fake timer clock: sleeps wait until `run` advances time to their deadline, so concurrent work overlaps exactly. */
function timerClock() {
  let t = 0;
  const timers: Array<{ at: number; resolve: () => void }> = [];
  const clock: AgentClock = {
    now: () => WALL + t,
    monotonicNow: () => t,
    sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(Object.assign(new Error("aborted"), { name: "AbortError" })); return; }
      timers.push({ at: t + ms, resolve });
    }),
  };
  const settle = async () => { for (let index = 0; index < 20; index++) await new Promise(resolve => setImmediate(resolve)); };
  /** Drive pending timers in deadline order until `work` settles. */
  async function run<T>(work: Promise<T>): Promise<T> {
    let done = false;
    void work.then(() => { done = true; }, () => { done = true; });
    while (true) {
      await settle();
      // Real I/O, such as context preparation, may still be pending; wait for it before advancing fake time.
      for (let waits = 0; !done && !timers.length && waits < 400; waits++) await new Promise(resolve => setTimeout(resolve, 5));
      if (done) return work;
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift();
      if (!next) throw new Error("Work is blocked with no pending timer");
      t = next.at;
      next.resolve();
    }
  }
  return { clock, run };
}

type Step = { advance?: number; event?: ModelStreamEvent; fail?: Error; waitForAbort?: true };

/** Model whose attempts advance the fake clock between scripted stream events. */
function timedModel(advance: (ms: number) => void, attempts: Step[][]): Model {
  let index = 0;
  return {
    provider: "scripted", id: "timed",
    async *stream(request: ModelRequest) {
      const steps = attempts[index++] ?? [];
      for (const step of steps) {
        if (step.advance) advance(step.advance);
        if (step.waitForAbort) {
          await new Promise<void>(resolve => request.signal?.aborted ? resolve() : request.signal?.addEventListener("abort", () => resolve(), { once: true }));
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }
        if (step.fail) throw step.fail;
        if (step.event) yield step.event;
      }
    },
  };
}

const message = (content: AssistantMessage["content"]): ModelStreamEvent => ({ type: "message_complete", message: { type: "assistant", id: crypto.randomUUID(), content } });

async function drain(generator: AsyncGenerator<RuntimeEvent, ModelTurnOutcome>): Promise<{ events: RuntimeEvent[]; outcome: ModelTurnOutcome }> {
  const events: RuntimeEvent[] = [];
  while (true) {
    const next = await generator.next();
    if (next.done) return { events, outcome: next.value };
    events.push(next.value);
  }
}

test("a timed model attempt records exact first-output, attempt and total times on the event and the message", async () => {
  const { clock, advance } = steppedClock();
  const model = timedModel(advance, [[
    { advance: 150, event: { type: "thinking_delta", text: "Plan" } },
    { advance: 50, event: { type: "text_delta", text: "Hi" } },
    { advance: 300, event: { type: "usage", usage: { inputTokens: 1200, outputTokens: 40, cachedInputTokens: 1024, reasoningTokens: 30 } } },
    { event: message([{ type: "text", text: "Hi" }]) },
  ]]);
  const { events, outcome } = await drain(streamModelTurn({ model, request: { systemPrompt: "", context: [], items: [] }, clock }));
  expect(events.filter(event => event.type === "model.usage")).toEqual([{ type: "model.usage", phase: "turn", complete: true, startedAt: iso(0), firstDeltaMs: 150, attemptMs: 500,
    usage: { inputTokens: 1200, outputTokens: 40, cachedInputTokens: 1024, reasoningTokens: 30 } }]);
  if (outcome.kind !== "complete") throw new Error("expected completion");
  expect(outcome.message.telemetry).toEqual({ startedAt: iso(0), firstDeltaMs: 150, attemptMs: 500, totalMs: 500, attempts: 1, retryWaitMs: 0,
    usage: { inputTokens: 1200, outputTokens: 40, cachedInputTokens: 1024, reasoningTokens: 30 } });
  expect(outcome.message.providerMetadata).toBeUndefined();
});

test("one transient failure then success records two attempts and the slept backoff", async () => {
  const { clock, advance } = steppedClock();
  const unavailable = Object.assign(new Error("Service unavailable"), { status: 503 });
  const model = timedModel(advance, [
    [{ advance: 200, event: { type: "text_delta", text: "par" } }, { advance: 20, fail: unavailable }],
    [{ advance: 100, event: { type: "text_delta", text: "Done" } }, { advance: 400, event: message([{ type: "text", text: "Done" }]) }],
  ]);
  const { events, outcome } = await drain(streamModelTurn({ model, request: { systemPrompt: "", context: [], items: [] }, clock }));
  const retry = events.find(event => event.type === "model.retry");
  expect(retry).toMatchObject({ attempt: 1, delayMs: 1000 });
  expect(events.filter(event => event.type === "model.usage")).toEqual([
    { type: "model.usage", phase: "turn", complete: false, startedAt: iso(0), firstDeltaMs: 200, attemptMs: 220, usage: { inputTokens: null, outputTokens: null } },
    { type: "model.usage", phase: "turn", complete: true, startedAt: iso(1220), firstDeltaMs: 100, attemptMs: 500, usage: { inputTokens: null, outputTokens: null } },
  ]);
  if (outcome.kind !== "complete") throw new Error("expected completion");
  expect(outcome.message.telemetry).toEqual({ startedAt: iso(0), firstDeltaMs: 100, attemptMs: 500, totalMs: 1720, attempts: 2, retryWaitMs: 1000,
    usage: { inputTokens: null, outputTokens: null } });
  const fold = createHistoryTelemetryFold();
  for (const event of events) fold.observe(event);
  expect(fold.summary()).toMatchObject({ modelCalls: 2, modelMs: 720, retries: 1, retryWaitMs: 1000, firstDelta: { minMs: 100, maxMs: 200, calls: 2 } });
});

test("a tool-call-only response with no deltas records a null first-output time, never the completion time", async () => {
  const { clock, advance } = steppedClock();
  const model = timedModel(advance, [[{ advance: 900, event: message([{ type: "tool_call", id: "call_1", name: "read", arguments: { path: "a" } }]) }]]);
  const { events, outcome } = await drain(streamModelTurn({ model, request: { systemPrompt: "", context: [], items: [] }, clock }));
  expect(events.find(event => event.type === "model.usage")).toMatchObject({ firstDeltaMs: null, attemptMs: 900 });
  if (outcome.kind !== "complete") throw new Error("expected completion");
  expect(outcome.message.telemetry).toMatchObject({ firstDeltaMs: null, attemptMs: 900, totalMs: 900 });
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

test("a cancelled attempt persists no assistant telemetry but still counts in the sidecar model time", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "schway-telemetry-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, "home"), root = join(dir, "work");
  await mkdir(root, { recursive: true });
  const workspace: Workspace = { root, launchCwd: root, extraRoots: [] };
  const session = await createJsonlSession({ directory: sessionsDirectory(home), workspace });
  session.append({ type: "user", id: crypto.randomUUID(), content: [{ type: "text", text: "Explain slowly" }] });
  const { clock, advance } = steppedClock();
  const model = timedModel(advance, [[{ advance: 250, event: { type: "text_delta", text: "Think" } }, { advance: 750, waitForAbort: true }]]);
  const collector = createHistoryCollector({ store: openHistoryStore({ home }), identity: historyTurnIdentity(session, root, "headless")!, now: () => new Date(WALL) });
  await collector.start();
  const abort = new AbortController();
  for await (const event of runAgentLoop({ session, model, contextManager: createContextManager(workspace), workspace, signal: abort.signal, clock })) {
    collector.observe(event);
    if (event.type === "model.delta") abort.abort();
  }
  expect(session.items.some(item => item.type === "assistant")).toBe(false);
  await collector.finalize({ observation: { status: "unavailable", reason: "headless" } });
  const read = await openHistoryStore({ home }).read(session.rootId);
  expect(read.finalizes[0]!.outcome).toBe("stopped");
  expect(read.finalizes[0]!.telemetry).toMatchObject({ modelCalls: 1, modelMs: 1000, firstDelta: { minMs: 250, maxMs: 250, calls: 1 }, retries: 0, toolCalls: 0, toolMs: 0 });
});

/** Tool that sleeps on the fake clock for `ms`. */
function sleeper(name: string, execution: "parallel" | "exclusive", effect: "read-only" | "mutating", clock: AgentClock, ms: number): ToolDefinition {
  return { name, description: name, inputSchema: { type: "object", properties: {} }, execution, effect,
    async execute(_input, ctx) { await clock.sleep(ms, ctx.signal); return { content: `${name} done` }; } };
}

const call = (id: string, name: string): ToolCallContent => ({ type: "tool_call", id, name, arguments: {} });

test("parallel read-only calls and an exclusive command record exact durations, and tool time is their union", async () => {
  const { clock, run } = timerClock();
  const registry = createToolRegistry([sleeper("slow_read", "parallel", "read-only", clock, 300), sleeper("quick_read", "parallel", "read-only", clock, 100),
    sleeper("command", "exclusive", "mutating", clock, 200)]);
  const workspace: Workspace = { root: "/tmp", launchCwd: "/tmp", extraRoots: [] };
  const events: RuntimeEvent[] = [];
  const executed = await run((async () => {
    const generator = scheduleToolCalls({ calls: [call("a", "slow_read"), call("b", "quick_read"), call("c", "command")], registry, workspace, clock });
    while (true) {
      const next = await generator.next();
      if (next.done) return next.value;
      events.push(next.value);
    }
  })());
  expect(executed.map(item => item.result.telemetry)).toEqual([
    { startedAt: iso(0), durationMs: 300 },
    { startedAt: iso(0), durationMs: 100 },
    { startedAt: iso(300), durationMs: 200 },
  ]);
  const finished = events.filter(event => event.type === "tool.finished");
  expect(finished.map(event => [event.toolCallId, event.durationMs, event.startedAt, event.approvalWaitMs])).toEqual([
    ["b", 100, iso(0), undefined], ["a", 300, iso(0), undefined], ["c", 200, iso(300), undefined]]);
  const fold = createHistoryTelemetryFold();
  for (const event of events) fold.observe(event);
  // The sum of durations is 600 ms; overlapping reads count once.
  expect(fold.summary()).toMatchObject({ toolCalls: 3, toolMs: 500, approvalWaitMs: 0 });
});

test("an ask-mode approval wait is reported apart from execution time", async () => {
  const { clock, run } = timerClock();
  const registry = createToolRegistry([sleeper("command", "exclusive", "mutating", clock, 50)]);
  const workspace: Workspace = { root: "/tmp", launchCwd: "/tmp", extraRoots: [] };
  const events: RuntimeEvent[] = [];
  const executed = await run((async () => {
    const generator = scheduleToolCalls({ calls: [call("c", "command")], registry, workspace, clock,
      approval: { interactive: true, mode: () => "ask", ask: async (_request, signal) => { await clock.sleep(700, signal); return { kind: "allow" }; } } });
    while (true) {
      const next = await generator.next();
      if (next.done) return next.value;
      events.push(next.value);
    }
  })());
  expect(executed[0]!.result.telemetry).toEqual({ startedAt: iso(0), durationMs: 750, approvalWaitMs: 700 });
  expect(events.find(event => event.type === "tool.finished")).toMatchObject({ durationMs: 750, approvalWaitMs: 700 });
  const fold = createHistoryTelemetryFold();
  for (const event of events) fold.observe(event);
  expect(fold.summary()).toMatchObject({ toolCalls: 1, toolMs: 750, approvalWaitMs: 700 });
});

test("results that never ran carry no telemetry instead of a fabricated zero", async () => {
  const { clock, run } = timerClock();
  const registry = createToolRegistry([sleeper("command", "exclusive", "mutating", clock, 50)]);
  const workspace: Workspace = { root: "/tmp", launchCwd: "/tmp", extraRoots: [] };
  const invalid: ToolCallContent = { type: "tool_call", id: "bad", name: "command", arguments: "not an object" };
  const events: RuntimeEvent[] = [];
  const executed = await run((async () => {
    const generator = scheduleToolCalls({ calls: [call("u", "missing_tool"), invalid], registry, workspace, clock });
    while (true) {
      const next = await generator.next();
      if (next.done) return next.value;
      events.push(next.value);
    }
  })());
  expect(executed.map(item => [item.status, item.result.telemetry])).toEqual([["error", undefined], ["error", undefined]]);
  expect(events.filter(event => event.type === "tool.finished").every(event => event.durationMs === undefined && event.startedAt === undefined)).toBe(true);
  const aborted = new AbortController();
  aborted.abort();
  const cancelled = await run((async () => {
    const generator = scheduleToolCalls({ calls: [call("c", "command")], registry, workspace, clock, signal: aborted.signal });
    while (true) { const next = await generator.next(); if (next.done) return next.value; }
  })());
  expect([cancelled[0]!.status, cancelled[0]!.result.telemetry]).toEqual(["cancelled", undefined]);
});

test("the agent loop persists assistant and tool telemetry measured with its clock", async () => {
  const { clock, run } = timerClock();
  const session = createSession([{ type: "user", id: "u1", content: [{ type: "text", text: "Go" }] }]);
  const workspace: Workspace = { root: "/tmp", launchCwd: "/tmp", extraRoots: [] };
  const model: Model = { provider: "scripted", id: "timed", async *stream() {
    await clock.sleep(40);
    if (!session.items.some(item => item.type === "tool_result")) { yield message([{ type: "tool_call", id: "call_1", name: "slow_read", arguments: {} }]); return; }
    yield { type: "text_delta", text: "Done" };
    await clock.sleep(10);
    yield message([{ type: "text", text: "Done" }]);
  } };
  await run((async () => {
    for await (const _ of runAgentLoop({ session, model, contextManager: createContextManager(workspace), workspace, clock,
      tools: createToolRegistry([sleeper("slow_read", "parallel", "read-only", clock, 300)]) })) { /* drain */ }
  })());
  const [first, result, second] = session.items.slice(1);
  expect(first).toMatchObject({ type: "assistant", telemetry: { startedAt: iso(0), firstDeltaMs: null, attemptMs: 40, totalMs: 40, attempts: 1, retryWaitMs: 0 } });
  expect(result).toMatchObject({ type: "tool_result", telemetry: { startedAt: iso(40), durationMs: 300 } });
  expect(second).toMatchObject({ type: "assistant", telemetry: { startedAt: iso(340), firstDeltaMs: 40, attemptMs: 50, totalMs: 50 } });
});
