// Rewritten by scripts/session-fixture.ts; all Schway execution uses the installed release.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createContextManager } from "../../src/context/manager.ts";
import type { Model, ModelStreamEvent } from "../../src/model/model.ts";
import { createJsonlSession } from "../../src/session/jsonl.ts";
import { readTool } from "../../src/tools/read.ts";
import { writeTool } from "../../src/tools/write.ts";
import { createToolRegistry } from "../../src/tools/registry.ts";
import { TuiController } from "../../src/tui/controller.ts";

const root = process.cwd();
const home = process.env.HOME!;
const version = process.env.SCHWAY_FIXTURE_VERSION!;
const hasUndo = Bun.semver.order(version, "0.6.0") >= 0;
const directory = join(home, "fixture");
await mkdir(directory);
await writeFile(join(root, "input.txt"), "Fixture input\n");
const workspace = { root, launchCwd: root, extraRoots: [] };
const session = await createJsonlSession({ directory, workspace });
let calls = 0;
const model: Model = {
  provider: "scripted", id: "fixture",
  /** Supply fixed tool calls, branch replies and the manual compaction summary without network access. */
  async *stream(): AsyncGenerator<ModelStreamEvent> {
    calls++;
    const text = calls === 2 ? "Shared reply" : calls === 3 ? "FIXTURE_ALT" : calls === 5 ? "FIXTURE_MAIN" : "FIXTURE_SUMMARY";
    const content = calls === 1 || calls === 4 ? [{
      type: "tool_call" as const, id: `tool-${calls}`, name: calls === 1 ? "read" : "write",
      arguments: calls === 1 ? { path: "input.txt" } : { path: "changed.txt", content: "Fixture change\n" },
    }] : [{ type: "text" as const, text }];
    yield { type: "message_complete", message: { type: "assistant", id: `reply-${calls}`, content } };
  },
};
const controller = new TuiController({
  session, sessionId: session.header.id, workspace, home, model,
  provider: "scripted", modelId: "fixture", changeTracking: "off",
  contextManager: createContextManager(workspace, { home, keepTurns: 1 }),
  tools: createToolRegistry([readTool, writeTool]),
});
try {
  await controller.submit("Read the shared input");
  assert.equal(calls, 2);
  assert(session.items.some(item => item.type === "tool_result" && !item.isError));
  const alternateBranchId = session.forkBranch(session.items.at(-1)!.id, "alternate");
  await controller.submit("FIXTURE_ALT request");
  session.selectBranch("main");
  await controller.submit("FIXTURE_MAIN request: write changed.txt");
  assert.equal(calls, 5);
  if (hasUndo) {
    assert(await controller.undoCommand(""));
    assert(controller.snapshot().undoPreview);
    await controller.applyUndo();
    assert(session.items.some(item => item.type === "turn_undo"));
  }
  assert(await controller.compact());
  assert.equal(calls, 6);
  assert(session.items.some(item => item.type === "compaction" && item.summary === "FIXTURE_SUMMARY"));
  const undo = session.items.find(item => item.type === "turn_undo");
  await writeFile(join(directory, "expect.json"), JSON.stringify({
    sessionId: session.header.id, mainBranchId: "main", alternateBranchId,
    version: session.header.version,
    markers: { main: "FIXTURE_MAIN", alternate: "FIXTURE_ALT", summary: "FIXTURE_SUMMARY" },
    hasUndo, ...(undo?.type === "turn_undo" ? { undoNote: undo.note } : {}),
  }, null, 2) + "\n");
} finally {
  controller.dispose();
}
