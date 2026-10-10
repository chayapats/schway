import { expect, test } from "bun:test";
import { readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { codexSubscriptionIdentity } from "../src/auth/store.ts";
import type { AgentClock } from "../src/agent/retry.ts";
import { runAgentLoop } from "../src/agent/loop.ts";
import { runCli } from "../src/cli/main.ts";
import { runLiveSmoke } from "../src/live/smoke.ts";
import { loadConfigEditor } from "../src/config/editing.ts";
import { createContextManager } from "../src/context/manager.ts";
import type { AssistantMessage, UserMessage } from "../src/conversation/types.ts";
import { loadExtensions } from "../src/extensions/loader.ts";
import type { Model, ModelCallOptions } from "../src/model/model.ts";
import { isPromptCacheKey, PROMPT_CACHE_KEY_PATTERN, PROMPT_CACHE_KEY_PREFIX, promptCacheKey } from "../src/model/prompt-cache-key.ts";
import { createCodexSubscriptionModel } from "../src/model/providers/codex-subscription.ts";
import { createOpenAIModel } from "../src/model/providers/openai.ts";
import { createXaiModel } from "../src/model/providers/xai.ts";
import { createJsonlSession, loadJsonlSession, sessionsDirectory } from "../src/session/jsonl.ts";
import { createSession, type Session } from "../src/session/session.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { readTool } from "../src/tools/read.ts";
import { handleSlashCommand } from "../src/tui/app.ts";
import { dispatchEditorInput } from "../src/tui/commands.ts";
import { TuiController } from "../src/tui/controller.ts";
import { resolveWorkspace } from "../src/workspace/workspace.ts";
import { sampleRequest, TEXT_STREAM_EVENTS } from "./fixtures/openai.ts";
import { encodeXaiSse, XAI_TEXT_EVENTS } from "./fixtures/xai.ts";
import { withTempDir } from "./helpers.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { collect, createScriptedModel, type ScriptedTurnFactory } from "./helpers/scripted-model.ts";

const workspace = { root: "/tmp/project", launchCwd: "/tmp/project", extraRoots: [] as string[] };

function user(text: string, id: string = crypto.randomUUID()): UserMessage {
  return { type: "user", id, content: [{ type: "text", text }] };
}

/** Scripted model that records the conversation key each call received, `undefined` when none. */
function keyedModel(responses: ScriptedTurnFactory[], id = "scripted") {
  const inner = createScriptedModel({ responses, id });
  const keys: Array<string | undefined> = [];
  const model: Model = {
    provider: inner.provider,
    id: inner.id,
    async *stream(request, call?: ModelCallOptions) {
      keys.push(call?.promptCacheKey);
      yield* inner.stream(request);
    },
  };
  return { model, keys };
}

/** Run one agent turn for `text` and return the keys its model calls received. */
async function turn(session: Session, text: string, responses: ScriptedTurnFactory[] = [{ text: "done" }], id?: string) {
  session.append(user(text));
  const { model, keys } = keyedModel(responses, id);
  const events = await collect(runAgentLoop({ session, model, contextManager: createContextManager(workspace) }));
  expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
  return keys;
}

/** Clock whose backoff returns at once, so retry tests never wait. */
function instantClock(): AgentClock {
  return { now: () => 0, async sleep() {} };
}

test("the key has the pinned versioned shape and derivation", () => {
  const key = promptCacheKey({ rootId: "6897f723-9ac1-4b9a-9b8b-0c90d3ebddc8", activeBranchId: "main" });
  // Pinned value; the same derivation is checked independently with Python's hashlib in the PR.
  expect(key).toBe("schway-v1-04ac90d36d61b80f2f53503ad57d38d6");
  expect(key.length).toBe(42);
  expect(key.startsWith(PROMPT_CACHE_KEY_PREFIX)).toBe(true);
  expect(PROMPT_CACHE_KEY_PATTERN.test(key)).toBe(true);
  expect(isPromptCacheKey(key)).toBe(true);
  expect(/^[\x21-\x7e]{1,64}$/.test(key)).toBe(true);
  expect(isPromptCacheKey("6897f723-9ac1-4b9a-9b8b-0c90d3ebddc8")).toBe(false);
  expect(isPromptCacheKey(`${key}0`)).toBe(false);
  expect(isPromptCacheKey(key.toUpperCase())).toBe(false);
  expect(isPromptCacheKey(undefined)).toBe(false);
  // Equal inputs agree; the two identity parts cannot be shifted into each other.
  expect(promptCacheKey({ rootId: "6897f723-9ac1-4b9a-9b8b-0c90d3ebddc8", activeBranchId: "main" })).toBe(key);
  expect(promptCacheKey({ rootId: "a", activeBranchId: "bc" })).not.toBe(promptCacheKey({ rootId: "ab", activeBranchId: "c" }));
});

test("the key reveals no session UUID, branch, workspace path, model ID, token or account", async () => {
  await withTempDir(async dir => {
    const project = await resolveWorkspace(dir);
    const session = await createJsonlSession({ directory: join(dir, "sessions"), workspace: project });
    session.append(user("first", "u-first"), { type: "assistant", id: "a-first", content: [{ type: "text", text: "ok" }] });
    const branch = session.forkBranch("a-first", "feature-branch-name");
    const captured: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
    const model = createXaiModel({ apiKey: "xai-fixture-secret-token", model: "grok-4.7", baseUrl: "http://127.0.0.1:9/v1",
      fetch: async (_url, init) => {
        captured.push({ body: JSON.parse(String(init!.body)) as Record<string, unknown>, headers: new Headers(init!.headers) });
        return new Response(encodeXaiSse(XAI_TEXT_EVENTS), { headers: { "Content-Type": "text/event-stream" } });
      } });
    session.append(user("second"));
    await collect(runAgentLoop({ session, model, contextManager: createContextManager(project) }));
    const key = captured[0]!.body.prompt_cache_key as string;
    expect(key).toBe(promptCacheKey(session));
    expect(key).toMatch(PROMPT_CACHE_KEY_PATTERN);
    // Fragments under 8 characters (4-hex UUID chunks, "main") collide with a random 32-hex digest often enough to flake.
    const fragments = [session.rootId, ...session.rootId.split("-"), branch, ...branch.split("-"), "feature-branch-name",
      dir, project.root, "grok-4.7", "xai-fixture-secret-token"].filter(fragment => fragment.length >= 8);
    for (const fragment of fragments) expect(key.slice(PROMPT_CACHE_KEY_PREFIX.length)).not.toContain(fragment);
  });
});

test("every round of a turn, later turns and a transport retry send one identical key", async () => {
  const session = createSession();
  const first = await turn(session, "first", [
    { toolCalls: [{ id: "call-1", name: "missing", arguments: {} }] },
    { text: "after tool" },
  ]);
  const second = await turn(session, "second");
  session.append(user("third"));
  const { model, keys } = keyedModel([{ error: "upstream unavailable", status: 503 }, { text: "recovered" }]);
  const events = await collect(runAgentLoop({ session, model, contextManager: createContextManager(workspace), clock: instantClock() }));
  expect(events.some(event => event.type === "model.retry")).toBe(true);
  expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
  const expected = promptCacheKey(session);
  expect(first).toEqual([expected, expected]);
  expect(second).toEqual([expected]);
  expect(keys).toEqual([expected, expected]);
});

test("a model change keeps the key because it names the conversation, not the model", async () => {
  const session = createSession();
  const before = await turn(session, "first", [{ text: "a" }], "model-a");
  const after = await turn(session, "second", [{ text: "b" }], "model-b");
  expect(after).toEqual(before);
});

test("a new session, a fork and another selected branch change the key; reselecting a branch restores it", async () => {
  const session = createSession();
  const [main] = await turn(session, "first");
  const [fresh] = await turn(createSession(), "first");
  expect(fresh).not.toBe(main);
  const head = session.items.at(-1)!.id;
  const forked = session.forkBranch(head, "experiment");
  const [onFork] = await turn(session, "on the fork");
  expect(onFork).not.toBe(main);
  expect(onFork).toBe(promptCacheKey({ rootId: session.rootId, activeBranchId: forked }));
  const other = session.forkBranch(head);
  const [onOther] = await turn(session, "another branch");
  expect(new Set([main, onFork, onOther]).size).toBe(3);
  session.selectBranch("main");
  expect(await turn(session, "back on main")).toEqual([main]);
  session.selectBranch(forked);
  expect(await turn(session, "back on the fork")).toEqual([onFork]);
  session.selectBranch(other);
  expect(await turn(session, "back on the other")).toEqual([onOther]);
});

test("resuming the published 1.0.0-rc.1 session reproduces each branch's pinned key", async () => {
  const fixtureDir = join(import.meta.dir, "fixtures/sessions/1.0.0-rc.1");
  const expected = JSON.parse(await readFile(join(fixtureDir, "expect.json"), "utf8")) as { sessionId: string; mainBranchId: string; alternateBranchId: string };
  const pinned = new Map([
    [expected.mainBranchId, "schway-v1-04ac90d36d61b80f2f53503ad57d38d6"],
    [expected.alternateBranchId, "schway-v1-83dd38262d4ae4ede3939bcc1b9d5975"],
  ]);
  await withTempDir(async directory => {
    const text = await readFile(join(fixtureDir, `${expected.sessionId}.jsonl`), "utf8");
    await writeFile(join(directory, `${expected.sessionId}.jsonl`), text.replaceAll("__SCHWAY_FIXTURE_WORKSPACE__", directory));
    for (const [branchId, key] of pinned) {
      const loaded = await loadJsonlSession({ directory, id: expected.sessionId, branchId });
      expect(await turn(loaded, `resume ${branchId}`)).toEqual([key]);
      // Resuming again after the new turn was saved gives the same key: it is derived, never stored.
      const again = await loadJsonlSession({ directory, id: expected.sessionId, branchId });
      expect(await turn(again, "and again")).toEqual([key]);
    }
    expect(await readFile(join(directory, `${expected.sessionId}.jsonl`), "utf8")).not.toContain("schway-v1-");
  });
});

test("pressure compaction keeps the conversation key and its summary request sends none", async () => {
  const items: Array<UserMessage | AssistantMessage> = [];
  for (let i = 0; i < 12; i++) items.push(user(`goal step ${i}`, `u${i}`), { type: "assistant", id: `a${i}`, content: [{ type: "text", text: `progress ${i}` }] });
  const session = createSession(items);
  const { model, keys } = keyedModel([{ text: "## Goal\nsummary" }, { text: "done" }]);
  const events = await collect(runAgentLoop({ session, model, contextManager: createContextManager(workspace, { contextWindow: 100 }) }));
  expect(events.some(event => event.type === "compaction.finished" && event.status === "completed")).toBe(true);
  expect(keys).toEqual([undefined, promptCacheKey(session)]);
});

test("overflow recovery resends the same key and its summary request sends none", async () => {
  const items: Array<UserMessage | AssistantMessage> = [];
  for (let i = 0; i < 12; i++) items.push(user(`goal step ${i}`, `u${i}`), { type: "assistant", id: `a${i}`, content: [{ type: "text", text: `progress ${i}` }] });
  const session = createSession(items);
  const { model, keys } = keyedModel([
    { error: "This model's maximum context length is exceeded", status: 400, code: "context_length_exceeded" },
    { text: "## Goal\nsummary" },
    { text: "recovered" },
  ]);
  const events = await collect(runAgentLoop({ session, model, contextManager: createContextManager(workspace, { keepTurns: 10 }) }));
  expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
  const key = promptCacheKey(session);
  expect(keys).toEqual([key, undefined, key]);
});

test("a manual compaction summary sends no conversation key", async () => {
  const items: Array<UserMessage | AssistantMessage> = [];
  for (let i = 0; i < 12; i++) items.push(user(`goal step ${i}`, `u${i}`), { type: "assistant", id: `a${i}`, content: [{ type: "text", text: `progress ${i}` }] });
  const session = createSession(items);
  const bodies: Array<Record<string, unknown>> = [];
  const headers: Headers[] = [];
  const model = createXaiModel({ apiKey: "xai-test-key", model: "grok-4.7", baseUrl: "http://127.0.0.1:9/v1", fetch: async (_url, init) => {
    bodies.push(JSON.parse(String(init!.body)) as Record<string, unknown>);
    headers.push(new Headers(init!.headers));
    return new Response(encodeXaiSse(XAI_TEXT_EVENTS), { headers: { "Content-Type": "text/event-stream" } });
  } });
  await createContextManager(workspace, { keepTurns: 2 }).compact(session, model, { reason: "manual" });
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).not.toHaveProperty("prompt_cache_key");
  expect(headers[0]!.get("x-grok-conv-id")).toBeNull();
});

