import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeEvent } from "../src/agent/events.ts";
import { runAgentLoop } from "../src/agent/loop.ts";
import type { AgentClock } from "../src/agent/retry.ts";
import { createContextManager } from "../src/context/manager.ts";
import type {
  AssistantMessage,
  ToolResult,
  UserMessage,
} from "../src/conversation/types.ts";
import { createOpenAICompatibleModel } from "../src/model/providers/openai-compatible.ts";
import { createJsonlSession, loadJsonlSession } from "../src/session/jsonl.ts";
import { createSession } from "../src/session/session.ts";
import { bashTool } from "../src/tools/bash.ts";
import { editTool } from "../src/tools/edit.ts";
import { readTool, type ReadInput } from "../src/tools/read.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import type { ToolDefinition } from "../src/tools/types.ts";
import { writeTool, type WriteInput } from "../src/tools/write.ts";
import { decodeStoredLine, withTempDir } from "./helpers.ts";
import { collect, createScriptedModel } from "./helpers/scripted-model.ts";

const workspace = {
  root: "/tmp/project",
  launchCwd: "/tmp/project",
  extraRoots: [],
};

/** Build a single-text user message for loop tests. */
function user(text: string): UserMessage {
  return { type: "user", id: "u1", content: [{ type: "text", text }] };
}

/** Clock that records backoff delays and never waits. */
function recordingClock(now = 0): AgentClock & { delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    now: () => now,
    async sleep(ms, signal) {
      delays.push(ms);
      if (signal?.aborted) {
        throw abortError();
      }
    },
  };
}

/** Clock whose sleep stays pending until the shared AbortSignal fires. */
function latchClock(): AgentClock & { delays: number[]; started: Promise<void> } {
  const delays: number[] = [];
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  return {
    delays,
    started: startedPromise,
    now: () => 0,
    async sleep(ms, signal) {
      delays.push(ms);
      if (signal?.aborted) {
        throw abortError();
      }
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => {
          signal?.removeEventListener("abort", onAbort);
          reject(abortError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        started();
      });
    },
  };
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function eventTypes(events: readonly RuntimeEvent[]): string[] {
  return events.map((event) => event.type);
}

test("transient provider failures retry then persist only the successful assistant message", async () => {
  const clock = recordingClock();
  const session = createSession([user("hello")]);
  const events = await collect(
    runAgentLoop({
      session,
      model: createScriptedModel({
        responses: [
          { error: "overloaded", status: 503 },
          { error: "rate limited", status: 429 },
          { chunks: ["ok"] },
        ],
      }),
      contextManager: createContextManager(workspace),
      clock,
    }),
  );

  expect(eventTypes(events)).toEqual([
    "agent.started",
    "model.started",
    "model.retry",
    "model.started",
    "model.retry",
    "model.started",
    "model.delta",
    "model.finished",
    "agent.finished",
  ]);
  expect(events.filter((event) => event.type === "model.retry")).toEqual([
    {
      type: "model.retry",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1000,
      message: "overloaded",
    },
    {
      type: "model.retry",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 2000,
      message: "rate limited",
    },
  ]);
  expect(clock.delays).toEqual([1000, 2000]);
  expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
  const assistants = session.items.filter(
    (item): item is AssistantMessage => item.type === "assistant",
  );
  expect(assistants).toHaveLength(1);
  expect(assistants[0]?.content).toEqual([{ type: "text", text: "ok" }]);
});

test("transient attempts stop at three and do not start a fourth stream", async () => {
  const clock = recordingClock();
  const session = createSession([user("hello")]);
  const events = await collect(
    runAgentLoop({
      session,
      model: createScriptedModel({
        responses: [
          { error: "network reset", code: "ECONNRESET" },
          { error: "network reset", code: "ECONNRESET" },
          { error: "network reset", code: "ECONNRESET" },
          { text: "should not run" },
        ],
      }),
      contextManager: createContextManager(workspace),
      clock,
    }),
  );

  expect(events.filter((event) => event.type === "model.started")).toHaveLength(3);
  expect(events.filter((event) => event.type === "model.retry")).toHaveLength(2);
  expect(events).toContainEqual({
    type: "error",
    message:
      "Provider request failed after 3 transient attempts: network reset",
  });
  expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "error" });
  expect(JSON.stringify(events).includes("should not run")).toBe(false);
  expect(session.items).toHaveLength(1);
  expect(clock.delays).toEqual([1000, 2000]);
});

