import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createContextManager } from "../src/context/manager.ts";
import type { RuntimeEvent } from "../src/agent/events.ts";
import type { Model } from "../src/model/model.ts";
import { createJsonlSession, loadJsonlSession } from "../src/session/jsonl.ts";
import { createSession } from "../src/session/session.ts";
import { bashTool } from "../src/tools/bash.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { writeTool } from "../src/tools/write.ts";
import { TuiController } from "../src/tui/controller.ts";
import { outcomeLabel, statusPill, toolPresentation } from "../src/tui/presentation.ts";
import { withTempDir } from "./helpers.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";

class Gate {
  private release!: () => void;
  readonly promise = new Promise<void>(resolve => { this.release = resolve; });
  open(): void { this.release(); }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("cancellation fixture did not reach the expected state");
}

test("a streamed stop has one neutral recovery and keeps only its provisional answer incomplete", async () => withTempDir(async root => {
  const workspace = { root, launchCwd: root, extraRoots: [] };
  const session = createSession();
  const events: RuntimeEvent[] = [];
  const controller = new TuiController({ session, workspace, contextManager: createContextManager(workspace),
    provider: "scripted", modelId: "stopped", sessionId: "stopped-session",
    model: createScriptedModel({ chunks: ["คำตอบบางส่วน 😀"], waitForAbort: true }),
    onRuntimeEvent(event) {
      events.push(event);
      if (event.type === "model.delta") { controller.cancel(); controller.cancel(); }
    },
  });
  const pending = controller.submit("accepted task");
  try {
    expect(await pending).toBe(true);
    const snapshot = controller.snapshot();
    expect(snapshot.status).toBe("idle");
    expect(snapshot.activity).toBeUndefined();
    expect(snapshot.outcome?.reason).toBe("cancelled");
    expect(snapshot.transcript.filter(entry => entry.kind === "error")).toEqual([]);
    expect(snapshot.transcript.filter(entry => entry.kind === "system")).toMatchObject([
      { text: "Stopped · Completed results kept\nCtrl+R continue · Esc keep editing" },
    ]);
    expect(snapshot.transcript.find(entry => entry.kind === "assistant")).toMatchObject({ text: "คำตอบบางส่วน 😀", incomplete: true });
    expect(snapshot.recovery).toMatchObject({ accepted: true, actions: ["continue", "keep-editing"] });
    expect(outcomeLabel(snapshot.outcome!)).toBe("− Stopped");
    expect(session.items.map(item => item.type)).toEqual(["user"]);
    expect(events.filter(event => event.type === "agent.finished")).toEqual([{ type: "agent.finished", reason: "cancelled" }]);
    controller.cancel();
    expect(controller.snapshot().transcript).toEqual(snapshot.transcript);
  } finally { controller.dispose(); await Promise.allSettled([pending]); }
}));

for (const scenario of ["completed", "provider-error", "session-write", "cleanup-after-completion", "cleanup-after-stop"] as const) {
  test(`late Esc preserves ${scenario} provenance`, async () => withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    let writes = 0;
    const session = createSession([], [], { writeOperation() {
      writes++;
      if (scenario === "session-write" && writes === 2) throw new Error("Fixture session-write failure");
    } });
    const base = createContextManager(workspace);
    const contextManager = scenario.startsWith("cleanup") ? { ...base, beginTurn() {
      const finish = base.beginTurn();
      return () => { finish(); throw Object.assign(new Error("Fixture cleanup failure"), { name: "AbortError" }); };
    } } : base;
    const events: RuntimeEvent[] = [];
    const controller = new TuiController({ session, workspace, contextManager,
      provider: "scripted", modelId: "race", sessionId: scenario,
      model: createScriptedModel(scenario === "provider-error"
        ? { error: "Request cancelled by remote policy", status: 400 }
        : { text: "Finished answer", waitForAbort: scenario === "cleanup-after-stop" }),
      onRuntimeEvent(event) {
        events.push(event);
        const cancelNow = scenario === "cleanup-after-stop" ? event.type === "model.delta"
          : scenario === "provider-error" || scenario === "session-write" ? event.type === "error" : event.type === "agent.finished";
        if (cancelNow) { controller.cancel(); controller.cancel(); }
      },
    });
    const pending = controller.submit("accepted once");
    try {
      expect(await pending).toBe(true);
      const snapshot = controller.snapshot();
      expect(snapshot.outcome?.reason).toBe(scenario === "completed" ? "completed" : "failed");
      expect(snapshot.status).toBe(scenario === "completed" ? "idle" : "error");
      expect(snapshot.activity).toBeUndefined();
      expect(snapshot.transcript.some(entry => entry.text.startsWith("Stopped"))).toBe(false);
      expect(session.items.filter(item => item.type === "user")).toHaveLength(1);
      if (scenario === "completed") {
        expect(snapshot.recovery).toBeUndefined();
        expect(snapshot.transcript.find(entry => entry.kind === "assistant")).toMatchObject({ text: "Finished answer", incomplete: false });
        expect(session.items.map(item => item.type)).toEqual(["user", "assistant"]);
      } else if (scenario === "provider-error") {
        expect(snapshot.recovery).toMatchObject({ category: "provider", actions: ["continue", "details", "keep-editing"] });
        expect(snapshot.transcript.filter(entry => entry.kind === "error")).toHaveLength(1);
        expect(controller.inspectRecovery()).toBe(true);
        expect(controller.snapshot().transcript.at(-1)?.text).toContain("Request cancelled by remote policy");
      } else if (scenario === "session-write") {
        expect(snapshot.recovery).toMatchObject({ category: "session-write", actions: ["details", "keep-editing"] });
        expect(snapshot.transcript.filter(entry => entry.kind === "error")).toHaveLength(1);
        expect(snapshot.transcript.find(entry => entry.kind === "assistant")?.incomplete).toBe(true);
        expect(await controller.continueRecovery()).toBe(false);
        expect(await controller.submit("keep this unsent")).toBe(false);
        expect(writes).toBe(2);
      } else {
        expect(snapshot.recovery).toBeUndefined();
        expect(snapshot.transcript.filter(entry => entry.kind === "error")).toMatchObject([{ text: "Fixture cleanup failure" }]);
        expect(snapshot.transcript.find(entry => entry.kind === "assistant")?.incomplete).toBe(scenario === "cleanup-after-stop");
      }
      expect(events.filter(event => event.type === "agent.finished")).toEqual([{ type: "agent.finished",
        reason: scenario === "provider-error" || scenario === "session-write" ? "error" : scenario === "cleanup-after-stop" ? "cancelled" : "completed" }]);
    } finally { controller.dispose(); await Promise.allSettled([pending]); }
  }));
}

