import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "../src/cli/args.ts";
import { createDiagnosticSink, diagnosticPath } from "../src/diagnostics/sink.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession, type Session } from "../src/session/session.ts";
import { TuiController } from "../src/tui/controller.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { readTool } from "../src/tools/read.ts";
import type { Model } from "../src/model/model.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { runInteractiveTui } from "../src/tui/app.ts";

test("interactive startup diagnostics are opt-in and never require OpenTUI for pre-render failures", async () => {
  const home = await mkdtemp(join(tmpdir(), "schway-tui-debug-"));
  try {
    for (const enabled of [false, true]) {
      const parsed = parseArgs(["--resume", "missing-session", ...(enabled ? ["--debug"] : [])]);
      if ("error" in parsed) throw new Error(parsed.error);
      const code = await runInteractiveTui({ args: parsed.args, env: { HOME: home, SCHWAY_MOTION: "off" }, cwd: home,
        stdout: { write() {} }, stderr: { write() {} } });
      expect(code).toBe(1);
      expect(await Bun.file(diagnosticPath(home)).exists()).toBe(enabled);
    }
    const records = (await readFile(diagnosticPath(home), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { event: string; component: string });
    expect(records).toContainEqual(expect.objectContaining({ component: "cli", event: "startup" }));

    const configArgs = parseArgs(["--debug", "--provider", "openai-compatible"]);
    if ("error" in configArgs) throw new Error(configArgs.error);
    expect(await runInteractiveTui({ args: configArgs.args, env: { HOME: home, SCHWAY_MOTION: "off" }, cwd: home,
      stdout: { write() {} }, stderr: { write() {} } })).toBe(1);
    expect(await readFile(diagnosticPath(home), "utf8")).toContain('"event":"invalid_configuration"');
  } finally { await rm(home, { recursive: true, force: true }); }
});

async function inHome(run: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "schway-tui-events-"));
  try { await run(home); } finally { await rm(home, { recursive: true, force: true }); }
}

function makeController(home: string, session: Session, model: Model, onRuntimeEvent?: (event: import("../src/agent/events.ts").RuntimeEvent) => void, contextWindow?: number) {
  const workspace = { root: home, launchCwd: home, extraRoots: [] as string[] };
  return new TuiController({
    session, model, contextManager: createContextManager(workspace, contextWindow ? { contextWindow } : undefined),
    workspace, tools: createToolRegistry([readTool]), provider: "scripted", modelId: "scripted", sessionId: "tui-session",
    onRuntimeEvent,
  });
}

test("interactive event sink records retry, tool settlement and lifecycle without raw provider text", async () => inHome(async home => {
  const sink = createDiagnosticSink({ home, enabled: true, runId: "tui-run", sessionId: () => "tui-session" });
  const session = createSession();
  const controller = makeController(home, session, createScriptedModel({ responses: [
    { error: "unknown-provider-prompt-echo", status: 429, headers: { "retry-after": "0" } },
    { toolCalls: [{ id: "r1", name: "read", arguments: { path: "missing.txt" } }] },
    { text: "done" },
  ] }), event => sink.runtime(event));
  await controller.submit("private prompt");
  await sink.close();
  const text = await readFile(diagnosticPath(home), "utf8");
  const records = text.trim().split("\n").map(line => JSON.parse(line) as { runId: string; sessionId: string; event: string; fields: { status?: string } });
  expect(records.map(record => record.event)).toContain("model.retry");
  expect(records.map(record => record.event)).toContain("tool.finished");
  expect(records.map(record => record.event)).toContain("agent.finished");
  expect(records.find(record => record.event === "tool.finished")?.fields.status).toBe("error");
  expect(records.every(record => record.runId === "tui-run" && record.sessionId === "tui-session")).toBe(true);
  expect(text).not.toMatch(/unknown-provider-prompt-echo|private prompt|missing\.txt/);
  expect(session.items.some(item => item.type === "tool_result")).toBe(true);
}));

test("interactive pressure compaction transitions are logged without summary text", async () => inHome(async home => {
  const summary = "## Goal\ncontinue\n## Constraints\nkeep history\n## Progress\nworked\n## Key Decisions\nretain\n## Current State\nworking\n## Next Steps\nresume\n## Files\n### Read\nsrc/a.ts\n### Modified\nsrc/b.ts";
  const session = createSession();
  for (let i = 0; i < 12; i++) {
    session.append({ type: "user", id: `u${i}`, content: [{ type: "text", text: `goal ${i}` }] });
    session.append({ type: "assistant", id: `a${i}`, content: [{ type: "text", text: `progress ${i}` }] });
  }
  const sink = createDiagnosticSink({ home, enabled: true, sessionId: () => "tui-session" });
  const controller = makeController(home, session, createScriptedModel({ responses: [{ text: summary }, { text: "done" }] }), event => sink.runtime(event), 100);
  await controller.submit("continue");
  await sink.close();
  const text = await readFile(diagnosticPath(home), "utf8");
  expect(text).toContain('"event":"compaction.started"');
  expect(text).toContain('"event":"compaction.finished"');
  expect(text).not.toContain(summary);
}));

