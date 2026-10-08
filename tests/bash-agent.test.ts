import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runAgentLoop } from "../src/agent/loop.ts";
import { createContextManager } from "../src/context/manager.ts";
import type {
  AssistantMessage,
  ToolResult,
  UserMessage,
} from "../src/conversation/types.ts";
import type { ModelRequest } from "../src/model/model.ts";
import { createSession } from "../src/session/session.ts";
import { buildResponsesRequest } from "../src/model/providers/responses-stream.ts";
import { bashTool, MAX_BASH_BYTES } from "../src/tools/bash.ts";
import { utf8ByteLength } from "../src/tools/output-budget.ts";
import { readTool } from "../src/tools/read.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { withTempDir } from "./helpers.ts";
import { collect, createScriptedModel } from "./helpers/scripted-model.ts";
import { runBashProbe } from "./fixtures/bash-spawn-failure.ts";

/** Build a single-text user message for loop tests. */
function user(text: string): UserMessage {
  return { type: "user", id: "u1", content: [{ type: "text", text }] };
}

test("an accepted bash spawn failure produces one harness error and lets the agent continue", async () => {
  await withTempDir(async root => {
    const probe = await runBashProbe("agent", root);
    expect(probe.expired, JSON.stringify(probe)).toBe(false); expect(probe.exit, probe.stderr).toBe(0);
    const result = JSON.parse(probe.stdout.trim().split("\n").at(-1)!);
    expect(result.started).toBe(1); expect(result.results).toHaveLength(1); expect(result.finished).toHaveLength(1);
    expect(result.results[0].content).toContain("ENOENT");
    expect(result.results[0].content).not.toContain("Exit code:");
    expect(result.results[0]).toMatchObject({ toolCallId: "spawn", isError: true });
    expect(result.finished[0]).toMatchObject({ toolCallId: "spawn", status: "error" });
    expect(result.lastEvent).toEqual({ type: "agent.finished", reason: "completed" });
    expect(result.lastItem.content).toEqual([{ type: "text", text: "recovered" }]);
  });
});

test("agent runs a successful shell command and continues from the result", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "marker.txt"), "loop-ok\n");
    const project = { root: dir, launchCwd: dir, extraRoots: [] };
    const session = createSession([user("run cat")]);
    let fed = "";
    const events = await collect(
      runAgentLoop({
        session,
        model: createScriptedModel({
          responses: [
            {
              toolCalls: [
                {
                  id: "b1",
                  name: "bash",
                  arguments: { command: "cat marker.txt" },
                },
              ],
            },
            (request) => {
              fed = resultContent(request, "b1");
              return { text: `saw ${fed}` };
            },
          ],
        }),
        contextManager: createContextManager(project),
        tools: createToolRegistry([bashTool, readTool]),
        workspace: project,
      }),
    );

    expect(fed).toContain("loop-ok");
    expect(fed).toContain("Exit code: 0");
    const finished = events.find(
      (event) => event.type === "tool.finished" && event.toolCallId === "b1",
    );
    expect(finished).toMatchObject({
      type: "tool.finished",
      name: "bash",
      status: "success",
    });
    expect(
      events.some(
        (event) =>
          event.type === "tool.delta" &&
          event.stream === "stdout" &&
          event.text.includes("loop-ok"),
      ),
    ).toBe(true);
    const assistant = session.items.at(-1) as AssistantMessage;
    expect(assistant.content).toEqual([
      { type: "text", text: expect.stringContaining("loop-ok") },
    ]);
  });
});

test("agent sees a failing command as ordinary result data, not transport failure", async () => {
  await withTempDir(async (dir) => {
    const project = { root: dir, launchCwd: dir, extraRoots: [] };
    const session = createSession([user("run tests")]);
    let fed = "";
    const events = await collect(
      runAgentLoop({
        session,
        model: createScriptedModel({
          responses: [
            {
              toolCalls: [
                {
                  id: "fail",
                  name: "bash",
                  arguments: {
                    command:
                      'echo "FAIL tests/example.test.ts"; echo "1 test failed" >&2; exit 1',
                  },
                },
              ],
            },
            (request) => {
              fed = resultContent(request, "fail");
              return { text: "tests failed" };
            },
          ],
        }),
        contextManager: createContextManager(project),
        tools: createToolRegistry([bashTool]),
        workspace: project,
      }),
    );

    const result = session.items.find(
      (item): item is ToolResult => item.type === "tool_result",
    );
    expect(result?.isError).toBe(false);
    expect(fed).toContain("Exit code: 1");
    expect(fed).toContain("FAIL tests/example.test.ts");
    expect(fed).toContain("1 test failed");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.finished",
        toolCallId: "fail",
        status: "success",
      }),
    );
    expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
  });
});