test("a terminal stop stays pending through provider cleanup without publishing recovery early", async () => withTempDir(async root => {
  const workspace = { root, launchCwd: root, extraRoots: [] };
  const cleanup = new Gate();
  let cleaning = false;
  const model: Model = { provider: "scripted", id: "cleanup", async *stream(request) {
    try { yield* createScriptedModel({ chunks: [], waitForAbort: true }).stream(request); }
    finally { cleaning = true; await cleanup.promise; }
  } };
  const controller = new TuiController({ session: createSession(), model, workspace,
    contextManager: createContextManager(workspace), provider: "scripted", modelId: "cleanup", sessionId: "cleanup" });
  const pending = controller.submit("wait before any text");
  try {
    await until(() => controller.snapshot().activity?.phase === "waiting");
    const operationId = controller.snapshot().activity!.operationId;
    controller.cancel(); controller.cancel();
    await until(() => cleaning);
    expect(statusPill(controller.snapshot()).label).toBe("Stop requested");
    controller.acknowledgeCancellationFrame(operationId);
    expect(statusPill(controller.snapshot()).label).toStartWith("Stopping");
    expect(controller.snapshot().status).toBe("running");
    expect(controller.snapshot().recovery).toBeUndefined();
    expect(controller.snapshot().transcript.map(entry => entry.kind)).toEqual(["user"]);
    cleanup.open();
    expect(await pending).toBe(true);
    expect(statusPill(controller.snapshot()).label).toBe("Ready");
    expect(controller.snapshot().outcome?.reason).toBe("cancelled");
    expect(controller.snapshot().transcript.map(entry => entry.kind)).toEqual(["user", "system"]);
  } finally { controller.dispose(); cleanup.open(); await Promise.allSettled([pending]); }
}));

