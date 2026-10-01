import { expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runAgentLoop } from "../src/agent/loop.ts";
import type { RuntimeEvent } from "../src/agent/events.ts";
import { runCli } from "../src/cli/main.ts";
import { createContextManager } from "../src/context/manager.ts";
import { ExtensionRuntime, OBSERVER_QUEUE_LIMIT, OBSERVER_QUEUE_CHAR_LIMIT } from "../src/extensions/host.ts";
import { loadExtensions } from "../src/extensions/loader.ts";
import { createJsonlSession, loadJsonlSession } from "../src/session/jsonl.ts";
import { createSession } from "../src/session/session.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { TuiController } from "../src/tui/controller.ts";
import { resolveWorkspace } from "../src/workspace/workspace.ts";
import { withIsolatedCliDirs, withTempDir } from "./helpers.ts";
import { collect, createScriptedModel } from "./helpers/scripted-model.ts";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

test("native loop observers cannot mutate events/results or abort execution by throwing or rejecting", async () => {
  await withTempDir(async dir => {
    const workspace = await resolveWorkspace(dir);
    const diagnostics: string[] = [];
    const runtime = new ExtensionRuntime({ onDiagnostic: message => diagnostics.push(message), secrets: ["private-key"] });
    const observed: unknown[] = [];
    runtime.subscribe("mutating.ts", event => {
      if (event.type === "model.delta") (event.content as { text: string }).text = "tampered";
      if (event.type === "tool.finished") (event.details as { nested: { value: string } }).nested.value = "tampered";
    });
    runtime.subscribe("rejecting.ts", async () => { throw new Error("reject private-key"); });
    runtime.subscribe("unprintable.ts", () => { throw { toString() { throw new Error("cannot stringify"); } }; });
    runtime.subscribe("healthy.ts", event => { observed.push(event); });
    const session = createSession();
    const details = { nested: { value: "original private-key" } };
    const events = await collect(runAgentLoop({
      session, workspace, extensions: runtime, contextManager: createContextManager(workspace),
      tools: createToolRegistry([{ name: "fixture", description: "Fixture", execution: "exclusive", inputSchema: { type: "object" },
        async execute() { return { content: "tool original", details }; } }]),
      model: createScriptedModel({ responses: [
        { toolCalls: [{ id: "one-result", name: "fixture", arguments: {} }] },
        { text: "assistant original" },
      ] }),
    }));
    expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
    expect(events.find(event => event.type === "model.delta")).toMatchObject({ content: { text: "assistant original" } });
    expect(events.find(event => event.type === "tool.finished")).toMatchObject({ content: "tool original", details });
    expect(details.nested.value).toBe("original private-key");
    expect(session.items.filter(item => item.type === "tool_result")).toMatchObject([{ toolCallId: "one-result", content: "tool original" }]);
    expect(session.items.filter(item => item.type === "tool_result")).toHaveLength(1);
    expect(observed).toHaveLength(events.length);
    expect(JSON.stringify(observed)).not.toContain("private-key");
    expect(JSON.stringify(observed)).not.toContain("tampered");
    expect(diagnostics.some(message => message.includes("mutating.ts") && message.includes("observer failed"))).toBe(true);
    expect(diagnostics.some(message => message.includes("rejecting.ts") && message.includes("reject ***"))).toBe(true);
    expect(diagnostics.some(message => message.includes("unprintable.ts") && message.includes("Unprintable extension failure"))).toBe(true);
    expect(diagnostics.join("\n")).not.toContain("private-key");
    runtime.dispose();
  });
});