test("Retry-After seconds override exponential backoff", async () => {
  const clock = recordingClock();
  const session = createSession([user("hello")]);
  const events = await collect(
    runAgentLoop({
      session,
      model: createScriptedModel({
        responses: [
          {
            error: "rate limited",
            status: 429,
            headers: { "retry-after": "5" },
          },
          { text: "ok" },
        ],
      }),
      contextManager: createContextManager(workspace),
      clock,
    }),
  );

  expect(clock.delays).toEqual([5000]);
  expect(events).toContainEqual({
    type: "model.retry",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 5000,
    message: "rate limited",
  });
  expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
});

test("Retry-After longer than 30s is capped so a provider cannot stall the run", async () => {
  const clock = recordingClock();
  const session = createSession([user("hello")]);
  const events = await collect(
    runAgentLoop({
      session,
      model: createScriptedModel({
        responses: [
          {
            error: "rate limited",
            status: 429,
            headers: { "retry-after": "3600" },
          },
          { text: "ok" },
        ],
      }),
      contextManager: createContextManager(workspace),
      clock,
    }),
  );

  expect(clock.delays).toEqual([30_000]);
  expect(events).toContainEqual({
    type: "model.retry",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 30_000,
    message: "rate limited",
  });
  expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
});

test("Retry-After HTTP-date is converted using the injected clock", async () => {
  const retryAt = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
  const clock = recordingClock(retryAt - 3500);
  const session = createSession([user("hello")]);
  await collect(
    runAgentLoop({
      session,
      model: createScriptedModel({
        responses: [
          {
            error: "rate limited",
            status: 429,
            headers: { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" },
          },
          { text: "ok" },
        ],
      }),
      contextManager: createContextManager(workspace),
      clock,
    }),
  );
  expect(clock.delays).toEqual([3500]);
});

test("authentication and malformed requests are not retried", async () => {
  const clock = recordingClock();
  const authSession = createSession([user("hello")]);
  const authEvents = await collect(
    runAgentLoop({
      session: authSession,
      model: createScriptedModel({ error: "unauthorized", status: 401 }),
      contextManager: createContextManager(workspace),
      clock,
    }),
  );
  expect(authEvents.filter((event) => event.type === "model.started")).toHaveLength(
    1,
  );
  expect(authEvents.some((event) => event.type === "model.retry")).toBe(false);
  expect(authEvents).toContainEqual({ type: "error", message: "unauthorized" });
  expect(authSession.items).toHaveLength(1);
  expect(clock.delays).toEqual([]);

  const badSession = createSession([user("hello")]);
  const badEvents = await collect(
    runAgentLoop({
      session: badSession,
      model: createScriptedModel({ error: "bad request", status: 400 }),
      contextManager: createContextManager(workspace),
      clock,
    }),
  );
  expect(badEvents.filter((event) => event.type === "model.started")).toHaveLength(
    1,
  );
  expect(badEvents.some((event) => event.type === "model.retry")).toBe(false);
  expect(badEvents).toContainEqual({ type: "error", message: "bad request" });
});

test("invalid tool arguments, failed shell commands, and edit mismatches are not retried", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "note.txt"), "alpha\n");
    const project = { root: dir, launchCwd: dir, extraRoots: [] };
    const clock = recordingClock();
    const session = createSession([user("try tools")]);
    const events = await collect(
      runAgentLoop({
        session,
        model: createScriptedModel({
          responses: [
            {
              toolCalls: [
                { id: "bad-args", name: "read", arguments: { path: 12 } },
                {
                  id: "bash-fail",
                  name: "bash",
                  arguments: { command: "exit 7" },
                },
                {
                  id: "edit-miss",
                  name: "edit",
                  arguments: {
                    path: "note.txt",
                    edits: [{ oldText: "missing-token", newText: "nope" }],
                  },
                },
              ],
            },
            { text: "handled" },
          ],
        }),
        contextManager: createContextManager(project),
        tools: createToolRegistry([readTool, bashTool, editTool]),
        workspace: project,
        clock,
      }),
    );

    expect(events.some((event) => event.type === "model.retry")).toBe(false);
    expect(events.filter((event) => event.type === "model.started")).toHaveLength(
      2,
    );
    expect(clock.delays).toEqual([]);
    const results = session.items.filter(
      (item): item is ToolResult => item.type === "tool_result",
    );
    expect(results).toHaveLength(3);
    expect(results[0]?.content).toContain("Invalid arguments for tool read");
    expect(results[1]?.content).toContain("Exit code: 7");
    expect(results[2]?.isError).toBe(true);
    expect(results[2]?.content.toLowerCase()).toContain("not found");
    expect(events.at(-1)).toEqual({
      type: "agent.finished",
      reason: "completed",
    });
  });
});

