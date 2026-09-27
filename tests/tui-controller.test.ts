import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createContextManager } from "../src/context/manager.ts";
import type { RuntimeEvent } from "../src/agent/events.ts";
import type { Session } from "../src/session/session.ts";
import {
  createJsonlSession,
  listSessions,
  loadJsonlSession,
} from "../src/session/jsonl.ts";
import { createSession } from "../src/session/session.ts";
import { readTool } from "../src/tools/read.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { helpText, parseSlashCommand } from "../src/tui/commands.ts";
import {
  boundDisplay,
  buildTranscriptFromSession,
  TuiController,
} from "../src/tui/controller.ts";
import { withTempDir } from "./helpers.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";

function workspaceFor(dir: string) {
  return { root: dir, launchCwd: dir, extraRoots: [] as string[] };
}

function controllerFor(
  session: Session,
  sessionId: string,
  workspace: { root: string; launchCwd: string; extraRoots: string[] },
  model: ReturnType<typeof createScriptedModel>,
) {
  return new TuiController({
    session,
    model,
    contextManager: createContextManager(workspace),
    tools: createToolRegistry([readTool]),
    workspace,
    provider: "scripted",
    modelId: "scripted",
    sessionId,
  });
}

test("successive prompts stream text and return to idle", async () => {
  await withTempDir(async (dir) => {
    const workspace = workspaceFor(dir);
    const session = createSession();
    const controller = controllerFor(
      session,
      "sess-1",
      workspace,
      createScriptedModel({
        responses: [{ chunks: ["Hel", "lo"] }, { text: "again" }],
      }),
    );
    await controller.submit("first");
    let snapshot = controller.snapshot();
    expect(snapshot.status).toBe("idle");
    expect(snapshot.transcript.filter((entry) => entry.kind === "user").map((entry) => entry.text)).toEqual([
      "first",
    ]);
    expect(snapshot.transcript.some((entry) => entry.kind === "assistant" && entry.text === "Hello")).toBe(true);

    await controller.submit("second");
    snapshot = controller.snapshot();
    expect(snapshot.status).toBe("idle");
    expect(snapshot.transcript.filter((entry) => entry.kind === "assistant").map((entry) => entry.text)).toEqual([
      "Hello",
      "again",
    ]);
  });
});

test("streamed tool output shows running then bounded completed state", async () => {
  await withTempDir(async (dir) => {
    const workspace = workspaceFor(dir);
    await writeFile(join(dir, "note.txt"), `${"x".repeat(5000)}\n`);
    const session = createSession();
    const controller = controllerFor(
      session,
      "sess-tools",
      workspace,
      createScriptedModel({
        responses: [
          {
            toolCalls: [{ id: "call-1", name: "read", arguments: { path: "note.txt" } }],
          },
          { text: "done" },
        ],
      }),
    );
    await controller.submit("read it");
    const snapshot = controller.snapshot();
    const tool = snapshot.transcript.find((entry) => entry.toolCallId === "call-1");
    expect(tool?.toolStatus).toBe("success");
    expect(tool?.toolName).toBe("read");
    expect(tool!.text.length).toBeLessThanOrEqual(2200);
    expect(tool!.text).toContain("truncated");
    expect(snapshot.status).toBe("idle");
  });
});

test("tool errors surface as error state without crashing the turn", async () => {
  await withTempDir(async (dir) => {
    const workspace = workspaceFor(dir);
    const session = createSession();
    const controller = controllerFor(
      session,
      "sess-err",
      workspace,
      createScriptedModel({
        responses: [
          {
            toolCalls: [{ id: "call-bad", name: "read", arguments: { path: "missing.txt" } }],
          },
          { text: "recovered" },
        ],
      }),
    );
    await controller.submit("read missing");
    const snapshot = controller.snapshot();
    const tool = snapshot.transcript.find((entry) => entry.toolCallId === "call-bad");
    expect(tool?.toolStatus).toBe("error");
    expect(snapshot.transcript.some((entry) => entry.kind === "assistant" && entry.text === "recovered")).toBe(true);
    expect(snapshot.status).toBe("idle");
  });
});