test("disabled interactive event sink creates no files, and failed log writes do not lose tools", async () => inHome(async home => {
  await writeFile(join(home, "note.txt"), "settled");
  const disabled = createDiagnosticSink({ home, enabled: false });
  const disabledSession = createSession();
  const model = () => createScriptedModel({ responses: [
    { toolCalls: [{ id: "r1", name: "read", arguments: { path: "note.txt" } }] }, { text: "done" },
  ] });
  await makeController(home, disabledSession, model(), event => disabled.runtime(event)).submit("read");
  await disabled.close();
  expect(await Bun.file(diagnosticPath(home)).exists()).toBe(false);
  const failed = createDiagnosticSink({ home, enabled: true, destination: home });
  const failedSession = createSession();
  const controller = makeController(home, failedSession, model(), event => failed.runtime(event));
  await controller.submit("read");
  await failed.close();
  expect(failed.dropped).toBeGreaterThan(0);
  expect(controller.snapshot().status).toBe("idle");
  expect(failedSession.items.some(item => item.type === "tool_result" && item.content.includes("settled"))).toBe(true);
}));

test("interactive /compact reports completed, noop, cancellation and rejected transitions without raw errors", async () => inHome(async home => {
  const olderTurns = () => {
    const session = createSession();
    for (let i = 0; i < 12; i++) {
      session.append({ type: "user", id: `u${i}`, content: [{ type: "text", text: `goal ${i}` }] });
      session.append({ type: "assistant", id: `a${i}`, content: [{ type: "text", text: `progress ${i}` }] });
    }
    return session;
  };
  let sessionId = "manual-success";
  const sink = createDiagnosticSink({ home, enabled: true, sessionId: () => sessionId });
  const completed = makeController(home, olderTurns(), createScriptedModel({ text: "## Goal\nsummary" }), event => sink.runtime(event));
  expect(await completed.compact()).toBe(true);
  sessionId = "manual-noop";
  const noop = makeController(home, createSession(), createScriptedModel({ text: "unused" }), event => sink.runtime(event));
  expect(await noop.compact()).toBe(false);
  sessionId = "manual-cancel";
  let started!: () => void;
  const waitStarted = new Promise<void>(resolve => { started = resolve; });
  const cancellation = makeController(home, olderTurns(), createScriptedModel({ waitForAbort: true, text: "never" }), event => {
    sink.runtime(event);
    if (event.type === "compaction.started") started();
  });
  const pending = cancellation.compact();
  await waitStarted;
  cancellation.cancel();
  expect(await pending).toBe(false);
  sessionId = "manual-failure";
  const workspace = { root: home, launchCwd: home, extraRoots: [] as string[] };
  const manager = createContextManager(workspace);
  const failure = new TuiController({ session: olderTurns(), model: createScriptedModel({ text: "unused" }),
    contextManager: { ...manager, async compact() { throw new Error("private-manual-error"); } },
    workspace, provider: "scripted", modelId: "scripted", sessionId,
    onRuntimeEvent: event => { sink.runtime(event); if (event.type === "compaction.started") throw Error("observer failed"); },
  });
  expect(await failure.compact()).toBe(false);
  expect(failure.snapshot().status).toBe("idle");
  expect(failure.snapshot().compactionNotice).toBe("Compaction failed · F2 repair details");
  expect(failure.inspectNoticeDetails()).toBe(true);
  expect(failure.snapshot().transcript.at(-1)?.text).toContain("/compact");
  await sink.close();
  const text = await readFile(diagnosticPath(home), "utf8");
  expect(text).not.toContain("private-manual-error");
  const records = text.trim().split("\n").map(line => JSON.parse(line) as { sessionId: string; event: string; fields: { status?: string; reason?: string } });
  for (const [id, status] of [["manual-success", "completed"], ["manual-noop", "noop"], ["manual-cancel", "cancelled"], ["manual-failure", "failed"]]) {
    const matching = records.filter(record => record.sessionId === id && record.event.startsWith("compaction."));
    expect(matching.map(record => record.event)).toEqual(["compaction.started", "compaction.finished"]);
    expect(matching[0]?.fields.reason).toBe("manual");
    expect(matching[1]?.fields.status).toBe(status);
  }
}));

