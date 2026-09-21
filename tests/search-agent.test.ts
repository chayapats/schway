import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runAgentLoop } from "../src/agent/loop.ts";
import { createContextManager } from "../src/context/manager.ts";
import type { ToolResult } from "../src/conversation/types.ts";
import type { ModelRequest } from "../src/model/model.ts";
import { createSession } from "../src/session/session.ts";
import { findTool } from "../src/tools/find.ts";
import { grepTool } from "../src/tools/grep.ts";
import { lsTool } from "../src/tools/ls.ts";
import { readTool } from "../src/tools/read.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { withTempDir } from "./helpers.ts";
import { collect, createScriptedModel } from "./helpers/scripted-model.ts";

test("scripted model traverses ls, find, grep, and read through the real loop", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "src"));
    await mkdir(join(dir, "my dir"));
    await mkdir(join(dir, "nested"));
    await writeFile(join(dir, "README.md"), "docs\n");
    await writeFile(join(dir, "src", "app.ts"), "export const LocateMe = 1;\n");
    await writeFile(join(dir, "my dir", "a file.ts"), "export const other = 2;\n");
    await writeFile(join(dir, "nested", "deep.ts"), "export const buried = 3;\n");

    const project = { root: dir, launchCwd: dir, extraRoots: [] };
    const session = createSession([
      {
        type: "user",
        id: "u1",
        content: [{ type: "text", text: "Where is LocateMe?" }],
      },
    ]);

    const seen: Record<string, string> = {};
    const events = await collect(
      runAgentLoop({
        session,
        model: createScriptedModel({
          responses: [
            {
              toolCalls: [
                { id: "ls1", name: "ls", arguments: { depth: 1 } },
              ],
            },
            (request) => {
              seen.ls = resultContent(request, "ls1");
              return {
                toolCalls: [
                  { id: "find1", name: "find", arguments: { pattern: "**/*.ts" } },
                ],
              };
            },
            (request) => {
              seen.find = resultContent(request, "find1");
              return {
                toolCalls: [
                  {
                    id: "grep1",
                    name: "grep",
                    arguments: {
                      pattern: "locateme",
                      glob: "*.ts",
                      ignoreCase: true,
                    },
                  },
                ],
              };
            },
            (request) => {
              seen.grep = resultContent(request, "grep1");
              const parsed = parseGrepHit(seen.grep);
              return {
                toolCalls: [
                  {
                    id: "read1",
                    name: "read",
                    arguments: {
                      path: parsed.path,
                      offset: parsed.line,
                      limit: 1,
                    },
                  },
                ],
              };
            },
            (request) => {
              seen.read = resultContent(request, "read1");
              return { text: `found ${seen.read}` };
            },
          ],
        }),
        contextManager: createContextManager(project),
        tools: createToolRegistry([lsTool, findTool, grepTool, readTool]),
        workspace: project,
      }),
    );

    expect(seen.ls).toContain("src/");
    expect(seen.ls).toContain("my dir/");
    expect(seen.ls.includes("app.ts")).toBe(false);
    expect(seen.ls.includes("deep.ts")).toBe(false);

    expect(seen.find).toContain("src/app.ts");
    expect(seen.find).toContain("my dir/a file.ts");
    expect(seen.find).toContain("nested/deep.ts");

    expect(seen.grep).toContain("src/app.ts:1:");
    expect(seen.grep.toLowerCase()).toContain("locateme");
    expect(seen.grep.includes("buried")).toBe(false);

    expect(seen.read).toContain("LocateMe");
    expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
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

/** Parse `path:line:text` from the first grep hit. */
function parseGrepHit(content: string): { path: string; line: number } {
  const first = content.split("\n")[0] ?? "";
  const match = /^(.*):(\d+):/.exec(first);
  if (!match) {
    throw new Error(`expected grep hit, got ${content}`);
  }
  return { path: match[1]!, line: Number(match[2]) };
}
