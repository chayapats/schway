import { expect, test } from "bun:test";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { runAgentLoop } from "../src/agent/loop.ts";
import { runCli } from "../src/cli/main.ts";
import { runLiveSmoke } from "../src/live/smoke.ts";
import { parseConfigObject, resolveSettings } from "../src/config/config.ts";
import { SUMMARY_SYSTEM_PROMPT } from "../src/context/compaction.ts";
import { createContextManager } from "../src/context/manager.ts";
import type { AssistantMessage, ConversationItem, UserMessage } from "../src/conversation/types.ts";
import { loadExtensions } from "../src/extensions/loader.ts";
import { HOSTED_ITEMS_KEY, HOSTED_TOOL_ALLOWLIST, hostedSearchCount, MAX_HOSTED_ITEM_BYTES, resolveHostedTools } from "../src/model/hosted-tools.ts";
import { loadProviderModel } from "../src/model/loader.ts";
import type { Model, ModelRequest, ModelStreamEvent } from "../src/model/model.ts";
import { promptCacheKey } from "../src/model/prompt-cache-key.ts";
import { CODEX_ACCOUNT_CLAIM, createCodexSubscriptionModel } from "../src/model/providers/codex-subscription.ts";
import { createOpenAIModel } from "../src/model/providers/openai.ts";
import { createOpenAICompatibleModel } from "../src/model/providers/openai-compatible.ts";
import { saveSubscriptionTokens } from "../src/model/providers/grok-subscription.ts";
import { createXaiModel, XAI_HOSTED_ITEM_REPLAY } from "../src/model/providers/xai.ts";
import { createJsonlSession, loadJsonlSession, sessionsDirectory } from "../src/session/jsonl.ts";
import { createSession, type Session } from "../src/session/session.ts";
import { readTool } from "../src/tools/read.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { buildTranscriptFromSession, hostedSearchEntryText } from "../src/tui/transcript-format.ts";
import { resolveWorkspace } from "../src/workspace/workspace.ts";
import { encodeSse as openaiSse, TEXT_STREAM_EVENTS as OPENAI_TEXT_EVENTS } from "./fixtures/openai.ts";
import { encodeChatCompletionsSse, TEXT_STREAM_CHUNKS } from "./fixtures/openai-compatible.ts";
import { encodeXaiSse, XAI_PARALLEL_TOOL_EVENTS, XAI_REASONING_ITEM, XAI_TEXT_EVENTS } from "./fixtures/xai.ts";
import { webSearchEvents, XAI_WEB_SEARCH_ITEM, XAI_WEB_SEARCH_REPLAY_ITEM } from "./fixtures/xai-web-search.ts";
import { withTempDir } from "./helpers.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { collect, createScriptedModel } from "./helpers/scripted-model.ts";

const workspace = { root: "/tmp/project", launchCwd: "/tmp/project", extraRoots: [] as string[] };
const SSE = { "Content-Type": "text/event-stream" };

function user(text: string, id: string = crypto.randomUUID()): UserMessage {
  return { type: "user", id, content: [{ type: "text", text }] };
}

/** xAI API-key adapter on a fetch fixture that records each raw body and answers with `events` per call. */
function capturingXai(options: { model?: string; events?: (call: number) => readonly object[]; replayHostedItems?: boolean } = {}) {
  const bodies: string[] = [];
  const model = createXaiModel({ apiKey: "xai-test-key", model: options.model ?? "grok-4.7", baseUrl: "https://xai.test/v1", replayHostedItems: options.replayHostedItems,
    fetch: async (_url, init) => {
      bodies.push(String(init!.body));
      return new Response(encodeXaiSse(options.events?.(bodies.length) ?? XAI_TEXT_EVENTS), { headers: SSE });
    } });
  return { model, bodies };
}

/** Run one agent turn and return the raw bodies sent, with the session's conversation key masked. */
async function turnBodies(model: Model, bodies: string[], options: { webSearch?: "auto" | "off"; session?: Session; tools?: ReturnType<typeof createToolRegistry>; extensions?: Parameters<typeof runAgentLoop>[0]["extensions"] } = {}) {
  const session = options.session ?? createSession([user("hello")]);
  const events = await collect(runAgentLoop({ session, model, contextManager: createContextManager(workspace), webSearch: options.webSearch, tools: options.tools, extensions: options.extensions }));
  const sent = bodies.splice(0).map(body => body.replaceAll(promptCacheKey(session), "KEY"));
  return { events, sent, session };
}