/** Load extension modules from source text into an isolated workspace. */
async function extensionFixture(dir: string, body: string) {
  const path = join(dir, "extension.ts");
  await Bun.write(path, body);
  const resolved = await realpath(path);
  const project = await resolveWorkspace(dir);
  const loaded = await loadExtensions({ modules: [resolved], workspace: project, home: join(dir, "home"), tools: createToolRegistry() });
  const module = await import(pathToFileURL(resolved).href) as { seen?: unknown[] };
  return { ...loaded, module, project };
}

/** xAI adapter on a fetch fixture that records each request body. */
function capturingXai() {
  const bodies: Array<Record<string, unknown>> = [];
  const model = createXaiModel({ apiKey: "xai-test-key", model: "grok-4.7", baseUrl: "http://127.0.0.1:9/v1", fetch: async (_url, init) => {
    bodies.push(JSON.parse(String(init!.body)) as Record<string, unknown>);
    return new Response(encodeXaiSse(XAI_TEXT_EVENTS), { headers: { "Content-Type": "text/event-stream" } });
  } });
  return { model, bodies };
}

test("an extension with only a prompt and a context hook still sends the Schway key", async () => {
  await withTempDir(async dir => {
    const setup = await extensionFixture(dir, `export default ctx => {
      ctx.registerPrompt({ name: 'style', content: 'be brief' });
      ctx.context(({ context }) => context);
    };`);
    try {
      const session = createSession([user("hello")]);
      const { model, bodies } = capturingXai();
      const events = await collect(runAgentLoop({ session, model, contextManager: createContextManager(setup.project), extensions: setup.runtime }));
      expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
      expect(String(bodies[0]!.instructions)).toContain("be brief");
      expect(bodies[0]!.prompt_cache_key).toBe(promptCacheKey(session));
    } finally { setup.runtime.dispose(); }
  });
});

