import { expect, test } from "bun:test";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runAgentLoop } from "../src/agent/loop.ts";
import { createContextManager } from "../src/context/manager.ts";
import type { ConversationItem, UserMessage } from "../src/conversation/types.ts";
import { loadExtensions } from "../src/extensions/loader.ts";
import type { ModelRequest } from "../src/model/model.ts";
import { createJsonlSession, loadJsonlSession } from "../src/session/jsonl.ts";
import { createSession } from "../src/session/session.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { TuiController } from "../src/tui/controller.ts";
import { resolveWorkspace } from "../src/workspace/workspace.ts";
import { withTempDir } from "./helpers.ts";
import { collect, createScriptedModel } from "./helpers/scripted-model.ts";

function user(text: string): UserMessage {
  return { type: "user", id: crypto.randomUUID(), content: [{ type: "text", text }] };
}

async function fixture(dir: string, bodies: string[], secrets: string[] = []) {
  const paths: string[] = [];
  for (const [index, body] of bodies.entries()) {
    const path = join(dir, `extension-${index}.ts`);
    await Bun.write(path, body);
    paths.push(await realpath(path));
  }
  const workspace = await resolveWorkspace(dir);
  const home = join(dir, "home");
  const loaded = await loadExtensions({ modules: paths, workspace, home, secrets, tools: createToolRegistry() });
  const modules = await Promise.all(paths.map(path => import(pathToFileURL(path).href)));
  return { ...loaded, modules, paths, workspace, home };
}

