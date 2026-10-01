import { expect, test } from "bun:test";
import { Type, type Static } from "@sinclair/typebox";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runAgentLoop } from "../src/agent/loop.ts";
import type { RuntimeEvent } from "../src/agent/events.ts";
import { createContextManager } from "../src/context/manager.ts";
import type { ToolResult, UserMessage } from "../src/conversation/types.ts";
import { createSession } from "../src/session/session.ts";
import { abortError } from "../src/tools/fs.ts";
import { readTool } from "../src/tools/read.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import type {
  ToolDefinition,
  ToolExecutionMode,
} from "../src/tools/types.ts";
import { writeTool } from "../src/tools/write.ts";
import { withTempDir } from "./helpers.ts";
import { collect, createScriptedModel } from "./helpers/scripted-model.ts";

const workspace = {
  root: "/tmp/project",
  launchCwd: "/tmp/project",
  extraRoots: [],
};

const probeSchema = Type.Object(
  { key: Type.String() },
  { additionalProperties: false },
);

type ProbeInput = Static<typeof probeSchema>;

/** Latch that tests open to let a controllable tool continue. */
class Gate {
  #resolve = (): void => {};
  #opened = false;
  readonly promise = new Promise<void>((resolve) => {
    this.#resolve = resolve;
  });
  open(): void {
    if (this.#opened) {
      return;
    }
    this.#opened = true;
    this.#resolve();
  }
}

interface ProbeController {
  log: string[];
  started: Map<string, Gate>;
  gates: Map<string, Gate>;
  executeCount: Map<string, number>;
  fail: Set<string>;
}

/** Per-key gates so tests can observe overlap without sleeping. */
function createController(keys: readonly string[]): ProbeController {
  return {
    log: [],
    started: new Map(keys.map((key) => [key, new Gate()])),
    gates: new Map(keys.map((key) => [key, new Gate()])),
    executeCount: new Map(),
    fail: new Set(),
  };
}

/** Controllable tool whose scheduling comes from `execution`, not its name. */
function probeTool(
  name: string,
  execution: ToolExecutionMode,
  controller: ProbeController,
): ToolDefinition<ProbeInput> {
  return {
    name,
    description: "controllable test tool",
    inputSchema: probeSchema,
    execution,
    async execute(input, ctx) {
      const key = input.key;
      controller.executeCount.set(
        key,
        (controller.executeCount.get(key) ?? 0) + 1,
      );
      controller.log.push(`${name}:${key}:start`);
      controller.started.get(key)?.open();
      const gate = controller.gates.get(key);
      if (gate) {
        await waitForGate(gate, ctx.signal);
      }
      if (ctx.signal?.aborted) {
        throw abortError();
      }
      if (controller.fail.has(key)) {
        throw new Error(`forced failure: ${key}`);
      }
      controller.log.push(`${name}:${key}:end`);
      return { content: `${name}:${key}` };
    },
  };
}

test("consecutive parallel-safe calls overlap before either finishes", async () => {
  const controller = createController(["a", "b"]);
  const running = runTurn({
    tools: [probeTool("scan", "parallel", controller)],
    calls: [
      call("c-a", "scan", "a"),
      call("c-b", "scan", "b"),
    ],
  });

  await Promise.all([
    controller.started.get("a")!.promise,
    controller.started.get("b")!.promise,
  ]);
  expect(starts(controller)).toEqual(["scan:a:start", "scan:b:start"]);
  expect(controller.log.some((entry) => entry.endsWith(":end"))).toBe(false);

  controller.gates.get("a")!.open();
  controller.gates.get("b")!.open();
  const { session } = await running;
  expect(resultContents(session)).toEqual(["scan:a", "scan:b"]);
});

test("at most 10 parallel calls run until a slot frees", async () => {
  const keys = Array.from({ length: 11 }, (_, index) => String(index));
  const controller = createController(keys);
  const running = runTurn({
    tools: [probeTool("scan", "parallel", controller)],
    calls: keys.map((key) => call(`c-${key}`, "scan", key)),
  });

  await Promise.all(
    keys.slice(0, 10).map((key) => controller.started.get(key)!.promise),
  );
  await Promise.resolve();
  expect(startedCount(controller)).toBe(10);
  expect(controller.executeCount.get("10") ?? 0).toBe(0);

  controller.gates.get("0")!.open();
  await controller.started.get("10")!.promise;
  expect(startedCount(controller)).toBe(11);

  for (const key of keys) {
    controller.gates.get(key)!.open();
  }
  const { session } = await running;
  expect(resultContents(session)).toEqual(
    keys.map((key) => `scan:${key}`),
  );
});

