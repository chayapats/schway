import { expect, test } from "bun:test";
import { join } from "node:path";
import { runAgentLoop } from "../src/agent/loop.ts";
import { createContextManager } from "../src/context/manager.ts";
import { SUMMARY_SYSTEM_PROMPT } from "../src/context/compaction.ts";
import { createEvalMetrics } from "../src/eval/metrics.ts";
import type {
  AssistantMessage,
  UserMessage,
} from "../src/conversation/types.ts";
import type { Model } from "../src/model/model.ts";
import {
  createJsonlSession,
  loadJsonlSession,
} from "../src/session/jsonl.ts";
import { createSession } from "../src/session/session.ts";
import { withTempDir } from "./helpers.ts";
import { collect, createScriptedModel } from "./helpers/scripted-model.ts";

const workspace = {
  root: "/tmp/project",
  launchCwd: "/tmp/project",
  extraRoots: [] as string[],
};

/** Build N complete user/assistant turns for compaction tests. */
function turns(count: number): Array<UserMessage | AssistantMessage> {
  const items: Array<UserMessage | AssistantMessage> = [];
  for (let i = 0; i < count; i++) {
    items.push({
      type: "user",
      id: `u${i}`,
      content: [{ type: "text", text: `goal step ${i}` }],
    });
    items.push({
      type: "assistant",
      id: `a${i}`,
      content: [{ type: "text", text: `progress ${i}` }],
    });
  }
  return items;
}

const CODING_SUMMARY = [
  "## Goal",
  "ship compaction",
  "## Constraints",
  "keep history",
  "## Progress",
  "did turns",
  "## Key Decisions",
  "keep recent",
  "## Current State",
  "compacting",
  "## Next Steps",
  "resume",
  "## Files",
  "### Read",
  "src/a.ts",
  "### Modified",
  "src/b.ts",
].join("\n");

test("pressure summarization and the completed turn both contribute usage once", async () => {
  const session = createSession([...turns(3), { type: "user", id: "last", content: [{ type: "text", text: "continue" }] }]);
  const tracker = createEvalMetrics(session);
  const model: Model = { provider: "scripted", id: "usage-fixture", async *stream(request) {
    const summary = request.systemPrompt === SUMMARY_SYSTEM_PROMPT;
    yield { type: "usage", usage: { inputTokens: summary ? 9 : 13, outputTokens: summary ? 4 : 6 } };
    yield { type: "message_complete", message: { type: "assistant", id: crypto.randomUUID(), content: [{ type: "text", text: summary ? CODING_SUMMARY : "ok" }] } };
  } };
  const events = await collect(runAgentLoop({ session, model, contextManager: createContextManager(workspace, { contextWindow: 1, keepTurns: 1 }) }));
  events.forEach(tracker.record);
  expect(events.filter(event => event.type === "model.usage")).toEqual([
    { type: "model.usage", phase: "compaction", usage: { inputTokens: 9, outputTokens: 4 }, complete: true },
    { type: "model.usage", phase: "turn", usage: { inputTokens: 13, outputTokens: 6 }, complete: true, startedAt: expect.any(String), firstDeltaMs: null, attemptMs: expect.any(Number) },
  ]);
  expect(tracker.result().inputTokens).toBe(22);
  expect(tracker.result().outputTokens).toBe(10);
  expect(tracker.result().compactions).toBe(1);
});

test("manual compaction preserves raw history and uses summary plus retained records", async () => {
  const session = createSession(turns(12));
  const before = session.items.length;
  const manager = createContextManager(workspace);
  const summarizer = createScriptedModel({ text: CODING_SUMMARY });

  const record = await manager.compact(session, summarizer, {
    reason: "manual",
  });

  expect(record).not.toBeNull();
  expect(record?.summary).toBe(CODING_SUMMARY);
  expect(typeof record?.id).toBe("string");
  expect(typeof record?.firstKeptId).toBe("string");
  // Raw history is preserved; the record is appended.
  expect(session.items.length).toBe(before + 1);
  expect(session.items.slice(0, before)).toEqual(turns(12));

  const prepared = await manager.prepare(session);
  const summarySection = prepared.context.find(
    (section) => section.name === "summary",
  );
  expect(summarySection?.content).toBe(CODING_SUMMARY);
  // Retained recent records only, never the full raw history.
  expect(prepared.items.length).toBeLessThan(before);
  expect(prepared.items.length).toBeGreaterThan(0);
});

