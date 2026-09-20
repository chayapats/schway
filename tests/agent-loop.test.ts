import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runAgentLoop } from "../src/agent/loop.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import type {
  AssistantMessage,
  ToolResult,
  UserMessage,
} from "../src/conversation/types.ts";
import type { ModelRequest } from "../src/model/model.ts";
import { editTool } from "../src/tools/edit.ts";
import {
  DEFAULT_READ_LINE_LIMIT,
  readTool,
  type ReadInput,
} from "../src/tools/read.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { writeTool } from "../src/tools/write.ts";
import type { ToolDefinition } from "../src/tools/types.ts";
import { withTempDir } from "./helpers.ts";
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

test("scripted model streams text through the real agent loop", async () => {
  const session = createSession([user("hello")]);
  const events = await collect(
    runAgentLoop({
      session,
      model: createScriptedModel({ chunks: ["Hel", "lo"] }),
      contextManager: createContextManager(workspace),
    }),
  );

  expect(events.map((event) => event.type)).toEqual([
    "agent.started",
    "model.started",
    "model.delta",
    "model.delta",
    "model.finished",
    "agent.finished",
  ]);
  expect(events).toContainEqual({
    type: "model.started",
    provider: "scripted",
    model: "scripted",
  });
  expect(events).toContainEqual({
    type: "model.delta",
    content: { type: "text", text: "Hel" },
  });
  expect(events).toContainEqual({
    type: "model.delta",
    content: { type: "text", text: "lo" },
  });
  expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });

  const assistant = session.items[1] as AssistantMessage;
  expect(assistant.type).toBe("assistant");
  expect(assistant.content).toEqual([{ type: "text", text: "Hello" }]);
});

test("stream failure emits an error and does not complete successfully", async () => {
  const session = createSession([user("hello")]);
  const events = await collect(
    runAgentLoop({
      session,
      model: createScriptedModel({ error: "connection reset" }),
      contextManager: createContextManager(workspace),
    }),
  );

  expect(events).toContainEqual({ type: "error", message: "connection reset" });
  expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "error" });
  expect(session.items).toHaveLength(1);
});

test("runtime events do not use provider wire types", async () => {
  const session = createSession([user("hello")]);
  const events = await collect(
    runAgentLoop({
      session,
      model: createScriptedModel({
        thinkingChunks: ["hmm"],
        text: "done",
      }),
      contextManager: createContextManager(workspace),
    }),
  );
  const serialized = JSON.stringify(events);
  expect(serialized.includes("content_block_delta")).toBe(false);
  expect(serialized.includes("message_start")).toBe(false);
  expect(serialized.includes("text_delta")).toBe(false);
  expect(events).toContainEqual({
    type: "model.delta",
    content: { type: "thinking", text: "hmm" },
  });
});

test("agent reads a workspace file and continues from the tool result", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "note.txt"), "secret-token-123\n");
    const project = { root: dir, launchCwd: dir, extraRoots: [] };
    const session = createSession([user("What is in note.txt?")]);
    const events = await collect(
      runAgentLoop({
        session,
        model: createScriptedModel({
          responses: [
            {
              toolCalls: [
                {
                  id: "call-read",
                  name: "read",
                  arguments: { path: "note.txt" },
                },
              ],
            },
            (request) => {
              const result = request.items.find(
                (item): item is ToolResult => item.type === "tool_result",
              );
              return { text: `Found ${result?.content ?? ""}` };
            },
          ],
        }),
        contextManager: createContextManager(project),
        tools: createToolRegistry([readTool]),
        workspace: project,
      }),
    );

    const result = session.items.find(
      (item): item is ToolResult => item.type === "tool_result",
    );
    expect(result?.toolCallId).toBe("call-read");
    expect(result?.isError).toBe(false);
    expect(result?.content).toContain("secret-token-123");
    expect(events.map((event) => event.type)).toEqual([
      "agent.started",
      "model.started",
      "model.finished",
      "tool.started",
      "tool.finished",
      "model.started",
      "model.delta",
      "model.finished",
      "agent.finished",
    ]);
    expect(events).toContainEqual({
      type: "tool.started",
      toolCallId: "call-read",
      name: "read",
    });
    const finished = events.find((event) => event.type === "tool.finished");
    expect(finished).toMatchObject({
      type: "tool.finished",
      toolCallId: "call-read",
      name: "read",
      status: "success",
      details: {
        path: "note.txt",
        truncated: false,
      },
    });
    if (finished?.type === "tool.finished") {
      expect(finished.content).toContain("secret-token-123");
    }
    expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
    const assistant = session.items.at(-1) as AssistantMessage;
    expect(assistant.content).toEqual([
      { type: "text", text: expect.stringContaining("secret-token-123") },
    ]);
  });
});