test("agent receives mixed stdout and stderr through runtime events", async () => {
  await withTempDir(async (dir) => {
    const project = { root: dir, launchCwd: dir, extraRoots: [] };
    const session = createSession([user("mix")]);
    const events = await collect(
      runAgentLoop({
        session,
        model: createScriptedModel({
          responses: [
            {
              toolCalls: [
                {
                  id: "mix",
                  name: "bash",
                  arguments: { command: "echo out-line; echo err-line >&2" },
                },
              ],
            },
            { text: "done" },
          ],
        }),
        contextManager: createContextManager(project),
        tools: createToolRegistry([bashTool]),
        workspace: project,
      }),
    );

    expect(
      events.some(
        (event) =>
          event.type === "tool.delta" &&
          event.stream === "stdout" &&
          event.text.includes("out-line"),
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "tool.delta" &&
          event.stream === "stderr" &&
          event.text.includes("err-line"),
      ),
    ).toBe(true);
    const finished = events.find((event) => event.type === "tool.finished");
    expect(finished?.content).toContain("out-line");
    expect(finished?.content).toContain("err-line");
  });
});

test("oversized bash output is bounded for the model and spilled to a file", async () => {
  await withTempDir(async (dir) => {
    const extra = 80;
    const project = { root: dir, launchCwd: dir, extraRoots: [] };
    const session = createSession([user("big")]);
    let fed = "";
    await collect(
      runAgentLoop({
        session,
        model: createScriptedModel({
          responses: [
            {
              toolCalls: [
                {
                  id: "big",
                  name: "bash",
                  arguments: {
                    command: `bun -e 'process.stdout.write("x".repeat(${MAX_BASH_BYTES + extra}))'`,
                  },
                },
              ],
            },
            (request) => {
              fed = resultContent(request, "big");
              return { text: "summarized" };
            },
          ],
        }),
        contextManager: createContextManager(project),
        tools: createToolRegistry([bashTool]),
        workspace: project,
      }),
    );

    expect(fed).toContain("truncated");
    expect(fed.includes("x".repeat(MAX_BASH_BYTES + extra))).toBe(false);
    expect(fed).toContain("Full output:");
  });
});

test("the next Responses request carries bounded non-ASCII bash output and the notice", async () => {
  await withTempDir(async (dir) => {
    // 20,000 Thai characters: 20,000 UTF-16 units but 60,000 UTF-8 bytes.
    const full = "ก".repeat(20_000);
    await writeFile(join(dir, "emit.js"), `process.stdout.write(${JSON.stringify(full)});`);
    const project = { root: dir, launchCwd: dir, extraRoots: [] };
    const session = createSession([user("scrape")]);
    let next: ModelRequest | undefined;
    await collect(
      runAgentLoop({
        session,
        model: createScriptedModel({
          responses: [
            { toolCalls: [{ id: "scrape", name: "bash", arguments: { command: "bun emit.js" } }] },
            (request) => {
              next = request;
              return { text: "done" };
            },
          ],
        }),
        contextManager: createContextManager(project),
        tools: createToolRegistry([bashTool]),
        workspace: project,
      }),
    );

    const body = buildResponsesRequest({ model: "grok-4.7", maxOutputTokens: 8192, request: next!, namespace: "xai" });
    const outputs = body.input.filter(item => "type" in item && item.type === "function_call_output");
    expect(outputs).toHaveLength(1);
    const output = (outputs[0] as { output: string }).output;
    const kept = "ก".repeat(Math.floor(MAX_BASH_BYTES / 3));
    expect(output.startsWith(`Exit code: 0\n\nstdout:\n${kept}\n\n[Output truncated: showing ${utf8ByteLength(kept)} of 60000 bytes. Full output: `)).toBe(true);
    expect(output).toEndWith(". Use read with offset to see the rest.]");
    expect(output.includes(full)).toBe(false);
    expect(output.isWellFormed()).toBe(true);
  });
});