test("summary stream throwing after message_complete still reports an incomplete attempt", async () => {
  const session = createSession(turns(12));
  const manager = createContextManager(workspace);
  const model: Model = { provider: "scripted", id: "interrupted-summary", async *stream() {
    yield { type: "usage", usage: { inputTokens: 3, outputTokens: 2 } };
    yield { type: "message_complete", message: { type: "assistant", id: "summary", content: [{ type: "text", text: CODING_SUMMARY }] } };
    throw new Error("transport dropped after completion event");
  } };
  expect(await manager.compact(session, model, { reason: "manual" })).toBeNull();
  expect(manager.takeUsage()).toEqual([{ usage: { inputTokens: 3, outputTokens: 2 }, complete: false }]);
});

test("failed summarization leaves history intact without a misleading record", async () => {
  const session = createSession(turns(12));
  const before = session.items.length;
  const manager = createContextManager(workspace);
  const failing = createScriptedModel({
    error: "summarizer overloaded",
    status: 503,
  });

  const record = await manager.compact(session, failing, { reason: "manual" });

  expect(record).toBeNull();
  expect(session.items.length).toBe(before);
  expect(session.items).toEqual(turns(12));
  const prepared = await manager.prepare(session);
  expect(
    prepared.context.some((section) => section.name === "summary"),
  ).toBe(false);
  expect(prepared.items.length).toBe(before);
});

test("cancelled summarization leaves prior usable context intact", async () => {
  const session = createSession(turns(12));
  const before = session.items.length;
  const manager = createContextManager(workspace);
  const controller = new AbortController();
  controller.abort();
  const summarizer = createScriptedModel({ text: CODING_SUMMARY });

  const record = await manager.compact(session, summarizer, {
    reason: "manual",
    signal: controller.signal,
  });

  expect(record).toBeNull();
  expect(session.items.length).toBe(before);
  const prepared = await manager.prepare(session);
  expect(prepared.items.length).toBe(before);
});

test("compaction never splits a tool-call/result group", async () => {
  const session = createSession([
    {
      type: "user",
      id: "u0",
      content: [{ type: "text", text: "read files" }],
    },
    {
      type: "assistant",
      id: "a0",
      content: [
        { type: "tool_call", id: "call-1", name: "read", arguments: { path: "a.txt" } },
        { type: "tool_call", id: "call-2", name: "read", arguments: { path: "b.txt" } },
      ],
    },
    {
      type: "tool_result",
      id: "r1",
      toolCallId: "call-1",
      content: "alpha",
      isError: false,
    },
    {
      type: "tool_result",
      id: "r2",
      toolCallId: "call-2",
      content: "beta",
      isError: false,
    },
    ...turns(11).map((item, index) => ({
      ...item,
      id: `${item.id}-tail${index}`,
    })),
  ]);
  const manager = createContextManager(workspace, { keepTurns: 10 });
  const summarizer = createScriptedModel({ text: CODING_SUMMARY });

  const record = await manager.compact(session, summarizer, { reason: "manual" });

  expect(record).not.toBeNull();
  const prepared = await manager.prepare(session);
  const ids = new Set(prepared.items.map((item) => item.id));
  // Both sibling results stay together: never keep one without the other.
  expect(ids.has("r1")).toBe(ids.has("r2"));
  // The boundary lands on a user turn, so the first retained item is a user message.
  expect(prepared.items[0]?.type).toBe("user");
});

test("pressure triggers compaction from model-aware token budgets", async () => {
  const session = createSession(turns(12));
  // Tiny window forces pressure: 12 small turns exceed 80% of 100 tokens.
  const manager = createContextManager(workspace, { contextWindow: 100 });
  const summarizer = createScriptedModel({ text: CODING_SUMMARY });

  const prepared = await manager.prepare(session, summarizer);

  expect(prepared.compaction).toBeDefined();
  expect(prepared.compaction?.summary).toBe(CODING_SUMMARY);
  expect(session.items.length).toBe(turns(12).length + 1);
  const summarySection = prepared.context.find((s) => s.name === "summary");
  expect(summarySection?.content).toBe(CODING_SUMMARY);
  expect(prepared.items.length).toBeLessThan(turns(12).length);
});