test("optional event callback runs before display folding and cannot suppress settled tool results", async () => {
  await withTempDir(async dir => {
    const workspace = workspaceFor(dir);
    await writeFile(join(dir, "note.txt"), "settled result");
    const session = createSession();
    const seen: string[] = [];
    let toolStatusBefore: string | undefined;
    let sawFilteredThinking = false;
    let controller!: TuiController;
    controller = new TuiController({
      session, model: createScriptedModel({ responses: [
        { toolCalls: [{ id: "read-1", name: "read", arguments: { path: "note.txt" } }] },
        { thinkingChunks: ["hidden-thought"], text: "completed" },
      ] }),
      contextManager: createContextManager(workspace), tools: createToolRegistry([readTool]),
      workspace, provider: "scripted", modelId: "scripted", sessionId: "sess-events",
      onRuntimeEvent(event: RuntimeEvent) {
        seen.push(event.type);
        if (event.type === "model.delta" && event.content.type === "thinking") sawFilteredThinking = true;
        if (event.type === "model.started") throw new Error("observer threw");
        if (event.type === "tool.finished") {
          toolStatusBefore = controller.snapshot().transcript.find(entry => entry.toolCallId === event.toolCallId)?.toolStatus;
          return Promise.reject(new Error("observer rejected"));
        }
      },
    });
    await controller.submit("read note");
    expect(seen).toEqual(["agent.started", "model.started", "model.usage", "model.finished", "tool.started", "tool.finished", "model.started", "model.delta", "model.delta", "model.usage", "model.finished", "agent.finished"]);
    expect(sawFilteredThinking).toBe(true);
    expect(JSON.stringify(controller.snapshot()).includes("hidden-thought")).toBe(false);
    expect(toolStatusBefore).toBe("running");
    expect(controller.snapshot().transcript.find(entry => entry.toolCallId === "read-1")?.toolStatus).toBe("success");
    expect(session.items.some(item => item.type === "tool_result" && item.content.includes("settled result"))).toBe(true);
  });
});

test("provider failures appear as actionable errors with error status", async () => {
  await withTempDir(async (dir) => {
    const workspace = workspaceFor(dir);
    const session = createSession();
    const controller = controllerFor(
      session,
      "sess-fail",
      workspace,
      createScriptedModel({ error: "boom", status: 400 }),
    );
    await controller.submit("hi");
    const snapshot = controller.snapshot();
    expect(snapshot.status).toBe("error");
    expect(snapshot.transcript.some((entry) => entry.kind === "error" && entry.text.includes("provider could not finish"))).toBe(true);
    expect(controller.inspectRecovery()).toBe(true);
    expect(controller.snapshot().transcript.at(-1)?.text).toContain("boom");
  });
});

test("missing credentials explain the interactive login path", async () => {
  await withTempDir(async (dir) => {
    const workspace = workspaceFor(dir);
    const controller = new TuiController({
      session: createSession(),
      model: undefined,
      contextManager: createContextManager(workspace),
      tools: createToolRegistry([readTool]),
      workspace,
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      sessionId: "sess-nokey",
      startupError: "Missing Anthropic API key. Pass --api-key or set ANTHROPIC_API_KEY.",
    });
    let snapshot = controller.snapshot();
    expect(snapshot.status).toBe("error");
    expect(snapshot.transcript.some((entry) => entry.text.includes("Missing Anthropic API key"))).toBe(true);
    expect(JSON.stringify(snapshot).toLowerCase().includes("subscription login")).toBe(false);

    await controller.submit("hello");
    snapshot = controller.snapshot();
    const lastError = [...snapshot.transcript].reverse().find((entry) => entry.kind === "error");
    expect(lastError?.text).toContain("Missing credentials");
    expect(lastError?.text).toContain("Alt+L connect");
    expect(snapshot.status).toBe("error");
  });
});

test("cancellation stops the active turn and returns to idle", async () => {
  await withTempDir(async (dir) => {
    const workspace = workspaceFor(dir);
    const session = createSession();
    const controller = controllerFor(
      session,
      "sess-cancel",
      workspace,
      createScriptedModel({ waitForAbort: true, text: "never" }),
    );
    const pending = controller.submit("long task");
    await Bun.sleep(20);
    expect(controller.running).toBe(true);
    expect(controller.snapshot().status).toBe("running");
    controller.cancel();
    await pending;
    const snapshot = controller.snapshot();
    expect(controller.running).toBe(false);
    expect(snapshot.status).toBe("idle");
    expect(snapshot.transcript.some((entry) => entry.text === "Cancelled.")).toBe(true);
    // User prompt is still persisted for resume even though the turn cancelled.
    expect(session.items.some((item) => item.type === "user")).toBe(true);
  });
});

