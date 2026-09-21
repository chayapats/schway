import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runAgentLoop } from "../src/agent/loop.ts";
import { createContextManager } from "../src/context/manager.ts";
import type { ModelRequest } from "../src/model/model.ts";
import { createJsonlSession, loadJsonlSession } from "../src/session/jsonl.ts";
import { bashTool } from "../src/tools/bash.ts";
import { editTool } from "../src/tools/edit.ts";
import { findTool } from "../src/tools/find.ts";
import { grepTool } from "../src/tools/grep.ts";
import { lsTool } from "../src/tools/ls.ts";
import { readTool } from "../src/tools/read.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { writeTool } from "../src/tools/write.ts";
import { withTempDir } from "./helpers.ts";
import { collect, createScriptedModel } from "./helpers/scripted-model.ts";

/** Return the model-facing content for a tool_result in a later model request. */
function toolContent(request: ModelRequest, toolCallId: string): string {
  const item = request.items.find(
    (entry) => entry.type === "tool_result" && entry.toolCallId === toolCallId,
  );
  if (item?.type !== "tool_result") {
    throw new Error(`missing tool result for ${toolCallId}`);
  }
  return item.content;
}

/** True when scoped AGENTS.md instructions are present on the model request. */
function hasProjectInstructions(request: ModelRequest): boolean {
  const section = request.context.find((entry) => entry.name === "project-instructions");
  return section?.content.includes("BUG markers") ?? false;
}

/**
 * Deterministic end-to-end v0.1 coding task.
 *
 * A scripted model locates code with parallel search/read calls, applies an
 * exclusive edit behind the scheduler barrier, creates a file, verifies with
 * bash, then the session is reloaded from JSONL and compacted. Success is
 * checked from actual files and command exit results, not the model's claims.
 */
