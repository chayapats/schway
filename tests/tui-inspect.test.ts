import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { editTool } from "../src/tools/edit.ts";
import { readTool } from "../src/tools/read.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import {
  UNKNOWN_MODEL_DEFAULTS,
  lookupModel,
} from "../src/model/catalog.ts";
import {
  formatModelPicker,
  helpText,
  parseModelArgs,
  parseSlashCommand,
} from "../src/tui/commands.ts";
import { listCatalog } from "../src/model/catalog.ts";
import {
  formatToolFinishedText,
  sanitizeBaseUrl,
  TuiController,
} from "../src/tui/controller.ts";
import { withTempDir } from "./helpers.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";

function workspaceFor(dir: string) {
  return { root: dir, launchCwd: dir, extraRoots: [] as string[] };
}

const CODING_SUMMARY = [
  "## Goal",
  "ship compaction",
  "## Constraints",
  "keep history",
  "## Progress",
  "did turns",
  "## Key Decisions",
  "keep recent",
  "## Current State",
  "compacting",
  "## Next Steps",
  "resume",
  "## Files",
  "### Read",
  "src/a.ts",
  "### Modified",
  "src/b.ts",
].join("\n");

function turns(count: number) {
  const items = [];
  for (let i = 0; i < count; i++) {
    items.push({
      type: "user" as const,
      id: `u${i}`,
      content: [{ type: "text" as const, text: `goal step ${i}` }],
    });
    items.push({
      type: "assistant" as const,
      id: `a${i}`,
      content: [{ type: "text" as const, text: `progress ${i}` }],
    });
  }
  return items;
}

test("slash commands include credential management and settings", () => {
  expect(parseSlashCommand("/compact")?.name).toBe("compact");
  expect(parseSlashCommand("/config")?.name).toBe("config");
  expect(parseSlashCommand("/model openai/gpt-4o")?.args).toBe("openai/gpt-4o");
  expect(parseSlashCommand("/skills")?.name).toBe("skills");
  const help = helpText();
  for (const command of ["/new", "/sessions", "/resume", "/model", "/compact", "/skills", "/add-dir", "/config", "/login", "/logout", "/help", "/quit"]) {
    expect(help).toContain(command);
  }
  expect(parseSlashCommand("/login openai")?.args).toBe("openai");
  expect(parseSlashCommand("/logout openai")?.name).toBe("logout");
});

test("help distinguishes entering inspection, copying code and toggling tool results", () => {
  const help = helpText();
  expect(help).toContain("Alt+I enters inspection without copying");
  expect(help).toContain("Up/Down or Tab selects a block or result");
  expect(help).toContain("C copies the highlighted item");
  expect(help).toContain("Enter copies selected code or toggles an expandable tool result");
  expect(help).toContain("Esc returns to the draft");
});

test("model args accept known, unknown, and provider-qualified ids", () => {
  expect(parseModelArgs("gpt-4o", "openai")).toEqual({ provider: "openai", modelId: "gpt-4o" });
  expect(parseModelArgs("openai/gpt-4o", "openai-compatible")).toEqual({ provider: "openai", modelId: "gpt-4o" });
  expect(parseModelArgs("openai gpt-4o", "openai-compatible")).toEqual({ provider: "openai", modelId: "gpt-4o" });
  expect(parseModelArgs("my-custom-model", "openai")).toEqual({ provider: "openai", modelId: "my-custom-model" });
  expect(parseModelArgs("openai/my-custom-model", "openai-compatible")).toEqual({
    provider: "openai",
    modelId: "my-custom-model",
  });
  expect("error" in parseModelArgs("", "openai")).toBe(true);
  expect("error" in parseModelArgs("nope/model", "openai")).toBe(true);
});

test("model picker lists known budgets and unknown-id usage", () => {
  const text = formatModelPicker("openai", "gpt-5.4", listCatalog());
  expect(text).toContain("Current: openai/gpt-5.4");
  expect(text).toContain("gpt-5.4");
  expect(text).toContain("gpt-4o");
  expect(text).toContain("Unknown ids are allowed");
});

