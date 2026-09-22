import { expect, test } from "bun:test";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { runAgentLoop } from "../src/agent/loop.ts";
import type { RuntimeEvent } from "../src/agent/events.ts";
import { createContextManager } from "../src/context/manager.ts";
import type { ToolCallContent, ToolResult } from "../src/conversation/types.ts";
import { ExtensionRuntime } from "../src/extensions/host.ts";
import { loadExtensions } from "../src/extensions/loader.ts";
import type { BeforeToolInput } from "../src/extensions/index.ts";
import type { ModelRequest } from "../src/model/model.ts";
import { createJsonlSession, loadJsonlSession } from "../src/session/jsonl.ts";
import { createSession } from "../src/session/session.ts";
import { editTool, type EditInput } from "../src/tools/edit.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import type { ToolDefinition } from "../src/tools/types.ts";
import { resolveWorkspace } from "../src/workspace/workspace.ts";
import { withTempDir } from "./helpers.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";

const user = { type: "user" as const, id: "user", content: [{ type: "text" as const, text: "go" }] };
const editArgs = { path: "note.txt", edits: [{ oldText: "before", newText: "after" }] };

async function fixture(dir: string, bodies: string[], secrets: string[] = []) {
  const paths: string[] = [];
  for (const [index, body] of bodies.entries()) {
    const path = join(dir, `extension-${index}.ts`);
    await Bun.write(path, body);
    paths.push(await realpath(path));
  }
  const workspace = await resolveWorkspace(dir);
  const home = join(dir, "home");
  const loaded = await loadExtensions({ modules: paths, workspace, home, secrets, tools: createToolRegistry([editTool]) });
  const modules = await Promise.all(paths.map(path => import(pathToFileURL(path).href)));
  return { ...loaded, modules, workspace, home };
}

function call(id: string, name = "edit", args: unknown = editArgs): ToolCallContent {
  return { type: "tool_call", id, name, arguments: args };
}

async function turn(dir: string, runtime: ExtensionRuntime, tools: ReturnType<typeof createToolRegistry>, calls: ToolCallContent[], options: {
  signal?: AbortSignal; maxConcurrentTools?: number; events?: RuntimeEvent[]; durable?: boolean;
} = {}) {
  const workspace = await resolveWorkspace(dir);
  const directory = join(dir, "sessions");
  const saved = options.durable ? await createJsonlSession({ directory, workspace }) : undefined;
  const session = saved ?? createSession();
  session.append(user);
  const events = options.events ?? [];
  const requests: ModelRequest[] = [];
  const model = createScriptedModel({ responses: [request => { requests.push(request); return { toolCalls: calls }; }, request => { requests.push(request); return { text: "done" }; }] });
  for await (const event of runAgentLoop({ session, workspace, model, extensions: runtime, tools,
    contextManager: createContextManager(workspace, { home: join(dir, "home") }), ...options })) events.push(event);
  const results = session.items.filter((item): item is ToolResult => item.type === "tool_result");
  if (saved) expect((await loadJsonlSession({ directory, id: saved.header.id })).items).toEqual(session.items);
  expect(results.map(result => result.toolCallId)).toEqual(calls.map(call => call.id));
  expect(events.filter(event => event.type === "tool.finished")).toHaveLength(calls.length);
  return { session, results, events, requests };
}