test("multiple tool calls in one turn keep sibling results after a failure", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "ok.txt"), "present\n");
    const project = { root: dir, launchCwd: dir, extraRoots: [] };
    const session = createSession([user("read both")]);
    await collect(
      runAgentLoop({
        session,
        model: createScriptedModel({
          responses: [
            {
              toolCalls: [
                {
                  id: "missing",
                  name: "read",
                  arguments: { path: "nope.txt" },
                },
                {
                  id: "ok",
                  name: "read",
                  arguments: { path: "ok.txt" },
                },
              ],
            },
            { text: "done" },
          ],
        }),
        contextManager: createContextManager(project),
        tools: createToolRegistry([readTool]),
        workspace: project,
      }),
    );

    const results = session.items.filter(
      (item): item is ToolResult => item.type === "tool_result",
    );
    expect(results).toHaveLength(2);
    expect(results[0]?.toolCallId).toBe("missing");
    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.content).toContain("File not found");
    expect(results[1]?.toolCallId).toBe("ok");
    expect(results[1]?.isError).toBe(false);
    expect(results[1]?.content).toContain("present");
  });
});

test("several rounds feed each tool result back into the next model request", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "a.txt"), "alpha-value\n");
    await writeFile(join(dir, "b.txt"), "beta-value\n");
    const project = { root: dir, launchCwd: dir, extraRoots: [] };
    const session = createSession([user("read both files")]);
    const seen: string[] = [];
    await collect(
      runAgentLoop({
        session,
        model: createScriptedModel({
          responses: [
            {
              toolCalls: [
                { id: "r1", name: "read", arguments: { path: "a.txt" } },
              ],
            },
            (request) => {
              seen.push(resultContent(request, "r1"));
              return {
                toolCalls: [
                  { id: "r2", name: "read", arguments: { path: "b.txt" } },
                ],
              };
            },
            (request) => {
              seen.push(resultContent(request, "r2"));
              return { text: "both read" };
            },
          ],
        }),
        contextManager: createContextManager(project),
        tools: createToolRegistry([readTool]),
        workspace: project,
      }),
    );
    expect(seen[0]).toContain("alpha-value");
    expect(seen[1]).toContain("beta-value");
    expect(session.items.filter((item) => item.type === "assistant")).toHaveLength(
      3,
    );
  });
});

test("bounded loop stops after the turn limit and still stores tool results", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "note.txt"), "keep-going\n");
    const project = { root: dir, launchCwd: dir, extraRoots: [] };
    const session = createSession([user("loop")]);
    const events = await collect(
      runAgentLoop({
        session,
        model: createScriptedModel({
          responses: [
            {
              toolCalls: [
                { id: "t1", name: "read", arguments: { path: "note.txt" } },
              ],
            },
            {
              toolCalls: [
                { id: "t2", name: "read", arguments: { path: "note.txt" } },
              ],
            },
            {
              toolCalls: [
                { id: "t3", name: "read", arguments: { path: "note.txt" } },
              ],
            },
          ],
        }),
        contextManager: createContextManager(project),
        tools: createToolRegistry([readTool]),
        workspace: project,
        maxTurns: 2,
      }),
    );
    expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "max_turns" });
    expect(
      session.items.filter((item) => item.type === "assistant"),
    ).toHaveLength(2);
    expect(
      session.items.filter((item) => item.type === "tool_result"),
    ).toHaveLength(2);
  });
});

test("malformed arguments and unknown tools become model-visible errors", async () => {
  await withTempDir(async (dir) => {
    const project = { root: dir, launchCwd: dir, extraRoots: [] };
    const session = createSession([user("bad calls")]);
    await collect(
      runAgentLoop({
        session,
        model: createScriptedModel({
          responses: [
            {
              toolCalls: [
                { id: "bad-args", name: "read", arguments: { path: 12 } },
                { id: "unknown", name: "nope", arguments: {} },
              ],
            },
            { text: "ok" },
          ],
        }),
        contextManager: createContextManager(project),
        tools: createToolRegistry([readTool]),
        workspace: project,
      }),
    );
    const results = session.items.filter(
      (item): item is ToolResult => item.type === "tool_result",
    );
    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.content).toContain("Invalid arguments for tool read");
    expect(results[1]?.isError).toBe(true);
    expect(results[1]?.content).toBe("Unknown tool: nope");
  });
});

test("oversized reads reach the model as bounded tool results with continuation", async () => {
  await withTempDir(async (dir) => {
    const lines = Array.from(
      { length: DEFAULT_READ_LINE_LIMIT + 25 },
      (_, index) => `row-${index + 1}`,
    );
    await writeFile(join(dir, "big.txt"), `${lines.join("\n")}\n`);
    const project = { root: dir, launchCwd: dir, extraRoots: [] };
    const session = createSession([user("read big.txt")]);
    let fed = "";
    await collect(
      runAgentLoop({
        session,
        model: createScriptedModel({
          responses: [
            {
              toolCalls: [
                { id: "big", name: "read", arguments: { path: "big.txt" } },
              ],
            },
            (request) => {
              fed = resultContent(request, "big");
              return { text: "summarized" };
            },
          ],
        }),
        contextManager: createContextManager(project),
        tools: createToolRegistry([readTool]),
        workspace: project,
      }),
    );
    expect(fed).toContain("row-1");
    expect(fed.includes(`row-${DEFAULT_READ_LINE_LIMIT + 1}`)).toBe(false);
    expect(fed).toContain("Use offset=");
  });
});