test("a mid-stream failure does not persist output or run tools before the successful retry", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "note.txt"), "secret-token\n");
    const project = { root: dir, launchCwd: dir, extraRoots: [] };
    let reads = 0;
    const countingRead: ToolDefinition<ReadInput> = {
      ...readTool,
      async execute(input, ctx) {
        reads += 1;
        return readTool.execute(input, ctx);
      },
    };
    const clock = recordingClock();
    const session = createSession([user("read it")]);
    const events = await collect(
      runAgentLoop({
        session,
        model: createScriptedModel({
          responses: [
            {
              chunks: ["Hel"],
              error: "connection reset",
              code: "ECONNRESET",
              throwAfter: "chunks",
            },
            {
              toolCalls: [
                { id: "r1", name: "read", arguments: { path: "note.txt" } },
              ],
            },
            { text: "done" },
          ],
        }),
        contextManager: createContextManager(project),
        tools: createToolRegistry([countingRead]),
        workspace: project,
        clock,
      }),
    );

    expect(events).toContainEqual({
      type: "model.delta",
      content: { type: "text", text: "Hel" },
    });
    expect(events.some((event) => event.type === "model.retry")).toBe(true);
    expect(reads).toBe(1);
    const assistants = session.items.filter((item) => item.type === "assistant");
    expect(assistants).toHaveLength(2);
    expect(JSON.stringify(assistants).includes("Hel")).toBe(false);
    expect(events.at(-1)).toEqual({
      type: "agent.finished",
      reason: "completed",
    });
  });
});

test("cancelling during backoff exits promptly and does not start another attempt", async () => {
  const controller = new AbortController();
  const clock = latchClock();
  const session = createSession([user("hello")]);
  const events: RuntimeEvent[] = [];
  const running = (async () => {
    for await (const event of runAgentLoop({
      session,
      model: createScriptedModel({
        responses: [
          { error: "overloaded", status: 503 },
          { text: "should not run" },
        ],
      }),
      contextManager: createContextManager(workspace),
      signal: controller.signal,
      clock,
    })) {
      events.push(event);
    }
  })();

  await clock.started;
  controller.abort();
  await running;

  expect(events.filter((event) => event.type === "model.started")).toHaveLength(1);
  expect(events.some((event) => event.type === "model.retry")).toBe(true);
  expect(JSON.stringify(events).includes("should not run")).toBe(false);
  expect(events.at(-1)).toEqual({
    type: "agent.finished",
    reason: "cancelled",
  });
  expect(session.items).toHaveLength(1);
});

test("cancelling a stream does not persist a partial assistant message", async () => {
  const controller = new AbortController();
  const session = createSession([user("hello")]);
  const events: RuntimeEvent[] = [];
  for await (const event of runAgentLoop({
    session,
    model: createScriptedModel({
      chunks: ["Hel"],
      waitForAbort: true,
      text: "should not complete",
    }),
    contextManager: createContextManager(workspace),
    signal: controller.signal,
    clock: recordingClock(),
  })) {
    events.push(event);
    if (event.type === "model.delta") {
      controller.abort();
    }
  }

  expect(events).toContainEqual({
    type: "model.delta",
    content: { type: "text", text: "Hel" },
  });
  expect(events.at(-1)).toEqual({
    type: "agent.finished",
    reason: "cancelled",
  });
  expect(session.items).toHaveLength(1);
});