test("unknown models use conservative defaults for pressure budgets", async () => {
  const big = (id: string) => ({
    type: "user" as const,
    id,
    content: [{ type: "text" as const, text: `x`.repeat(10_000) }],
  });
  const items = [];
  for (let i = 0; i < 12; i++) {
    items.push(big(`u${i}`));
    items.push({
      type: "assistant" as const,
      id: `a${i}`,
      content: [{ type: "text" as const, text: `y`.repeat(10_000) }],
    });
  }
  const session = createSession(items);
  const manager = createContextManager(workspace);
  const unknown = createScriptedModel({
    provider: "custom",
    id: "huge-model-xyz",
    text: CODING_SUMMARY,
  });

  const prepared = await manager.prepare(session, unknown);

  // 12 x 20k chars ~= 60k tokens > 80% of the 32k unknown default.
  expect(prepared.compaction).toBeDefined();
  expect(prepared.context.find((s) => s.name === "summary")?.content).toBe(
    CODING_SUMMARY,
  );
});

test("oversized tool output is pruned only for summarization input", async () => {
  const huge = `z`.repeat(20_000);
  const session = createSession([
    {
      type: "user",
      id: "u0",
      content: [{ type: "text", text: "run" }],
    },
    {
      type: "assistant",
      id: "a0",
      content: [
        { type: "tool_call", id: "call-big", name: "bash", arguments: {} },
      ],
    },
    {
      type: "tool_result",
      id: "r-big",
      toolCallId: "call-big",
      content: huge,
      isError: false,
    },
    ...turns(11).map((item, index) => ({
      ...item,
      id: `${item.id}-tail${index}`,
    })),
  ]);
  let summarizerInput = "";
  const capturing = createScriptedModel({
    responses: [
      (request) => {
        summarizerInput = JSON.stringify(request.items);
        return { text: CODING_SUMMARY };
      },
    ],
  });
  const manager = createContextManager(workspace, { keepTurns: 10 });

  const record = await manager.compact(session, capturing, { reason: "manual" });

  expect(record).not.toBeNull();
  // Summarizer saw a truncated copy.
  expect(summarizerInput.includes(huge)).toBe(false);
  expect(summarizerInput.includes("[truncated for summarization]")).toBe(true);
  // Original history is untouched.
  const stored = session.items.find((item) => item.id === "r-big");
  expect(stored?.type).toBe("tool_result");
  if (stored?.type === "tool_result") {
    expect(stored.content).toBe(huge);
  }
});

test("repeated compaction chains summaries and advances the retained window", async () => {
  const session = createSession(turns(12));
  const manager = createContextManager(workspace, { keepTurns: 10 });
  const firstSummary = `${CODING_SUMMARY}\nfirst`;
  const secondSummary = `${CODING_SUMMARY}\nsecond`;
  let secondInput = "";
  const first = createScriptedModel({ text: firstSummary });
  const second = createScriptedModel({
    responses: [
      (request) => {
        secondInput = JSON.stringify(request.items);
        return { text: secondSummary };
      },
    ],
  });

  const one = await manager.compact(session, first, { reason: "manual" });
  expect(one).not.toBeNull();
  const firstKept = one?.firstKeptId;

  // New work arrives after the first compaction.
  session.append(
    { type: "user", id: "u-new", content: [{ type: "text", text: "more" }] },
    { type: "assistant", id: "a-new", content: [{ type: "text", text: "done" }] },
  );
  const two = await manager.compact(session, second, { reason: "manual" });

  expect(two).not.toBeNull();
  expect(two?.firstKeptId).not.toBe(firstKept);
  // Parent linkage chains the second record to the first.
  expect(one?.parentCompactionId).toBeUndefined();
  expect(two?.parentCompactionId).toBe(one?.id);
  // The second summary input built on the first summary.
  expect(secondInput.includes("first")).toBe(true);
  const prepared = await manager.prepare(session);
  expect(prepared.context.find((s) => s.name === "summary")?.content).toBe(
    secondSummary,
  );
});