test("exclusive calls wait, run alone, and block later calls", async () => {
  const controller = createController(["a", "x", "b"]);
  const running = runTurn({
    tools: [
      probeTool("scan", "parallel", controller),
      probeTool("poke", "exclusive", controller),
    ],
    calls: [
      call("c-a", "scan", "a"),
      call("c-x", "poke", "x"),
      call("c-b", "scan", "b"),
    ],
  });

  await controller.started.get("a")!.promise;
  await Promise.resolve();
  expect(starts(controller)).toEqual(["scan:a:start"]);

  controller.gates.get("a")!.open();
  await controller.started.get("x")!.promise;
  await Promise.resolve();
  expect(starts(controller)).toEqual(["scan:a:start", "poke:x:start"]);

  controller.gates.get("x")!.open();
  await controller.started.get("b")!.promise;
  expect(starts(controller)).toEqual([
    "scan:a:start",
    "poke:x:start",
    "scan:b:start",
  ]);
  expect(controller.log).toEqual([
    "scan:a:start",
    "scan:a:end",
    "poke:x:start",
    "poke:x:end",
    "scan:b:start",
  ]);

  controller.gates.get("b")!.open();
  const { session } = await running;
  expect(resultContents(session)).toEqual(["scan:a", "poke:x", "scan:b"]);
});

test("scheduler uses each tool declaration rather than the tool name", async () => {
  const overlap = createController(["w1", "w2"]);
  const overlapping = runTurn({
    tools: [probeTool("write", "parallel", overlap)],
    calls: [
      call("c-w1", "write", "w1"),
      call("c-w2", "write", "w2"),
    ],
  });
  await Promise.all([
    overlap.started.get("w1")!.promise,
    overlap.started.get("w2")!.promise,
  ]);
  expect(startedCount(overlap)).toBe(2);
  overlap.gates.get("w1")!.open();
  overlap.gates.get("w2")!.open();
  await overlapping;

  const barrier = createController(["r1", "r2"]);
  const blocked = runTurn({
    tools: [probeTool("read", "exclusive", barrier)],
    calls: [
      call("c-r1", "read", "r1"),
      call("c-r2", "read", "r2"),
    ],
  });
  await barrier.started.get("r1")!.promise;
  await Promise.resolve();
  expect(starts(barrier)).toEqual(["read:r1:start"]);
  barrier.gates.get("r1")!.open();
  await barrier.started.get("r2")!.promise;
  expect(starts(barrier)).toEqual(["read:r1:start", "read:r2:start"]);
  barrier.gates.get("r2")!.open();
  await blocked;
});

test("model-facing results stay in source order when work finishes out of order", async () => {
  const controller = createController(["a", "b"]);
  const session = createSession([user("go")]);
  const loop = runAgentLoop({
    session,
    model: createScriptedModel({
      responses: [
        {
          toolCalls: [
            call("c-a", "scan", "a"),
            call("c-b", "scan", "b"),
          ],
        },
        { text: "done" },
      ],
    }),
    contextManager: createContextManager(workspace),
    tools: createToolRegistry([probeTool("scan", "parallel", controller)]),
    workspace,
  });
  const observed = observe(loop);

  await Promise.all([
    controller.started.get("a")!.promise,
    controller.started.get("b")!.promise,
  ]);
  controller.gates.get("b")!.open();
  await observed.waitFor(
    (event) => event.type === "tool.finished" && event.toolCallId === "c-b",
  );
  expect(finishedIds(observed.events)).toEqual(["c-b"]);
  expect(resultContents(session)).toEqual([]);

  controller.gates.get("a")!.open();
  await observed.done;
  expect(finishedIds(observed.events)).toEqual(["c-b", "c-a"]);
  expect(resultContents(session)).toEqual(["scan:a", "scan:b"]);
});

test("a sibling failure still records every accepted call", async () => {
  const controller = createController(["a", "b"]);
  controller.fail.add("a");
  const running = runTurn({
    tools: [probeTool("scan", "parallel", controller)],
    calls: [
      call("c-a", "scan", "a"),
      call("c-b", "scan", "b"),
    ],
  });
  await Promise.all([
    controller.started.get("a")!.promise,
    controller.started.get("b")!.promise,
  ]);
  controller.gates.get("a")!.open();
  controller.gates.get("b")!.open();
  const { session, events } = await running;
  const results = toolResults(session);
  expect(results).toHaveLength(2);
  expect(results[0]?.toolCallId).toBe("c-a");
  expect(results[0]?.isError).toBe(true);
  expect(results[0]?.content).toContain("forced failure: a");
  expect(results[1]?.toolCallId).toBe("c-b");
  expect(results[1]?.isError).toBe(false);
  expect(results[1]?.content).toBe("scan:b");
  expect(finishedIds(events)).toEqual(expect.arrayContaining(["c-a", "c-b"]));
});