test("two enabled extensions waterfall into actual requests without mutating durable or retained data", async () => {
  await withTempDir(async dir => {
    const setup = await fixture(dir, [
      `export const trace = []; const retained = [];
       export function corrupt() { for (const value of retained) value.content = 'late corruption'; }
       export default ctx => {
         const section = { name: 'style', content: 'be concise' };
         ctx.registerPrompt(section); section.content = 'registration corruption';
         ctx.registerTool({ name: 'ping', description: 'Ping', execution: 'parallel', inputSchema: { type: 'object' }, execute() { return { content: 'pong' }; } });
         ctx.beforeAgent(async input => {
           await Promise.resolve(); trace.push('a1');
           input.message.content[0].text = 'user corruption';
           const turn = { name: 'turn', content: 'once' }; retained.push(turn);
           return { context: [...input.context, turn] };
         });
         ctx.context(async input => {
           await Promise.resolve(); trace.push('c1');
           const section = input.context.find(s => s.name === 'turn');
           section.content += '-context'; retained.push(section);
           return input.context;
         });
         ctx.beforeModel(async request => {
           await Promise.resolve(); trace.push('m1');
           request.systemPrompt += '-first';
           request.items.find(i => i.type === 'user').content[0].text += '-ephemeral';
           request.tools = request.tools.filter(t => t.name === 'ping');
           retained.push(request.context.find(s => s.name === 'turn'));
           return request;
         });
       };`,
      `import { trace } from './extension-0.ts';
       export default ctx => {
         ctx.beforeAgent(input => {
           trace.push('a2');
           if (input.message.content[0].text !== 'original' || input.context[0].content !== 'once') throw new Error('wrong beforeAgent waterfall');
           return { context: [...input.context, { name: 'second', content: 'two' }] };
         });
         ctx.context(input => {
           trace.push('c2');
           const section = input.context.find(s => s.name === 'turn');
           if (section.content !== 'once-context') throw new Error('wrong context waterfall');
           section.content += '-second'; return input.context;
         });
         ctx.beforeModel(request => {
           trace.push('m2');
           if (!request.systemPrompt.endsWith('-first') || request.tools.length !== 1) throw new Error('wrong model waterfall');
           request.systemPrompt += '-second'; return request;
         });
       };`,
    ]);
    try {
      await Bun.write(join(setup.home, ".schway/SYSTEM.md"), "custom system");
      await Bun.write(join(dir, "AGENTS.md"), "project instructions");
      await Bun.write(join(dir, ".agents/skills/demo/SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\nSkill body");
      const directory = join(dir, "sessions");
      const session = await createJsonlSession({ directory, workspace: setup.workspace });
      session.append(user("original"));
      const contextManager = createContextManager(setup.workspace, { home: setup.home });
      const requests: ModelRequest[] = [];
      const inspect = (request: ModelRequest) => {
        requests.push(request);
        expect(request.systemPrompt).toBe("custom system-first-second");
        expect(request.context.map(s => s.name)).toEqual(["environment", "project-instructions", "available-skills", "style", "turn", "second"]);
        expect(request.context.find(s => s.name === "style")?.content).toBe("be concise");
        expect(request.context.find(s => s.name === "turn")?.content).toBe("once-context-second");
        expect(request.items.find(i => i.type === "user")?.content).toEqual([{ type: "text", text: "original-ephemeral" }]);
        expect(request.tools?.map(t => t.name)).toEqual(["ping"]);
        setup.modules[0].corrupt();
        expect(request.context.find(s => s.name === "turn")?.content).toBe("once-context-second");
      };
      const model = createScriptedModel({ responses: [
        request => { inspect(request); return { toolCalls: [{ id: "call", name: "ping", arguments: {} }] }; },
        request => { inspect(request); return { text: "done" }; },
      ] });
      const events = await collect(runAgentLoop({ ...setup, session, contextManager, model, extensions: setup.runtime }));
      expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
      expect(requests).toHaveLength(2);
      expect(setup.modules[0].trace).toEqual(["a1", "a2", "c1", "c2", "m1", "m2", "c1", "c2", "m1", "m2"]);
      expect(session.items[0]).toEqual(expect.objectContaining({ content: [{ type: "text", text: "original" }] }));
      expect(setup.tools.definitions().map(tool => tool.name)).toEqual(["ping"]);
      const resumed = await loadJsonlSession({ directory, id: session.header.id });
      expect(resumed.items).toEqual(session.items);
      expect(JSON.stringify(resumed.items)).not.toContain("ephemeral");
      expect(JSON.stringify(resumed.items)).not.toContain("once-context");
    } finally { setup.runtime.dispose(); }
  });
});

test("transport retries reuse a prepared object while overflow reruns only request hooks and bypasses the summarizer", async () => {
  await withTempDir(async dir => {
    const setup = await fixture(dir, [`export const counts = { agent: 0, context: 0, model: 0 };
      export default ctx => {
        ctx.registerPrompt({ name: 'extension', content: 'normal requests only' });
        ctx.beforeAgent(input => { counts.agent++; return { context: [{ name: 'turn', content: 'once' }] }; });
        ctx.context(({ context }) => { counts.context++; return context; });
        ctx.beforeModel(request => { counts.model++; request.systemPrompt += '-hook-' + counts.model; return request; });
      };`]);
    try {
      const history: ConversationItem[] = [];
      for (let i = 0; i < 6; i++) history.push(user(`old ${i}`), { type: "assistant", id: `a${i}`, content: [{ type: "text", text: "past" }] });
      const session = createSession([...history, user("new")]);
      const contextManager = createContextManager(setup.workspace, { home: setup.home, keepTurns: 1 });
      contextManager.setActiveSkill({ name: "active", body: "skill body", source: "skill/SKILL.md", dir: dir, scope: "project" });
      let original!: ModelRequest;
      const model = createScriptedModel({ responses: [
        request => { original = request; return { error: "busy", status: 503 }; },
        request => { expect(request).toBe(original); return { error: "context too long", code: "context_length_exceeded", status: 400 }; },
        request => {
          expect(request.context).toEqual([]);
          expect(request.systemPrompt).not.toContain("-hook-");
          expect(setup.modules[0].counts).toEqual({ agent: 1, context: 1, model: 1 });
          return { text: "Coding summary" };
        },
        request => {
          expect(request).not.toBe(original);
          expect(request.systemPrompt).toContain("-hook-2");
          expect(request.context.map(s => s.name)).toEqual(["environment", "summary", "active-skill", "extension", "turn"]);
          expect(request.context.find(s => s.name === "summary")?.content).toBe("Coding summary");
          return { text: "done" };
        },
      ] });
      const events = await collect(runAgentLoop({ ...setup, session, contextManager, model, extensions: setup.runtime,
        clock: { now: () => 0, sleep: async () => {} } }));
      expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
      expect(setup.modules[0].counts).toEqual({ agent: 1, context: 2, model: 2 });
      expect(session.items.filter(i => i.type === "compaction")).toHaveLength(1);
      expect(session.items.slice(0, history.length)).toEqual(history);
    } finally { setup.runtime.dispose(); }
  });
});

test("pressure summaries bypass hooks, and resumed/new turns get fresh extension context", async () => {
  await withTempDir(async dir => {
    const setup = await fixture(dir, [`export const counts = { agent: 0, model: 0 }; export default ctx => {
      ctx.beforeAgent(() => ({ context: [{ name: 'turn', content: String(++counts.agent) }] }));
      ctx.beforeModel(request => { counts.model++; return request; });
    };`]);
    try {
      const directory = join(dir, "sessions");
      const saved = await createJsonlSession({ directory, workspace: setup.workspace });
      for (let i = 0; i < 4; i++) saved.append(user("long ".repeat(500)), { type: "assistant", id: `old${i}`, content: [{ type: "text", text: "past" }] });
      const session = await loadJsonlSession({ directory, id: saved.header.id });
      session.append(user("new"));
      const contextManager = createContextManager(setup.workspace, { home: setup.home, keepTurns: 1, contextWindow: 1000 });
      const model = createScriptedModel({ responses: [
        request => { expect(request.context).toEqual([]); expect(setup.modules[0].counts).toEqual({ agent: 1, model: 0 }); return { text: "summary" }; },
        request => { expect(request.context.find(s => s.name === "turn")?.content).toBe("1"); return { text: "first" }; },
        request => { expect(request.context.find(s => s.name === "turn")?.content).toBe("2"); return { text: "second" }; },
      ] });
      const options = { ...setup, session, contextManager, model, extensions: setup.runtime };
      expect((await collect(runAgentLoop(options))).at(-1)).toMatchObject({ reason: "completed" });
      session.append(user("again"));
      expect((await collect(runAgentLoop(options))).at(-1)).toMatchObject({ reason: "completed" });
      expect(setup.modules[0].counts).toEqual({ agent: 2, model: 2 });
      expect(JSON.stringify((await loadJsonlSession({ directory, id: saved.header.id })).items)).not.toContain('"name":"turn"');
    } finally { setup.runtime.dispose(); }
  });
});

const failures: Array<[string, string, string]> = [
  ["beforeAgent", "return { deny: 'policy explanation' }", "Denied: policy explanation"],
  ["beforeModel", "return { deny: 'model explanation' }", "Denied: model explanation"],
  ["beforeAgent", "return { context: [{ name: 'environment', content: 'forged' }] }", "reserved"],
  ["beforeAgent", "return { message: input.message }", "unsupported field"],
  ["context", "return []", "retain named section"],
  ["context", "return [...input.context, input.context[0]]", "duplicate context"],
  ["context", "return [{ name: 'environment', content: 42 }]", "content must be a string"],
  ["beforeModel", "return { ...input, systemPrompt: 42 }", "systemPrompt must be a string"],
  ["beforeModel", "return { ...input, messages: [] }", "unsupported field"],
  ["beforeModel", "return { ...input, signal: new AbortController().signal }", "signal must remain"],
  ["beforeModel", "return { ...input, items: [{ type: 'system', id: 'bad', content: 'wire' }] }", "native user"],
  ["beforeModel", "return { ...input, items: [{ type: 'assistant', id: 'a', content: [{ type: 'tool_call', id: 'c', name: 'anything', arguments: {} }] }] }", "unresolved tool calls"],
  ["beforeModel", "return { ...input, tools: [{ name: 'invented', description: 'Fake', inputSchema: {} }] }", "unchanged registered"],
  ["beforeModel", "input.tools[0].inputSchema = {}; return input", "unchanged registered"],
  ["beforeModel", "return { ...input, tools: [input.tools[0], input.tools[0]] }", "unchanged registered"],
  ["beforeModel", "return { deny: '' }", "nonempty"],
  ["beforeAgent", "throw new Error('private-key ' + 'x'.repeat(60000))", "***"],
  ["context", "await Promise.resolve(); throw new Error('rejected hook')", "rejected hook"],
];

for (const [phase, body, expected] of failures) {
  test(`${phase} failure (${expected}) prevents provider execution and leaves controller usable`, async () => {
    await withTempDir(async dir => {
      const setup = await fixture(dir, [`let calls = 0; export default ctx => {
        ctx.${phase}(async input => { if (++calls === 1) { ${body} } });
      };`], ["private-key"]);
      let requests = 0;
      const session = createSession();
      const controller = new TuiController({ ...setup, session, sessionId: "hooks", extensions: setup.runtime,
        contextManager: createContextManager(setup.workspace, { home: setup.home }), provider: "scripted", modelId: "scripted",
        model: createScriptedModel({ responses: [() => { requests++; return { text: "recovered" }; }] }) });
      try {
        await controller.submit("first");
        expect(requests).toBe(0);
        expect(controller.running).toBe(false);
        const error = controller.snapshot().transcript.at(-1)!.text;
        expect(error).toContain(setup.paths[0]!);
        expect(error).toContain(phase);
        expect(error).toContain(expected);
        expect(error).not.toContain("private-key");
        expect(error.length).toBeLessThanOrEqual(50_000);
        expect(session.items).toHaveLength(1);
        await controller.submit("second");
        expect(requests).toBe(1);
        expect(controller.snapshot().transcript.at(-1)?.text).toBe("recovered");
      } finally { controller.dispose(); }
    });
  });
}

for (const phase of ["beforeAgent", "context", "beforeModel"]) {
  test(`cancellation settles a hanging ${phase} and observes its later rejection`, async () => {
    await withTempDir(async dir => {
      const setup = await fixture(dir, [`let start; export const started = new Promise(resolve => start = resolve);
        export let signal; export let reject; let calls = 0; export default ctx => {
          ctx.${phase}(input => { if (++calls > 1) return; signal = input.signal; start(); return new Promise((_, fail) => reject = fail); });
        };`]);
      const session = createSession();
      let requests = 0;
      const controller = new TuiController({ ...setup, session, sessionId: "cancel", extensions: setup.runtime,
        contextManager: createContextManager(setup.workspace, { home: setup.home }), provider: "scripted", modelId: "scripted",
        model: createScriptedModel({ responses: [() => { requests++; return { text: "recovered" }; }] }) });
      try {
        const work = controller.submit("cancel me");
        await setup.modules[0].started;
        controller.cancel();
        await work;
        expect(setup.modules[0].signal.aborted).toBe(true);
        expect(requests).toBe(0);
        expect(controller.running).toBe(false);
        expect(session.items.filter(i => i.type !== "user")).toEqual([]);
        setup.modules[0].reject(new Error("late rejection"));
        await Promise.resolve();
        await controller.submit("recover");
        expect(requests).toBe(1);
      } finally { controller.dispose(); }
    });
  });
}

test("denying a later request preserves exactly one result for each previously accepted tool call", async () => {
  await withTempDir(async dir => {
    const setup = await fixture(dir, [`export default ctx => {
      let calls = 0;
      ctx.registerTool({ name: 'ping', description: 'Ping', inputSchema: { type: 'object' }, execution: 'parallel', execute() { return { content: 'pong' }; } });
      ctx.beforeModel(() => { if (++calls === 2) return { deny: 'stop after tools' }; });
    };`]);
    try {
      const session = createSession([user("start")]);
      const events = await collect(runAgentLoop({ ...setup, session, extensions: setup.runtime,
        contextManager: createContextManager(setup.workspace, { home: setup.home }),
        model: createScriptedModel({ toolCalls: [{ id: "one", name: "ping", arguments: {} }, { id: "two", name: "ping", arguments: {} }] }) }));
      expect(events.at(-1)).toMatchObject({ reason: "error" });
      expect(session.items.filter(i => i.type === "tool_result").map(i => i.toolCallId)).toEqual(["one", "two"]);
    } finally { setup.runtime.dispose(); }
  });
});

test("request registration is atomic, source-labelled, and closes after initialization", async () => {
  await withTempDir(async dir => {
    const setup = await fixture(dir, [`export let retained; export default ctx => { retained = ctx; };`]);
    try {
      for (const name of ["beforeAgent", "context", "beforeModel"]) expect(() => setup.modules[0].retained[name](() => {})).toThrow("registration is closed");
      expect(() => setup.modules[0].retained.registerPrompt({ name: "late", content: "no" })).toThrow("registration is closed");
    } finally { setup.runtime.dispose(); }
    for (const [index, body] of [
      `ctx.registerPrompt({ name: 'environment', content: 'bad' })`,
      `ctx.beforeAgent(42)`,
      `ctx.context(null)`,
      `ctx.beforeModel('bad')`,
    ].entries()) {
      const path = join(dir, `invalid-${index}.ts`);
      await Bun.write(path, `export default ctx => { try { ${body}; } catch {} };`);
      await expect(loadExtensions({ modules: [path], workspace: setup.workspace, home: setup.home, tools: createToolRegistry() })).rejects.toThrow(`invalid-${index}.ts`);
    }
    await mkdir(join(dir, "duplicates"));
    for (const name of ["first", "second"]) await Bun.write(join(dir, "duplicates", `${name}.ts`), `export default ctx => ctx.registerPrompt({ name: 'same', content: 'content' });`);
    const duplicate = loadExtensions({ modules: ["duplicates/first.ts", "duplicates/second.ts"], workspace: setup.workspace, home: setup.home, tools: createToolRegistry() });
    await expect(duplicate).rejects.toThrow("first.ts");
    await expect(duplicate).rejects.toThrow("second.ts");
  });
});

test("mutating hook inputs without returning changes leaves native requests and session history intact", async () => {
  await withTempDir(async dir => {
    const setup = await fixture(dir, [`export default ctx => {
      ctx.beforeAgent(input => { input.message.content[0].text = 'corrupt'; input.context.push({ name: 'ignored', content: 'ignored' }); });
      ctx.context(input => { input.context.length = 0; });
      ctx.beforeModel(input => { input.systemPrompt = 'corrupt'; input.context.length = 0; input.items.length = 0; input.tools[0].inputSchema = {}; });
    };`]);
    try {
      const session = createSession([user("original")]);
      const events = await collect(runAgentLoop({ ...setup, session, extensions: setup.runtime,
        contextManager: createContextManager(setup.workspace, { home: setup.home }),
        model: createScriptedModel({ responses: [request => {
          expect(request.systemPrompt).toContain("You are Schway");
          expect(request.context.map(s => s.name)).toEqual(["environment"]);
          expect(request.items[0]).toMatchObject({ type: "user", content: [{ type: "text", text: "original" }] });
          expect(request.tools![0]!.inputSchema).not.toEqual({});
          return { text: "done" };
        }] }) }));
      expect(events.at(-1)).toMatchObject({ reason: "completed" });
      expect(session.items[0]).toMatchObject({ content: [{ type: "text", text: "original" }] });
    } finally { setup.runtime.dispose(); }
  });
});

for (const action of ["cancel", "dispose"] as const) {
  test(`${action} during a later request hook leaves accepted tool calls fully settled`, async () => {
    await withTempDir(async dir => {
      const setup = await fixture(dir, [`let start; export const started = new Promise(resolve => start = resolve);
        export let signal; export default ctx => {
          let calls = 0;
          ctx.registerTool({ name: 'ping', description: 'Ping', inputSchema: { type: 'object' }, execution: 'parallel', execute() { return { content: 'pong' }; } });
          ctx.beforeModel(input => { if (++calls === 2) { signal = input.signal; start(); return new Promise(() => {}); } });
        };`]);
      const abort = new AbortController();
      const session = createSession([user("start")]);
      try {
        const work = collect(runAgentLoop({ ...setup, session, extensions: setup.runtime, signal: action === "cancel" ? abort.signal : undefined,
          contextManager: createContextManager(setup.workspace, { home: setup.home }),
          model: createScriptedModel({ toolCalls: [{ id: "one", name: "ping", arguments: {} }] }) }));
        await setup.modules[0].started;
        if (action === "cancel") abort.abort();
        else setup.runtime.dispose();
        const events = await work;
        expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "cancelled" });
        expect(setup.modules[0].signal.aborted).toBe(true);
        expect(session.items.filter(i => i.type === "tool_result")).toMatchObject([{ toolCallId: "one", content: "pong", isError: false }]);
      } finally { setup.runtime.dispose(); }
    });
  });
}
