// Copied into a clean consumer with Schway imports rewritten to the installed artifact.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createContextManager } from "../../src/context/manager.ts";
import type { Model, ModelRequest, ModelStreamEvent } from "../../src/model/model.ts";
import { createJsonlSession, loadJsonlSession } from "../../src/session/jsonl.ts";
import { readTool } from "../../src/tools/read.ts";
import { writeTool } from "../../src/tools/write.ts";
import { createToolRegistry } from "../../src/tools/registry.ts";
import { TuiController } from "../../src/tui/controller.ts";
import { invokeSkillTurn } from "../../src/tui/app.ts";

const root = process.cwd();
const extra = join(root, "attached");
const home = process.env.HOME!;
const sessions = join(root, "sessions");
const skillDir = join(extra, ".agents/skills/attached");
await mkdir(skillDir, { recursive: true });
await writeFile(join(extra, "AGENTS.md"), "ATTACHED_RULE\n");
await writeFile(join(skillDir, "SKILL.md"), "---\nname: attached\ndescription: Attached project skill\n---\nATTACHED_SKILL\n");
const workspace = { root, launchCwd: root, extraRoots: [extra] };
const session = await createJsonlSession({ directory: sessions, workspace });
const manager = createContextManager(workspace, { home });
const tools = createToolRegistry([readTool, writeTool]);
let calls = 0;
const model: Model = {
  provider: "scripted", id: "installed", async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
    calls++;
    if (calls === 1) {
      assert(request.context.some((entry: any) => entry.name === "active-skill" && entry.content.includes("ATTACHED_SKILL")), `Missing skill: ${JSON.stringify(request.context)}`);
      assert(request.context.some((entry: any) => entry.name === "environment" && entry.content.includes(extra)), `Missing root: ${JSON.stringify(request.context)}`);
      yield { type: "message_complete", message: { type: "assistant", id: "write-call", content: [
        { type: "tool_call", id: "write-once", name: "write", arguments: { path: "installed-primary.txt", content: "ONCE" } },
      ] } };
    } else if (calls === 2) {
      assert(request.items.some((item: any) => item.type === "tool_result" && item.toolCallId === "write-once" && !item.isError));
      yield { type: "message_complete", message: { type: "assistant", id: "common-reply", content: [{ type: "text", text: "common" }] } };
    } else {
      const content = JSON.stringify(request.items);
      const summary = request.context.find((entry: any) => entry.name === "summary")?.content ?? "";
      if (calls === 3) assert(!content.includes("main-only"));
      if (calls === 4) { assert(!content.includes("alt-only")); assert(!summary.includes("ALT_SUMMARY")); }
      if (calls === 5) { assert(summary.includes("ALT_SUMMARY")); assert(content.includes("alt-only")); assert(!content.includes("main-only")); }
      yield { type: "message_complete", message: { type: "assistant", id: `reply-${calls}`, content: [{ type: "text", text: calls === 3 ? "alt-only" : calls === 4 ? "main-only" : "alt-resumed" }] } };
    }
  },
};
const createController = (current: typeof session, contextManager = createContextManager(workspace, { home })) => new TuiController({
  session: current, sessionId: session.header.id, workspace, home,
  contextManager, tools, model, provider: "scripted", modelId: "installed",
});
let controller = createController(session, manager);
try {
  await invokeSkillTurn({ name: "attached", args: "now", raw: "/attached now" }, {
    controller, home, skillScope: { manager, workspaceRoot: root },
  });
  assert.equal(calls, 2, JSON.stringify(controller.snapshot().transcript));
  assert.equal(await readFile(join(root, "installed-primary.txt"), "utf8"), "ONCE");
  assert.equal(await Bun.file(join(extra, "installed-primary.txt")).exists(), false);
  const fork = session.forkBranch(session.items.at(-1)!.id, "alternate");
  await controller.submit("alternate work");
  session.append({ type: "compaction", id: "alt-summary", firstKeptId: session.items[0]!.id, summary: "ALT_SUMMARY" });
  assert(controller.openBranchTree());
  assert(controller.activateBranchTreeBranch("main"));
  await controller.submit("main work");
  assert(!controller.snapshot().transcript.some((entry: any) => entry.text.includes("ALT_SUMMARY")));
  controller.dispose();
  const restored = await loadJsonlSession({ directory: sessions, id: session.header.id });
  assert.deepEqual(restored.metadata.extraRoots, [extra]);
  assert.deepEqual(restored.header.extraRoots, [extra]);
  assert.equal(restored.activeBranchId, "main");
  controller = createController(restored);
  assert(controller.openBranchTree());
  assert(controller.activateBranchTreeBranch(fork));
  assert(controller.snapshot().transcript.some((entry: any) => entry.text.includes("ALT_SUMMARY")));
  await controller.submit("resume alternate");
  assert.equal(await readFile(join(root, "installed-primary.txt"), "utf8"), "ONCE");
  assert.equal(calls, 5);
  const persisted = await readFile(join(sessions, `${session.header.id}.jsonl`), "utf8");
  assert(!persisted.includes("model.delta"));
  assert(!persisted.includes("tool.delta"));
  assert.equal(restored.items.filter((item) => item.type === "tool_result" && item.toolCallId === "write-once").length, 1);
  console.log(JSON.stringify({ status: "passed", scenarios: ["attached-skill", "primary-tool-root", "branch-tree", "compaction-resume"] }));
} finally {
  controller.dispose();
}