test("a beforeModel hook returning a modified { ...request } succeeds, never sees the key and cannot set it", async () => {
  await withTempDir(async dir => {
    const setup = await extensionFixture(dir, `export const seen = [];
      export default ctx => {
        ctx.beforeModel(request => {
          const { signal, ...data } = request;
          seen.push(JSON.stringify(data) + ' ' + Object.keys(request).join(','));
          return { ...request, systemPrompt: request.systemPrompt + ' [hooked]' };
        });
      };`);
    try {
      const session = createSession([user("hello")]);
      const { model, bodies } = capturingXai();
      const events = await collect(runAgentLoop({ session, model, contextManager: createContextManager(setup.project), extensions: setup.runtime }));
      expect(events.some(event => event.type === "error")).toBe(false);
      expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
      const key = promptCacheKey(session);
      expect(String(bodies[0]!.instructions)).toContain("[hooked]");
      expect(bodies[0]!.prompt_cache_key).toBe(key);
      expect(setup.module.seen).toHaveLength(1);
      expect(String(setup.module.seen![0])).not.toContain(key);
      expect(String(setup.module.seen![0])).not.toMatch(/cache|schway-v1-/i);
    } finally { setup.runtime.dispose(); }
  });
  await withTempDir(async dir => {
    const setup = await extensionFixture(dir, `export default ctx => {
      ctx.beforeModel(request => ({ ...request, promptCacheKey: 'schway-v1-00000000000000000000000000000000' }));
    };`);
    try {
      const session = createSession([user("hello")]);
      const { model, bodies } = capturingXai();
      const events = await collect(runAgentLoop({ session, model, contextManager: createContextManager(setup.project), extensions: setup.runtime }));
      // The existing field check rejects the attempt before any request is sent.
      expect(events.some(event => event.type === "error" && event.message.includes("unsupported field"))).toBe(true);
      expect(bodies).toHaveLength(0);
    } finally { setup.runtime.dispose(); }
  });
});