test("cancellation stops new work and settles queued and running calls", async () => {
  const controller = createController(["a", "b", "c"]);
  const abort = new AbortController();
  const running = runTurn({
    tools: [
      probeTool("poke", "exclusive", controller),
      probeTool("scan", "parallel", controller),
    ],
    calls: [
      call("c-a", "poke", "a"),
      call("c-b", "scan", "b"),
      call("c-c", "scan", "c"),
    ],
    signal: abort.signal,
  });

  await controller.started.get("a")!.promise;
  await Promise.resolve();
  expect(controller.executeCount.get("b") ?? 0).toBe(0);
  expect(controller.executeCount.get("c") ?? 0).toBe(0);
  abort.abort();
  const { session, events } = await running;

  expect(controller.executeCount.get("b") ?? 0).toBe(0);
  expect(controller.executeCount.get("c") ?? 0).toBe(0);
  const results = toolResults(session);
  expect(results).toHaveLength(3);
  expect(results.map((result) => result.toolCallId)).toEqual([
    "c-a",
    "c-b",
    "c-c",
  ]);
  expect(results.every((result) => result.isError)).toBe(true);
  expect(results.every((result) => result.content === "Tool call cancelled")).toBe(
    true,
  );
  expect(events.at(-1)).toEqual({
    type: "agent.finished",
    reason: "cancelled",
  });
});

test("a configured concurrency cap limits overlapping parallel work", async () => {
  const controller = createController(["a", "b", "c"]);
  const running = runTurn({
    tools: [probeTool("scan", "parallel", controller)],
    calls: [
      call("c-a", "scan", "a"),
      call("c-b", "scan", "b"),
      call("c-c", "scan", "c"),
    ],
    maxConcurrentTools: 2,
  });

  await Promise.all([
    controller.started.get("a")!.promise,
    controller.started.get("b")!.promise,
  ]);
  expect(controller.executeCount.get("c") ?? 0).toBe(0);
  controller.gates.get("a")!.open();
  controller.gates.get("b")!.open();
  await controller.started.get("c")!.promise;
  controller.gates.get("c")!.open();
  await running;
  expect(controller.executeCount.get("c")).toBe(1);
});

test("queued work beyond the concurrency cap is cancelled without running", async () => {
  const keys = Array.from({ length: 11 }, (_, index) => String(index));
  const controller = createController(keys);
  const abort = new AbortController();
  const running = runTurn({
    tools: [probeTool("scan", "parallel", controller)],
    calls: keys.map((key) => call(`c-${key}`, "scan", key)),
    signal: abort.signal,
  });

  await Promise.all(
    keys.slice(0, 10).map((key) => controller.started.get(key)!.promise),
  );
  expect(controller.executeCount.get("10") ?? 0).toBe(0);
  abort.abort();
  const { session } = await running;
  expect(controller.executeCount.get("10") ?? 0).toBe(0);
  const results = toolResults(session);
  expect(results).toHaveLength(11);
  expect(results.every((result) => result.content === "Tool call cancelled")).toBe(
    true,
  );
  expect(results[10]?.toolCallId).toBe("c-10");
});

test("read/write/read sees the mutation only after the exclusive barrier", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "note.txt"), "before-token\n");
    const project = { root: dir, launchCwd: dir, extraRoots: [] };
    const session = createSession([user("update note")]);
    await collect(
      runAgentLoop({
        session,
        model: createScriptedModel({
          responses: [
            {
              toolCalls: [
                {
                  id: "r1",
                  name: "read",
                  arguments: { path: "note.txt" },
                },
                {
                  id: "w1",
                  name: "write",
                  arguments: {
                    path: "note.txt",
                    content: "after-token\n",
                  },
                },
                {
                  id: "r2",
                  name: "read",
                  arguments: { path: "note.txt" },
                },
              ],
            },
            { text: "done" },
          ],
        }),
        contextManager: createContextManager(project),
        tools: createToolRegistry([readTool, writeTool]),
        workspace: project,
      }),
    );
    const results = toolResults(session);
    expect(results).toHaveLength(3);
    expect(results[0]?.content).toContain("before-token");
    expect(results[0]?.content.includes("after-token")).toBe(false);
    expect(results[1]?.content).toBe("Wrote note.txt");
    expect(results[2]?.content).toContain("after-token");
    expect(results[2]?.content.includes("before-token")).toBe(false);
  });
});

/** Build a single-text user message. */
function user(text: string): UserMessage {
  return { type: "user", id: "u1", content: [{ type: "text", text }] };
}