function toolsOf(body: string): Array<{ type: string; name?: string }> {
  return (JSON.parse(body) as { tools?: Array<{ type: string; name?: string }> }).tools ?? [];
}

test("the gate admits only allowlisted xAI routes and models with webSearch auto and no web_search function tool", () => {
  const base = { provider: "xai", route: "api-key" as const, model: "grok-4.7", webSearch: "auto" as const, functionToolNames: ["read", "bash"] };
  expect(HOSTED_TOOL_ALLOWLIST.map(entry => `${entry.provider}/${entry.route}/${entry.model}/${entry.tool}`)).toEqual(["xai/api-key/grok-4.7/web_search"]);
  expect(resolveHostedTools(base)).toEqual(["web_search"]);
  expect(resolveHostedTools({ ...base, webSearch: undefined })).toEqual([]);
  expect(resolveHostedTools({ ...base, webSearch: "off" })).toEqual([]);
  expect(resolveHostedTools({ ...base, model: "grok-4.5" })).toEqual([]);
  expect(resolveHostedTools({ ...base, route: "grok" })).toEqual([]);
  expect(resolveHostedTools({ ...base, route: undefined })).toEqual([]);
  expect(resolveHostedTools({ ...base, provider: "openai", route: undefined, model: "gpt-6-astra" })).toEqual([]);
  expect(resolveHostedTools({ ...base, provider: "openai-compatible", route: undefined })).toEqual([]);
  expect(resolveHostedTools({ ...base, functionToolNames: ["read", "web_search"] })).toEqual([]);
  // A test-only entry admits the Grok subscription route the real allowlist leaves off.
  const allowlist = [{ provider: "xai" as const, route: "grok" as const, model: "grok-4.7", tool: "web_search" as const, evidence: "test fixture" }];
  expect(resolveHostedTools({ ...base, route: "grok", allowlist })).toEqual(["web_search"]);
  expect(resolveHostedTools({ ...base, allowlist })).toEqual([]);
});

test("an allowlisted API-key session sends the function tools then one web_search entry", async () => {
  const { model, bodies } = capturingXai();
  const { sent } = await turnBodies(model, bodies, { webSearch: "auto", tools: createToolRegistry([readTool]) });
  expect(sent).toHaveLength(1);
  expect(toolsOf(sent[0]!).map(tool => tool.name ?? tool.type)).toEqual(["read", "web_search"]);
  expect(toolsOf(sent[0]!).at(-1)).toEqual({ type: "web_search" });
});

test("every disallowed request sends a body byte-identical to one sent without the setting", async () => {
  const tools = () => createToolRegistry([readTool]);
  const cases: Array<[string, () => Promise<{ model: Model; bodies: string[] }>, "auto" | "off"]> = [
    ["webSearch off", async () => capturingXai(), "off"],
    ["unknown model", async () => capturingXai({ model: "grok-4.5" }), "auto"],
    ["unlisted Grok subscription route", async () => {
      const store = fakeCredentialStore();
      await saveSubscriptionTokens(store, { accessToken: "grok-token", refreshToken: "refresh", obtainedAt: Date.now() });
      const bodies: string[] = [];
      const model = await loadProviderModel({ provider: "xai", model: "grok-4.7", xaiAuth: "grok", grokStore: store }, async (_url, init) => {
        bodies.push(String(init!.body));
        return new Response(encodeXaiSse(XAI_TEXT_EVENTS), { headers: SSE });
      });
      return { model, bodies };
    }, "auto"],
    ["native OpenAI", async () => {
      const bodies: string[] = [];
      const model = createOpenAIModel({ model: "gpt-6-astra", apiKey: "fixture", fetch: async (_url, init) => {
        bodies.push(String(init!.body));
        return new Response(openaiSse(OPENAI_TEXT_EVENTS), { headers: SSE });
      } });
      return { model, bodies };
    }, "auto"],
    ["ChatGPT subscription", async () => {
      const bodies: string[] = [];
      const payload = Buffer.from(JSON.stringify({ [CODEX_ACCOUNT_CLAIM]: { chatgpt_account_id: "acct-fixture" } })).toString("base64url");
      const model = createCodexSubscriptionModel({ model: "gpt-6-astra", tokens: { accessToken: `h.${payload}.s`, expiresAt: Date.now() + 3_600_000 }, fetch: async (_url, init) => {
        bodies.push(String(init!.body));
        return new Response(encodeXaiSse(XAI_TEXT_EVENTS), { headers: SSE });
      } });
      return { model, bodies };
    }, "auto"],
    ["compatible endpoint", async () => {
      const bodies: string[] = [];
      const model = createOpenAICompatibleModel({ model: "grok-4.7", baseUrl: "https://example.test/v1", auth: "none", fetch: async (_url, init) => {
        bodies.push(String(init!.body));
        return new Response(encodeChatCompletionsSse(TEXT_STREAM_CHUNKS), { headers: SSE });
      } });
      return { model, bodies };
    }, "auto"],
  ];
  for (const [name, build, webSearch] of cases) {
    const { model, bodies } = await build();
    const before = await turnBodies(model, bodies, { tools: tools(), session: createSession([user("hello", "u-fixed")]) });
    const checked = await turnBodies(model, bodies, { tools: tools(), webSearch, session: createSession([user("hello", "u-fixed")]) });
    expect(before.sent, name).toHaveLength(1);
    expect(checked.sent, name).toEqual(before.sent);
    expect(checked.sent[0]!, name).not.toContain("web_search");
  }
});

