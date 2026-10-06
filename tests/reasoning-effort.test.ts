import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { TextRenderable } from "@opentui/core";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { grokSubscriptionIdentity } from "../src/auth/store.ts";
import { runCli } from "../src/cli/runtime.ts";
import { loadConfigEditor } from "../src/config/editing.ts";
import { createContextManager } from "../src/context/manager.ts";
import { HISTORY_REASONING_LEVELS, parseHistoryLine, serializeHistoryFinalize, type HistoryReasoning, type HistoryTurnFinalize } from "../src/history/records.ts";
import { openHistoryStore } from "../src/history/store.ts";
import { buildHistoryTimeline } from "../src/history/timeline.ts";
import type { ModelCapability } from "../src/model/catalog.ts";
import { loadProviderModel, type ProviderLoaderInput } from "../src/model/loader.ts";
import { THINKING_LEVELS } from "../src/model/model.ts";
import { resolveCodexReasoning } from "../src/model/providers/codex-subscription.ts";
import { describeEffectiveThinking, MODEL_THINKING_DEFAULTS, modelReasoning, resolveEffectiveThinking, resolveReasoningRecord, type ModelThinkingDefault } from "../src/model/thinking.ts";
import { createJsonlSession, loadJsonlSession, sessionsDirectory } from "../src/session/jsonl.ts";
import { createSession } from "../src/session/session.ts";
import { loadInteractiveModel, stageInteractiveSettings } from "../src/tui/app.ts";
import { dispatchEditorInput } from "../src/tui/commands.ts";
import { TuiController, type TuiControllerOptions } from "../src/tui/controller.ts";
import { historyDetailsText, historyReasoningLine } from "../src/tui/controller-history.ts";
import { createConversationView } from "../src/tui/view.ts";
import { parseHistoryLine as parseHistoryLine0af6f9a } from "./fixtures/history-records-0af6f9a.ts";
import { encodeSse, sampleRequest, TEXT_STREAM_EVENTS } from "./fixtures/openai.ts";
import { encodeChatCompletionsSse, TEXT_STREAM_CHUNKS } from "./fixtures/openai-compatible.ts";
import { encodeXaiSse, XAI_MODELS_PAYLOAD, XAI_TEXT_EVENTS } from "./fixtures/xai.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { collect, createScriptedModel, type ScriptedTurn } from "./helpers/scripted-model.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function temp() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "schway-reasoning-effort-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const grokCapability = (supportedThinking: ModelCapability["supportedThinking"] = ["low", "medium", "high", "xhigh"]): ModelCapability =>
  ({ id: "grok-4.7", authRoute: "grok", supportedThinking, defaultThinking: "high" });
const GROK_LOW: readonly ModelThinkingDefault[] = [{ provider: "xai", authRoute: "grok", model: /^grok-4(\.|$)/, level: "low" }];

test("effective reasoning names each state from the shared policy, and /thinking keeps the same full wording", () => {
  const cases: Array<[Parameters<typeof resolveEffectiveThinking>, ReturnType<typeof resolveEffectiveThinking>]> = [
    [["openai", "high", "gpt-5.4"], { state: "explicit", sent: "high", label: "high", chip: "high" }],
    [["openai", "off", "gpt-5.4"], { state: "explicit", sent: "off", label: "Off", chip: "off" }],
    // Off on a model without a disable control sends nothing, so the provider's default applies.
    [["openai", "off", "gpt-4o"], { state: "provider-default", label: "Provider default", chip: "Provider default" }],
    [["xai", undefined, "grok-4.7", { authRoute: "grok", capability: null }], { state: "provider-default", label: "Provider default", chip: "Provider default" }],
    [["xai", undefined, "grok-4.7", { authRoute: "grok", capability: grokCapability() }],
      { state: "provider-default", advertised: "high", label: "Provider default (high)", chip: "Provider default (high)" }],
    [["openai", "xhigh", "gpt-5.4"], { state: "unavailable", label: "xhigh unavailable · /model choose thinking", chip: "xhigh unavailable" }],
    [["openai-compatible", undefined, "local", { baseUrl: "http://127.0.0.1:9/v1", extraBody: { reasoning_effort: "medium" } }],
      { state: "custom", label: "Custom reasoning controls", chip: "Custom reasoning" }],
  ];
  for (const [args, expected] of cases) {
    expect(resolveEffectiveThinking(...args)).toEqual(expected);
    expect(describeEffectiveThinking(args[0], args[1], args[2], args[3])).toBe(expected.label);
  }
});