test("cancellation prevents later tool calls and yields cancelled results", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "a.txt"), "one\n");
    await writeFile(join(dir, "b.txt"), "two\n");
    const project = { root: dir, launchCwd: dir, extraRoots: [] };
    const session = createSession([user("read")]);
    const controller = new AbortController();
    const abortingRead: ToolDefinition<ReadInput> = {
      ...readTool,
      async execute(input, ctx) {
        const output = await readTool.execute(input, ctx);
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
                  id: "first",
                  name: "read",
                  arguments: { path: "a.txt" },
                },
                {
                  id: "second",
                  name: "read",
                  arguments: { path: "b.txt" },
                },
              ],
            },
            { text: "should not run" },
          ],
        }),
        contextManager: createContextManager(project),
        tools: createToolRegistry([abortingRead]),
        workspace: project,
        signal: controller.signal,
      }),
    );
    const results = session.items.filter(
      (item): item is ToolResult => item.type === "tool_result",
    );
    expect(results).toHaveLength(2);
    expect(results[0]?.isError).toBe(false);
    expect(results[0]?.content).toContain("one");
    expect(results[1]?.isError).toBe(true);
    expect(results[1]?.content).toBe("Tool call cancelled");
    expect(events.at(-1)).toEqual({
      type: "agent.finished",
      reason: "cancelled",
    });
  });
});

test("agent creates a file and reads it back through the real loop", async () => {
  await withTempDir(async (dir) => {
    const project = { root: dir, launchCwd: dir, extraRoots: [] };
    const session = createSession([user("create note.txt")]);
    let readBack = "";
    await collect(
      runAgentLoop({
        session,
        model: createScriptedModel({
          responses: [
            {
              toolCalls: [
                {
                  id: "w1",
                  name: "write",
                  arguments: { path: "note.txt", content: "created-token\n" },
                },
              ],
            },
            {
              toolCalls: [
                { id: "r1", name: "read", arguments: { path: "note.txt" } },
              ],
            },
            (request) => {
              readBack = resultContent(request, "r1");
              return { text: `saw ${readBack}` };
            },
          ],
        }),
        contextManager: createContextManager(project),
        tools: createToolRegistry([readTool, writeTool, editTool]),
        workspace: project,
      }),
    );
    expect(readBack).toContain("created-token");
    const assistant = session.items.at(-1) as AssistantMessage;
    expect(assistant.content).toEqual([
      { type: "text", text: expect.stringContaining("created-token") },
    ]);
  });
});

test("agent edits a file and reads it back through the real loop", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "note.txt"), "alpha-token\n");
    const project = { root: dir, launchCwd: dir, extraRoots: [] };
    const session = createSession([user("edit note.txt")]);
    let readBack = "";
    const events = await collect(
      runAgentLoop({
        session,
        model: createScriptedModel({
          responses: [
            {
              toolCalls: [
                {
                  id: "e1",
                  name: "edit",
                  arguments: {
                    path: "note.txt",
                    edits: [{ oldText: "alpha-token", newText: "beta-token" }],
                  },
                },
              ],
            },
            {
              toolCalls: [
                { id: "r1", name: "read", arguments: { path: "note.txt" } },
              ],
            },
            (request) => {
              readBack = resultContent(request, "r1");
              return { text: `saw ${readBack}` };
            },
          ],
        }),
        contextManager: createContextManager(project),
        tools: createToolRegistry([readTool, writeTool, editTool]),
        workspace: project,
      }),
    );
    expect(readBack).toContain("beta-token");
    expect(readBack.includes("alpha-token")).toBe(false);
    const editResult = session.items.find(
      (item): item is ToolResult =>
        item.type === "tool_result" && item.toolCallId === "e1",
    );
    expect(editResult?.content).toBe("Edited note.txt (1 replacement)");
    expect(editResult?.content.includes("alpha-token")).toBe(false);
    const finished = events.find(
      (event) => event.type === "tool.finished" && event.toolCallId === "e1",
    );
    expect(finished).toMatchObject({
      type: "tool.finished",
      name: "edit",
      status: "success",
      content: "Edited note.txt (1 replacement)",
      details: {
        hunks: [{ oldText: "alpha-token", newText: "beta-token" }],
      },
    });
  });
});

/** Return the model-facing content for a tool_result in a later model request. */
function resultContent(request: ModelRequest, toolCallId: string): string {
  const match = request.items.find(
    (item): item is ToolResult =>
      item.type === "tool_result" && item.toolCallId === toolCallId,
  );
  return match?.content ?? "";
}
