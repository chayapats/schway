import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runAgentLoop } from "../src/agent/loop.ts";
import { createContextManager } from "../src/context/manager.ts";
import type {
  AssistantMessage,
  ConversationItem,
  ToolResult,
} from "../src/conversation/types.ts";
import type { ModelRequest } from "../src/model/model.ts";
import { createJsonlSession, loadJsonlSession } from "../src/session/jsonl.ts";
import { readTool } from "../src/tools/read.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { withTempDir } from "./helpers.ts";
import { collect, createScriptedModel } from "./helpers/scripted-model.ts";

test("a saved session continues after file tools without persisting runtime deltas", async () => {
  await withTempDir(async (dir) => {
    const project = join(dir, "project");
    await mkdir(project);
    await writeFile(join(project, "note.txt"), "secret-token-123\n");
    const sessions = join(dir, "sessions");
    const workspace = { root: project, launchCwd: project, extraRoots: [] };
    const session = await createJsonlSession({ directory: sessions, workspace });
    session.append({
      type: "user",
      id: "u1",
      content: [{ type: "text", text: "What is in note.txt?" }],
    });

    const events = await collect(
      runAgentLoop({
        session,
        model: createScriptedModel({
          responses: [
            {
              thinkingChunks: ["hmm"],
              message: {
                type: "assistant",
                id: "a1",
                content: [
                  {
                    type: "thinking",
                    text: "hmm",
                    providerMetadata: { thought: "sig" },
                  },
                  {
                    type: "tool_call",
                    id: "call-read",
                    name: "read",
                    arguments: { path: "note.txt" },
                  },
                ],
                providerMetadata: { opaque: "keep-me" },
              },
            },
            (request) => ({
              text: `Found ${toolContent(request.items)}`,
            }),
          ],
        }),
        contextManager: createContextManager(workspace),
        tools: createToolRegistry([readTool]),
        workspace,
      }),
    );

    expect(events.some((event) => event.type === "model.delta")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });

    const records = await readRecords(join(sessions, `${session.header.id}.jsonl`));
    expect(records.map((record) => record.type)).toEqual([
      "session",
      "user",
      "assistant",
      "tool_result",
      "assistant",
    ]);
    expect(JSON.stringify(records).includes('"name":"environment"')).toBe(false);
    expect(JSON.stringify(records).includes("model.delta")).toBe(false);

    const loaded = await loadJsonlSession({
      directory: sessions,
      id: session.header.id,
    });
    const savedAssistant = loaded.items.find(
      (item): item is AssistantMessage => item.id === "a1",
    );
    expect(savedAssistant?.providerMetadata).toEqual({ opaque: "keep-me" });
    loaded.append({
      type: "user",
      id: "u2",
      content: [{ type: "text", text: "remind me" }],
    });

    let continued: ModelRequest | undefined;
    await collect(
      runAgentLoop({
        session: loaded,
        model: createScriptedModel({
          responses: [
            (request) => {
              continued = request;
              return { text: "still there" };
            },
          ],
        }),
        contextManager: createContextManager({
          root: loaded.header.workspaceRoot,
          launchCwd: loaded.header.launchCwd,
          extraRoots: loaded.header.extraRoots,
        }),
      }),
    );

    expect(toolContent(continued?.items ?? [])).toContain("secret-token-123");
    expect(
      continued?.items.find((item): item is AssistantMessage => item.id === "a1")
        ?.providerMetadata,
    ).toEqual({ opaque: "keep-me" });
    expect(continued?.context).toEqual([
      {
        name: "environment",
        content: [
          `Workspace root: ${project}`,
          `Launch directory: ${project}`,
        ].join("\n"),
      },
    ]);
  });
});

/** Read durable JSONL records from a session file. */
async function readRecords(path: string): Promise<Array<{ type: string }>> {
  const text = await Bun.file(path).text();
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { type: string });
}

/** Model-facing text of the first tool result in a request. */
function toolContent(items: readonly ConversationItem[]): string {
  const result = items.find((item): item is ToolResult => item.type === "tool_result");
  return result?.content ?? "";
}