test("no Schway model default ships without a recorded live evaluation, and a listed one applies only with verified evidence for its exact route", () => {
  // Decision for #321: no recorded run, so no default. Adding one needs the evidence and wiring in docs/configuration.md.
  expect(MODEL_THINKING_DEFAULTS).toEqual([]);
  expect(resolveEffectiveThinking("xai", undefined, "grok-4.7", { authRoute: "grok", capability: grokCapability() }).state).toBe("provider-default");

  const model = (context: Parameters<typeof resolveEffectiveThinking>[3], thinking?: "high") => resolveEffectiveThinking("xai", thinking, "grok-4.7", context, GROK_LOW);
  expect(model({ authRoute: "grok", capability: grokCapability() })).toEqual({ state: "model-default", sent: "low", label: "Schway default (low)", chip: "Schway default (low)" });
  expect(model({ authRoute: "grok", capability: grokCapability() }, "high")).toEqual({ state: "explicit", sent: "high", label: "high", chip: "high" });
  // No capability, an unavailable list, a list without the level, another route or another model: nothing is sent.
  for (const context of [{ authRoute: "grok" as const }, { authRoute: "grok" as const, capability: null }, { authRoute: "grok" as const, capability: grokCapability(["medium", "high"]) },
    { authRoute: "api-key" as const, capability: { ...grokCapability(), authRoute: "api-key" as const } }]) {
    expect(model(context)).toMatchObject({ state: "provider-default" });
    expect(model(context).sent).toBeUndefined();
  }
  expect(resolveEffectiveThinking("xai", undefined, "grok-3", { authRoute: "grok", capability: { ...grokCapability(), id: "grok-3" } }, GROK_LOW).state).toBe("provider-default");
  expect(resolveReasoningRecord({ provider: "xai", xaiAuth: "grok", model: "grok-4.7", capability: grokCapability() }, GROK_LOW))
    .toEqual({ provider: "xai", model: "grok-4.7", route: "grok", level: "low", source: "model-default" });
});

/** Serve one SSE body per request and capture inference request bodies; model-list GETs are recorded separately. */
function capture(body: () => string) {
  const requests: Record<string, unknown>[] = [];
  const lists: string[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/models")) { lists.push(url); return Response.json(XAI_MODELS_PAYLOAD); }
    requests.push(JSON.parse(String(init?.body)));
    return new Response(body(), { headers: { "content-type": "text/event-stream" } });
  };
  return { fetch, requests, lists };
}