test("slow listeners preserve their own order without gating other listeners or model completion, and report bounded drops", async () => {
  await withTempDir(async dir => {
    const diagnostics: string[] = [];
    const runtime = new ExtensionRuntime({ onDiagnostic: message => diagnostics.push(message) });
    const gate = deferred();
    const drained = deferred();
    const slow: string[] = [];
    const fast: string[] = [];
    let signal: AbortSignal | undefined;
    runtime.subscribe("slow.ts", async (event, context) => {
      signal = context.signal;
      slow.push(event.type === "model.delta" ? event.content.text : event.type);
      if (slow.length === 1) await gate.promise;
      if (slow.length === OBSERVER_QUEUE_LIMIT + 1) drained.resolve();
    });
    runtime.subscribe("fast.ts", event => { fast.push(event.type === "model.delta" ? event.content.text : event.type); });
    const workspace = await resolveWorkspace(dir);
    const chunks = Array.from({ length: 300 }, (_, index) => String(index));
    const events = await collect(runAgentLoop({
      session: createSession(), workspace, contextManager: createContextManager(workspace),
      extensions: runtime, model: createScriptedModel({ chunks }),
    }));
    expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
    expect(fast).toHaveLength(events.length);
    expect(slow).toEqual(["agent.started"]);
    expect(diagnostics.some(message => message.includes("slow.ts") && message.includes("queue limit exceeded"))).toBe(true);
    gate.resolve();
    await drained.promise;
    expect(slow).toEqual(fast.slice(0, OBSERVER_QUEUE_LIMIT + 1));
    runtime.dispose();
    expect(signal!.aborted).toBe(true);
    expect(diagnostics.join("\n")).toContain(`dropped ${events.length - OBSERVER_QUEUE_LIMIT - 1} runtime notifications in total`);
  });
});

test("observer byte limits and disposal keep unresolved listener work from holding the runtime open", async () => {
  const diagnostics: string[] = [];
  const runtime = new ExtensionRuntime({ onDiagnostic: message => diagnostics.push(message) });
  const started = deferred();
  let signal: AbortSignal | undefined;
  runtime.subscribe("blocked.ts", (_event, context) => {
    signal = context.signal;
    started.resolve();
    return new Promise(() => {});
  });
  runtime.publish({ type: "agent.started" });
  await started.promise;
  runtime.publish({ type: "model.delta", content: { type: "text", text: "x".repeat(OBSERVER_QUEUE_CHAR_LIMIT) } });
  runtime.publish({ type: "agent.finished", reason: "completed" });
  runtime.dispose();
  runtime.dispose();
  expect(signal!.aborted).toBe(true);
  expect(diagnostics.join("\n")).toContain("queue limit exceeded");
  expect(diagnostics.join("\n")).toContain("1 queued runtime notification: runtime disposed");
});

test("unsubscribe aborts current work and catches a rejection returned after self-unsubscription", async () => {
  const runtime = new ExtensionRuntime();
  let called = 0;
  let signal: AbortSignal | undefined;
  const calledOnce = deferred();
  const unsubscribe = runtime.subscribe("self.ts", (_event, context) => {
    called++;
    signal = context.signal;
    unsubscribe();
    calledOnce.resolve();
    return Promise.reject(new Error("already unsubscribed"));
  });
  runtime.publish({ type: "agent.started" });
  await calledOnce.promise;
  runtime.publish({ type: "agent.finished", reason: "completed" });
  unsubscribe();
  expect(called).toBe(1);
  expect(signal!.aborted).toBe(true);
  runtime.dispose();
});

test("new/resumed sessions fence old draining tools and reset observer work without multiplying subscriptions", async () => {
  await withTempDir(async dir => {
    const workspace = await resolveWorkspace(dir);
    const runtime = new ExtensionRuntime();
    const events: RuntimeEvent[] = [];
    const signals: AbortSignal[] = [];
    const blockedStarted = deferred();
    runtime.subscribe("healthy.ts", event => { events.push(event as RuntimeEvent); });
    runtime.subscribe("blocked.ts", (_event, context) => {
      signals.push(context.signal);
      blockedStarted.resolve();
      return new Promise(() => {});
    });
    const toolStarted = deferred();
    const toolGate = deferred();
    const old = createSession();
    const controller = new TuiController({
      session: old, sessionId: "old", extensions: runtime, workspace,
      provider: "scripted", modelId: "scripted", contextManager: createContextManager(workspace),
      tools: createToolRegistry([{ name: "gated", description: "Gated", inputSchema: { type: "object" }, execution: "exclusive",
        async execute() { toolStarted.resolve(); await toolGate.promise; return { content: "old tool completed" }; } }]),
      model: createScriptedModel({ responses: [
        { toolCalls: [{ id: "old-call", name: "gated", arguments: {} }] }, { text: "fresh" }, { text: "resumed" },
      ] }),
    });
    const oldTurn = controller.submit("old");
    await toolStarted.promise;
    await blockedStarted.promise;
    const directory = join(dir, "sessions");
    const fresh = await createJsonlSession({ directory, workspace });
    controller.replaceSession(fresh, fresh.header.id);
    expect(signals[0]!.aborted).toBe(true);
    const boundary = events.length;
    toolGate.resolve();
    await oldTurn;
    expect(events).toHaveLength(boundary);
    expect(old.items.filter(item => item.type === "tool_result")).toMatchObject([{ toolCallId: "old-call", content: "old tool completed" }]);
    await controller.submit("fresh prompt");
    const resumed = await loadJsonlSession({ directory, id: fresh.header.id });
    controller.replaceSession(resumed, resumed.header.id);
    await controller.submit("resumed prompt");
    expect(events.slice(boundary).filter(event => event.type === "agent.started")).toHaveLength(2);
    expect(events.slice(boundary).filter(event => event.type === "agent.finished")).toHaveLength(2);
    expect(events.slice(boundary).some(event => event.type === "tool.finished")).toBe(false);
    expect(signals).toHaveLength(3);
    expect(signals[1]!.aborted).toBe(true);
    controller.dispose();
    expect(signals[2]!.aborted).toBe(true);
    const before = controller.snapshot().transcript.length;
    runtime.publish({ type: "error", message: "must not reach destroyed controller" });
    expect(controller.snapshot().transcript).toHaveLength(before);
  });
});

