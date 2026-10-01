import { expect, test } from "bun:test";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { TuiController } from "../src/tui/controller.ts";
import { createConversationView } from "../src/tui/view.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { readTool } from "../src/tools/read.ts";
import { editTool } from "../src/tools/edit.ts";
import { bashTool } from "../src/tools/bash.ts";
import { resolveWorkspace } from "../src/workspace/workspace.ts";
import { createDemoModel, createDemoWorkspace } from "./fixtures/readme-demo-scenario.ts";
import { withTempDir } from "./helpers.ts";

test("the offline README demo fixes clamp, runs its test and renders review without private paths", async () => {
  await withTempDir(async root => {
    const { home, workspace: cwd } = await createDemoWorkspace(root);
    const workspace = await resolveWorkspace(cwd);
    const controller = new TuiController({
      session: createSession(), sessionId: "readme-demo", workspace, home,
      provider: "demo", modelId: "offline-model", model: createDemoModel(),
      contextManager: createContextManager(workspace, { home }),
      tools: createToolRegistry([readTool, editTool, bashTool]),
    });
    const terminal = await createTestRenderer({ width: 120, height: 32 });
    const view = createConversationView(terminal.renderer, {
      controller, home, workspaceRoot: cwd, secrets: [],
      env: { HOME: home, SCHWAY_THEME: "dark", SCHWAY_MOTION: "reduced" },
      submit: value => controller.submit(value), quit: () => {},
    });
    try {
      await terminal.flush();
      expect(terminal.captureCharFrame()).toContain("demo/offline-model");
      expect(terminal.captureCharFrame()).toContain("~/clamp-demo on main");
      await controller.submit("Fix clamp so it respects the upper bound");
      expect(await Bun.file(join(cwd, "src/clamp.ts")).text()).toContain("return Math.min(hi, Math.max(lo, n));");
      expect(controller.snapshot().outcome?.commands[0]?.exitCode).toBe(0);
      expect(controller.snapshot().outcome?.reason).toBe("completed");
      expect(controller.snapshot().transcript.map(entry => entry.text).join("\n")).not.toContain(root);
      view.refresh();
      await terminal.flush();
      const finished = terminal.captureCharFrame();
      expect(finished).toContain("Fixed clamp so it respects the upper bound.");
      expect(finished).toContain("return Math.min(hi, Math.max(lo, n));");
      expect(finished).toContain("1 file +1 −1 · 1 command ok");
      expect(finished).toContain("Alt+R review");
      expect(finished).not.toContain(root);
      await controller.openChangeReview();
      view.refresh();
      await terminal.flush();
      const review = terminal.captureCharFrame();
      expect(review).toContain("Review · turn 1");
      expect(review).toContain("src/clamp.ts");
      expect(review).toContain("return Math.min(hi, Math.max(lo, n));");
      expect(review).not.toContain(root);
    } finally {
      view.destroy();
      controller.dispose();
      terminal.renderer.destroy();
    }
  });
});

test("the committed README recording fits the 2 MB budget", async () => {
  const gif = Bun.file("docs/demo/schway-demo.gif");
  expect(await gif.exists()).toBe(true);
  expect(gif.size).toBeGreaterThan(0);
  expect(gif.size).toBeLessThanOrEqual(2_097_152);
  expect(new TextDecoder().decode((await gif.bytes()).subarray(0, 6))).toMatch(/^GIF8[79]a$/);
});