test("loaded tool waterfalls edit a real file, detach metadata, and retain original durable arguments", async () => {
  await withTempDir(async dir => {
    await Bun.write(join(dir, "note.txt"), "before");
    const setup = await fixture(dir, [
      `export const trace = []; export let retained;
       export default ctx => {
         ctx.beforeTool(input => { trace.push('before1'); input.id = 'forged'; input.name = 'write'; input.execution = 'parallel'; input.inputSchema.required = []; input.arguments.edits[0].newText = 'first'; retained = input.arguments; return { arguments: input.arguments }; });
         ctx.afterTool(input => { trace.push('after1'); if (input.arguments.edits[0].newText !== 'final') throw new Error('wrong executed args'); retained.edits[0].newText = 'late corruption'; return { content: 'first result', details: { first: true } }; });
       };`,
      `import { trace } from './extension-0.ts'; export default ctx => {
         ctx.beforeTool(input => { trace.push('before2'); if (input.id !== 'edit-call' || input.name !== 'edit' || input.execution !== 'exclusive' || !input.inputSchema.required.includes('path') || input.arguments.edits[0].newText !== 'first') throw new Error('metadata or waterfall corrupted'); input.arguments.edits[0].newText = 'final'; return { arguments: input.arguments }; });
         ctx.afterTool(input => { trace.push('after2'); if (input.outcome.content !== 'first result' || !input.outcome.details.first || input.outcome.status !== 'success') throw new Error('outcome waterfall wrong'); return { content: 'final result', details: { final: true }, isError: false }; });
       };`,
    ]);
    try {
      expect(setup.runtime.hooks.active).toBe(false);
      const result = await turn(dir, setup.runtime, setup.tools, [call("edit-call")], { durable: true });
      expect(await Bun.file(join(dir, "note.txt")).text()).toBe("final");
      expect(setup.modules[0].trace).toEqual(["before1", "before2", "after1", "after2"]);
      expect(result.results).toMatchObject([{ content: "final result", isError: false }]);
      expect(result.session.items.find(item => item.type === "assistant")?.content).toEqual([call("edit-call")]);
      expect(result.events.find(event => event.type === "tool.finished")).toMatchObject({ details: { final: true } });
      expect(result.requests[0]?.signal).toBeUndefined();
    } finally { setup.runtime.dispose(); }
  });
});

for (const [label, body, expected] of [
  ["denied", "return { deny: 'policy denied' }", "Denied: policy denied"],
  ["invalid", "return { arguments: { path: 'note.txt', edits: [] } }", "Invalid transformed arguments"],
  ["throws", "throw new Error('hook broke')", "hook broke"],
  ["rejects", "return Promise.reject(new Error('hook rejected'))", "hook rejected"],
  ["empty", "return {}", "requires arguments"],
  ["malformed", "return { arguments: input.arguments, name: 'write' }", "unsupported field"],
  ["empty denial", "return { deny: '' }", "nonempty"],
] as const) {
  test(`beforeTool ${label} settles one bounded durable error without file changes or later hooks`, async () => {
    await withTempDir(async dir => {
      await Bun.write(join(dir, "note.txt"), "before");
      const setup = await fixture(dir, [`export const counts = { later: 0 }; export default ctx => {
        ctx.beforeTool(input => { ${body} }); ctx.beforeTool(() => { counts.later++; }); ctx.afterTool(() => { counts.later++; });
      };`]);
      try {
        const result = await turn(dir, setup.runtime, setup.tools, [call("one")], { durable: true });
        expect(await Bun.file(join(dir, "note.txt")).text()).toBe("before");
        expect(result.results[0]).toMatchObject({ isError: true });
        expect(result.results[0]!.content).toContain(expected);
        expect(result.results[0]!.content).toContain("extension-0.ts");
        expect(result.results[0]!.content.length).toBeLessThanOrEqual(50_000);
        expect(setup.modules[0].counts.later).toBe(0);
      } finally { setup.runtime.dispose(); }
    });
  });
}

test("unknown tools and invalid original arguments are rejected before any interception", async () => {
  await withTempDir(async dir => {
    const runtime = new ExtensionRuntime();
    let hooks = 0;
    runtime.toolHooks.beforeTool("policy", () => { hooks++; return { arguments: editArgs }; });
    runtime.toolHooks.afterTool("policy", () => { hooks++; });
    try {
      const result = await turn(dir, runtime, createToolRegistry([editTool]), [call("unknown", "missing"), call("invalid", "edit", {})], { durable: true });
      expect(result.results[0]!.content).toContain("Unknown tool");
      expect(result.results[1]!.content).toContain("Invalid arguments");
      expect(hooks).toBe(0);
    } finally { runtime.dispose(); }
  });
});