test("ChatGPT subscription requests stay unchanged when a conversation key is offered", async () => {
  const bodies: string[] = [];
  const headers: Headers[] = [];
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-fixture" } })).toString("base64url");
  const model = createCodexSubscriptionModel({
    model: "gpt-6-astra",
    tokens: { accessToken: `h.${payload}.s`, expiresAt: Date.now() + 3_600_000 },
    fetch: async (_input, init) => {
      bodies.push(String(init?.body));
      headers.push(new Headers(init?.headers));
      return new Response(encodeXaiSse(XAI_TEXT_EVENTS), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  const key = promptCacheKey({ rootId: "8a4f1f36-6a43-4c55-9d1e-5b0f2f0c9e11", activeBranchId: "main" });
  await collect(model.stream(sampleRequest()));
  await collect(model.stream(sampleRequest(), { promptCacheKey: key }));
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]!);
  expect(JSON.parse(bodies[1]!)).not.toHaveProperty("prompt_cache_key");
  expect(bodies[1]).not.toContain(key);
  expect(key).not.toContain("acct-fixture");
  expect([...headers[1]!.keys()].sort()).toEqual([...headers[0]!.keys()].sort());
  expect([...headers[1]!.values()].join(" ")).not.toContain(key);
});

test("native OpenAI API-key requests stay unchanged when a conversation key is offered", async () => {
  const bodies: string[] = [];
  const model = createOpenAIModel({ apiKey: "sk-test", model: "gpt-6-astra", fetch: async (_input, init) => {
    bodies.push(String(init?.body));
    const sse = TEXT_STREAM_EVENTS.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
    return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
  } });
  const key = promptCacheKey({ rootId: "8a4f1f36-6a43-4c55-9d1e-5b0f2f0c9e11", activeBranchId: "main" });
  await collect(model.stream(sampleRequest()));
  await collect(model.stream(sampleRequest(), { promptCacheKey: key }));
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]!);
  expect(JSON.parse(bodies[1]!)).not.toHaveProperty("prompt_cache_key");
});