test("actual interactive quit while a turn is active logs truthful cancellation request and exits without hanging", async () => inHome(async home => {
  // Isolated process keeps the mocked renderer from affecting other OpenTUI tests.
  const script = String.raw`
    import { mock } from "bun:test";
    import { join } from "node:path";
    import { pathToFileURL } from "node:url";
    import { createTestRenderer } from "@opentui/core/testing";
    const root = process.cwd();
    const terminal = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true });
    const fixture = join(root, "src/tui/credential-input.ts");
    const credentialInput = await import(pathToFileURL(fixture).href);
    const core = await credentialInput.loadCredentialSafeTui();
    mock.module(fixture, () => ({
      ...credentialInput,
      loadCredentialSafeTui: async () => ({ ...core, createCliRenderer: async () => {
        setTimeout(async () => {
          await terminal.mockInput.pasteBracketedText("work");
          terminal.mockInput.pressEnter();
        }, 0);
        return terminal.renderer;
      } }),
    }));
    const { runInteractiveTui } = await import(pathToFileURL(join(root, "src/tui/app.ts")).href);
    const model = { provider: "scripted", id: "scripted", async *stream(request) {
      yield { type: "text_delta", text: "partial" };
      setTimeout(() => terminal.mockInput.pressKey("d", { ctrl: true }), 0);
      await new Promise(resolve => request.signal.addEventListener("abort", resolve, { once: true }));
      const failure = new Error("aborted"); failure.name = "AbortError"; throw failure;
    } };
    const code = await runInteractiveTui({ args: { json: false, help: false, debug: true },
      env: { HOME: process.env.HOME, SCHWAY_MOTION: "off" }, cwd: process.env.HOME, model,
      stdout: { write() {} }, stderr: { write(text) { console.error(text); } } });
    console.log("EXIT:" + code);
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: process.cwd(), env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([child.exited, new Promise<number>((_, reject) => {
      timer = setTimeout(() => reject(new Error("TUI quit fixture hung")), 4000);
    })]);
    expect(code).toBe(0);
    expect(await new Response(child.stdout).text()).toContain("EXIT:0");
    const stderr = await new Response(child.stderr).text();
    expect(stderr.trim()).toMatch(/^Cancellation requested\. Running tools may have changed files; completion was not confirmed\.\n\nResume: schway --resume [a-f0-9-]+$/);
    const records = (await readFile(diagnosticPath(home), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { component: string; event: string; fields: { state?: string; reason?: string } });
    expect(records.some(record => record.component === "tui" && record.event === "shutdown" && record.fields.state === "cancellation_requested" && record.fields.reason === "quit")).toBe(true);
    expect(records.some(record => record.event === "agent.finished")).toBe(false);
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}));

test("TUI event callback uses constant-time current session ID after a switch without inspecting transcript", async () => inHome(async home => {
  const workspace = { root: home, launchCwd: home, extraRoots: [] as string[] };
  const first = createSession();
  let diagnosticSessionId: string | undefined = "first";
  const sink = createDiagnosticSink({ home, enabled: true, sessionId: () => diagnosticSessionId });
  const seenIds: string[] = [];
  const controller = new TuiController({ session: first,
    model: createScriptedModel({ responses: [{ text: "one" }, { text: "two" }] }),
    contextManager: createContextManager(workspace), workspace,
    provider: "scripted", modelId: "scripted", sessionId: "first",
    onRuntimeEvent(event, sessionId) { diagnosticSessionId = sessionId; seenIds.push(sessionId); sink.runtime(event); },
  });
  controller.snapshot = () => { throw new Error("expensive transcript snapshot accessed"); };
  await controller.submit("first prompt");
  expect(await controller.switchSession(createSession(), "second", { workspace, contextManager: createContextManager(workspace) })).toBe(true);
  await controller.submit("second prompt");
  await sink.close();
  expect(seenIds).toContain("first");
  expect(seenIds).toContain("second");
  const records = (await readFile(diagnosticPath(home), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { sessionId: string; event: string });
  expect(records.filter(record => record.event === "agent.finished").map(record => record.sessionId)).toEqual(["first", "second"]);
}));

test("interactive cancellation flushes the final correlated lifecycle event", async () => inHome(async home => {
  const sink = createDiagnosticSink({ home, enabled: true, sessionId: () => "tui-session" });
  let started!: () => void;
  const modelStarted = new Promise<void>(resolve => { started = resolve; });
  const controller = makeController(home, createSession(), createScriptedModel({ waitForAbort: true, text: "partial" }), event => {
    sink.runtime(event);
    if (event.type === "model.started") started();
  });
  const pending = controller.submit("cancelled prompt");
  await modelStarted;
  controller.cancel();
  await pending;
  await sink.close();
  const records = (await readFile(diagnosticPath(home), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { event: string; sessionId: string; fields: { reason?: string } });
  expect(records.find(record => record.event === "agent.finished")?.fields.reason).toBe("cancelled");
  expect(records.every(record => record.sessionId === "tui-session")).toBe(true);
}));