test("ignored mutations and retained return references cannot alter execution or result identity", async () => {
  await withTempDir(async dir => {
    await Bun.write(join(dir, "note.txt"), "before");
    const runtime = new ExtensionRuntime();
    let retained: BeforeToolInput | undefined;
    let details: { kept: boolean } | undefined;
    runtime.toolHooks.beforeTool("first", input => { retained = input; (input.arguments as EditInput).edits[0]!.newText = "ignored"; });
    runtime.toolHooks.beforeTool("second", input => { expect((input.arguments as EditInput).edits[0]!.newText).toBe("after"); (retained!.arguments as EditInput).edits[0]!.newText = "too late"; });
    runtime.toolHooks.afterTool("first", () => { details = { kept: true }; return { content: "kept", details }; });
    runtime.toolHooks.afterTool("second", input => { details!.kept = false; expect(input.outcome.details).toEqual({ kept: true }); input.outcome.content = "ignored"; });
    try {
      const result = await turn(dir, runtime, createToolRegistry([editTool]), [call("one")]);
      expect(await Bun.file(join(dir, "note.txt")).text()).toBe("after");
      expect(result.results[0]).toMatchObject({ content: "kept", toolCallId: "one", isError: false });
      expect(result.events.find(event => event.type === "tool.finished")).toMatchObject({ details: { kept: true } });
    } finally { runtime.dispose(); }
  });
});

for (const body of ["throw new Error('postprocessing broke')", "return { content: 42 }", "return { content: 'forged', toolCallId: 'different' }", "return { content: 'bad details', details: { bad: 1n } }"]) {
  test(`afterTool failure preserves a real edit and original outcome without replay: ${body}`, async () => {
    await withTempDir(async dir => {
      await Bun.write(join(dir, "note.txt"), "before");
      const setup = await fixture(dir, [`export const counts = { before: 0, after: 0 }; export default ctx => {
        ctx.beforeTool(() => { counts.before++; }); ctx.afterTool(() => { counts.after++; ${body} }); ctx.afterTool(() => { counts.after++; });
      };`]);
      try {
        const result = await turn(dir, setup.runtime, setup.tools, [call("one")], { durable: true });
        expect(await Bun.file(join(dir, "note.txt")).text()).toBe("after");
        expect(setup.modules[0].counts.before).toBe(1);
        expect(setup.modules[0].counts.after).toBe(1);
        expect(result.results[0]).toMatchObject({ isError: true });
        expect(result.results[0]!.content).toContain("Tool execution occurred; its effects may already apply");
        expect(result.results[0]!.content).toContain("did not replay");
        expect(result.results[0]!.content).toContain("extension-0.ts");
        expect(result.events.find(event => event.type === "tool.finished")).toMatchObject({ status: "error", details: {
          afterToolFailure: true, execution: { status: "success", isError: false, content: "Edited note.txt (1 replacement)", details: { path: "note.txt", hunks: [{ oldText: "before", newText: "after" }] } },
        } });
      } finally { setup.runtime.dispose(); }
    });
  });
}

test("afterTool handles returned and thrown execution errors and may change their presentation", async () => {
  await withTempDir(async dir => {
    await Bun.write(join(dir, "note.txt"), "no match");
    const runtime = new ExtensionRuntime();
    const seen: string[] = [];
    runtime.toolHooks.afterTool("first", input => {
      seen.push(input.name);
      expect(input.outcome.status).toBe("error");
      expect(input.outcome.isError).toBe(true);
      return { content: "Handled: " + input.outcome.content, details: { handled: true }, isError: false };
    });
    runtime.toolHooks.afterTool("second", input => { expect(input.outcome.status).toBe("error"); expect(input.outcome.isError).toBe(false); });
    const throws: ToolDefinition = { name: "throws", execution: "parallel", description: "Throw", inputSchema: { type: "object" }, async execute() { throw new Error("execution rejected"); } };
    try {
      const result = await turn(dir, runtime, createToolRegistry([editTool, throws]), [call("edit"), call("throws", "throws", {})]);
      expect(seen).toEqual(["edit", "throws"]);
      expect(result.results.every(result => !result.isError && result.content.startsWith("Handled: "))).toBe(true);
      expect(await Bun.file(join(dir, "note.txt")).text()).toBe("no match");
    } finally { runtime.dispose(); }
  });
});

