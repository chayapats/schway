import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfigObject, resolveSettings, describeEffectiveThinking, validateThinking } from "../src/config/config.ts";
import { loadConfigEditor } from "../src/config/editing.ts";
import { cliOverridesFromArgs, parseArgs, USAGE } from "../src/cli/args.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createJsonlSession, loadJsonlSession } from "../src/session/jsonl.ts";
import { createSession } from "../src/session/session.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { readTool } from "../src/tools/read.ts";
import { toPlainJsonSchema } from "../src/tools/schema.ts";
import {
  OPENAI_THINKING_EFFORTS,
  createOpenAIModel,
  resolveOpenAIReasoning,
} from "../src/model/providers/openai.ts";
import {
  createOpenAICompatibleModel,
  findCompatibleReasoningBodyKey,
  resolveCompatibleThinking,
} from "../src/model/providers/openai-compatible.ts";
import {
  describeThinkingSupport,
  getThinkingSupport,
  isThinkingSupported,
  COMPATIBLE_REASONING_BODY_KEYS,
  findCompatibleReasoningBodyKey as findCompatibleCatalogKey,
} from "../src/model/catalog.ts";
import { isThinkingLevel } from "../src/model/model.ts";
import { loadProviderModel } from "../src/model/loader.ts";
import { helpText, parseSlashCommand, parseThinkingArgs } from "../src/tui/commands.ts";
import { TuiController } from "../src/tui/controller.ts";
import { collect, createScriptedModel } from "./helpers/scripted-model.ts";
import { withTempDir } from "./helpers.ts";
import {
  encodeSse as encodeOpenAISse,
  sampleRequest as openaiSample,
  TEXT_STREAM_EVENTS as OPENAI_TEXT,
  THINKING_STREAM_EVENTS as OPENAI_THINKING,
  TOOL_USE_STREAM_EVENTS as OPENAI_TOOL,
} from "./fixtures/openai.ts";
import {
  encodeChatCompletionsSse,
  sampleRequest as compatibleSample,
  TEXT_STREAM_CHUNKS as COMPATIBLE_TEXT,
  TOOL_USE_STREAM_CHUNKS as COMPATIBLE_TOOL,
} from "./fixtures/openai-compatible.ts";

type Captured = { body?: unknown; calls: number; url?: string };