test("/clear and /new start a conversation with a new key, and /resume restores the old one", async () => {
  await withTempDir(async home => {
    const project = await resolveWorkspace(home);
    const directory = join(home, "sessions");
    const session = await createJsonlSession({ directory, workspace: project });
    const config = await loadConfigEditor({ home, workspaceRoot: home });
    const store = fakeCredentialStore();
    await store.set(codexSubscriptionIdentity(), "fixture-login");
    const { model, keys } = keyedModel(Array.from({ length: 6 }, () => ({ text: "answer" })));
    const controller = new TuiController({ home, workspace: project, session, sessionId: session.header.id,
      provider: "scripted", modelId: "fixture", thinking: "high", auth: "none", appearanceEnvironment: "light", configEditor: config,
      model, tools: createToolRegistry([readTool]), credentials: { store, env: {}, reload: async () => ({ model }) },
      contextManager: createContextManager(project, { home }) });
    const ctx = { controller, home, workspaceRoot: home, skillScope: { workspaceRoot: home }, sessionsDir: directory,
      settings: () => config.settings, env: {}, secrets: [], finishQuit() {}, stderr: { write() {} } };
    const send = (input: string) => dispatchEditorInput(input, controller,
      (command, accept) => handleSlashCommand(command.name, command.args, ctx, command.raw, accept));
    const sessionIds: string[] = [];
    await send("first conversation");
    sessionIds.push(controller.snapshot().sessionId!);
    expect(await send("/clear")).toBe(true);
    await send("second conversation");
    sessionIds.push(controller.snapshot().sessionId!);
    expect(await send("/new")).toBe(true);
    await send("third conversation");
    sessionIds.push(controller.snapshot().sessionId!);
    expect(await send(`/resume ${sessionIds[0]}`)).toBe(true);
    await send("back to the first");
    expect(new Set(sessionIds).size).toBe(3);
    expect(keys).toHaveLength(4);
    expect(keys.every(isPromptCacheKey)).toBe(true);
    expect(new Set(keys.slice(0, 3)).size).toBe(3);
    expect(keys[0]).toBe(promptCacheKey({ rootId: sessionIds[0]!, activeBranchId: "main" }));
    expect(keys[3]).toBe(keys[0]);
  });
});