test("resumed sessions reconstruct the same summary plus retained records", async () => {
  await withTempDir(async (dir) => {
    const sessions = join(dir, "sessions");
    const project = { root: dir, launchCwd: dir, extraRoots: [] as string[] };
    const session = await createJsonlSession({ directory: sessions, workspace: project });
    for (const item of turns(12)) {
      session.append(item);
    }
    const manager = createContextManager(project, { keepTurns: 10 });
    const summarizer = createScriptedModel({ text: CODING_SUMMARY });

    const record = await manager.compact(session, summarizer, { reason: "manual" });
    expect(record).not.toBeNull();
    const before = await manager.prepare(session);

    const loaded = await loadJsonlSession({ directory: sessions, id: session.header.id });
    const after = await createContextManager(project).prepare(loaded);

    expect(after.context.find((s) => s.name === "summary")?.content).toBe(
      before.context.find((s) => s.name === "summary")?.content,
    );
    expect(after.items.map((item) => item.id)).toEqual(
      before.items.map((item) => item.id),
    );
    // Raw history survived the round trip, including the compaction marker.
    expect(loaded.items.length).toBe(turns(12).length + 1);
    const persisted = loaded.items.find((item) => item.type === "compaction");
    expect(persisted?.type).toBe("compaction");
    if (persisted?.type === "compaction" && record) {
      expect(persisted.summary).toBe(CODING_SUMMARY);
      expect(persisted.firstKeptId).toBe(record?.firstKeptId);
    }
    // A second compaction after resume chains to the reloaded record.
    loaded.append(
      { type: "user", id: "u-post", content: [{ type: "text", text: "more" }] },
      { type: "assistant", id: "a-post", content: [{ type: "text", text: "done" }] },
    );
    const chained = await createContextManager(project).compact(
      loaded,
      createScriptedModel({ text: `${CODING_SUMMARY}\nchained` }),
      { reason: "manual" },
    );
    expect(chained?.parentCompactionId).toBe(record?.id);
  });
});

test("pressure compaction runs inside the real loop before the first turn", async () => {
  const session = createSession(turns(12));
  const manager = createContextManager(workspace, { contextWindow: 100 });
  const model = createScriptedModel({
    responses: [{ text: CODING_SUMMARY }, { text: "done" }],
  });

  const events = await collect(
    runAgentLoop({ session, model, contextManager: manager }),
  );

  expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
  expect(
    events.filter((e) => e.type === "compaction.started").length,
  ).toBeGreaterThan(0);
  expect(session.items.some((item) => item.type === "compaction")).toBe(true);
});

test("pressure compaction starts before the summary wait and finishes after it", async () => {
  const session = createSession(turns(12));
  const manager = createContextManager(workspace, { contextWindow: 100 });
  const scripted = createScriptedModel({ responses: [{ text: CODING_SUMMARY }, { text: "done" }] });
  let releaseSummary!: () => void;
  const summaryGate = new Promise<void>(resolve => { releaseSummary = resolve; });
  let summaryStarted!: () => void;
  const started = new Promise<void>(resolve => { summaryStarted = resolve; });
  let calls = 0;
  const model = { ...scripted, async *stream(request: Parameters<typeof scripted.stream>[0]) {
    if (++calls === 1) { summaryStarted(); await summaryGate; }
    yield* scripted.stream(request);
  } };
  const events = runAgentLoop({ session, model, contextManager: manager });
  expect((await events.next()).value).toEqual({ type: "agent.started" });
  expect((await events.next()).value).toEqual({ type: "compaction.started", reason: "pressure" });
  const next = events.next();
  await started;
  let finished = false;
  void next.then(() => { finished = true; });
  await Promise.resolve();
  expect(finished).toBe(false);
  releaseSummary();
  expect((await next).value).toMatchObject({ type: "compaction.finished", reason: "pressure", status: "completed" });
  for await (const _event of events) { /* Drain the ordinary final answer. */ }
});