/** One scripted tool call against a probe key. */
function call(
  id: string,
  name: string,
  key: string,
): { id: string; name: string; arguments: { key: string } } {
  return { id, name, arguments: { key } };
}

/** Run one tool-using turn, then a final text answer. */
function runTurn(options: {
  tools: ToolDefinition[];
  calls: Array<{ id: string; name: string; arguments: unknown }>;
  signal?: AbortSignal;
  approval?: import("../src/agent/approval.ts").ApprovalPolicy;
  maxConcurrentTools?: number;
}): Promise<{ session: ReturnType<typeof createSession>; events: RuntimeEvent[] }> {
  const session = createSession([user("go")]);
  return collect(
    runAgentLoop({
      session,
      model: createScriptedModel({
        responses: [
          { toolCalls: options.calls },
          { text: "done" },
        ],
      }),
      contextManager: createContextManager(workspace),
      tools: createToolRegistry(options.tools),
      workspace,
      approval: options.approval,
      signal: options.signal,
      maxConcurrentTools: options.maxConcurrentTools,
    }),
  ).then((events) => ({ session, events }));
}

/** Collect runtime events while tests release gates. */
function observe(loop: AsyncIterable<RuntimeEvent>): {
  events: RuntimeEvent[];
  done: Promise<void>;
  waitFor: (predicate: (event: RuntimeEvent) => boolean) => Promise<void>;
} {
  const events: RuntimeEvent[] = [];
  const waiters: Array<{
    predicate: (event: RuntimeEvent) => boolean;
    resolve: () => void;
  }> = [];
  const done = (async () => {
    for await (const event of loop) {
      events.push(event);
      for (const waiter of waiters) {
        if (waiter.predicate(event)) {
          waiter.resolve();
        }
      }
    }
  })();
  return {
    events,
    done,
    waitFor(predicate) {
      if (events.some(predicate)) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        waiters.push({ predicate, resolve });
      });
    },
  };
}

/** Await a test gate or abort, whichever happens first. */
async function waitForGate(gate: Gate, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw abortError();
  }
  if (!signal) {
    await gate.promise;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void gate.promise.then(() => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      resolve();
    });
  });
}

function starts(controller: ProbeController): string[] {
  return controller.log.filter((entry) => entry.endsWith(":start"));
}

function startedCount(controller: ProbeController): number {
  return controller.log.filter((entry) => entry.endsWith(":start")).length;
}

function toolResults(
  session: ReturnType<typeof createSession>,
): ToolResult[] {
  return session.items.filter(
    (item): item is ToolResult => item.type === "tool_result",
  );
}

function resultContents(session: ReturnType<typeof createSession>): string[] {
  return toolResults(session).map((item) => item.content);
}

function finishedIds(events: RuntimeEvent[]): string[] {
  return events
    .filter((event) => event.type === "tool.finished")
    .map((event) => event.toolCallId);
}


test("read-only denies mutations while parallel reads overlap and settlements retain source order", async () => {
  const controller = createController(["a", "b"]);
  const running = runTurn({
    tools: [{ ...probeTool("read", "parallel", controller), effect: "read-only" }, probeTool("edit", "parallel", controller)],
    calls: [call("first", "read", "a"), call("denied", "edit", "x"), call("last", "read", "b")],
    approval: { interactive: true, mode: () => "read-only" },
  });
  await Promise.all([controller.started.get("a")!.promise, controller.started.get("b")!.promise]);
  expect(startedCount(controller)).toBe(2);
  controller.gates.get("b")!.open(); controller.gates.get("a")!.open();
  const { session, events } = await running;
  expect(resultContents(session)).toEqual(["read:a", "Read-only mode: file changes and commands are off. The user can switch modes with Shift+Tab.", "read:b"]);
  const denied = events.findIndex(event => event.type === "tool.denied");
  expect(events[denied]).toEqual({ type: "tool.denied", toolCallId: "denied", name: "edit", mode: "read-only", reason: resultContents(session)[1] });
  expect(events[denied + 1]?.type).toBe("tool.finished");
});


test("scheduler retains prototype approval accessors and method receivers", async () => {
  class Policy {
    readonly configured = true;
    get interactive() { return this.configured; }
    mode() { expect(this.configured).toBe(true); return "read-only" as const; }
  }
  const controller = createController(["mutation"]);
  const { session } = await runTurn({ tools: [probeTool("edit", "parallel", controller)], calls: [call("mutation", "edit", "mutation")], approval: new Policy() });
  expect(resultContents(session)).toEqual(["Read-only mode: file changes and commands are off. The user can switch modes with Shift+Tab."]);
  expect(controller.executeCount.size).toBe(0);
});
