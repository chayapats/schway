import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runAgentLoop } from "../src/agent/loop.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import type { ToolResult, UserMessage } from "../src/conversation/types.ts";
import { createOpenAIModel } from "../src/model/providers/openai.ts";
import { readTool } from "../src/tools/read.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { withTempDir } from "./helpers.ts";
import { collect } from "./helpers/scripted-model.ts";
import {
  encodeSse,
  TEXT_STREAM_EVENTS,
  TOOL_USE_STREAM_EVENTS,
} from "./fixtures/openai.ts";

test("headless OpenAI loop completes a read-tool conversation without a paid API", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "note.txt"), "hello from workspace\n");
    const bodies: unknown[] = [];
    const model = createOpenAIModel({
      apiKey: "sk-test",
      fetch: async (_input, init) => {
        bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
        const events =
          bodies.length === 1 ? TOOL_USE_STREAM_EVENTS : TEXT_STREAM_EVENTS;
        return new Response(encodeSse(events), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });

    const workspace = { root: dir, launchCwd: dir, extraRoots: [] };
    const session = createSession([
      {
        type: "user",
        id: "u1",
        content: [{ type: "text", text: "read note.txt" }],
      } satisfies UserMessage,
    ]);

    const events = await collect(
      runAgentLoop({
        session,
        model,
        contextManager: createContextManager(workspace),
        tools: createToolRegistry([readTool]),
        workspace,
      }),
    );

    expect(events.some((event) => event.type === "tool.started")).toBe(true);
    expect(events.some((event) => event.type === "tool.finished")).toBe(true);
    expect(events.at(-1)).toEqual({
      type: "agent.finished",
      reason: "completed",
    });
    expect(bodies).toHaveLength(2);

    const second = bodies[1] as { input: Array<{ type?: string; call_id?: string; output?: string }> };
    const toolOutput = second.input.find(
      (item) => item.type === "function_call_output",
    );
    expect(toolOutput?.call_id).toBe("call_read1");
    expect(toolOutput?.output).toContain("hello from workspace");

    const result = session.items.find(
      (item): item is ToolResult => item.type === "tool_result",
    );
    expect(result?.toolCallId).toBe("call_read1");
    expect(result?.content).toContain("hello from workspace");
  });
});