test("context overflow forces one compaction and retries once", async () => {
  const session = createSession(turns(12));
  const manager = createContextManager(workspace, { keepTurns: 10 });
  const model = createScriptedModel({
    responses: [
      {
        error: "This model's maximum context length is exceeded",
        status: 400,
        code: "context_length_exceeded",
      },
      { text: CODING_SUMMARY },
      { text: "recovered" },
    ],
  });

  const events = await collect(
    runAgentLoop({ session, model, contextManager: manager }),
  );

  expect(events.some((e) => e.type === "compaction.started")).toBe(true);
  expect(events.some((e) => e.type === "compaction.finished")).toBe(true);
  expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
  // Overflow recovery is distinct from transient transport retries.
  expect(events.some((e) => e.type === "model.retry")).toBe(false);
  expect(session.items.some((item) => item.type === "compaction")).toBe(true);
  const last = session.items.at(-1);
  expect(last?.type).toBe("assistant");
});

test("repeated overflow terminates clearly instead of looping", async () => {
  const session = createSession(turns(12));
  const manager = createContextManager(workspace, { keepTurns: 10 });
  const overflow = (text: string) => ({
    error: text,
    status: 400 as const,
    code: "context_length_exceeded",
  });
  const model = createScriptedModel({
    responses: [
      overflow("first overflow"),
      { text: CODING_SUMMARY },
      overflow("second overflow"),
      { text: "should never run" },
    ],
  });

  const events = await collect(
    runAgentLoop({ session, model, contextManager: manager }),
  );

  expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "error" });
  const errors = events.filter((e) => e.type === "error");
  expect(errors.length).toBeGreaterThan(0);
  expect(JSON.stringify(errors).toLowerCase()).toContain("overflow");
  expect(JSON.stringify(events).includes("should never run")).toBe(false);
  // Went through exactly one forced compaction before terminating.
  expect(events.filter((e) => e.type === "compaction.started")).toHaveLength(1);
  expect(session.items.filter((item) => item.type === "compaction")).toHaveLength(1);
});

test("Anthropic prompt-too-long text without a code still recovers", async () => {
  const session = createSession(turns(12));
  const manager = createContextManager(workspace, { keepTurns: 10 });
  const model = createScriptedModel({
    responses: [
      {
        error: "prompt is too long: 213418 tokens > 200000 maximum",
        status: 400,
      },
      { text: CODING_SUMMARY },
      { text: "recovered" },
    ],
  });

  const events = await collect(
    runAgentLoop({ session, model, contextManager: manager }),
  );

  expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
  expect(events.some((e) => e.type === "model.retry")).toBe(false);
  expect(session.items.some((item) => item.type === "compaction")).toBe(true);
});

test("aborting during forced compaction discards a late summary and reports cancellation", async () => {
  const session = createSession(turns(12));
  const manager = createContextManager(workspace, { keepTurns: 10 });
  const controller = new AbortController();
  let calls = 0;
  const model: Model = {
    provider: "scripted",
    id: "scripted",
    async *stream() {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(
          new Error("prompt is too long: 213418 tokens > 200000 maximum"),
          { status: 400 },
        );
      }
      // Abort mid-compaction, then still return a summary.
      controller.abort();
      yield {
        type: "message_complete",
        message: {
          type: "assistant",
          id: "a-sum",
          content: [{ type: "text", text: CODING_SUMMARY }],
        },
      };
    },
  };

  const events = await collect(
    runAgentLoop({
      session,
      model,
      contextManager: manager,
      signal: controller.signal,
    }),
  );

  expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "cancelled" });
  const finished = events.filter((e) => e.type === "compaction.finished");
  expect(finished).toHaveLength(1);
  expect(finished[0]).toMatchObject({ status: "cancelled" });
  expect(session.items.some((item) => item.type === "compaction")).toBe(false);
});


test("undo notes stay with the preceding turn and never become compaction boundaries", async () => {
  const session = createSession([...turns(3), { type: "turn_undo", id: "undo-note", turnId: "u2", turnNumber: 3,
    reverted: [{ path: "clamp.ts", action: "restored" }], skipped: [], note: "The user undid your file changes from the previous turn: clamp.ts." }]);
  const manager = createContextManager(workspace, { keepTurns: 1 });
  const record = await manager.compact(session, createScriptedModel({ responses: [{ text: CODING_SUMMARY }] }), { reason: "manual" });
  expect(record?.firstKeptId).toBe("u2");
  const prepared = await manager.prepare(session, createScriptedModel({ responses: [] }));
  expect(prepared.items.at(-1)).toEqual({ type: "user", id: "undo-note", content: [{ type: "text", text: "The user undid your file changes from the previous turn: clamp.ts." }] });
});