/** Fake OpenAI fetch that records the request body and returns an SSE fixture. */
function openaiFetch(events: readonly object[], captured: Captured) {
  return async (_input: string | URL | Request, init?: RequestInit) => {
    captured.calls += 1;
    captured.body = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(encodeOpenAISse(events), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
}

/** Fake compatible fetch that records URL/body and returns Chat Completions SSE. */
function compatibleFetch(chunks: readonly object[], captured: Captured) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    captured.calls += 1;
    captured.url = String(input);
    captured.body = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(encodeChatCompletionsSse(chunks), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
}

function workspaceFor(dir: string) {
  return { root: dir, launchCwd: dir, extraRoots: [] as string[] };
}

// Config validation

test("thinking config parses provider-independent levels but validates provider support separately", () => {
  for (const level of ["off", "low", "medium", "high", "xhigh", "max", "ultra"] as const) {
    const parsed = parseConfigObject({ thinking: level }, "test");
    expect("error" in parsed).toBe(false);
    if (!("error" in parsed)) expect(parsed.thinking).toBe(level);
  }
  const invalid = parseConfigObject({ thinking: "extreme" }, "test");
  expect("error" in invalid).toBe(true);
  if ("error" in invalid) expect(invalid.error).toContain("thinking");
  const wrongType = parseConfigObject({ thinking: 42 }, "test");
  expect("error" in wrongType).toBe(true);
});

test("thinking follows built-in, user, project, CLI, session precedence", () => {
  const resolved = resolveSettings({
    user: { thinking: "low" },
    project: { thinking: "medium" },
    cli: { thinking: "high" },
    session: { thinking: "off" },
  });
  expect("error" in resolved).toBe(false);
  if ("error" in resolved) throw new Error(resolved.error);
  expect(resolved.thinking).toBe("off");
  expect(resolved.effectiveThinking).toBe("off");
});

test("unset thinking leaves provider defaults with no effective level", () => {
  const resolved = resolveSettings({});
  expect("error" in resolved).toBe(false);
  if ("error" in resolved) throw new Error(resolved.error);
  expect(resolved.thinking).toBeUndefined();
  expect(resolved.effectiveThinking).toBeUndefined();
});

test("thinking clashes with direct extraBody reasoning keys fail naming both settings", () => {
  const resolved = resolveSettings({
    cli: {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      thinking: "low",
      extraBody: { reasoning_effort: "high" },
    },
  });
  expect("error" in resolved).toBe(true);
  if (!("error" in resolved)) throw new Error("expected conflict");
  expect(resolved.error).toContain("thinking");
  expect(resolved.error).toContain("extraBody.reasoning_effort");
});

test("thinking clashes with selected-profile extraBody fail the same way", () => {
  const resolved = resolveSettings({
    user: {
      profiles: {
        p: {
          baseUrl: "http://127.0.0.1:11434/v1",
          extraBody: { reasoning: { effort: "medium" } },
        },
      },
    },
    cli: {
      provider: "openai-compatible",
      profile: "p",
      thinking: "high",
      baseUrl: "http://127.0.0.1:11434/v1",
    },
  });
  expect("error" in resolved).toBe(true);
  if (!("error" in resolved)) throw new Error("expected profile conflict");
  expect(resolved.error).toContain("thinking");
  expect(resolved.error).toContain("extraBody.reasoning");
});

test("unsupported thinking for known non-reasoning models fails with capability text", () => {
  const openai = resolveSettings({ cli: { provider: "openai", model: "gpt-4o", thinking: "high" } });
  expect("error" in openai).toBe(true);
  if (!("error" in openai)) throw new Error("expected unsupported");
  expect(openai.error).toContain("gpt-4o");
  expect(openai.error.toLowerCase()).toContain("only");
  const off = resolveSettings({ cli: { provider: "openai", model: "gpt-4o", thinking: "off" } });
  expect("error" in off).toBe(false);
});

test("explicit thinking for unknown models explains conservative handling", () => {
  const unknown = resolveSettings({ cli: { provider: "openai", model: "mystery-9", thinking: "medium" } });
  expect("error" in unknown).toBe(true);
  if (!("error" in unknown)) throw new Error("expected unknown error");
  expect(unknown.error).toContain("Unknown model");
  const off = resolveSettings({ cli: { provider: "openai", model: "mystery-9", thinking: "off" } });
  expect("error" in off).toBe(false);
  const unset = resolveSettings({ cli: { provider: "openai", model: "mystery-9" } });
  expect("error" in unset).toBe(false);
});

test("validateThinking and describeEffectiveThinking stay provider-independent", () => {
  expect(validateThinking("openai", "gpt-5.4", "medium", undefined)).toBeUndefined();
  expect(validateThinking("openai", "gpt-5.4", "high", { reasoning: 1 })).toBeUndefined();
  expect(validateThinking("openai-compatible", "gpt-4o", "low", { reasoning_effort: "low" })).toContain("extraBody");
  expect(describeEffectiveThinking("openai", "high")).toContain("high");
  expect(describeEffectiveThinking("openai", undefined)).toContain("provider default");
});

// CLI

test("--thinking parses all supported syntax and rejects unknown levels", () => {
  for (const level of ["off", "low", "medium", "high", "xhigh", "max", "ultra"] as const) {
    const parsed = parseArgs(["-p", "hi", "--thinking", level]);
    expect("error" in parsed).toBe(false);
    if (!("error" in parsed)) expect(parsed.args.thinking).toBe(level);
    const equals = parseArgs(["-p", "hi", `--thinking=${level}`]);
    expect("error" in equals).toBe(false);
  }
  const bad = parseArgs(["-p", "hi", "--thinking", "extreme"]);
  expect("error" in bad).toBe(true);
  if (!("error" in bad)) throw new Error("expected error");
  expect(bad.error).toContain("thinking");
  const missing = parseArgs(["-p", "hi", "--thinking"]);
  expect("error" in missing).toBe(true);
});

test("cliOverridesFromArgs maps thinking onto a config layer and USAGE documents it", () => {
  expect(cliOverridesFromArgs({ json: false, help: false, thinking: "low" as const }).thinking).toBe("low");
  expect(cliOverridesFromArgs({ json: false, help: false }).thinking).toBeUndefined();
  expect(USAGE).toContain("--thinking");
});

test("isThinkingLevel guards provider-independent levels", () => {
  expect(isThinkingLevel("low")).toBe(true);
  expect(isThinkingLevel("ultra")).toBe(true);
  expect(isThinkingLevel("extreme")).toBe(false);
  expect(isThinkingLevel(undefined)).toBe(false);
});

// Catalog capability

test("catalog reports per-model thinking support without changing lookup defaults", () => {
  expect(getThinkingSupport("openai", "gpt-5.4").supported).toEqual(["off", "low", "medium", "high"]);
  expect(getThinkingSupport("openai", "gpt-4o").supported).toEqual(["off"]);
  expect(getThinkingSupport("openai-compatible", "gpt-4o").supported).toEqual(["off"]);
  const unknown = getThinkingSupport("openai", "mystery-9");
  expect(unknown.known).toBe(false);
  expect(unknown.supported).toEqual(["off"]);
  expect(isThinkingSupported("openai", "gpt-5.4", "high")).toBe(true);
  expect(isThinkingSupported("openai", "gpt-4o", "high")).toBe(false);
  expect(describeThinkingSupport("openai", "mystery-9")).toContain("Unknown model");
  expect(describeThinkingSupport("openai", "gpt-4o")).toContain("only");
});

// OpenAI mapping

test("openai off/low/medium/high map to documented reasoning efforts", async () => {
  expect(OPENAI_THINKING_EFFORTS).toEqual({ off: "none", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
  expect(resolveOpenAIReasoning(undefined, "gpt-5.4")).toBeUndefined();
  expect(resolveOpenAIReasoning("off", "gpt-5.4")).toEqual({ effort: "none" });
  expect(resolveOpenAIReasoning("medium", "gpt-5.4")).toEqual({ effort: "medium", summary: "auto" });

  for (const level of ["low", "medium", "high"] as const) {
    const captured: Captured = { calls: 0 };
    const model = createOpenAIModel({ apiKey: "sk-test", model: "gpt-5.4", thinking: level, fetch: openaiFetch(OPENAI_TEXT, captured) });
    await collect(model.stream(openaiSample()));
    expect((captured.body as { reasoning: unknown }).reasoning).toEqual({ effort: level, summary: "auto" });
  }
  const offCaptured: Captured = { calls: 0 };
  const offModel = createOpenAIModel({ apiKey: "sk-test", model: "gpt-5.4", thinking: "off", fetch: openaiFetch(OPENAI_TEXT, offCaptured) });
  await collect(offModel.stream(openaiSample()));
  expect((offCaptured.body as { reasoning: unknown }).reasoning).toEqual({ effort: "none" });
});

test("openai unset reasoning leaves outgoing controls untouched", async () => {
  const captured: Captured = { calls: 0 };
  const model = createOpenAIModel({
    model: "gpt-6-astra", apiKey: "sk-test", fetch: openaiFetch(OPENAI_TEXT, captured) });
  await collect(model.stream(openaiSample()));
  expect("reasoning" in ((captured.body as Record<string, unknown>) ?? {})).toBe(false);
});

test("openai unsupported and unknown levels fail before any request", async () => {
  const captured: Captured = { calls: 0 };
  const model = createOpenAIModel({ apiKey: "sk-test", model: "gpt-4o", thinking: "high", fetch: openaiFetch(OPENAI_TEXT, captured) });
  await expect(collect(model.stream(openaiSample()))).rejects.toThrow(/not supported/);
  expect(captured.calls).toBe(0);
  const unknownCaptured: Captured = { calls: 0 };
  const unknown = createOpenAIModel({ apiKey: "sk-test", model: "mystery-9", thinking: "low", fetch: openaiFetch(OPENAI_TEXT, unknownCaptured) });
  await expect(collect(unknown.stream(openaiSample()))).rejects.toThrow(/Unknown model/);
  expect(unknownCaptured.calls).toBe(0);
});

test("openai reasoning and tool metadata survive round trips", async () => {
  const captured: Captured = { calls: 0 };
  const model = createOpenAIModel({ apiKey: "sk-test", model: "gpt-5.4", thinking: "medium", fetch: openaiFetch(OPENAI_THINKING, captured) });
  const events = await collect(model.stream(openaiSample()));
  const complete = events.at(-1);
  if (complete?.type !== "message_complete") throw new Error("expected complete");
  expect(complete.message.content[0]).toMatchObject({ type: "thinking" });
  expect((captured.body as { reasoning: unknown }).reasoning).toEqual({ effort: "medium", summary: "auto" });

  const replay: Captured = { calls: 0 };
  const replayModel = createOpenAIModel({
    model: "gpt-6-astra", apiKey: "sk-test", fetch: openaiFetch(OPENAI_TOOL, replay) });
  const toolEvents = await collect(replayModel.stream({ ...openaiSample(), items: [...openaiSample().items, complete.message] }));
  const toolComplete = toolEvents.at(-1);
  if (toolComplete?.type !== "message_complete") throw new Error("expected tool complete");
  expect(toolComplete.message.content.some((block) => block.type === "tool_call")).toBe(true);
  const body = replay.body as { input: unknown[] };
  expect(JSON.stringify(body.input)).toContain("enc-abc");
});

// Compatible mapping

test("compatible unset thinking passes extraBody through as configured mapping", async () => {
  const captured: Captured = { calls: 0 };
  const model = createOpenAICompatibleModel({
    model: "gpt-4o",
    baseUrl: "http://127.0.0.1:11434/v1",
    extraBody: { reasoning_effort: "medium", temperature: 0.2 },
    fetch: compatibleFetch(COMPATIBLE_TEXT, captured),
  });
  await collect(model.stream(compatibleSample()));
  const body = captured.body as Record<string, unknown>;
  expect(body.reasoning_effort).toBe("medium");
  expect(body.temperature).toBe(0.2);
  expect(body.model).toBe("gpt-4o");
});

test("compatible off leaves defaults untouched while low/medium/high fail clearly", async () => {
  const plain: Captured = { calls: 0 };
  await collect(createOpenAICompatibleModel({
    model: "gpt-4o", baseUrl: "http://127.0.0.1:11434/v1", fetch: compatibleFetch(COMPATIBLE_TEXT, plain) }).stream(compatibleSample()));
  expect("reasoning" in ((plain.body as Record<string, unknown>) ?? {})).toBe(false);
  expect("reasoning_effort" in ((plain.body as Record<string, unknown>) ?? {})).toBe(false);

  const off: Captured = { calls: 0 };
  await collect(createOpenAICompatibleModel({
    model: "gpt-4o", baseUrl: "http://127.0.0.1:11434/v1", thinking: "off", fetch: compatibleFetch(COMPATIBLE_TEXT, off) }).stream(compatibleSample()));
  expect(off.calls).toBe(1);

  for (const level of ["low", "medium", "high"] as const) {
    const captured: Captured = { calls: 0 };
    const model = createOpenAICompatibleModel({
    model: "gpt-4o", baseUrl: "http://127.0.0.1:11434/v1", thinking: level, fetch: compatibleFetch(COMPATIBLE_TEXT, captured) });
    await expect(collect(model.stream(compatibleSample()))).rejects.toThrow(/not mapped|not supported/);
    expect(captured.calls).toBe(0);
  }
});

test("compatible thinking conflicts with reasoning body keys instead of silently applying one", () => {
  expect(findCompatibleReasoningBodyKey({ temperature: 0.2 })).toBeUndefined();
  expect(findCompatibleReasoningBodyKey({ reasoning_effort: "low" })).toBe("reasoning_effort");
  expect(() => resolveCompatibleThinking("low", "gpt-4o", { reasoning: { effort: "low" } })).toThrow(/conflicts with extraBody/);
  expect(() => resolveCompatibleThinking("off", "gpt-4o", { thinking: "x" })).toThrow(/conflicts/);
  resolveCompatibleThinking(undefined, "gpt-4o", { reasoning_effort: "low" });
  resolveCompatibleThinking("off", "gpt-4o", undefined);
});

test("compatible tool conversations preserve metadata with thinking unset", async () => {
  const captured: Captured = { calls: 0 };
  const model = createOpenAICompatibleModel({
    model: "gpt-4o", baseUrl: "http://127.0.0.1:8080/v1", fetch: compatibleFetch(COMPATIBLE_TOOL, captured) });
  const events = await collect(model.stream({ ...compatibleSample(), tools: [{ name: readTool.name, description: readTool.description, inputSchema: toPlainJsonSchema(readTool.inputSchema) }] }));
  const complete = events.at(-1);
  if (complete?.type !== "message_complete") throw new Error("expected complete");
  expect(complete.message.content.some((block) => block.type === "tool_call")).toBe(true);
  expect((captured.body as { tools: unknown[] }).tools).toHaveLength(1);
});

// Loader

test("loader maps thinking per provider without loading unselected providers", async () => {
  const openaiCaptured: Captured = { calls: 0 };
  const openai = await loadProviderModel(
    { provider: "openai", apiKey: "sk-test", model: "gpt-5.4", thinking: "high" },
    openaiFetch(OPENAI_TEXT, openaiCaptured),
  );
  await collect(openai.stream(openaiSample()));
  expect((openaiCaptured.body as { reasoning: unknown }).reasoning).toEqual({ effort: "high", summary: "auto" });

  const compatibleCaptured: Captured = { calls: 0 };
  const compatible = await loadProviderModel(
    { provider: "openai-compatible", model: "gpt-4o", baseUrl: "http://127.0.0.1:11434/v1", extraBody: { temperature: 0.1 } },
    compatibleFetch(COMPATIBLE_TEXT, compatibleCaptured),
  );
  await collect(compatible.stream(compatibleSample()));
  expect((compatibleCaptured.body as Record<string, unknown>).temperature).toBe(0.1);
});

// Cancellation and budgets

test("changing thinking affects future requests only and never rewrites history", async () => {
  const history = [...openaiSample().items];
  const first: Captured = { calls: 0 };
  await collect(createOpenAIModel({ apiKey: "sk-test", model: "gpt-5.4", thinking: "low", fetch: openaiFetch(OPENAI_TEXT, first) }).stream({ ...openaiSample(), items: history }));
  expect((first.body as { reasoning: unknown }).reasoning).toEqual({ effort: "low", summary: "auto" });
  expect(history).toHaveLength(1);
  const second: Captured = { calls: 0 };
  await collect(createOpenAIModel({ apiKey: "sk-test", model: "gpt-5.4", thinking: "high", fetch: openaiFetch(OPENAI_TEXT, second) }).stream({ ...openaiSample(), items: history }));
  expect((second.body as { reasoning: unknown }).reasoning).toEqual({ effort: "high", summary: "auto" });
  expect(history).toHaveLength(1);
});

// TUI commands

test("/thinking parses show, levels, reset, and invalid values", () => {
  expect(parseSlashCommand("/thinking medium")?.name).toBe("thinking");
  expect(parseThinkingArgs("")).toBe("show");
  expect(parseThinkingArgs("medium")).toBe("medium");
  expect(parseThinkingArgs("RESET")).toBe("reset");
  expect(parseThinkingArgs("ultra")).toBe("ultra");
  const invalid = parseThinkingArgs("extreme");
  expect(typeof invalid === "object" && "error" in invalid).toBe(true);
  expect(helpText()).toContain("/thinking");
});

// Controller

async function controllerWithThinking(dir: string, cli: Record<string, unknown> = {}) {
  const home = join(dir, "home");
  const root = join(dir, "project");
  await mkdir(home, { recursive: true });
  await mkdir(root, { recursive: true });
  const editor = await loadConfigEditor({ home, workspaceRoot: root, cli: cli as never });
  const workspace = workspaceFor(root);
  const session = createSession();
  const stageSettings = async (_next: never, _signal: AbortSignal, _workspace?: never, _current?: never) => ({
    model: createScriptedModel({ text: "ok" }),
    contextManager: createContextManager(workspace),
  });
  const controller = new TuiController({
    session,
    model: createScriptedModel({ text: "ok" }),
    contextManager: createContextManager(workspace),
    tools: createToolRegistry([readTool]),
    workspace,
    provider: editor.settings.provider,
    modelId: editor.settings.model,
    sessionId: "sess-thinking",
    configEditor: editor,
    stageSettings: stageSettings as never,
  });
  return { controller, editor, workspace, session };
}

test("controller /thinking shows requested and effective with provider/model", async () => {
  await withTempDir(async (dir) => {
    const { controller } = await controllerWithThinking(dir, { provider: "openai", model: "gpt-5.4", thinking: "medium" });
    const text = controller.describeThinking();
    expect(text).toContain("medium");
    expect(text).toContain("openai/gpt-5.4");
    expect(text).toContain("reasoning effort medium");
    const config = controller.describeConfig();
    expect(config).toContain("thinking");
    expect(config).toContain("medium");
    const snapshot = controller.snapshot();
    expect(snapshot.thinking).toBe("medium");
    expect(snapshot.effectiveThinking).toContain("reasoning effort medium");
    controller.dispose();
  });
});

test("controller thinkingCommand sets, shows, resets, and rejects invalid levels", async () => {
  await withTempDir(async (dir) => {
    const { controller } = await controllerWithThinking(dir, { provider: "openai", model: "gpt-5.4" });
    expect(await controller.thinkingCommand("")).toBe(true);
    expect(controller.snapshot().thinking).toBeUndefined();
    expect(await controller.thinkingCommand("high")).toBe(true);
    expect(controller.snapshot().thinking).toBe("high");
    expect(await controller.thinkingCommand("ultra")).toBe(false);
    expect(controller.snapshot().thinking).toBe("high");
    expect(controller.snapshot().status).toBe("error");
    await controller.submit("recover");
    expect(await controller.thinkingCommand("reset")).toBe(true);
    expect(controller.snapshot().thinking).toBeUndefined();
    controller.dispose();
  });
});

test("controller keeps previous state after an invalid model or level switch", async () => {
  await withTempDir(async (dir) => {
    const { controller } = await controllerWithThinking(dir, { provider: "openai", model: "gpt-5.4", thinking: "high" });
    const before = controller.snapshot();
    expect(await controller.selectModel("openai/gpt-4o")).toBe(false);
    const after = controller.snapshot();
    expect(after.provider).toBe(before.provider);
    expect(after.modelId).toBe(before.modelId);
    expect(after.thinking).toBe("high");
    expect(await controller.thinkingCommand("ultra")).toBe(false);
    expect(controller.snapshot().thinking).toBe("high");
    expect(await controller.thinkingCommand("off")).toBe(true);
    expect(await controller.selectModel("openai/gpt-4o")).toBe(true);
    expect(controller.snapshot().provider).toBe("openai");
    controller.dispose();
  });
});

test("controller profile switches recompute effective reasoning the same way as model switches", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const root = join(dir, "project");
    await mkdir(home, { recursive: true });
    await mkdir(root, { recursive: true });
    await mkdir(join(home, ".schway"), { recursive: true });
    await writeFile(
      join(home, ".schway", "config.json"),
      JSON.stringify({
        profiles: {
          good: { baseUrl: "http://127.0.0.1:11434/v1", model: "llama", extraBody: { temperature: 0.1 } },
          reasoning: { baseUrl: "http://127.0.0.1:11434/v1", model: "llama", extraBody: { reasoning_effort: "high" } },
        },
      }),
    );
    await mkdir(join(root, ".schway"), { recursive: true });
    const editor = await loadConfigEditor({ home, workspaceRoot: root, cli: { provider: "openai-compatible", profile: "good", thinking: "off", baseUrl: "http://127.0.0.1:11434/v1" } });
    const workspace = workspaceFor(root);
    const controller = new TuiController({
      session: createSession(),
      model: createScriptedModel({ text: "ok" }),
      contextManager: createContextManager(workspace),
      tools: createToolRegistry([readTool]),
      workspace,
      provider: editor.settings.provider,
      modelId: editor.settings.model,
      sessionId: "sess-profile-thinking",
      configEditor: editor,
      stageSettings: (async (_next: never, _signal: AbortSignal) => ({
        model: createScriptedModel({ text: "ok" }),
        contextManager: createContextManager(workspace),
      })) as never,
    });
    expect(controller.snapshot().thinking).toBe("off");
    expect(await controller.selectProfile("reasoning")).toBe(false);
    expect(controller.snapshot().profile ?? editor.settings.profile).toBeDefined();
    expect(controller.snapshot().thinking).toBe("off");
    controller.dispose();
  });
});

test("controller configCommand edits thinking through the normal session path", async () => {
  await withTempDir(async (dir) => {
    const { controller } = await controllerWithThinking(dir, { provider: "openai", model: "gpt-5.4" });
    expect(await controller.configCommand("set thinking high")).toBe(true);
    expect(controller.snapshot().thinking).toBe("high");
    expect(await controller.configCommand("set thinking ultra")).toBe(false);
    expect(controller.snapshot().thinking).toBe("high");
    expect(await controller.configCommand("reset thinking")).toBe(true);
    expect(controller.snapshot().thinking).toBeUndefined();
    controller.dispose();
  });
});

test("off on unknown and non-reasoning models sends no wire controls", async () => {
  expect(resolveOpenAIReasoning("off", "gpt-4o")).toBeUndefined();
  expect(resolveOpenAIReasoning("off", "mystery-9")).toBeUndefined();
  expect(resolveOpenAIReasoning("off", "gpt-5.4")).toEqual({ effort: "none" });

  const openaiKnown: Captured = { calls: 0 };
  await collect(
    createOpenAIModel({ apiKey: "sk-test", model: "gpt-4o", thinking: "off", fetch: openaiFetch(OPENAI_TEXT, openaiKnown) }).stream(openaiSample()),
  );
  expect(openaiKnown.calls).toBe(1);
  expect("reasoning" in ((openaiKnown.body as Record<string, unknown>) ?? {})).toBe(false);

  const openaiUnknown: Captured = { calls: 0 };
  await collect(
    createOpenAIModel({ apiKey: "sk-test", model: "mystery-9", thinking: "off", fetch: openaiFetch(OPENAI_TEXT, openaiUnknown) }).stream(openaiSample()),
  );
  expect(openaiUnknown.calls).toBe(1);
  expect("reasoning" in ((openaiUnknown.body as Record<string, unknown>) ?? {})).toBe(false);
});

test("thinking support records disabling and describes off honestly", () => {
  expect(getThinkingSupport("openai", "gpt-5.4").supportsDisabling).toBe(true);
  expect(getThinkingSupport("openai", "gpt-4o").supportsDisabling).toBe(false);
  expect(getThinkingSupport("openai", "mystery-9").supportsDisabling).toBe(false);
  expect(describeThinkingSupport("openai", "mystery-9")).toContain("no reasoning controls");
  expect(describeThinkingSupport("openai", "gpt-4o")).toContain("no reasoning controls");
  expect(describeThinkingSupport("openai", "gpt-5.4")).toContain("disable");
  expect(describeEffectiveThinking("openai", "off", "mystery-9")).toContain("no reasoning controls");
  expect(describeEffectiveThinking("openai", "off", "gpt-4o")).toContain("no reasoning controls");
  expect(describeEffectiveThinking("openai", "off", "gpt-5.4")).toContain("none");
});

test("bare effort is not a compatible reasoning control and scanners share one source", () => {
  expect((COMPATIBLE_REASONING_BODY_KEYS as readonly string[]).includes("effort")).toBe(false);
  expect(findCompatibleReasoningBodyKey({ effort: "high", temperature: 0.2 })).toBeUndefined();
  expect(findCompatibleCatalogKey({ effort: "high" })).toBeUndefined();
  expect(findCompatibleReasoningBodyKey({ reasoning_effort: "low" })).toBe("reasoning_effort");
  expect(findCompatibleCatalogKey({ reasoning_effort: "low" })).toBe("reasoning_effort");
  expect(findCompatibleReasoningBodyKey).toBe(findCompatibleCatalogKey);
  expect(validateThinking("openai-compatible", "gpt-4o", "off", { effort: "high" })).toBeUndefined();
  expect(validateThinking("openai-compatible", "gpt-4o", "off", { reasoning_effort: "high" })).toContain("extraBody.reasoning_effort");
  const noConflict = resolveSettings({
    cli: {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      thinking: "off",
      extraBody: { effort: "high" },
    },
  });
  expect("error" in noConflict).toBe(false);
});

test("openai thinking metadata survives compaction and resume round trips", async () => {
  const captured: Captured = { calls: 0 };
  const source = createOpenAIModel({ apiKey: "sk-test", model: "gpt-5.4", thinking: "medium", fetch: openaiFetch(OPENAI_THINKING, captured) });
  const events = await collect(source.stream(openaiSample()));
  const complete = events.at(-1);
  if (complete?.type !== "message_complete") throw new Error("expected complete");
  expect(JSON.stringify(complete.message.content)).toContain("enc-abc");

  await withTempDir(async (dir) => {
    const workspace = workspaceFor(join(dir, "project"));
    const { mkdir: makeDir } = await import("node:fs/promises");
    await makeDir(workspace.root, { recursive: true });
    const session = createSession([
      { type: "user", id: "u0", content: [{ type: "text", text: "first" }] },
      { type: "assistant", id: "a0", content: [{ type: "text", text: "one" }] },
      { type: "user", id: "u1", content: [{ type: "text", text: "second" }] },
      { type: "assistant", id: "a1", content: [{ type: "text", text: "two" }] },
      { type: "user", id: "u2", content: [{ type: "text", text: "third" }] },
      { type: "assistant", id: "a2", content: [{ type: "text", text: "three" }] },
      { type: "user", id: "u3", content: [{ type: "text", text: "fourth" }] },
      { ...complete.message, id: "a3" },
    ]);
    const manager = createContextManager(workspace, { keepTurns: 2 });
    const record = await manager.compact(session, createScriptedModel({ text: "## Goal\nkept\n## Constraints\nnone\n## Progress\ndid\n## Key Decisions\nnone\n## Current State\nok\n## Next Steps\nmore\n## Files\n### Read\nnone\n### Modified\nnone" }), { reason: "manual" });
    expect(record).not.toBeNull();
    expect(JSON.stringify(session.items)).toContain("enc-abc");
    const prepared = await manager.prepare(session);
    expect(JSON.stringify(prepared.items)).toContain("enc-abc");

    const sessionsDir = join(dir, "sessions");
    const persisted = await createJsonlSession({ directory: sessionsDir, workspace });
    for (const item of session.items) persisted.append(item);
    const resumed = await loadJsonlSession({ directory: sessionsDir, id: persisted.header.id });
    expect(JSON.stringify(resumed.items)).toContain("enc-abc");

    const replay: Captured = { calls: 0 };
    const replayModel = createOpenAIModel({
    model: "gpt-6-astra", apiKey: "sk-test", fetch: openaiFetch(OPENAI_TOOL, replay) });
    await collect(replayModel.stream({ ...openaiSample(), items: [...openaiSample().items, ...(resumed.items.filter((item) => item.type !== "compaction") as never[]).slice(-1)] }));
    expect(JSON.stringify((replay.body as { input: unknown }).input)).toContain("enc-abc");
  });
});

test("openai thinking adapter forwards cancellation without pretending success", async () => {
  const model = createOpenAIModel({ apiKey: "sk-test", model: "gpt-5.4", thinking: "medium", fetch: async (_input, init) => {
    if (init?.signal?.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    return new Response(encodeOpenAISse(OPENAI_TEXT), { headers: { "Content-Type": "text/event-stream" } });
  } });
  const controller = new AbortController();
  controller.abort();
  await expect(collect(model.stream({ ...openaiSample(), signal: controller.signal }))).rejects.toThrow();
});

test("compatible adapter forwards cancellation without pretending success", async () => {
  const model = createOpenAICompatibleModel({
    model: "gpt-4o", baseUrl: "http://127.0.0.1:11434/v1", fetch: async (_input, init) => {
    if (init?.signal?.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    return new Response(encodeChatCompletionsSse(COMPATIBLE_TEXT), { headers: { "Content-Type": "text/event-stream" } });
  } });
  const controller = new AbortController();
  controller.abort();
  await expect(collect(model.stream({ ...compatibleSample(), signal: controller.signal }))).rejects.toThrow();
});