test("edit success renders a diff from details while session content stays bounded", async () => {
  await withTempDir(async (dir) => {
    const workspace = workspaceFor(dir);
    await writeFile(join(dir, "note.txt"), "hello\nworld\n");
    const session = createSession();
    const controller = new TuiController({
      session,
      model: createScriptedModel({
        responses: [
          {
            toolCalls: [
              { id: "call-1", name: "edit", arguments: { path: "note.txt", edits: [{ oldText: "world", newText: "there" }] } },
            ],
          },
          { text: "done" },
        ],
      }),
      contextManager: createContextManager(workspace),
      tools: createToolRegistry([editTool, readTool]),
      workspace,
      provider: "scripted",
      modelId: "scripted",
      sessionId: "sess-edit-diff",
    });
    await controller.submit("edit it");
    const snapshot = controller.snapshot();
    const tool = snapshot.transcript.find((entry) => entry.toolCallId === "call-1");
    expect(tool?.toolStatus).toBe("success");
    expect(tool?.text).toContain("note.txt");
    expect(tool?.text).toContain("2 │-world");
    expect(tool?.text).toContain("2 │+there");
    const stored = session.items.find((item) => item.type === "tool_result");
    expect(stored?.type).toBe("tool_result");
    if (stored?.type === "tool_result") {
      expect(stored.content).toContain("Edited note.txt");
      expect(stored.content.length).toBeLessThanOrEqual(2000);
      expect(stored.content).not.toContain("│-world");
    }
    expect(snapshot.status).toBe("idle");
  });
});

test("failed edits are clearly distinguished from applied changes", async () => {
  await withTempDir(async (dir) => {
    const workspace = workspaceFor(dir);
    await writeFile(join(dir, "note.txt"), "hello\n");
    const session = createSession();
    const controller = new TuiController({
      session,
      model: createScriptedModel({
        responses: [
          {
            toolCalls: [
              { id: "call-bad", name: "edit", arguments: { path: "note.txt", edits: [{ oldText: "missing", newText: "x" }] } },
            ],
          },
          { text: "recovered" },
        ],
      }),
      contextManager: createContextManager(workspace),
      tools: createToolRegistry([editTool]),
      workspace,
      provider: "scripted",
      modelId: "scripted",
      sessionId: "sess-edit-fail",
    });
    await controller.submit("bad edit");
    const snapshot = controller.snapshot();
    const tool = snapshot.transcript.find((entry) => entry.toolCallId === "call-bad");
    expect(tool?.toolStatus).toBe("error");
    expect(tool?.text.toLowerCase()).toContain("fail");
    expect(snapshot.transcript.some((entry) => entry.kind === "assistant" && entry.text === "recovered")).toBe(true);
    const direct = formatToolFinishedText("edit", "oldText not found", { path: "note.txt" }, "error");
    expect(direct.toLowerCase()).toContain("fail");
    expect(direct).toContain("note.txt");
  });
});

test("model selection propagates to subsequent requests with matching budget", async () => {
  await withTempDir(async (dir) => {
    const workspace = workspaceFor(dir);
    const session = createSession();
    const first = createScriptedModel({ text: "from-first" });
    const controller = new TuiController({
      session,
      model: first,
      contextManager: createContextManager(workspace),
      tools: createToolRegistry([readTool]),
      workspace,
      provider: "openai",
      modelId: "gpt-5.4",
      sessionId: "sess-model-switch",
    });
    controller.setModel(createScriptedModel({ text: "from-second" }), "openai", "gpt-4o");
    const snapshot = controller.snapshot();
    expect(snapshot.provider).toBe("openai");
    expect(snapshot.modelId).toBe("gpt-4o");
    const budgets = controller.effectiveBudgets();
    expect(budgets).toEqual({
      contextWindow: lookupModel("openai", "gpt-4o").contextWindow,
      maxOutput: lookupModel("openai", "gpt-4o").maxOutput,
    });
    await controller.submit("hi");
    const after = controller.snapshot();
    expect(after.transcript.some((entry) => entry.kind === "assistant" && entry.text === "from-second")).toBe(true);
  });
});