test("graceful cancel settles tools once, persists source order, and resume does not replay writes", async () => {
  await withTempDir(async (dir) => {
    const project = { root: dir, launchCwd: dir, extraRoots: [] };
    const sessions = join(dir, "sessions");
    const session = await createJsonlSession({
      directory: sessions,
      workspace: project,
    });
    session.append(user("write then run"));
    let writes = 0;
    const controller = new AbortController();
    const countingWrite: ToolDefinition<WriteInput> = {
      ...writeTool,
      async execute(input, ctx) {
        writes += 1;
        const output = await writeTool.execute(input, ctx);
        controller.abort();
        return output;
      },
    };
    const events = await collect(
      runAgentLoop({
        session,
        model: createScriptedModel({
          responses: [
            {
              toolCalls: [
                {
                  id: "w1",
                  name: "write",
                  arguments: { path: "note.txt", content: "kept\n" },
                },
                {
                  id: "b1",
                  name: "bash",
                  arguments: { command: "echo should-not-run" },
                },
              ],
            },
            { text: "should not run" },
          ],
        }),
        contextManager: createContextManager(project),
        tools: createToolRegistry([countingWrite, bashTool]),
        workspace: project,
        signal: controller.signal,
        clock: recordingClock(),
      }),
    );

    const results = session.items.filter(
      (item): item is ToolResult => item.type === "tool_result",
    );
    expect(results.map((result) => result.toolCallId)).toEqual(["w1", "b1"]);
    expect(results[0]?.isError).toBe(false);
    expect(results[1]?.content).toBe("Tool call cancelled");
    expect(events.filter((event) => event.type === "tool.finished")).toHaveLength(
      2,
    );
    expect(events.at(-1)).toEqual({
      type: "agent.finished",
      reason: "cancelled",
    });
    expect(writes).toBe(1);
    expect(await Bun.file(join(dir, "note.txt")).text()).toBe("kept\n");

    const records = (await Bun.file(join(sessions, `${session.header.id}.jsonl`)).text())
      .split("\n")
      .filter((line) => line.length > 0)
      .flatMap(decodeStoredLine);
    expect(records.map((record) => record.type)).toEqual([
      "session",
      "user",
      "assistant",
      "tool_result",
      "tool_result",
    ]);
    expect(JSON.stringify(records).includes("model.retry")).toBe(false);

    const loaded = await loadJsonlSession({
      directory: sessions,
      id: session.header.id,
    });
    await collect(
      runAgentLoop({
        session: loaded,
        model: createScriptedModel({ text: "resumed" }),
        contextManager: createContextManager(project),
        tools: createToolRegistry([countingWrite, bashTool]),
        workspace: project,
        clock: recordingClock(),
      }),
    );
    expect(writes).toBe(1);
    const last = loaded.items.at(-1) as AssistantMessage;
    expect(last.content).toEqual([{ type: "text", text: "resumed" }]);
  });
});

test("abrupt interruption stays recoverable and does not rerun side-effecting tools", async () => {
  await withTempDir(async (dir) => {
    const project = { root: dir, launchCwd: dir, extraRoots: [] };
    const sessions = join(dir, "sessions");
    const created = await createJsonlSession({
      directory: sessions,
      workspace: project,
    });
    created.append(user("write it"));
    created.append({
      type: "assistant",
      id: "a1",
      content: [
        {
          type: "tool_call",
          id: "call-write",
          name: "write",
          arguments: { path: "secret.txt", content: "nope" },
        },
      ],
    });

    const loaded = await loadJsonlSession({
      directory: sessions,
      id: created.header.id,
    });
    let writes = 0;
    const countingWrite: ToolDefinition<WriteInput> = {
      ...writeTool,
      async execute(input, ctx) {
        writes += 1;
        return writeTool.execute(input, ctx);
      },
    };
    await collect(
      runAgentLoop({
        session: loaded,
        model: createScriptedModel({ text: "recovered" }),
        contextManager: createContextManager(project),
        tools: createToolRegistry([countingWrite]),
        workspace: project,
        clock: recordingClock(),
      }),
    );
    expect(writes).toBe(0);
    expect(await Bun.file(join(dir, "secret.txt")).exists()).toBe(false);
    const result = loaded.items.find(
      (item): item is ToolResult => item.type === "tool_result",
    );
    expect(result?.content.toLowerCase()).toContain("interrupted");
  });
});

test("openai-compatible 5xx responses retry with Retry-After and then exhaust clearly", async () => {
  const clock = recordingClock();
  let fetches = 0;
  const model = createOpenAICompatibleModel({
    baseUrl: "http://127.0.0.1:9/v1",
    auth: "none",
    fetch: async () => {
      fetches += 1;
      return new Response(JSON.stringify({ error: { message: "busy" } }), {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "2",
        },
      });
    },
  });
  const session = createSession([user("hello")]);
  const events = await collect(
    runAgentLoop({
      session,
      model,
      contextManager: createContextManager(workspace),
      clock,
    }),
  );

  expect(fetches).toBe(3);
  expect(clock.delays).toEqual([2000, 2000]);
  expect(events.filter((event) => event.type === "model.retry")).toHaveLength(2);
  expect(events).toContainEqual({
    type: "error",
    message: expect.stringMatching(
      /Provider request failed after 3 transient attempts:.*busy/,
    ),
  });
  expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "error" });
  expect(session.items).toHaveLength(1);
});