test("headless JSONL and controller observers receive the same native events, with cleanup and stderr-only diagnostics", async () => {
  await withIsolatedCliDirs(async ({ work, home }) => {
    const file = join(work, "observe.ts");
    await Bun.write(file, `export const observed = []; export let disposed = 0; export let lifetime;
      export default ctx => {
        lifetime = ctx.signal;
        ctx.onRuntimeEvent(event => { observed.push(event); });
        ctx.onRuntimeEvent(() => { throw new Error('diagnostic private-key'); });
        ctx.onDispose(() => { disposed++; });
      };`);
    const module = await import(pathToFileURL(await realpath(file)).href);
    let stdout = "";
    let stderr = "";
    expect(await runCli(["-p", "hello", "--json", "--extension", file], {
      cwd: work, env: { HOME: home, OPENAI_API_KEY: "private-key" }, model: createScriptedModel({ text: "original" }),
      stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } },
    })).toBe(0);
    const output = stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(module.observed).toEqual(output);
    expect(output.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
    expect(stderr).toContain("observe.ts");
    expect(stderr).toContain("diagnostic ***");
    expect(stderr).not.toContain("private-key");
    expect(module.disposed).toBe(1);
    expect(module.lifetime.aborted).toBe(true);
    module.observed.length = 0;
    const workspace = await resolveWorkspace(work);
    const loaded = await loadExtensions({ modules: [file], workspace, tools: createToolRegistry(), secrets: ["private-key"] });
    const controller = new TuiController({
      session: createSession(), sessionId: "tui", ...loaded, extensions: loaded.runtime, workspace,
      provider: "scripted", modelId: "scripted", contextManager: createContextManager(workspace),
      model: createScriptedModel({ text: "original" }),
    });
    await controller.submit("hello");
    expect(module.observed).toEqual(output);
    expect(controller.snapshot().status).toBe("idle");
    expect(controller.snapshot().transcript.some(entry => entry.text.includes("diagnostic ***"))).toBe(true);
    controller.dispose();
    expect(module.disposed).toBe(2);
  });
});

test("headless early return disposes extension subscriptions before constructing a model or session", async () => {
  await withIsolatedCliDirs(async ({ work, home }) => {
    const file = join(work, "lifetime.ts");
    await Bun.write(file, `export let disposed = 0; export let signal; export default ctx => {
      signal = ctx.signal; ctx.onRuntimeEvent(() => {}); ctx.onDispose(() => { disposed++; });
    };`);
    expect(await runCli(["-p", "/skills", "--extension", file], {
      cwd: work, env: { HOME: home }, stdout: { write() {} }, stderr: { write() {} },
      createModel: async () => { throw new Error("must not construct model"); },
    })).toBe(0);
    const module = await import(pathToFileURL(await realpath(file)).href);
    expect(module.disposed).toBe(1);
    expect(module.signal.aborted).toBe(true);
  });
});