test("an extension function tool named web_search wins and the body matches today's", async () => {
  await withTempDir(async dir => {
    const setup = await extensionFixture(dir, `export default ctx => {
      ctx.registerTool({ name: 'web_search', description: 'Search with the extension.', execution: 'parallel', effect: 'read-only', inputSchema: { type: 'object' }, async execute() { return { content: 'none' }; } });
    };`);
    try {
      const { model, bodies } = capturingXai();
      const plain = await turnBodies(model, bodies, { tools: setup.tools, extensions: setup.runtime, session: createSession([user("hello", "u-fixed")]) });
      const auto = await turnBodies(model, bodies, { tools: setup.tools, extensions: setup.runtime, webSearch: "auto", session: createSession([user("hello", "u-fixed")]) });
      expect(auto.sent).toEqual(plain.sent);
      expect(toolsOf(auto.sent[0]!).filter(tool => tool.type === "web_search")).toEqual([]);
      expect(toolsOf(auto.sent[0]!).filter(tool => tool.name === "web_search")).toHaveLength(1);
    } finally { setup.runtime.dispose(); }
  });
});

async function extensionFixture(dir: string, body: string) {
  const path = join(dir, "extension.ts");
  await Bun.write(path, body);
  const resolved = await realpath(path);
  const project = await resolveWorkspace(dir);
  return loadExtensions({ modules: [resolved], workspace: project, home: join(dir, "home"), tools: createToolRegistry([readTool]) });
}

test("extension hooks cannot see, drop or set the Schway-chosen hosted entry", async () => {
  for (const hook of ["ctx.registerPrompt({ name: 'style', content: 'be brief' });",
    "ctx.beforeModel(request => { if ('hostedTools' in request) throw new Error('saw hosted tools'); return { ...request, systemPrompt: request.systemPrompt + ' [hooked]', tools: [] }; });"]) {
    await withTempDir(async dir => {
      const setup = await extensionFixture(dir, `export default ctx => { ${hook} };`);
      try {
        const { model, bodies } = capturingXai();
        const { events, sent } = await turnBodies(model, bodies, { tools: setup.tools, extensions: setup.runtime, webSearch: "auto" });
        expect(events.some(event => event.type === "error")).toBe(false);
        expect(sent).toHaveLength(1);
        expect(toolsOf(sent[0]!).at(-1)).toEqual({ type: "web_search" });
        if (hook.includes("beforeModel")) expect(toolsOf(sent[0]!)).toEqual([{ type: "web_search" }]);
      } finally { setup.runtime.dispose(); }
    });
  }
  await withTempDir(async dir => {
    const setup = await extensionFixture(dir, `export default ctx => { ctx.beforeModel(request => ({ ...request, hostedTools: [] })); };`);
    try {
      const { model, bodies } = capturingXai();
      const { events, sent } = await turnBodies(model, bodies, { tools: setup.tools, extensions: setup.runtime, webSearch: "auto" });
      const error = events.find(event => event.type === "error");
      expect(error?.type === "error" && error.message).toMatch(/^Extension ".*extension\.ts" beforeModel: unsupported field/);
      expect(sent).toHaveLength(0);
    } finally { setup.runtime.dispose(); }
  });
});

