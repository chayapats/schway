import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { TextareaRenderable } from "@opentui/core";
import { createContextManager } from "../src/context/manager.ts";
import { createJsonlSession, loadJsonlSession } from "../src/session/jsonl.ts";
import { bashTool } from "../src/tools/bash.ts";
import { editTool } from "../src/tools/edit.ts";
import { readTool } from "../src/tools/read.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { TuiController } from "../src/tui/controller.ts";
import { dispatchEditorInput } from "../src/tui/commands.ts";
import { createConversationView } from "../src/tui/view.ts";
import { withTempDir } from "./helpers.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";

test("Thai task keeps tool effects, keyboard reading, review, and compacted resume in one journey", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const home = join(root, "home");
    const directory = join(home, "sessions");
    const original = join(root, "task.txt");
    await writeFile(original, "BUG\n");
    for (const args of [["init", "-q"], ["add", "task.txt"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "baseline"]]) {
      const result = Bun.spawnSync(["git", ...args], { cwd: root, env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
      expect(result.exitCode).toBe(0);
    }
    const session = await createJsonlSession({ directory, workspace });
    for (let index = 0; index < 4; index++) session.append(
      { type: "user", id: `older-user-${index}`, content: [{ type: "text", text: `Earlier task ${index}` }] },
      { type: "assistant", id: `older-answer-${index}`, content: [{ type: "text", text: `Earlier answer ${index}` }] },
    );
    const model = createScriptedModel({ responses: [
      { toolCalls: [{ id: "read-journey", name: "read", arguments: { path: "task.txt" } }] },
      request => {
        expect(request.items.find(item => item.type === "tool_result" && item.toolCallId === "read-journey")?.content).toContain("BUG");
        return { toolCalls: [{ id: "edit-journey", name: "edit", arguments: { path: "task.txt", edits: [{ oldText: "BUG", newText: "FIXED" }] } }] };
      },
      { toolCalls: [{ id: "check-journey", name: "bash", arguments: { command: "test \"$(cat task.txt)\" = FIXED", timeout: 1000 } }] },
      { text: "Finished FIXED after the observed check." },
      { text: "Summary: the Thai task changed task.txt to FIXED and its check exited zero." },
    ] });
    const manager = createContextManager(workspace, { home, keepTurns: 2 });
    const controller = new TuiController({ session, sessionId: session.header.id, workspace, home,
      provider: "scripted", modelId: "scripted", model, contextManager: manager,
      tools: createToolRegistry([readTool, editTool, bashTool]), changeTracking: "on-demand" });
    const terminal = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true });
    const copied: string[] = [];
    terminal.renderer.copyToClipboardOSC52 = text => { copied.push(text); return true; };
    const view = createConversationView(terminal.renderer, { controller, home, workspaceRoot: root, env: {}, secrets: [],
      quit() {}, submit: (value, accepted) => dispatchEditorInput(value, controller, async () => false, accepted) });
    const editor = terminal.renderer.root.findDescendantById("prompt") as TextareaRenderable;
    const settle = async () => { view.refresh(); await terminal.flush(); };
    const waitFor = async (ready: () => boolean) => {
      const deadline = Date.now() + 5_000;
      while (!ready() && Date.now() < deadline) { await Bun.sleep(10); await settle(); }
      expect(ready()).toBe(true);
    };
    try {
      await settle();
      const task = "แก้ BUG ใน task.txt\nตรวจผลแล้วสรุปภาษาไทย";
      await terminal.mockInput.pasteBracketedText(task);
      expect(editor.plainText).toBe(task);
      terminal.mockInput.pressEnter();
      await controller.waitForIdle();
      await settle();
      expect(controller.snapshot().outcome?.reason).toBe("completed");
      expect(controller.snapshot().outcome?.commands).toMatchObject([{ callId: "check-journey", exitCode: 0 }]);
      expect(await readFile(original, "utf8")).toBe("FIXED\n");
      expect(session.items.filter(item => item.type === "tool_result")).toHaveLength(3);
      expect(session.items.some(item => item.type === "user" && item.content[0]?.type === "text" && item.content[0].text === task)).toBe(true);
      expect(terminal.captureCharFrame()).toContain("Finished FIXED");

      await terminal.mockInput.pasteBracketedText("keep this next task");
      terminal.mockInput.pressKey("i", { meta: true });
      await settle();
      terminal.mockInput.pressKey("c");
      expect(copied.at(-1)).toContain("BUG");
      terminal.mockInput.pressEscape();
      expect(editor.plainText).toBe("keep this next task");
      terminal.mockInput.pressKey("f", { ctrl: true });
      await terminal.mockInput.typeText("FIXED");
      await waitFor(() => terminal.captureCharFrame().includes("Find 1/"));
      terminal.mockInput.pressEnter();
      await settle();
      expect(editor.plainText).toBe("keep this next task");

      terminal.mockInput.pressKey("r", { meta: true });
      await waitFor(() => !!controller.snapshot().changeReview && !controller.snapshot().changeReview?.loading);
      expect(controller.snapshot().changeReview?.files.map(file => file.path)).toContain("task.txt");
      expect(controller.snapshot().changeReview?.heading).toBe("Review · turn 5");
      terminal.mockInput.pressKey("i", { ctrl: true });
      await settle();
      expect(controller.snapshot().changeReview?.showingDetails).toBe(true);
      expect(controller.snapshot().changeReview?.details).toContain('test "$(cat task.txt)" = FIXED → exit 0');
      expect(controller.snapshot().changeReview?.details).not.toContain("check-journey");
      terminal.mockInput.pressEscape();
      expect(controller.snapshot().changeReview?.showingDetails).toBe(false);
      terminal.mockInput.pressEscape();
      expect(editor.plainText).toBe("keep this next task");
      expect(await controller.compact()).toBe(true);
      expect(controller.snapshot().context.summaryId).toBeDefined();
      const recordedResults = session.items.filter(item => item.type === "tool_result").length;
      const reopened = await loadJsonlSession({ directory, id: session.header.id });
      expect(reopened.items.filter(item => item.type === "tool_result")).toHaveLength(recordedResults);
      const resumed = new TuiController({ session: reopened, sessionId: session.header.id, workspace, home,
        provider: "scripted", modelId: "scripted", model, contextManager: manager });
      try {
        expect(resumed.snapshot().context.summaryId).toBeDefined();
        expect(await readFile(original, "utf8")).toBe("FIXED\n");
      } finally { resumed.dispose(); }
    } finally { view.destroy(); controller.dispose(); terminal.renderer.destroy(); }
  });
}, 20_000);
