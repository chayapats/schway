import { expect, test } from "bun:test";
import { join } from "node:path";

test("headless CLI startup has no TUI dependency", async () => {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "../src/cli/main.ts")],
    target: "bun",
  });
  expect(result.success).toBe(true);
  const outputs = await Promise.all(
    result.outputs.map((output) => output.text()),
  );
  const bundle = outputs.join("\n");
  expect(bundle.includes("@opentui")).toBe(false);
  expect(bundle.includes("/tui/")).toBe(false);
});

test("core modules do not import provider SDKs", async () => {
  const files = [
    "src/agent/loop.ts",
    "src/agent/scheduler.ts",
    "src/agent/events.ts",
    "src/conversation/types.ts",
    "src/context/manager.ts",
    "src/session/session.ts",
    "src/workspace/workspace.ts",
    "src/cli/args.ts",
    "src/tools/types.ts",
    "src/tools/schema.ts",
    "src/tools/registry.ts",
    "src/tools/executor.ts",
    "src/tools/read.ts",
    "src/tools/write.ts",
    "src/tools/edit.ts",
    "src/tools/bash.ts",
    "src/tools/fs.ts",
    "src/tools/path.ts",
  ];
  for (const file of files) {
    const source = await Bun.file(file).text();
    expect(source.includes("@anthropic-ai/sdk")).toBe(false);
    expect(source.includes("providers/anthropic")).toBe(false);
  }
});

test("headless CLI loads the Anthropic provider only after selection", async () => {
  const source = await Bun.file("src/cli/main.ts").text();
  expect(source.includes('from "@anthropic-ai/sdk"')).toBe(false);
  expect(source.includes('from "../model/providers/anthropic.ts"')).toBe(false);
  expect(source.includes('import("../model/providers/anthropic.ts")')).toBe(true);
});