test("dispose releases the active turn for terminal cleanup", async () => {
  await withTempDir(async (dir) => {
    const workspace = workspaceFor(dir);
    const session = createSession();
    const controller = controllerFor(
      session,
      "sess-dispose",
      workspace,
      createScriptedModel({ waitForAbort: true, text: "never" }),
    );
    const pending = controller.submit("work");
    await Bun.sleep(20);
    expect(controller.running).toBe(true);
    controller.dispose();
    await pending;
    expect(controller.running).toBe(false);
  });
});

test("resume rebuilds history without replaying old tool effects", async () => {
  await withTempDir(async (dir) => {
    const project = join(dir, "project");
    await mkdir(project);
    await writeFile(join(project, "note.txt"), "original\n");
    const sessions = join(dir, "sessions");
    const workspace = workspaceFor(project);
    const created = await createJsonlSession({ directory: sessions, workspace });
    created.append({
      type: "user",
      id: "u1",
      content: [{ type: "text", text: "read note" }],
    });
    // Durable assistant tool call plus its persisted result.
    created.append({
      type: "assistant",
      id: "a1",
      content: [{ type: "tool_call", id: "call-1", name: "read", arguments: { path: "note.txt" } }],
    });
    created.append({
      type: "tool_result",
      id: "r1",
      toolCallId: "call-1",
      content: "original\n",
      isError: false,
    });
    created.append({
      type: "assistant",
      id: "a2",
      content: [{ type: "text", text: "saw original" }],
    });

    // Change the file after the session was saved; resume must not re-execute.
    await writeFile(join(project, "note.txt"), "changed\n");
    const loaded = await loadJsonlSession({ directory: sessions, id: created.header.id });
    const transcript = buildTranscriptFromSession(loaded.items);
    expect(transcript.some((entry) => entry.kind === "user" && entry.text === "read note")).toBe(true);
    expect(transcript.some((entry) => entry.kind === "assistant" && entry.text === "saw original")).toBe(true);
    const tool = transcript.find((entry) => entry.toolCallId === "call-1");
    expect(tool?.toolStatus).toBe("success");
    expect(tool?.text).toBe("original\n");

    const resumed = new TuiController({
      session: loaded,
      model: createScriptedModel({ text: "still here" }),
      contextManager: createContextManager({
        root: loaded.header.workspaceRoot,
        launchCwd: loaded.header.launchCwd,
        extraRoots: loaded.header.extraRoots,
      }),
      tools: createToolRegistry([readTool]),
      workspace: {
        root: loaded.header.workspaceRoot,
        launchCwd: loaded.header.launchCwd,
        extraRoots: loaded.header.extraRoots,
      },
      provider: "scripted",
      modelId: "scripted",
      sessionId: loaded.header.id,
    });
    const before = resumed.snapshot().transcript.length;
    expect(before).toBeGreaterThan(0);
    await resumed.submit("continue");
    expect(resumed.snapshot().transcript.length).toBeGreaterThan(before);
  });
});

test("new sessions start from an empty transcript", async () => {
  await withTempDir(async (dir) => {
    const workspace = workspaceFor(dir);
    const first = createSession();
    const controller = controllerFor(sessionless(), "old", workspace, createScriptedModel({ text: "hi" }));
    void first;
    await controller.submit("hello");
    expect(controller.snapshot().transcript.length).toBeGreaterThan(0);
    const fresh = createSession();
    controller.replaceSession(fresh, "new-id");
    const snapshot = controller.snapshot();
    expect(snapshot.sessionId).toBe("new-id");
    expect(snapshot.transcript).toEqual([]);
    expect(snapshot.status).toBe("idle");
  });

  function sessionless(): Session {
    return createSession();
  }
});

test("snapshots redact runtime secrets from displayed transcript", async () => {
  await withTempDir(async (dir) => {
    const workspace = workspaceFor(dir);
    const secret = "sk-live-12345";
    const controller = new TuiController({
      session: createSession(),
      model: createScriptedModel({ text: `key is ${secret}` }),
      contextManager: createContextManager(workspace),
      tools: createToolRegistry([readTool]),
      workspace,
      provider: "scripted",
      modelId: "scripted",
      sessionId: "sess-secrets",
      secrets: [secret],
    });
    await controller.submit("hi");
    const snapshot = controller.snapshot();
    expect(JSON.stringify(snapshot).includes(secret)).toBe(false);
    expect(snapshot.transcript.some((entry) => entry.text.includes("***"))).toBe(true);
  });
});