test("v0.1 coding workflow locates, edits, verifies, resumes, and compacts", async () => {
  await withTempDir(async (dir) => {
    const project = join(dir, "project");
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(
      join(project, "AGENTS.md"),
      "# Project\n\nAlways fix BUG markers by replacing them with FIXED.\n",
    );
    await writeFile(join(project, "README.md"), "demo project\n");
    await writeFile(join(project, "src", "app.ts"), "export const value = 1; // BUG\n");
    await writeFile(join(project, "src", "other.ts"), "export const other = 2;\n");

    const sessions = join(dir, "sessions");
    const workspace = { root: project, launchCwd: project, extraRoots: [] };
    const session = await createJsonlSession({ directory: sessions, workspace });
    session.append({
      type: "user",
      id: "u1",
      content: [{ type: "text", text: "Fix the BUG marker in src/app.ts" }],
    });

    const seen: Record<string, string> = {};
    let sawInstructions = false;
    const tools = createToolRegistry([
      readTool,
      writeTool,
      editTool,
      bashTool,
      grepTool,
      findTool,
      lsTool,
    ]);

    const events = await collect(
      runAgentLoop({
        session,
        model: createScriptedModel({
          responses: [
            // Parallel search/read round: two parallel-safe calls in one turn.
            (request) => {
              if (hasProjectInstructions(request)) {
                sawInstructions = true;
              }
              return {
                toolCalls: [
                  { id: "ls1", name: "ls", arguments: { depth: 1 } },
                  { id: "read1", name: "read", arguments: { path: "src/other.ts" } },
                ],
              };
            },
            (request) => {
              if (hasProjectInstructions(request)) {
                sawInstructions = true;
              }
              seen.ls = toolContent(request, "ls1");
              seen.other = toolContent(request, "read1");
              return {
                toolCalls: [
                  {
                    id: "grep1",
                    name: "grep",
                    arguments: { pattern: "BUG", path: "src" },
                  },
                ],
              };
            },
            (request) => {
              seen.grep = toolContent(request, "grep1");
              expect(seen.grep).toContain("src/app.ts");
              return {
                toolCalls: [{ id: "read2", name: "read", arguments: { path: "src/app.ts" } }],
              };
            },
            (request) => {
              seen.app = toolContent(request, "read2");
              expect(seen.app).toContain("BUG");
              // Exclusive barrier: edit runs alone after the parallel reads.
              return {
                toolCalls: [
                  {
                    id: "edit1",
                    name: "edit",
                    arguments: {
                      path: "src/app.ts",
                      edits: [
                        {
                          oldText: "export const value = 1; // BUG",
                          newText: "export const value = 2; // FIXED",
                        },
                      ],
                    },
                  },
                ],
              };
            },
            (request) => {
              seen.edit = toolContent(request, "edit1");
              return {
                toolCalls: [
                  {
                    id: "write1",
                    name: "write",
                    arguments: { path: "NOTES.md", content: "fixed\n" },
                  },
                ],
              };
            },
            (request) => {
              seen.write = toolContent(request, "write1");
              return {
                toolCalls: [
                  {
                    id: "bash1",
                    name: "bash",
                    arguments: { command: "grep -q FIXED src/app.ts && test -f NOTES.md" },
                  },
                ],
              };
            },
            (request) => {
              seen.bash = toolContent(request, "bash1");
              expect(seen.bash.toLowerCase()).toContain("exit code: 0");
              return { text: "fixed and verified" };
            },
          ],
        }),
        contextManager: createContextManager(workspace),
        tools,
        workspace,
      }),
    );

    expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });

    // Project instructions reached the model through scoped AGENTS.md discovery.
    expect(sawInstructions).toBe(true);

    // Search/read observations came from real tool execution.
    expect(seen.ls).toContain("src/");
    expect(seen.other).toContain("other = 2");
    expect(seen.grep).toContain("BUG");

    // Success is checked from actual files and command exit results.
    const appSource = await readFile(join(project, "src", "app.ts"), "utf8");
    expect(appSource).toContain("FIXED");
    expect(appSource.includes("BUG")).toBe(false);
    const notes = await readFile(join(project, "NOTES.md"), "utf8");
    expect(notes).toBe("fixed\n");

    // The durable session reloads and continues without replaying tool effects.
    const resumed = await loadJsonlSession({ directory: sessions, id: session.header.id });
    expect(resumed.items.length).toBeGreaterThan(0);
    resumed.append({
      type: "user",
      id: "u2",
      content: [{ type: "text", text: "Confirm the fix is still present" }],
    });
    const resumeEvents = await collect(
      runAgentLoop({
        session: resumed,
        model: createScriptedModel({
          responses: [
            {
              toolCalls: [{ id: "read3", name: "read", arguments: { path: "src/app.ts" } }],
            },
            (request) => {
              const content = toolContent(request, "read3");
              expect(content).toContain("FIXED");
              return { text: "confirmed" };
            },
          ],
        }),
        contextManager: createContextManager(workspace),
        tools,
        workspace,
      }),
    );
    expect(resumeEvents.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
    const reread = await readFile(join(project, "src", "app.ts"), "utf8");
    expect(reread).toContain("FIXED");

    // Compaction preserves a durable summary plus retained records.
    const manager = createContextManager(workspace, { keepTurns: 1 });
    const summaryModel = createScriptedModel({
      text: "## Goal\nFix the BUG marker.\n\n## Constraints\nNone.\n\n## Progress\nFixed.\n\n## Key Decisions\nNone.\n\n## Current State\nFIXED.\n\n## Next Steps\nNone.\n\n## Files\nsrc/app.ts, NOTES.md\n",
    });
    const compacted = await manager.compact(resumed, summaryModel, { reason: "manual" });
    expect(compacted).not.toBeNull();
    expect(resumed.items.some((item) => item.type === "compaction")).toBe(true);

    // Runtime-only deltas were never persisted to the durable JSONL.
    const persisted = await readFile(join(sessions, `${session.header.id}.jsonl`), "utf8");
    expect(persisted.includes('"name":"environment"')).toBe(false);
    expect(JSON.parse(persisted.split("\n")[0]).type).toBe("session");
  });
});