test("unknown model ids use conservative defaults unless overridden", async () => {
  await withTempDir(async (dir) => {
    const workspace = workspaceFor(dir);
    const controller = new TuiController({
      session: createSession(),
      model: createScriptedModel({ text: "ok" }),
      contextManager: createContextManager(workspace),
      workspace,
      provider: "openai",
      modelId: "my-custom-gpt",
      sessionId: "sess-unknown",
    });
    expect(controller.effectiveBudgets().contextWindow).toBe(UNKNOWN_MODEL_DEFAULTS.contextWindow);
    const overridden = new TuiController({
      session: createSession(),
      model: createScriptedModel({ text: "ok" }),
      contextManager: createContextManager(workspace),
      workspace,
      provider: "openai",
      modelId: "my-custom-gpt",
      sessionId: "sess-overridden",
      explicitContextWindow: 9000,
      explicitMaxOutput: 1000,
    });
    expect(overridden.effectiveBudgets()).toEqual({ contextWindow: 9000, maxOutput: 1000 });
  });
});

test("config shows effective settings with secrets redacted as session-only", async () => {
  await withTempDir(async (dir) => {
    const workspace = workspaceFor(dir);
    const secret = "sk-live-config-123";
    const controller = new TuiController({
      session: createSession(),
      model: createScriptedModel({ text: "ok" }),
      contextManager: createContextManager(workspace),
      workspace,
      provider: "openai-compatible",
      modelId: "my-model",
      sessionId: "sess-config",
      maxTurns: 32,
      maxConcurrentTools: 10,
      baseUrl: `https://example.test/${secret}`,
      auth: "optional",
      secrets: [secret],
    });
    const text = controller.describeConfig();
    expect(text).toContain("Provider: openai-compatible");
    expect(text).toContain("Model: my-model");
    expect(text).toContain("Context window:");
    expect(text).toContain("Session: sess-config");
    expect(text).toContain("session only");
    expect(text).not.toContain(secret);
    expect(text).toContain("***");
    controller.setModel(createScriptedModel({ text: "ok" }), "openai", "gpt-5.4");
    const switched = controller.describeConfig();
    expect(switched).toContain("Provider: openai");
    expect(switched).toContain("gpt-5.4");
    expect(switched).toContain(`${lookupModel("openai", "gpt-5.4").contextWindow}`);
  });
});

test("config never leaks base-url credentials", async () => {
  expect(sanitizeBaseUrl("https://user:s3cret@example.test:8080/v1?token=abc#frag")).toBe(
    "https://example.test:8080/v1",
  );
  expect(sanitizeBaseUrl("not a url")).toBe("configured");
  await withTempDir(async (dir) => {
    const workspace = workspaceFor(dir);
    const controller = new TuiController({
      session: createSession(),
      model: createScriptedModel({ text: "ok" }),
      contextManager: createContextManager(workspace),
      workspace,
      provider: "openai-compatible",
      modelId: "my-model",
      sessionId: "sess-config-url",
      baseUrl: "https://user:s3cret@example.test/v1?token=abc",
      secrets: [],
    });
    const text = controller.describeConfig();
    expect(text).not.toContain("s3cret");
    expect(text).not.toContain("token=abc");
    expect(text).toContain("example.test");
  });
});