test("replaceSession rebinds workspace and context for later turns", async () => {
  await withTempDir(async (dir) => {
    const first = join(dir, "first");
    const second = join(dir, "second");
    await mkdir(first);
    await mkdir(second);
    await writeFile(join(second, "note.txt"), "from-second\n");
    const wsA = workspaceFor(first);
    const controller = new TuiController({
      session: createSession(),
      model: createScriptedModel({ text: "unused" }),
      contextManager: createContextManager(wsA),
      tools: createToolRegistry([readTool]),
      workspace: wsA,
      provider: "scripted",
      modelId: "scripted",
      sessionId: "old",
    });
    const wsB = workspaceFor(second);
    controller.replaceSession(createSession(), "new", {
      workspace: wsB,
      contextManager: createContextManager(wsB),
    });
    controller.setModel(
      createScriptedModel({
        responses: [
          {
            toolCalls: [{ id: "c1", name: "read", arguments: { path: "note.txt" } }],
          },
          { text: "done" },
        ],
      }),
      "scripted",
      "scripted",
    );
    await controller.submit("read it");
    const tool = controller.snapshot().transcript.find((entry) => entry.toolCallId === "c1");
    expect(tool?.toolStatus).toBe("success");
    expect(tool?.text).toContain("from-second");
  });
});

test("bounded display truncates long tool output for the terminal", () => {
  const long = "y".repeat(5000);
  const bounded = boundDisplay(long);
  expect(bounded.length).toBeLessThan(long.length);
  expect(bounded).toContain("truncated");
  expect(boundDisplay("short")).toBe("short");
});

test("slash commands parse and help lists the supported interactions", () => {
  expect(parseSlashCommand("hello")).toBeNull();
  expect(parseSlashCommand("/new")?.name).toBe("new");
  expect(parseSlashCommand("/resume abc")?.args).toBe("abc");
  expect(parseSlashCommand("/sessions")?.name).toBe("sessions");
  expect(parseSlashCommand("/model")?.name).toBe("model");
  expect(parseSlashCommand("/compact")?.name).toBe("compact");
  expect(parseSlashCommand("/config")?.name).toBe("config");
  expect(parseSlashCommand("/help")?.name).toBe("help");
  expect(parseSlashCommand("/quit")?.name).toBe("quit");
  expect(parseSlashCommand("/nope")?.name).toBe("unknown");
  const help = helpText();
  expect(help).toContain("/new");
  expect(help).toContain("/sessions");
  expect(help).toContain("/resume");
  expect(help).toContain("/model");
  expect(help).toContain("/compact");
  expect(help).toContain("/config");
  expect(help).toContain("/help");
  expect(help).toContain("/quit");
});

test("listSessions returns newest-first summaries and skips corrupt files", async () => {
  await withTempDir(async (dir) => {
    expect(await listSessions(join(dir, "missing"))).toEqual([]);
    const workspace = workspaceFor(dir);
    const first = await createJsonlSession({ directory: join(dir, "sessions"), workspace });
    await Bun.sleep(5);
    const second = await createJsonlSession({ directory: join(dir, "sessions"), workspace });
    await writeFile(join(dir, "sessions", "bad.jsonl"), "not json\n");
    await writeFile(join(dir, "sessions", "notes.txt"), "ignore me\n");
    const listed = await listSessions(join(dir, "sessions"));
    expect(listed.map((entry) => entry.id)).toEqual([second.header.id, first.header.id]);
    expect(listed[0]?.workspaceRoot).toBe(dir);
  });
});

test("listSessions skips files with an overlong first line without reading them fully", async () => {
  await withTempDir(async (dir) => {
    const workspace = workspaceFor(dir);
    const sessions = join(dir, "sessions");
    const kept = await createJsonlSession({ directory: sessions, workspace });
    await writeFile(join(sessions, "huge.jsonl"), `${"z".repeat(100_000)}\nmore\n`);
    const listed = await listSessions(sessions);
    expect(listed.map((entry) => entry.id)).toEqual([kept.header.id]);
  });
});
