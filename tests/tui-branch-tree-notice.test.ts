import { expect, test } from "bun:test";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { TuiController } from "../src/tui/controller.ts";
import { withTempDir } from "./helpers.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";

for (const action of ["tree", "show"] as const) {
  test(`/branch ${action} leaves no key notice in the transcript after Esc`, async () => withTempDir(async (dir) => {
    const workspace = { root: dir, launchCwd: dir, extraRoots: [] as string[] };
    const session = createSession();
    session.append({ type: "user", id: "u1", content: [{ type: "text", text: "hello" }] });
    session.append({ type: "assistant", id: "a1", content: [{ type: "text", text: "hi" }] });
    const controller = new TuiController({
      session,
      model: createScriptedModel({ text: "ok" }),
      contextManager: createContextManager(workspace),
      tools: createToolRegistry([]),
      workspace,
      provider: "scripted",
      modelId: "scripted",
      sessionId: "branch-tree-notice",
    });
    try {
      const before = controller.snapshot().transcript.map((entry) => entry.text);
      expect(controller.branchCommand(action)).toBe(true);
      expect(controller.snapshot().branchTree).toBeDefined();
      // The hint row shows the tree keys while it is open; the transcript must not repeat them.
      expect(controller.snapshot().transcript.map((entry) => entry.text)).toEqual(before);
      controller.closeBranchTree();
      expect(controller.snapshot().branchTree).toBeUndefined();
      const after = controller.snapshot().transcript.map((entry) => entry.text);
      expect(after).toEqual(before);
      expect(after.join("\n")).not.toContain("Choose a conversation");
    } finally {
      controller.dispose();
    }
  }));
}