test("manual compaction succeeds then conversation and resume continue", async () => {
  await withTempDir(async (dir) => {
    const workspace = workspaceFor(dir);
    const session = createSession(turns(12) as never);
    const controller = new TuiController({
      session,
      model: createScriptedModel({ text: CODING_SUMMARY }),
      contextManager: createContextManager(workspace),
      tools: createToolRegistry([readTool]),
      workspace,
      provider: "scripted",
      modelId: "scripted",
      sessionId: "sess-compact-ok",
    });
    const before = session.items.length;
    const ok = await controller.compact();
    expect(ok).toBe(true);
    expect(session.items.length).toBe(before + 1);
    const snapshot = controller.snapshot();
    expect(snapshot.status).toBe("idle");
    expect(snapshot.transcript.some((entry) => entry.text.includes("Compacting"))).toBe(true);
    expect(snapshot.transcript.some((entry) => entry.text.includes("Context compacted"))).toBe(true);
    controller.setModel(createScriptedModel({ text: "after-compaction" }), "scripted", "scripted");
    await controller.submit("continue");
    const after = controller.snapshot();
    expect(after.status).toBe("idle");
    expect(after.transcript.some((entry) => entry.kind === "assistant" && entry.text === "after-compaction")).toBe(true);
  });
});

test("failed compaction preserves a usable conversation", async () => {
  await withTempDir(async (dir) => {
    const workspace = workspaceFor(dir);
    const initial = turns(12) as never;
    const session = createSession(initial);
    const before = session.items.length;
    const controller = new TuiController({
      session,
      model: createScriptedModel({ error: "summarizer overloaded", status: 503 }),
      contextManager: createContextManager(workspace),
      tools: createToolRegistry([readTool]),
      workspace,
      provider: "scripted",
      modelId: "scripted",
      sessionId: "sess-compact-fail",
    });
    const ok = await controller.compact();
    expect(ok).toBe(false);
    expect(session.items.length).toBe(before);
    expect(controller.snapshot().status).toBe("idle");
    controller.setModel(createScriptedModel({ text: "still usable" }), "scripted", "scripted");
    await controller.submit("continue");
    expect(controller.snapshot().transcript.some((entry) => entry.kind === "assistant" && entry.text === "still usable")).toBe(true);
  });
});

test("cancelled compaction preserves a usable conversation", async () => {
  await withTempDir(async (dir) => {
    const workspace = workspaceFor(dir);
    const session = createSession(turns(12) as never);
    const before = session.items.length;
    const controller = new TuiController({
      session,
      model: createScriptedModel({ waitForAbort: true, text: CODING_SUMMARY }),
      contextManager: createContextManager(workspace),
      tools: createToolRegistry([readTool]),
      workspace,
      provider: "scripted",
      modelId: "scripted",
      sessionId: "sess-compact-cancel",
    });
    const pending = controller.compact();
    await Bun.sleep(20);
    expect(controller.running).toBe(true);
    controller.cancel();
    const ok = await pending;
    expect(ok).toBe(false);
    expect(controller.running).toBe(false);
    expect(controller.snapshot().status).toBe("idle");
    expect(session.items.length).toBe(before);
    controller.setModel(createScriptedModel({ text: "usable after cancel" }), "scripted", "scripted");
    await controller.submit("continue");
    expect(controller.snapshot().transcript.some((entry) => entry.kind === "assistant" && entry.text === "usable after cancel")).toBe(true);
  });
});

test("compaction refuses while a turn is running", async () => {
  await withTempDir(async (dir) => {
    const workspace = workspaceFor(dir);
    const controller = new TuiController({
      session: createSession(),
      model: createScriptedModel({ waitForAbort: true, text: "never" }),
      contextManager: createContextManager(workspace),
      tools: createToolRegistry([readTool]),
      workspace,
      provider: "scripted",
      modelId: "scripted",
      sessionId: "sess-compact-busy",
    });
    const pending = controller.submit("long task");
    await Bun.sleep(20);
    expect(controller.running).toBe(true);
    const ok = await controller.compact();
    expect(ok).toBe(false);
    expect(controller.snapshot().transcript.some((entry) => entry.text === "Wait for this turn · Esc stop")).toBe(true);
    controller.cancel();
    await pending;
    expect(controller.snapshot().status).toBe("idle");
  });
});