test("each headless run without --resume gets a new key, and --resume reproduces the saved session's key", async () => {
  await withTempDir(async home => {
    const { model, keys } = keyedModel(Array.from({ length: 3 }, () => ({ text: "done" })));
    let errors = "";
    const run = (argv: string[]) => runCli(argv, { cwd: home, env: { HOME: home }, stdout: { write() {} }, stderr: { write(chunk) { errors += chunk; } }, model });
    expect(await run(["-p", "first"])).toBe(0);
    const [saved] = (await readdir(sessionsDirectory(home))).filter(name => name.endsWith(".jsonl")).map(name => name.slice(0, -".jsonl".length));
    expect(await run(["-p", "second"])).toBe(0);
    expect(await run(["-p", "again", "--resume", saved!])).toBe(0);
    expect(errors).toBe("");
    expect(keys).toHaveLength(3);
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[0]).toBe(promptCacheKey({ rootId: saved!, activeBranchId: "main" }));
    expect(keys[2]).toBe(keys[0]);
  });
});

test("a live smoke xAI lane sends one production key on both rounds without reporting it", async () => {
  const bodies: Array<{ prompt_cache_key?: string; input: Array<{ type?: string; output?: string }> }> = [];
  const report = await runLiveSmoke({ enabled: true, providers: ["xai-api-key"], revision: "test-revision", timeoutMs: 5000, env: { XAI_API_KEY: "PRIVATE_KEY" } }, {
    createStore: () => fakeCredentialStore(),
    createModel: async input => createXaiModel({ apiKey: input.apiKey!, model: input.model, fetch: async (_url, init) => {
      const body = JSON.parse(String(init!.body)) as (typeof bodies)[number];
      bodies.push(body);
      const marker = body.input.find(item => item.type === "function_call_output")?.output?.match(/1\|([a-f0-9]{40})/)?.[1];
      const events = marker === undefined
        ? [
          { type: "response.output_item.added", output_index: 0, item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "read", arguments: "" } },
          { type: "response.output_item.done", output_index: 0, item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "read", arguments: JSON.stringify({ path: "smoke-sentinel.txt" }) } },
          { type: "response.completed", response: { id: "r1", status: "completed" } },
        ]
        : [
          { type: "response.output_item.added", output_index: 0, item: { id: "m1", type: "message", role: "assistant", content: [] } },
          { type: "response.output_text.delta", output_index: 0, delta: marker },
          { type: "response.output_item.done", output_index: 0, item: { id: "m1", type: "message", role: "assistant", content: [{ type: "output_text", text: marker }] } },
          { type: "response.completed", response: { id: "r2", status: "completed" } },
        ];
      return new Response(encodeXaiSse(events), { headers: { "Content-Type": "text/event-stream" } });
    } }),
  });
  expect(report.scenarios[0]).toMatchObject({ status: "passed", toolRoundTrip: true });
  expect(bodies).toHaveLength(2);
  expect(bodies[0]!.prompt_cache_key).toMatch(PROMPT_CACHE_KEY_PATTERN);
  expect(bodies[1]!.prompt_cache_key).toBe(bodies[0]!.prompt_cache_key!);
  expect(JSON.stringify(report)).not.toContain("schway-v1-");
});