test("rounds and turns in one session send the same tools array; a model outside the allowlist drops the entry", async () => {
  const { model, bodies } = capturingXai({ events: call => call === 1 ? XAI_PARALLEL_TOOL_EVENTS : XAI_TEXT_EVENTS });
  await withTempDir(async dir => {
    const local = { root: dir, launchCwd: dir, extraRoots: [] as string[] };
    await Bun.write(join(dir, "note.txt"), "hello\n");
    const session = createSession([user("inspect")]);
    const tools = createToolRegistry([readTool, { ...readTool, name: "grep" }]);
    await collect(runAgentLoop({ session, model, workspace: local, contextManager: createContextManager(local), tools, webSearch: "auto" }));
    session.append(user("again"));
    await collect(runAgentLoop({ session, model, workspace: local, contextManager: createContextManager(local), tools, webSearch: "auto" }));
    expect(bodies).toHaveLength(3);
    const arrays = bodies.map(body => JSON.stringify(toolsOf(body)));
    expect(new Set(arrays).size).toBe(1);
    expect(toolsOf(bodies[0]!).at(-1)).toEqual({ type: "web_search" });
    const other = capturingXai({ model: "grok-4.5" });
    session.append(user("switch"));
    await collect(runAgentLoop({ session, model: other.model, workspace: local, contextManager: createContextManager(local), tools, webSearch: "auto" }));
    expect(toolsOf(other.bodies[0]!).some(tool => tool.type === "web_search")).toBe(false);
    expect(JSON.stringify(toolsOf(other.bodies[0]!))).toBe(JSON.stringify(toolsOf(bodies[0]!).slice(0, -1)));
  });
});

test("a compaction summary request never carries hosted tools", async () => {
  const requests: ModelRequest[] = [];
  const model: Model = { provider: "xai", id: "grok-4.7", async *stream(request) {
    requests.push(request);
    const summary = request.systemPrompt === SUMMARY_SYSTEM_PROMPT;
    yield { type: "message_complete", message: { type: "assistant", id: crypto.randomUUID(), content: [{ type: "text", text: summary ? "## Goal\nship\n## Next Steps\nresume" : "ok" }] } };
  } };
  const items: ConversationItem[] = [];
  for (let i = 0; i < 3; i++) items.push(user(`goal ${i}`), { type: "assistant", id: `a${i}`, content: [{ type: "text", text: `progress ${i}` }] });
  const session = createSession([...items, user("continue")]);
  await collect(runAgentLoop({ session, model, contextManager: createContextManager(workspace, { contextWindow: 1, keepTurns: 1 }), webSearch: "auto" }));
  const summaries = requests.filter(request => request.systemPrompt === SUMMARY_SYSTEM_PROMPT);
  expect(summaries.length).toBeGreaterThan(0);
  expect(summaries.every(request => request.hostedTools === undefined && request.tools === undefined)).toBe(true);
  expect(requests.filter(request => request.systemPrompt !== SUMMARY_SYSTEM_PROMPT).every(request => request.hostedTools?.join() === "web_search")).toBe(true);
});

/** Stream one fixture through the xAI adapter and return its events and committed message. */
async function assemble(events: readonly object[], replayHostedItems?: boolean) {
  const { model } = capturingXai({ events: () => events, replayHostedItems });
  const streamed = await collect(model.stream({ systemPrompt: "s", context: [], items: [user("weather?", "u1")], hostedTools: ["web_search"] }));
  const complete = streamed.at(-1);
  if (complete?.type !== "message_complete") throw new Error("expected a committed message");
  return { streamed, message: complete.message };
}

const deltas = (events: ModelStreamEvent[]) => events.filter(event => event.type === "text_delta" || event.type === "thinking_delta");

test("search progress adds no deltas and the committed message keeps the hosted item with its position", async () => {
  const withSearch = await assemble(webSearchEvents());
  const without = await assemble(webSearchEvents({ withSearch: false }));
  expect(deltas(withSearch.streamed)).toEqual(deltas(without.streamed));
  expect(withSearch.message.content).toEqual(without.message.content);
  expect(withSearch.message.content.map(block => block.type)).toEqual(["thinking", "text"]);
  expect(withSearch.message.providerMetadata).toEqual({ xai: { response_id: "resp_search", status: "completed", [HOSTED_ITEMS_KEY]: [{ position: 1, item: XAI_WEB_SEARCH_REPLAY_ITEM }] } });
  expect(without.message.providerMetadata).toEqual({ xai: { response_id: "resp_search", status: "completed" } });
  expect(hostedSearchCount(withSearch.message)).toBe(1);
});