test("bash timeout yields one error result and the loop continues", async () => {
  await withTempDir(async (dir) => {
    const project = { root: dir, launchCwd: dir, extraRoots: [] };
    const session = createSession([user("sleep")]);
    const started = Date.now();
    const events = await collect(
      runAgentLoop({
        session,
        model: createScriptedModel({
          responses: [
            {
              toolCalls: [
                {
                  id: "slow",
                  name: "bash",
                  arguments: { command: "sleep 30", timeout: 200 },
                },
              ],
            },
            { text: "recovered" },
          ],
        }),
        contextManager: createContextManager(project),
        tools: createToolRegistry([bashTool]),
        workspace: project,
      }),
    );
    expect(Date.now() - started).toBeLessThan(3000);
    const results = session.items.filter(
      (item): item is ToolResult => item.type === "tool_result",
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.content.toLowerCase()).toContain("timed out");
    expect(events.filter((event) => event.type === "tool.finished")).toHaveLength(
      1,
    );
    expect(events).toContainEqual({
      type: "tool.finished",
      toolCallId: "slow",
      name: "bash",
      status: "error",
      content: results[0]!.content,
      details: expect.objectContaining({ timedOut: true }),
      startedAt: expect.any(String),
      durationMs: expect.any(Number),
    });
    expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
    const assistant = session.items.at(-1) as AssistantMessage;
    expect(assistant.content).toEqual([{ type: "text", text: "recovered" }]);
  });
});

test("cancelling a running bash command yields exactly one cancelled result", async () => {
  await withTempDir(async (dir) => {
    const project = { root: dir, launchCwd: dir, extraRoots: [] };
    const session = createSession([user("run")]);
    const controller = new AbortController();
    const events = [];
    const loop = runAgentLoop({
      session,
      model: createScriptedModel({
        responses: [
          {
            toolCalls: [
              {
                id: "b1",
                name: "bash",
                arguments: { command: "echo start; sleep 30" },
              },
            ],
          },
          { text: "should not run" },
        ],
      }),
      contextManager: createContextManager(project),
      tools: createToolRegistry([bashTool]),
      workspace: project,
      signal: controller.signal,
    });
    for await (const event of loop) {
      events.push(event);
      if (
        event.type === "tool.delta" &&
        event.stream === "stdout" &&
        event.text.includes("start")
      ) {
        controller.abort();
      }
    }
    const results = session.items.filter(
      (item): item is ToolResult => item.type === "tool_result",
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBe("Tool call cancelled");
    expect(results[0]?.isError).toBe(true);
    expect(events.filter((event) => event.type === "tool.finished")).toHaveLength(
      1,
    );
    expect(events.at(-1)).toEqual({
      type: "agent.finished",
      reason: "cancelled",
    });
  });
});

test("changing directory in bash does not change later path resolution or default cwd", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "root.txt"), "from-root\n");
    const project = { root: dir, launchCwd: dir, extraRoots: [] };
    const session = createSession([user("isolate cwd")]);
    let bashPwd = "";
    let readBack = "";
    await collect(
      runAgentLoop({
        session,
        model: createScriptedModel({
          responses: [
            {
              toolCalls: [
                {
                  id: "cd",
                  name: "bash",
                  arguments: { command: "cd sub && echo leaked > gone.txt" },
                },
              ],
            },
            {
              toolCalls: [
                {
                  id: "pwd",
                  name: "bash",
                  arguments: { command: "cat root.txt && test ! -f gone.txt" },
                },
              ],
            },
            {
              toolCalls: [
                { id: "read-root", name: "read", arguments: { path: "root.txt" } },
                {
                  id: "read-leaked",
                  name: "read",
                  arguments: { path: "gone.txt" },
                },
                {
                  id: "read-sub",
                  name: "read",
                  arguments: { path: "sub/gone.txt" },
                },
              ],
            },
            (request) => {
              bashPwd = resultContent(request, "pwd");
              readBack = resultContent(request, "read-root");
              const missing = resultContent(request, "read-leaked");
              const nested = resultContent(request, "read-sub");
              return {
                text: `${bashPwd} ${readBack} ${missing} ${nested}`,
              };
            },
          ],
        }),
        contextManager: createContextManager(project),
        tools: createToolRegistry([bashTool, readTool]),
        workspace: project,
      }),
    );

    expect(bashPwd).toContain("from-root");
    expect(bashPwd).toContain("Exit code: 0");
    expect(readBack).toContain("from-root");
    const leaked = session.items.find(
      (item): item is ToolResult =>
        item.type === "tool_result" && item.toolCallId === "read-leaked",
    );
    expect(leaked?.isError).toBe(true);
    const nested = session.items.find(
      (item): item is ToolResult =>
        item.type === "tool_result" && item.toolCallId === "read-sub",
    );
    expect(nested?.isError).toBe(false);
    expect(nested?.content).toContain("leaked");
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