test("stopping a real shell keeps a completed write and explicit continuation does not replay either tool", async () => withTempDir(async root => {
  const workspace = { root, launchCwd: root, extraRoots: [] };
  const directory = join(root, "sessions");
  const session = await createJsonlSession({ directory, workspace });
  let writes = 0;
  let requests = 0;
  let shellOutput = "";
  const controller = new TuiController({ session, workspace, contextManager: createContextManager(workspace),
    tools: createToolRegistry([{ ...writeTool, execute: async (...args: Parameters<typeof writeTool.execute>) => { writes++; return writeTool.execute(...args); } }, bashTool]),
    provider: "scripted", modelId: "effects", sessionId: session.header.id,
    model: createScriptedModel({ responses: [
      () => { requests++; return { toolCalls: [{ id: "saved", name: "write", arguments: { path: "saved.txt", content: "completed ไทย\n" } }] }; },
      () => { requests++; return { toolCalls: [{ id: "running", name: "bash", arguments: { command: "printf ready; sleep 5", timeout: 2_000 } }] }; },
      request => {
        requests++;
        expect(request.items.filter(item => item.type === "user")).toHaveLength(1);
        expect(request.items.filter(item => item.type === "tool_result")).toMatchObject([
          { toolCallId: "saved", isError: false }, { toolCallId: "running", isError: true },
        ]);
        return { text: "continued without repeating tools" };
      },
    ] }),
    onRuntimeEvent(event) {
      if (event.type === "tool.delta") {
        shellOutput += event.text;
        if (shellOutput.includes("ready")) { controller.cancel(); controller.cancel(); }
      }
    },
  });
  const pending = controller.submit("write then run a command");
  try {
    expect(await pending).toBe(true);
    expect(shellOutput).toContain("ready");
    expect(controller.snapshot().outcome?.reason).toBe("cancelled");
    expect(controller.snapshot().transcript.filter(entry => entry.kind === "error")).toEqual([]);
    expect(controller.snapshot().transcript.find(entry => entry.toolCallId === "saved")).toMatchObject({ toolStatus: "success" });
    const stopped = controller.snapshot().transcript.find(entry => entry.toolCallId === "running")!;
    expect(stopped.toolStatus).toBe("cancelled");
    expect(toolPresentation(stopped, false)).toMatchObject({ state: "Stopped", tone: "muted" });
    expect(await readFile(join(root, "saved.txt"), "utf8")).toBe("completed ไทย\n");
    expect(writes).toBe(1); expect(requests).toBe(2);
    const saved = await loadJsonlSession({ directory, id: session.header.id });
    expect(saved.items).toEqual(session.items);
    expect(saved.items.filter(item => item.type === "tool_result")).toHaveLength(2);
    expect(await controller.continueRecovery()).toBe(true);
    expect(writes).toBe(1); expect(requests).toBe(3);
    expect(session.items.filter(item => item.type === "user")).toHaveLength(1);
    expect(session.items.filter(item => item.type === "tool_result")).toHaveLength(2);
    expect(controller.snapshot().outcome?.reason).toBe("completed");
    expect(controller.snapshot().recovery).toBeUndefined();
    expect(await readFile(join(root, "saved.txt"), "utf8")).toBe("completed ไทย\n");
  } finally { controller.dispose(); await Promise.allSettled([pending]); }
}));

test("stopping an approval wait settles every accepted call without executing a write", async () => withTempDir(async root => {
  const workspace = { root, launchCwd: root, extraRoots: [] };
  const session = createSession();
  let writes = 0;
  const controller = new TuiController({ session, workspace, contextManager: createContextManager(workspace),
    tools: createToolRegistry([{ ...writeTool, execute: async (...args: Parameters<typeof writeTool.execute>) => { writes++; return writeTool.execute(...args); } }]),
    provider: "scripted", modelId: "approval", sessionId: "approval",
    model: createScriptedModel({ toolCalls: ["first", "queued"].map(id => ({ id, name: "write", arguments: { path: `${id}.txt`, content: "must not write" } })) }),
  });
  controller.cycleApprovalMode();
  expect(controller.snapshot().approvalMode).toBe("ask");
  const pending = controller.submit("ask before writing");
  try {
    await until(() => !!controller.snapshot().toolApproval);
    controller.cancel(); controller.cancel();
    expect(await pending).toBe(true);
    expect(writes).toBe(0);
    expect(controller.snapshot().toolApproval).toBeUndefined();
    expect(controller.snapshot().outcome?.reason).toBe("cancelled");
    expect(controller.snapshot().transcript.filter(entry => entry.kind === "error")).toEqual([]);
    expect(session.items.filter(item => item.type === "tool_result")).toMatchObject([
      { toolCallId: "first", content: "Tool call cancelled", isError: true },
      { toolCallId: "queued", content: "Tool call cancelled", isError: true },
    ]);
    for (const entry of controller.snapshot().transcript.filter(entry => entry.kind === "tool")) {
      expect(toolPresentation(entry, false)).toMatchObject({ state: "Stopped", marker: "−", tone: "muted" });
    }
  } finally { controller.dispose(); await Promise.allSettled([pending]); }
}));

for (const action of ["replace-session", "dispose"] as const) test(`late stopped cleanup cannot publish after ${action}`, async () => withTempDir(async root => {
  const workspace = { root, launchCwd: root, extraRoots: [] };
  const cleanup = new Gate();
  let cleaning = false;
  const original = createSession();
  const replacement = createSession();
  const model: Model = { provider: "scripted", id: "stale", async *stream(request) {
    try { yield* createScriptedModel({ chunks: ["old partial"], waitForAbort: true }).stream(request); }
    finally { cleaning = true; await cleanup.promise; }
  } };
  const controller = new TuiController({ session: original, model, workspace, contextManager: createContextManager(workspace),
    provider: "scripted", modelId: "stale", sessionId: "old",
    onRuntimeEvent(event) { if (event.type === "model.delta") controller.cancel(); },
  });
  const pending = controller.submit("old task");
  try {
    await until(() => cleaning);
    if (action === "dispose") controller.dispose();
    else controller.replaceSession(replacement, "new");
    const before = controller.snapshot();
    cleanup.open(); await pending;
    const after = controller.snapshot();
    expect(after.transcript).toEqual(before.transcript);
    expect(after.outcome).toBeUndefined();
    expect(after.recovery).toBeUndefined();
    expect(await controller.continueRecovery()).toBe(false);
    expect(replacement.items).toEqual([]);
    expect(original.items.filter(item => item.type === "user")).toHaveLength(1);
    expect(original.busy).toBe(false);
  } finally { controller.dispose(); cleanup.open(); await Promise.allSettled([pending]); }
}));
