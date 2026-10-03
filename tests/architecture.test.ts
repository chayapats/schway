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
    "src/text/format.ts",
    "src/text/diff.ts",
    "src/undo/store.ts",
    "src/undo/record.ts",
    "src/agent/approval.ts",
    "src/agent/loop.ts",
    "src/agent/scheduler.ts",
    "src/agent/events.ts",
    "src/agent/retry.ts",
    "src/conversation/types.ts",
    "src/context/manager.ts",
    "src/context/prompt.ts",
    "src/context/agents.ts",
    "src/context/compaction.ts",
    "src/context/tokens.ts",
    "src/session/session.ts",
    "src/session/jsonl.ts",
    "src/workspace/workspace.ts",
    "src/cli/args.ts",
    "src/cli/help.ts",
    "src/config/config.ts",
    "src/config/defaults.ts",
    "src/config/env-file.ts",
    "src/model/catalog.ts",
    "src/tools/types.ts",
    "src/tools/schema.ts",
    "src/tools/registry.ts",
    "src/tools/executor.ts",
    "src/tools/read.ts",
    "src/tools/write.ts",
    "src/tools/edit.ts",
    "src/tools/bash.ts",
    "src/tools/grep.ts",
    "src/tools/find.ts",
    "src/tools/ls.ts",
    "src/tools/fs.ts",
    "src/tools/path.ts",
    "src/extensions/index.ts",
    "src/extensions/loader.ts",
    "src/extensions/runtime.ts",
    "src/extensions/host.ts",
    "src/extensions/hooks.ts",
    "src/extensions/tool-hooks.ts",
    "src/extensions/validation.ts",
  ];
  for (const file of files) {
    const source = await Bun.file(file).text();
    expect(source.includes("@anthropic-ai/sdk")).toBe(false);
    expect(source.includes('from "openai"')).toBe(false);
    expect(source.includes("providers/anthropic")).toBe(false);
    expect(source.includes("providers/openai")).toBe(false);
    expect(source.includes("providers/openai-compatible")).toBe(false);
    expect(source.includes("providers/xai")).toBe(false);
    expect(source.includes("providers/responses-stream")).toBe(false);
  }
});

test("core modules never import the renderer", async () => {
  const files = [
    "src/text/format.ts",
    "src/text/diff.ts",
    "src/undo/store.ts",
    "src/undo/record.ts",
    "src/agent/approval.ts",
    "src/agent/loop.ts",
    "src/agent/scheduler.ts",
    "src/agent/events.ts",
    "src/agent/retry.ts",
    "src/conversation/types.ts",
    "src/context/manager.ts",
    "src/context/prompt.ts",
    "src/context/agents.ts",
    "src/context/compaction.ts",
    "src/context/tokens.ts",
    "src/session/session.ts",
    "src/session/jsonl.ts",
    "src/workspace/workspace.ts",
    "src/cli/args.ts",
    "src/cli/help.ts",
    "src/config/config.ts",
    "src/config/defaults.ts",
    "src/config/env-file.ts",
    "src/model/catalog.ts",
    "src/model/model.ts",
    "src/model/loader.ts",
    "src/tools/types.ts",
    "src/tools/schema.ts",
    "src/tools/registry.ts",
    "src/tools/executor.ts",
    "src/tools/read.ts",
    "src/tools/write.ts",
    "src/tools/edit.ts",
    "src/tools/bash.ts",
    "src/tools/grep.ts",
    "src/tools/find.ts",
    "src/tools/ls.ts",
    "src/tools/fs.ts",
    "src/tools/path.ts",
    "src/extensions/index.ts",
    "src/extensions/loader.ts",
    "src/extensions/runtime.ts",
    "src/extensions/host.ts",
    "src/extensions/hooks.ts",
    "src/extensions/tool-hooks.ts",
    "src/extensions/validation.ts",
  ];
  for (const file of files) {
    const source = await Bun.file(file).text();
    expect(source.includes("@opentui")).toBe(false);
    expect(source.includes("../tui/")).toBe(false);
    expect(source.includes("./tui/")).toBe(false);
  }
});

test("TUI controller stays renderer-free; raw-input-safe renderer module loads OpenTUI lazily", async () => {
  for (const file of ["src/tui/controller.ts", "src/tui/commands.ts", "src/tui/motion-policy.ts", "src/tui/git-head.ts", "src/tui/presentation.ts", "src/tui/theme.ts"]) {
    const source = await Bun.file(file).text();
    expect(source.includes("@opentui")).toBe(false);
  }
  const app = await Bun.file("src/tui/app.ts").text();
  const credentialInput = await Bun.file("src/tui/credential-input.ts").text();
  expect(app.includes('from "./credential-input.ts"')).toBe(true);
  expect(app.includes("@opentui/core")).toBe(false);
  expect(credentialInput.includes('await import("@opentui/core")')).toBe(true);
  expect(credentialInput.indexOf('process.env.OTUI_STDIN_LOG = ""')).toBeLessThan(credentialInput.indexOf('await import("@opentui/core")'));
});

test("provider adapters load lazily through the shared loader", async () => {
  for (const file of ["src/cli/main.ts", "src/cli/runtime.ts", "src/tui/app.ts"]) {
    const source = await Bun.file(file).text();
    expect(source.includes('from "@anthropic-ai/sdk"')).toBe(false);
    expect(source.includes('from "openai"')).toBe(false);
    expect(source.includes('from "../model/providers/anthropic.ts"')).toBe(false);
    expect(source.includes('from "../model/providers/openai.ts"')).toBe(false);
    expect(source.includes('from "../model/providers/openai-compatible.ts"')).toBe(false);
    expect(source.includes('from "../model/providers/codex-subscription.ts"')).toBe(false);
    expect(source.includes('from "../model/providers/xai.ts"')).toBe(false);
  }
  const loader = await Bun.file("src/model/loader.ts").text();
  expect(loader.includes("anthropic")).toBe(false);
  expect(loader.includes('import("./providers/openai.ts")')).toBe(true);
  expect(loader.includes('import("./providers/openai-compatible.ts")')).toBe(true);
  expect(loader.includes('import("./providers/codex-subscription.ts")')).toBe(true);
  expect(loader.includes('import("./providers/xai.ts")')).toBe(true);
});

test("subscription adapter stays headless-safe without TUI or provider SDK imports", async () => {
  const source = await Bun.file("src/model/providers/codex-subscription.ts").text();
  expect(source.includes("@opentui")).toBe(false);
  expect(source.includes("../tui/")).toBe(false);
  expect(source.includes('from "openai"')).toBe(false);
  expect(source.includes("~/.codex/auth.json")).toBe(false);
});

test("Grok OAuth is lazy and isolated from UI, SDK imports and other CLI credentials", async () => {
  const module = await Bun.file("src/model/providers/grok-subscription.ts").text();
  expect(module).not.toMatch(/@opentui|\.\.\/tui\/|from "openai"/);
  for (const path of ["src/cli/main.ts", "src/cli/runtime.ts", "src/tui/app.ts"]) expect(await Bun.file(path).text()).not.toContain('from "../model/providers/grok-subscription.ts"');
  for await (const path of new Bun.Glob("src/**/*.ts").scan(".")) {
    const source = await Bun.file(path).text();
    for (const forbidden of [".grok/", "auth.json", "cli-chat-proxy", "X-XAI-Token-Auth"]) expect(source).not.toContain(forbidden);
  }
});