test("tool hook presentation and denial redact credentials and bound text/details", async () => {
  await withTempDir(async dir => {
    const secret = 'private"key';
    const runtime = new ExtensionRuntime({ secrets: [secret] });
    runtime.toolHooks.beforeTool("policy", input => { if (input.id === "deny") return { deny: secret + "x".repeat(70_000) }; });
    runtime.toolHooks.afterTool("format", () => ({ content: "x".repeat(49_990) + secret + "x".repeat(70_000), details: { [secret]: secret + '"'.repeat(70_000) } }));
    const tool: ToolDefinition = { name: "probe", execution: "parallel", description: "Probe", inputSchema: {}, async execute() { return { content: "ok" }; } };
    try {
      const result = await turn(dir, runtime, createToolRegistry([tool]), [call("deny", "probe", {}), call("after", "probe", {})]);
      expect(JSON.stringify(result.results)).not.toContain("private");
      for (const resultItem of result.results) expect(resultItem.content.length).toBeLessThanOrEqual(50_000);
      const event = result.events.find(event => event.type === "tool.finished" && event.toolCallId === "after");
      expect(JSON.stringify(event)).not.toContain("private");
      if (event?.type === "tool.finished") expect(JSON.stringify(event.details).length).toBeLessThanOrEqual(50_000);
    } finally { runtime.dispose(); }
  });
});

class Gate {
  open!: () => void;
  readonly promise = new Promise<void>(resolve => { this.open = resolve; });
}

test("parallel waterfalls overlap, failures preserve siblings, and exclusive slots cover before/execution/after", async () => {
  await withTempDir(async dir => {
    const runtime = new ExtensionRuntime();
    const trace: string[] = [];
    const started = new Map(["a", "b", "exclusive-before", "exclusive-after", "later"].map(key => [key, new Gate()]));
    const gates = new Map(["a", "b", "exclusive-before", "exclusive-after"].map(key => [key, new Gate()]));
    runtime.toolHooks.beforeTool("policy", async input => {
      const key = input.id === "exclusive" ? "exclusive-before" : input.id;
      trace.push(key); started.get(key)!.open(); await gates.get(key)?.promise;
      if (input.id === "b") throw new Error("sibling denial");
    });
    runtime.toolHooks.afterTool("format", async input => {
      trace.push(`${input.id}-after`);
      if (input.id === "exclusive") { started.get("exclusive-after")!.open(); await gates.get("exclusive-after")!.promise; }
    });
    const probe = (name: string, execution: "parallel" | "exclusive"): ToolDefinition => ({ name, execution, description: "Probe", inputSchema: {}, async execute() { trace.push(`${name}-execute`); return { content: name }; } });
    try {
      const running = turn(dir, runtime, createToolRegistry([probe("parallel", "parallel"), probe("exclusive", "exclusive")]), [call("a", "parallel", {}), call("b", "parallel", {}), call("exclusive", "exclusive", {}), call("later", "parallel", {})], { durable: true });
      await Promise.all([started.get("a")!.promise, started.get("b")!.promise]);
      expect(trace).toEqual(["a", "b"]);
      gates.get("b")!.open(); gates.get("a")!.open();
      await started.get("exclusive-before")!.promise;
      expect(trace).not.toContain("exclusive-execute"); expect(trace).not.toContain("later");
      gates.get("exclusive-before")!.open();
      await started.get("exclusive-after")!.promise;
      expect(trace).toContain("exclusive-execute"); expect(trace).not.toContain("later");
      gates.get("exclusive-after")!.open();
      const result = await running;
      expect(result.results.map(result => result.isError)).toEqual([false, true, false, false]);
      expect(result.events.filter(event => event.type === "tool.finished").map(event => event.toolCallId)).toEqual(["b", "a", "exclusive", "later"]);
      expect(trace.indexOf("later")).toBeGreaterThan(trace.indexOf("exclusive-after"));
    } finally { for (const gate of gates.values()) gate.open(); runtime.dispose(); }
  });
});