test("a stream that ends after a hosted item but before a message follows the existing incomplete and failed handling", async () => {
  const head = webSearchEvents().slice(0, 9);
  expect((head.at(-1) as { type: string }).type).toBe("response.output_item.done");
  for (const [terminal, message] of [[{ type: "response.incomplete", response: { id: "resp_search", status: "incomplete" } }, "xAI response incomplete"],
    [{ type: "response.failed", response: { id: "resp_search", status: "failed", error: { message: "search failed" } } }, "search failed"]] as const) {
    const { model } = capturingXai({ events: () => [...head, terminal] });
    await expect(collect(model.stream({ systemPrompt: "s", context: [], items: [user("q", "u1")], hostedTools: ["web_search"] }))).rejects.toThrow(message);
  }
});

test("the next request replays reasoning, hosted item and message in order; the omit switch and the openai namespace leave it out", async () => {
  const { message } = await assemble(webSearchEvents());
  const history: ConversationItem[] = [user("weather?", "u1"), message, user("thanks", "u2")];
  const inputOf = async (replayHostedItems?: boolean) => {
    const { model, bodies } = capturingXai({ replayHostedItems });
    await collect(model.stream({ systemPrompt: "s", context: [], items: history, hostedTools: ["web_search"] }));
    return (JSON.parse(bodies[0]!) as { input: Array<Record<string, unknown>> }).input;
  };
  const replayed = await inputOf();
  expect(XAI_HOSTED_ITEM_REPLAY).toEqual({ "api-key": true, grok: true });
  expect(replayed.map(item => item.type ?? item.role)).toEqual(["user", "reasoning", "web_search_call", "message", "user"]);
  expect(replayed[1]).toEqual(XAI_REASONING_ITEM);
  expect(replayed[2]).toEqual(XAI_WEB_SEARCH_REPLAY_ITEM);
  expect(JSON.stringify(replayed)).not.toContain("provider_debug");
  const omitted = await inputOf(false);
  expect(omitted).toEqual(replayed.filter(item => item.type !== "web_search_call"));
  const openaiBodies: string[] = [];
  const openai = createOpenAIModel({ model: "gpt-6-astra", apiKey: "fixture", fetch: async (_url, init) => {
    openaiBodies.push(String(init!.body));
    return new Response(openaiSse(OPENAI_TEXT_EVENTS), { headers: SSE });
  } });
  await collect(openai.stream({ systemPrompt: "s", context: [], items: history, hostedTools: ["web_search"] }));
  expect(openaiBodies[0]).not.toContain("web_search");
  expect(openaiBodies[0]).not.toContain("ws_fixture_1");
});

test("an item over 8 KiB and a 33rd item are neither stored nor replayed, and the message still commits", async () => {
  const big = { ...XAI_WEB_SEARCH_ITEM, id: "ws_big", action: { type: "search", query: "x".repeat(MAX_HOSTED_ITEM_BYTES) } };
  const oversized = await assemble(webSearchEvents({ searches: [big] }));
  expect(oversized.message.content.map(block => block.type)).toEqual(["thinking", "text"]);
  expect(oversized.message.providerMetadata).toEqual({ xai: { response_id: "resp_search", status: "completed" } });
  const many = Array.from({ length: 33 }, (_, index) => ({ ...XAI_WEB_SEARCH_ITEM, id: `ws_${index + 1}` }));
  const capped = await assemble(webSearchEvents({ searches: many }));
  const kept = (capped.message.providerMetadata!.xai as Record<string, Array<{ item: { id: string } }>>)[HOSTED_ITEMS_KEY]!;
  expect(kept.map(entry => entry.item.id)).toEqual(many.slice(0, 32).map(item => item.id));
  const { model, bodies } = capturingXai();
  // A tampered record past the caps is skipped on replay as well.
  const tampered: AssistantMessage = { ...capped.message, providerMetadata: { xai: { [HOSTED_ITEMS_KEY]: [{ position: 0, item: { type: "function_call", call_id: "smuggled", name: "read", arguments: "{}" } }, ...kept.slice(0, 31), { position: 1, item: big }, { position: 1, item: { ...XAI_WEB_SEARCH_REPLAY_ITEM, id: "ws_33" } }] } } };
  await collect(model.stream({ systemPrompt: "s", context: [], items: [user("q", "u1"), tampered, user("next", "u2")] }));
  const input = (JSON.parse(bodies[0]!) as { input: Array<{ type?: string; id?: string }> }).input;
  // Only the first 32 stored entries are read; the smuggled non-search item and the oversized one are skipped.
  expect(input.filter(item => item.type === "web_search_call").map(item => item.id)).toEqual(many.slice(0, 31).map(item => item.id));
  expect(JSON.stringify(input)).not.toContain("smuggled");
});