test("each adapter's bound record names exactly the level its request sends, and never a provider wire payload", async () => {
  const store = fakeCredentialStore();
  await store.set(grokSubscriptionIdentity(), JSON.stringify({ accessToken: "fixture-grok", obtainedAt: Date.now() }));
  const xai = () => encodeXaiSse(XAI_TEXT_EVENTS), openai = () => encodeSse(TEXT_STREAM_EVENTS), compatible = () => encodeChatCompletionsSse(TEXT_STREAM_CHUNKS);
  const router: ModelCapability = { id: "org/model", baseUrl: "https://openrouter.ai/api/v1", supportedThinking: ["low", "medium"], defaultThinking: "medium" };
  const cases: Array<{ input: ProviderLoaderInput; sse: () => string; wire: unknown; record: HistoryReasoning }> = [
    { input: { provider: "xai", apiKey: "k", model: "grok-4.7" }, sse: xai, wire: undefined,
      record: { provider: "xai", model: "grok-4.7", route: "api-key", level: null, source: "provider-default" } },
    { input: { provider: "xai", apiKey: "k", model: "grok-4.7", thinking: "low", modelCapability: { ...grokCapability(), authRoute: "api-key" } }, sse: xai,
      wire: { effort: "low", summary: "auto" }, record: { provider: "xai", model: "grok-4.7", route: "api-key", level: "low", source: "explicit" } },
    { input: { provider: "xai", xaiAuth: "grok", grokStore: store, model: "grok-4.7" }, sse: xai, wire: undefined,
      record: { provider: "xai", model: "grok-4.7", route: "grok", level: null, source: "provider-default" } },
    { input: { provider: "xai", xaiAuth: "grok", grokStore: store, model: "grok-4.7", thinking: "medium", modelCapability: grokCapability() }, sse: xai,
      wire: { effort: "medium", summary: "auto" }, record: { provider: "xai", model: "grok-4.7", route: "grok", level: "medium", source: "explicit" } },
    { input: { provider: "xai", apiKey: "k", model: "grok-4.5", thinking: "off", modelCapability: { id: "grok-4.5", supportedThinking: ["off", "low"], supportsDisabling: true } }, sse: xai,
      wire: { effort: "none", summary: "auto" }, record: { provider: "xai", model: "grok-4.5", route: "api-key", level: "off", source: "explicit" } },
    { input: { provider: "xai", apiKey: "k", model: "grok-3", thinking: "off", modelCapability: { id: "grok-3", supportedThinking: ["off"] } }, sse: xai, wire: undefined,
      record: { provider: "xai", model: "grok-3", route: "api-key", level: null, source: "provider-default" } },
    { input: { provider: "openai", openaiAuth: "api-key", apiKey: "k", model: "gpt-5.4" }, sse: openai, wire: undefined,
      record: { provider: "openai", model: "gpt-5.4", route: "api-key", level: null, source: "provider-default" } },
    { input: { provider: "openai", openaiAuth: "api-key", apiKey: "k", model: "gpt-5.4", thinking: "low" }, sse: openai, wire: { effort: "low", summary: "auto" },
      record: { provider: "openai", model: "gpt-5.4", route: "api-key", level: "low", source: "explicit" } },
    { input: { provider: "openai", openaiAuth: "api-key", apiKey: "k", model: "gpt-4o", thinking: "off" }, sse: openai, wire: undefined,
      record: { provider: "openai", model: "gpt-4o", route: "api-key", level: null, source: "provider-default" } },
    { input: { provider: "openai-compatible", baseUrl: "http://127.0.0.1:9/v1", auth: "none", model: "local", extraBody: { reasoning_effort: "medium" } }, sse: compatible,
      wire: undefined, record: { provider: "openai-compatible", model: "local", level: null, source: "custom" } },
    { input: { provider: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", model: "org/model", thinking: "medium", modelCapability: router }, sse: compatible,
      wire: { effort: "medium" }, record: { provider: "openai-compatible", model: "org/model", level: "medium", source: "explicit" } },
  ];
  for (const { input, sse, wire, record } of cases) {
    const served = capture(sse);
    const model = await loadProviderModel(input, served.fetch);
    await collect(model.stream(sampleRequest()));
    expect(served.requests[0]?.reasoning, JSON.stringify(input.thinking)).toEqual(wire);
    expect(modelReasoning(model)).toEqual(record);
    // Unset thinking never fetches a model list: no default is sent, so no capability is needed.
    expect(served.lists).toEqual([]);
    expect(JSON.stringify(modelReasoning(model))).not.toMatch(/fixture-grok|"k"|summary|encrypted/);
  }
  // Codex: the adapter's own wire mapping agrees with the record for unset, an explicit level and off listed as none.
  const codex: ModelCapability = { id: "gpt-6-sol", authRoute: "codex", supportedThinking: ["off", "low", "high"], defaultThinking: "high" };
  for (const thinking of [undefined, "high", "off"] as const) {
    const record = resolveReasoningRecord({ provider: "openai", openaiAuth: "codex", model: "gpt-6-sol", thinking, capability: codex })!;
    const wire = resolveCodexReasoning(thinking, "gpt-6-sol", codex);
    expect(record).toMatchObject({ route: "codex", level: wire === undefined ? null : wire.effort === "none" ? "off" : wire.effort,
      source: thinking === undefined ? "provider-default" : "explicit" });
  }
  // A level the model does not offer, evidence for another model, or a conflicting extraBody is refused before sending, so there is nothing to record.
  expect(resolveReasoningRecord({ provider: "openai", openaiAuth: "api-key", model: "gpt-5.4", thinking: "xhigh" })).toBeUndefined();
  expect(resolveReasoningRecord({ provider: "xai", xaiAuth: "grok", model: "grok-4.7", capability: { ...grokCapability(), id: "grok-4.5" } })).toBeUndefined();
  expect(resolveReasoningRecord({ provider: "openai-compatible", model: "local", baseUrl: "http://127.0.0.1:9/v1", thinking: "off", extraBody: { reasoning_effort: "low" } })).toBeUndefined();
});

const finalize = (reasoning?: unknown): HistoryTurnFinalize => ({ type: "turn_finalize", version: 1, turnId: "user-1", attemptId: "attempt-1", revision: 1, outcome: "completed",
  finishedAt: "2026-10-01T08:00:01.000Z", activeMs: 62_600, toolResults: 0, failedTools: 0, commands: { total: 0, exitZero: 0, nonzero: 0, unknown: 0, truncated: false, items: [] },
  files: { total: 0, truncated: false, items: [] }, git: { status: "unavailable", reason: "headless" }, ...(reasoning !== undefined ? { reasoning } : {}) } as HistoryTurnFinalize);

test("a finalize record with reasoning stays version 1, passes the 0af6f9a validator unchanged, and the new reader rejects a malformed field", () => {
  const reasoning: HistoryReasoning = { provider: "xai", model: "grok-4.7", route: "grok", level: null, source: "provider-default" };
  const line = serializeHistoryFinalize(finalize(reasoning)).trim();
  expect(JSON.parse(line)).toMatchObject({ version: 1, reasoning });
  expect(parseHistoryLine(line)).toEqual(finalize(reasoning));
  // The older release ignores the unknown key and keeps the record.
  expect(parseHistoryLine0af6f9a(line)).toMatchObject({ type: "turn_finalize", version: 1, attemptId: "attempt-1" });
  expect(parseHistoryLine0af6f9a(serializeHistoryFinalize(finalize({ provider: "xai", model: "grok-4.7", level: "low", source: "explicit" })).trim())).toBeDefined();
  for (const bad of [
    "low", null, [], { ...reasoning, level: "extreme" }, { ...reasoning, level: undefined }, { ...reasoning, source: "explicit" }, { ...reasoning, level: "low" },
    { ...reasoning, source: "guessed" }, { ...reasoning, route: "browser" }, { ...reasoning, provider: "" }, { ...reasoning, model: "x".repeat(257) },
    { ...reasoning, model: "grok\u0007" }, { ...reasoning, level: "low", source: "custom" },
  ]) expect(parseHistoryLine(JSON.stringify(finalize(bad))), JSON.stringify(bad)).toBeUndefined();
  expect(() => serializeHistoryFinalize(finalize({ ...reasoning, source: "explicit" }))).toThrow("Invalid history identity or record");
  // The sidecar keeps its own level list so session commands never load model modules; it must match the shared levels.
  expect(HISTORY_REASONING_LEVELS).toEqual(THINKING_LEVELS);
});

test("a session and sidecar written by 0af6f9a load unchanged and say the effort was not recorded, never inferring it", async () => {
  const dir = await temp();
  const home = join(dir, "home");
  await cp(join(import.meta.dir, "fixtures/history-0af6f9a/.schway"), join(home, ".schway"), { recursive: true });
  const id = "13f24fb3-364a-4c6c-8109-c68b5bbb5623";
  const before = await readFile(join(home, ".schway/history", `${id}.jsonl`), "utf8");
  const session = await loadJsonlSession({ directory: sessionsDirectory(home), id });
  expect(session.items.map(item => item.type)).toEqual(["user", "assistant"]);
  const read = await openHistoryStore({ home }).read(id);
  expect(read).toMatchObject({ rejected: 0, tornTail: false });
  const turn = buildHistoryTimeline(read, session).turns[0]!;
  expect(turn).toMatchObject({ evidence: "recorded", outcome: "completed" });
  expect(turn.attempts[0]!.reasoning).toBeUndefined();
  expect(historyReasoningLine(turn)).toBe("Reasoning: not recorded");
  expect(historyDetailsText({ unsaved: {} }, turn)).toContain("  Reasoning effort was not recorded for this attempt.");
  // Reading never rewrites earlier lines.
  expect(await readFile(join(home, ".schway/history", `${id}.jsonl`), "utf8")).toBe(before);
});

test("history lines name each recorded effort, a change between attempts, and an attempt without an outcome", () => {
  const attempt = (reasoning?: HistoryReasoning, finished = true) => ({ attemptId: crypto.randomUUID(), mode: "tui" as const, workspaceRoot: "/w",
    startedAt: "2026-10-01T08:00:00.000Z", activeMs: 1000, ...(finished ? { outcome: "completed" as const } : {}), ...(reasoning ? { reasoning } : {}) });
  const turn = (...attempts: ReturnType<typeof attempt>[]) => ({ evidence: "recorded" as const, attempts });
  const low: HistoryReasoning = { provider: "xai", model: "grok-4.7", route: "grok", level: "low", source: "explicit" };
  expect(historyReasoningLine(turn(attempt(low)))).toBe("Reasoning: low");
  expect(historyReasoningLine(turn(attempt({ ...low, level: null, source: "provider-default" })))).toBe("Reasoning: provider default");
  expect(historyReasoningLine(turn(attempt({ ...low, source: "model-default" })))).toBe("Reasoning: Schway default (low)");
  expect(historyReasoningLine(turn(attempt({ ...low, route: undefined, level: null, source: "custom" })))).toBe("Reasoning: custom controls");
  expect(historyReasoningLine(turn(attempt(), attempt(low), attempt(low)))).toBe("Reasoning: not recorded, then low");
  expect(historyReasoningLine(turn(attempt(low, false)))).toBe("");
  expect(historyReasoningLine({ evidence: "missing", attempts: [] })).toBe("");
});

/** Read every finalize record of one saved session's sidecar. */
async function finalizes(home: string, sessionId: string) {
  return (await openHistoryStore({ home }).read(sessionId)).finalizes;
}

test("TUI turns record the effort of the adapter that served each attempt; a running attempt keeps its level and launching writes no memory", async () => {
  const dir = await temp();
  const home = join(dir, "home"), root = join(dir, "work");
  await mkdir(root, { recursive: true });
  // A remembered v1 choice with no thinking key, exactly as the issue's session had it.
  const memoryPath = join(home, ".schway/interactive", `${createHash("sha256").update(root).digest("hex")}.json`);
  await mkdir(join(home, ".schway/interactive"), { recursive: true });
  const remembered = `${JSON.stringify({ version: 1, revision: "fixture-revision", choice: { provider: "openai", model: "gpt-5.4", openaiAuth: "api-key" } })}\n`;
  await writeFile(memoryPath, remembered);
  const workspace = { root, launchCwd: root, extraRoots: [] };
  const editor = await loadConfigEditor({ home, workspaceRoot: root, interactiveMemory: true });
  expect(editor.settings).toMatchObject({ provider: "openai", model: "gpt-5.4" });
  expect(editor.settings.thinking).toBeUndefined();
  const turns: ScriptedTurn[][] = [[{ text: "first" }], [{ chunks: ["Working"], waitForAbort: true }, { text: "third" }]];
  const options = { workspace, home, env: { OPENAI_API_KEY: "sk-fixture" }, secrets: [], runtimeApiKey: undefined, credentialStore: fakeCredentialStore(),
    createModel: async (input: { provider: string; model?: string }) => createScriptedModel({ provider: input.provider, id: input.model, responses: turns.shift() ?? [] }) };
  const initial = await stageInteractiveSettings(editor.settings, editor.settings, { ...options, forceLoad: true, signal: new AbortController().signal });
  const session = await createJsonlSession({ directory: sessionsDirectory(home), workspace });
  const c = new TuiController({ session, sessionId: session.header.id, workspace, home, configEditor: editor, provider: "openai", modelId: "gpt-5.4", openaiAuth: "api-key",
    model: initial.model, contextManager: initial.contextManager, activityClock: () => 0,
    stageSettings: (next, signal, _workspace, model) => stageInteractiveSettings(next, editor.settings, { ...options, model, signal }) } as TuiControllerOptions);
  cleanups.push(() => c.dispose());
  expect(c.snapshot().thinkingChip).toBe("Provider default");

  expect(await c.submit("first task")).toBe(true);
  expect(await c.thinkingCommand("low")).toBe(true);
  expect(c.snapshot().thinkingChip).toBe("low");
  const running = c.submit("second task");
  const deadline = Date.now() + 5000;
  while (!c.snapshot().transcript.some(entry => entry.kind === "assistant" && entry.text.includes("Working")) && Date.now() < deadline) await Bun.sleep(5);
  // Settings wait for the turn, so the running attempt cannot switch levels between its model calls.
  expect(await c.thinkingCommand("high")).toBe(false);
  c.cancel();
  await running;
  expect(await c.submit("third task")).toBe(true);

  const records = await finalizes(home, session.header.id);
  const low: HistoryReasoning = { provider: "openai", model: "gpt-5.4", route: "api-key", level: "low", source: "explicit" };
  // One record per attempt: the stopped attempt and the next one keep the level their adapter was built with.
  expect(records.map(record => [record.outcome, record.reasoning])).toEqual([
    ["completed", { provider: "openai", model: "gpt-5.4", route: "api-key", level: null, source: "provider-default" }], ["stopped", low], ["completed", low],
  ]);
  // Launching and the provider-default turn wrote no memory or config; only the explicit /thinking choice was remembered.
  expect(await Bun.file(join(home, ".schway/config.json")).exists()).toBe(false);
  expect(await Bun.file(join(root, ".schway/config.json")).exists()).toBe(false);
  expect(JSON.parse(await readFile(memoryPath, "utf8")).choice).toMatchObject({ provider: "openai", model: "gpt-5.4", thinking: "low" });
});

test("launching with a remembered choice and no thinking key, then running a turn, never rewrites memory", async () => {
  const dir = await temp();
  const home = join(dir, "home"), root = join(dir, "work");
  await mkdir(root, { recursive: true });
  const memoryPath = join(home, ".schway/interactive", `${createHash("sha256").update(root).digest("hex")}.json`);
  await mkdir(join(home, ".schway/interactive"), { recursive: true });
  const remembered = `${JSON.stringify({ version: 1, revision: "fixture-revision", choice: { provider: "xai", model: "grok-4.7", xaiAuth: "api-key" } })}\n`;
  await writeFile(memoryPath, remembered);
  const workspace = { root, launchCwd: root, extraRoots: [] };
  const editor = await loadConfigEditor({ home, workspaceRoot: root, interactiveMemory: true });
  const lists: string[] = [];
  const loaded = await loadInteractiveModel("xai", "grok-4.7", { xaiAuth: "api-key", runtimeApiKey: undefined, env: { XAI_API_KEY: "fixture" }, secrets: [], credentialStore: fakeCredentialStore(),
    fetch: async url => { lists.push(String(url)); return Response.json(XAI_MODELS_PAYLOAD); }, createModel: async () => createScriptedModel({ provider: "xai", id: "grok-4.7", text: "ok" }) });
  if ("error" in loaded) throw new Error(loaded.error);
  // Unset thinking fetches no model list and binds the provider default.
  expect(lists).toEqual([]);
  expect(modelReasoning(loaded.model)).toEqual({ provider: "xai", model: "grok-4.7", route: "api-key", level: null, source: "provider-default" });
  const session = await createJsonlSession({ directory: sessionsDirectory(home), workspace });
  const c = new TuiController({ session, sessionId: session.header.id, workspace, home, configEditor: editor, provider: "xai", xaiAuth: "api-key", modelId: "grok-4.7",
    model: loaded.model, contextManager: createContextManager(workspace), activityClock: () => 0 });
  cleanups.push(() => c.dispose());
  expect(c.snapshot().thinkingChip).toBe("Provider default");
  expect(await c.submit("weather")).toBe(true);
  expect((await finalizes(home, session.header.id))[0]?.reasoning).toEqual({ provider: "xai", model: "grok-4.7", route: "api-key", level: null, source: "provider-default" });
  expect(await readFile(memoryPath, "utf8")).toBe(remembered);
  expect(await readdir(join(home, ".schway/interactive"))).toEqual([`${createHash("sha256").update(root).digest("hex")}.json`]);
});

test("headless turns record the provider default when unset and the explicit level when set, from the adapter that served them", async () => {
  for (const thinking of [undefined, "low"] as const) {
    const dir = await temp();
    const home = join(dir, "home"), root = join(dir, "work");
    await mkdir(root, { recursive: true });
    const served = capture(() => encodeXaiSse(XAI_TEXT_EVENTS));
    let stdout = "";
    const code = await runCli(["-p", "weather tomorrow", "--provider", "xai", "--xai-auth", "api-key", "--model", "grok-4.7", "--json", ...(thinking ? ["--thinking", thinking] : [])], {
      cwd: root, env: { HOME: home, XAI_API_KEY: "fixture-key" }, stdout: { write(text) { stdout += text; } }, stderr: { write() {} }, credentialStore: fakeCredentialStore(), fetch: served.fetch,
    });
    expect(code).toBe(0);
    const sessionId = stdout.split("\n").filter(Boolean).map(line => JSON.parse(line)).find(event => event.type === "session.ready").sessionId;
    expect((await finalizes(home, sessionId))[0]?.reasoning).toEqual({ provider: "xai", model: "grok-4.7", route: "api-key", level: thinking ?? null,
      source: thinking ? "explicit" : "provider-default" });
    expect(served.requests[0]?.reasoning).toEqual(thinking ? { effort: thinking, summary: "auto" } : undefined);
    // Unset thinking still fetches no model list in headless runs.
    expect(served.lists.length).toBe(thinking ? 1 : 0);
    expect(await Bun.file(join(home, ".schway/config.json")).exists()).toBe(false);
  }
});

/** Render the conversation footer for one controller at `width` columns. */
async function footerAt(options: Partial<TuiControllerOptions>, width: number): Promise<string> {
  const workspace = { root: "/project", launchCwd: "/project", extraRoots: [] };
  const terminal = await createTestRenderer({ width, height: 30 });
  const controller = new TuiController({ session: createSession(), sessionId: "footer", workspace, contextManager: createContextManager(workspace), ...options } as TuiControllerOptions);
  const view = createConversationView(terminal.renderer, { controller, workspaceRoot: "/project", home: "/home/test", env: {}, secrets: [], motion: "off", quit: () => {},
    submit: (value, accepted) => dispatchEditorInput(value, controller, async () => false, accepted) });
  try {
    view.refresh(); await terminal.flush();
    return (terminal.renderer.root.findDescendantById("footer") as TextRenderable).plainText;
  } finally { view.destroy(); controller.dispose(); terminal.renderer.destroy(); }
}

test("the footer chip shows the effective effort in each state and drops right after the route as the terminal narrows", async () => {
  const openai = (modelId: string, thinking?: string): Partial<TuiControllerOptions> => ({ provider: "openai", modelId, openaiAuth: "api-key", ...(thinking ? { thinking } : {}),
    model: createScriptedModel({ provider: "openai", id: modelId }) });
  const states: Array<[Partial<TuiControllerOptions>, string]> = [
    [openai("gpt-5.4", "high"), "high"],
    [{ provider: "xai", modelId: "grok-4.7", xaiAuth: "grok", model: createScriptedModel({ provider: "xai", id: "grok-4.7" }) }, "Provider default"],
    [openai("gpt-6-luna"), "Provider default (medium)"],
    [openai("gpt-5.4", "xhigh"), "xhigh unavailable"],
  ];
  for (const [options, chip] of states) {
    const footer = await footerAt(options, 120);
    expect(footer).toContain(` ${chip} `);
    // An advertised default is never shown as a level Schway sent.
    if (chip.startsWith("Provider default")) expect(footer).not.toMatch(/\s(medium|high)\s/);
  }
  let routeGone = 0, chipGone = 0, modelGone = 0;
  for (let width = 120; width >= 40; width--) {
    const footer = await footerAt(openai("gpt-6-luna"), width);
    if (!routeGone && !footer.includes("OpenAI API key")) routeGone = width;
    if (!chipGone && !footer.includes("Provider default (medium)")) chipGone = width;
    if (!modelGone && !footer.includes("openai/gpt-6-luna")) modelGone = width;
    expect(footer).toContain("Auto");
  }
  expect(routeGone).toBeGreaterThan(chipGone);
  expect(chipGone).toBeGreaterThan(modelGone);
  expect(modelGone).toBeGreaterThan(0);
});

test("history modules stay free of the renderer and provider wire types", async () => {
  for (const file of ["src/history/records.ts", "src/history/collector.ts", "src/history/telemetry.ts", "src/history/timeline.ts", "src/model/thinking.ts"]) {
    const source = await Bun.file(join(import.meta.dir, "..", file)).text();
    expect(source).not.toMatch(/@opentui|\.\.\/tui\/|providers\/|from "openai"/);
  }
});