for (const phase of ["before", "execution", "after"] as const) {
  for (const action of ["cancel", "dispose"] as const) {
    test(`${action} in ${phase} settles every queued call once and preserves completed effects`, async () => {
      await withTempDir(async dir => {
        const runtime = new ExtensionRuntime();
        const abort = new AbortController();
        const started = new Gate();
        const executionGate = new Gate();
        let invocations = 0;
        let later = 0;
        let hookSignal: AbortSignal | undefined;
        runtime.toolHooks.beforeTool("policy", input => {
          hookSignal = input.signal;
          if (phase === "before") { started.open(); return new Promise(() => {}); }
        });
        runtime.toolHooks.afterTool("partial", () => ({ content: "discard this partial transform", details: { transformed: true }, isError: true }));
        runtime.toolHooks.afterTool("format", () => {
          if (phase === "after") { started.open(); return new Promise(() => {}); }
        });
        runtime.toolHooks.afterTool("later", () => { later++; return { content: "must not run" }; });
        const tool: ToolDefinition = { name: "probe", description: "Probe", execution: "exclusive", inputSchema: {}, async execute() {
          invocations++;
          await Bun.write(join(dir, "effect.txt"), "once");
          if (phase === "execution") { started.open(); await executionGate.promise; }
          return { content: "executed", details: { original: true } };
        } };
        try {
          const events: RuntimeEvent[] = [];
          const running = turn(dir, runtime, createToolRegistry([tool]), [call("running", "probe", {}), call("queued", "probe", {})], { signal: abort.signal, events, durable: true });
          await started.promise;
          if (action === "cancel") abort.abort(); else runtime.dispose();
          expect(hookSignal?.aborted).toBe(true);
          if (phase === "execution") {
            await Promise.resolve();
            expect(events.filter(event => event.type === "tool.finished")).toHaveLength(0);
            executionGate.open();
          }
          const result = await running;
          expect(invocations).toBe(phase === "before" ? 0 : 1);
          expect(later).toBe(0);
          expect(result.results[0]).toMatchObject(phase === "before" ? { isError: true, content: "Tool call cancelled" } : { isError: false, content: "executed" });
          expect(result.results[1]).toMatchObject({ isError: true, content: "Tool call cancelled" });
          expect(result.events.at(-1)).toEqual({ type: "agent.finished", reason: "cancelled" });
          expect(await Bun.file(join(dir, "effect.txt")).exists()).toBe(phase !== "before");
        } finally { executionGate.open(); runtime.dispose(); }
      });
    });
  }
}

test("cancellation at beforeTool resolution cannot start unchecked work", async () => {
  await withTempDir(async dir => {
    const runtime = new ExtensionRuntime();
    const abort = new AbortController();
    let executed = 0;
    runtime.toolHooks.beforeTool("policy", async () => { abort.abort(); return { arguments: {} }; });
    const tool: ToolDefinition = { name: "probe", description: "Probe", execution: "parallel", inputSchema: {}, async execute() { executed++; return { content: "bad" }; } };
    try {
      const result = await turn(dir, runtime, createToolRegistry([tool]), [call("one", "probe", {})], { signal: abort.signal });
      expect(executed).toBe(0);
      expect(result.results[0]!.content).toBe("Tool call cancelled");
    } finally { runtime.dispose(); }
  });
});

test("activate_skill is intercepted on the ordinary loop path", async () => {
  await withTempDir(async dir => {
    await Bun.write(join(dir, ".agents/skills/demo/SKILL.md"), "---\nname: demo\ndescription: Demo\n---\nSkill instructions");
    const runtime = new ExtensionRuntime();
    let called = 0;
    runtime.toolHooks.beforeTool("policy", input => { expect(input.name).toBe("activate_skill"); called++; return { deny: "skill activation denied" }; });
    try {
      const result = await turn(dir, runtime, createToolRegistry(), [call("skill", "activate_skill", { name: "demo" })]);
      expect(called).toBe(1);
      expect(result.results[0]!.content).toContain("skill activation denied");
      expect(result.requests[1]?.context.some(section => section.name === "active-skill")).toBe(false);
    } finally { runtime.dispose(); }
  });
});