test("usage carries the kept search count and the provider's own counter, and nothing when no search arrived", async () => {
  const usage = { input_tokens: 40, output_tokens: 12, server_side_tool_usage_details: { web_search_calls: 1, x_search_calls: 0 } };
  const searched = await assemble(webSearchEvents({ usage }));
  expect(searched.streamed.filter(event => event.type === "usage")).toEqual([{ type: "usage", usage: {
    inputTokens: 40, outputTokens: 12, cachedInputTokens: null, reasoningTokens: null, hostedSearchCalls: 1, reportedHostedSearchCalls: 1 } }]);
  const plain = await assemble(webSearchEvents({ withSearch: false }));
  expect(plain.streamed.filter(event => event.type === "usage")).toEqual([{ type: "usage", usage: { inputTokens: 40, outputTokens: 12, cachedInputTokens: null, reasoningTokens: null } }]);
  // Through the loop the per-call record and the message telemetry carry the same count.
  const { model } = capturingXai({ events: () => webSearchEvents({ usage }) });
  const session = createSession([user("weather?")]);
  const events = await collect(runAgentLoop({ session, model, contextManager: createContextManager(workspace), webSearch: "auto" }));
  expect(events.find(event => event.type === "model.usage")).toMatchObject({ phase: "turn", usage: { hostedSearchCalls: 1, reportedHostedSearchCalls: 1 } });
  const committed = session.items.findLast(item => item.type === "assistant") as AssistantMessage;
  expect(committed.telemetry?.usage).toMatchObject({ hostedSearchCalls: 1, reportedHostedSearchCalls: 1 });
});

test("a JSONL session written with hosted items loads, resumes and replays without a format change", async () => {
  const { message } = await assemble(webSearchEvents());
  await withTempDir(async dir => {
    const local = { root: dir, launchCwd: dir, extraRoots: [] as string[] };
    const created = await createJsonlSession({ directory: sessionsDirectory(dir), workspace: local });
    created.append(user("weather?", "u1"));
    created.append({ ...message, telemetry: { startedAt: "2026-10-08T00:00:00.000Z", firstDeltaMs: 5, attemptMs: 9, totalMs: 9, attempts: 1, retryWaitMs: 0,
      usage: { inputTokens: 40, outputTokens: 12, hostedSearchCalls: 1, reportedHostedSearchCalls: 1 } } });
    const raw = await readFile(join(sessionsDirectory(dir), `${created.header.id}.jsonl`), "utf8");
    expect(raw).toContain(`"${HOSTED_ITEMS_KEY}"`);
    expect(raw).not.toMatch(/"type":"web_search_call","text"/);
    const loaded = await loadJsonlSession({ directory: sessionsDirectory(dir), id: created.header.id });
    const assistant = loaded.items.find(item => item.type === "assistant") as AssistantMessage;
    expect(assistant.providerMetadata).toEqual(message.providerMetadata);
    expect(assistant.content).toEqual(message.content);
    expect(assistant.telemetry?.usage).toEqual({ inputTokens: 40, outputTokens: 12, hostedSearchCalls: 1, reportedHostedSearchCalls: 1 });
    loaded.append(user("thanks", "u2"));
    const { model, bodies } = capturingXai();
    await collect(runAgentLoop({ session: loaded, model, contextManager: createContextManager(local), webSearch: "auto" }));
    const input = (JSON.parse(bodies[0]!) as { input: Array<Record<string, unknown>> }).input;
    expect(input.map(item => item.type ?? item.role)).toEqual(["user", "reasoning", "web_search_call", "message", "user"]);
  });
});

test("the transcript shows one compact line for messages with hosted searches and none without", () => {
  const withItems = (count: number): AssistantMessage => ({ type: "assistant", id: `a${count}`, content: [{ type: "text", text: `answer ${count}` }],
    ...(count ? { providerMetadata: { xai: { response_id: "r", [HOSTED_ITEMS_KEY]: Array.from({ length: count }, (_, index) => ({ position: 0, item: { ...XAI_WEB_SEARCH_REPLAY_ITEM, id: `ws_${index}` } })) } } } : {}) });
  expect(hostedSearchEntryText(withItems(0))).toBeUndefined();
  expect(hostedSearchEntryText(withItems(1))).toBe("Searched the web");
  expect(hostedSearchEntryText(withItems(2))).toBe("Searched the web (2)");
  // Malformed or foreign records are not counted as searches.
  expect(hostedSearchCount({ providerMetadata: { xai: { [HOSTED_ITEMS_KEY]: [{ position: -1, item: XAI_WEB_SEARCH_REPLAY_ITEM }, { position: 0, item: { type: "x_search_call" } }, "bad"] } } })).toBe(0);
  const transcript = buildTranscriptFromSession([user("q1"), withItems(2), user("q2"), withItems(0), user("q3"), withItems(1)]);
  expect(transcript.map(entry => `${entry.kind}:${entry.text}`)).toEqual([
    "user:q1", "assistant:answer 2", "system:Searched the web (2)", "user:q2", "assistant:answer 0", "user:q3", "assistant:answer 1", "system:Searched the web",
  ]);
});

test("webSearch accepts auto and off, defaults to auto and rejects other values with the config error style", () => {
  expect(resolveSettings({})).toMatchObject({ webSearch: "auto" });
  for (const value of ["auto", "off"] as const) {
    const layer = parseConfigObject({ webSearch: value }, "/config.json");
    expect("error" in layer).toBe(false);
    expect(resolveSettings({ user: layer as never })).toMatchObject({ webSearch: value });
  }
  const invalid = parseConfigObject({ webSearch: "on" }, "/config.json");
  expect(invalid).toMatchObject({ diagnostics: [expect.objectContaining({ source: "/config.json", path: "webSearch", category: "enum" })] });
  expect(JSON.stringify(invalid)).toContain("auto");
});

test("a scripted model never fails because of hosted tools it cannot honor", async () => {
  const model = createScriptedModel({ provider: "xai", id: "grok-4.7", text: "done" });
  const events = await collect(runAgentLoop({ session: createSession([user("hi")]), model, contextManager: createContextManager(workspace), webSearch: "auto" }));
  expect(events.at(-1)).toEqual({ type: "agent.finished", reason: "completed" });
});

test("headless runs send hosted search with webSearch unset, none with webSearch off, and --json output gains no new event", async () => {
  await withTempDir(async home => {
    const { model, bodies } = capturingXai();
    const lines: string[] = [];
    const run = (argv: string[]) => runCli(argv, { cwd: home, env: { HOME: home }, stdout: { write(chunk: string) { lines.push(chunk); } }, stderr: { write() {} }, model });
    expect(await run(["-p", "weather?", "--json"])).toBe(0);
    expect(toolsOf(bodies[0]!).at(-1)).toEqual({ type: "web_search" });
    const types = lines.join("").trim().split("\n").map(line => (JSON.parse(line) as { type: string }).type);
    expect(new Set(types)).toEqual(new Set(["session.ready", "agent.started", "model.started", "model.delta", "model.usage", "model.finished", "agent.finished"]));
    await mkdir(join(home, ".schway"), { recursive: true });
    await writeFile(join(home, ".schway", "config.json"), JSON.stringify({ webSearch: "off" }));
    expect(await run(["-p", "weather?"])).toBe(0);
    expect(bodies[1]).not.toContain("web_search");
  });
});

test("a live smoke xAI lane never sends hosted tools", async () => {
  const bodies: string[] = [];
  await runLiveSmoke({ enabled: true, providers: ["xai-api-key"], revision: "test-revision", timeoutMs: 5000, env: { XAI_API_KEY: "PRIVATE_KEY" } }, {
    createStore: () => fakeCredentialStore(),
    createModel: async input => createXaiModel({ apiKey: input.apiKey!, model: input.model, fetch: async (_url, init) => {
      bodies.push(String(init!.body));
      return new Response(encodeXaiSse(XAI_TEXT_EVENTS), { headers: SSE });
    } }),
  });
  expect(bodies.length).toBeGreaterThan(0);
  expect(bodies.every(body => !body.includes("web_search"))).toBe(true);
});