test("tool hook registration is atomic, callable, and closed after initialization", async () => {
  await withTempDir(async dir => {
    const setup = await fixture(dir, [`export const state = {}; export default ctx => { state.saved = ctx; ctx.beforeTool(() => {}); ctx.afterTool(() => {}); };`]);
    try {
      expect(() => setup.modules[0].state.saved.beforeTool(() => {})).toThrow("registration is closed");
      expect(() => setup.modules[0].state.saved.afterTool(() => {})).toThrow("registration is closed");
    } finally { setup.runtime.dispose(); }
    await expect(fixture(join(dir, "invalid"), [`export default ctx => { try { ctx.beforeTool(42); } catch {} };`])).rejects.toThrow("Tool hook must be a function");
  });
});

for (const body of ["({ bad: () => {} })", "({ bad: 1n })", "({ bad: NaN })", "({ bad: undefined })", "new Date()", "(() => { const cycle = {}; cycle.self = cycle; return cycle; })()"] ) {
  test(`permissive tool schemas cannot admit non-JSON hook arguments: ${body}`, async () => {
    await withTempDir(async dir => {
      const setup = await fixture(dir, [`export const counts = { executed: 0 }; export default ctx => {
        ctx.registerTool({ name: 'anything', description: 'Anything', inputSchema: {}, execution: 'parallel', execute() { counts.executed++; return { content: 'unsafe' }; } });
        ctx.beforeTool(() => ({ arguments: ${body} }));
      };`]);
      try {
        const result = await turn(dir, setup.runtime, setup.tools, [call("one", "anything", {})]);
        expect(result.results[0]!.isError).toBe(true);
        expect(result.results[0]!.content).toContain("beforeTool");
        expect(result.results[0]!.content).toContain("extension-0.ts");
        expect(setup.modules[0].counts.executed).toBe(0);
      } finally { setup.runtime.dispose(); }
    });
  });
}

test("a cancelled execution rejects once without afterTool claiming an unfinished success", async () => {
  await withTempDir(async dir => {
    const runtime = new ExtensionRuntime();
    const abort = new AbortController();
    const started = new Gate();
    let after = 0;
    runtime.toolHooks.afterTool("format", () => { after++; return { content: "forged success", isError: false }; });
    const tool: ToolDefinition = { name: "probe", description: "Probe", execution: "parallel", inputSchema: {}, async execute(_input, context) {
      started.open();
      await new Promise((_resolve, reject) => context.signal!.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true }));
      return { content: "never" };
    } };
    try {
      const pending = turn(dir, runtime, createToolRegistry([tool]), [call("one", "probe", {}), call("queued", "probe", {})], { signal: abort.signal, maxConcurrentTools: 1 });
      await started.promise; abort.abort();
      const result = await pending;
      expect(after).toBe(0);
      expect(result.results.every(result => result.content === "Tool call cancelled" && result.isError)).toBe(true);
    } finally { runtime.dispose(); }
  });
});

test("post-hook failure retains an executed error's details and never leaks a boundary-straddling credential", async () => {
  await withTempDir(async dir => {
    const secret = "private-long-credential";
    const runtime = new ExtensionRuntime({ secrets: [secret] });
    runtime.toolHooks.afterTool("format", () => { throw new Error(secret + "x".repeat(60_000)); });
    const tool: ToolDefinition = { name: "probe", description: "Probe", execution: "parallel", inputSchema: {}, async execute() {
      return { content: "x".repeat(49_915) + secret + "x".repeat(60_000), isError: true, details: { reason: secret } };
    } };
    try {
      const result = await turn(dir, runtime, createToolRegistry([tool]), [call("one", "probe", {})]);
      expect(JSON.stringify(result.events)).not.toContain("private");
      expect(result.results[0]!.content).toContain("did not replay");
      expect(result.results[0]!.content.length).toBeLessThanOrEqual(50_000);
      expect(result.events.find(event => event.type === "tool.finished")).toMatchObject({ details: {
        afterToolFailure: true, execution: { status: "error", isError: true, details: { reason: "***" } },
      } });
    } finally { runtime.dispose(); }
  });
});
