import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { loadConfigEditor } from "../src/config/editing.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { TuiController } from "../src/tui/controller.ts";
import { withTempDir } from "./helpers.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import type { ResolvedSettings } from "../src/config/config.ts";
import type { Model } from "../src/model/model.ts";
import { createOpenAIModel } from "../src/model/providers/openai.ts";
import { encodeSse, TEXT_STREAM_EVENTS } from "./fixtures/openai.ts";
import { stageInteractiveSettings } from "../src/tui/app.ts";

async function fixture(root: string, stage?: (settings: ResolvedSettings, signal: AbortSignal) => Promise<Model>, cli = {}) {
  const workspace = { root, launchCwd: root, extraRoots: [] };
  const configEditor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root, cli });
  const settings = configEditor.settings;
  const controller = new TuiController({
    session: createSession(), sessionId: "settings", workspace, configEditor,
    provider: settings.provider, modelId: settings.model, model: createScriptedModel({ text: "previous usable" }),
    contextManager: createContextManager(workspace), secrets: ["sk-test-secret"],
    stageSettings: async (next, signal, nextWorkspace) => ({
      model: stage ? await stage(next, signal) : createScriptedModel({ provider: next.provider, id: next.model }),
      contextManager: createContextManager(nextWorkspace ?? workspace, { contextWindow: next.contextWindow }),
    }),
  });
  return controller;
}

test("controller scoped config edits show saved shadowing and reset session overrides", async () => {
  await withTempDir(async root => {
    const controller = await fixture(root, undefined, { maxTurns: 7 });
    expect(await controller.configCommand("set maxTurns 4 --scope project")).toBe(true);
    expect(JSON.parse(await readFile(join(root, ".schway/config.json"), "utf8"))).toEqual({ maxTurns: 4 });
    expect(controller.snapshot().transcript.at(-1)?.text).toContain("saved 4");
    expect(controller.snapshot().transcript.at(-1)?.text).toContain("shadowed by CLI");
    expect(await controller.configCommand("set maxTurns 2")).toBe(true);
    expect(controller.describeConfig()).toContain("maxTurns: 2 [current-session override]");
    expect(await controller.configCommand("reset maxTurns")).toBe(true);
    expect(controller.describeConfig()).toContain("maxTurns: 7 [CLI]");
    expect(await controller.configCommand("reset maxTurns --scope project")).toBe(true);
    expect(JSON.parse(await readFile(join(root, ".schway/config.json"), "utf8"))).toEqual({});
  });
});

test("a saved model suppressed by CLI provider selection explains the actual shadowing source", async () => {
  await withTempDir(async root => {
    const controller = await fixture(root, undefined, { provider: "openai" });
    expect(await controller.configCommand("set model gpt-4o --scope project")).toBe(true);
    expect(JSON.parse(await readFile(join(root, ".schway/config.json"), "utf8"))).toEqual({ model: "gpt-4o" });
    expect(controller.snapshot().modelId).toBe("gpt-5.4");
    const notice = controller.snapshot().transcript.at(-1)?.text;
    expect(notice).toContain("saved gpt-4o");
    expect(notice).toContain("Effective: gpt-5.4 [built-in default]");
    expect(notice).toContain("shadowed by CLI provider selection");
    expect(await controller.configCommand("reset model --scope project")).toBe(true);
    expect(controller.snapshot().transcript.at(-1)?.text).toContain("CLI provider selection");
  });
});

test("a session without startup credentials can configure and select an optional-auth compatible endpoint", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const configEditor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root });
    let previous = configEditor.settings;
    const loaded: string[] = [];
    const controller = new TuiController({
      session: createSession(), sessionId: "no-credentials", workspace, configEditor,
      provider: previous.provider, modelId: previous.model,
      contextManager: createContextManager(workspace),
      stageSettings: (settings, signal, currentWorkspace, model) => stageInteractiveSettings(settings, previous, {
        model, signal, workspace: currentWorkspace!, home: join(root, "home"), env: { OPENAI_API_KEY: "fixture-key" }, runtimeApiKey: undefined, secrets: [],
        createModel: async input => { loaded.push(input.provider); return createScriptedModel({ id: input.model, provider: input.provider, text: "compatible works" }); },
      }),
      onSettingsCommitted: settings => { previous = settings; },
    });
    expect(await controller.configCommand("set baseUrl http://localhost:8080/v1")).toBe(true);
    expect(await controller.configCommand("set maxTurns 3")).toBe(true);
    expect(loaded).toEqual([]);
    expect(await controller.selectModel("openai-compatible/local-model")).toBe(true);
    expect(loaded).toEqual(["openai-compatible"]);
    await controller.submit("hello");
    expect(controller.snapshot().transcript.some(entry => entry.text === "compatible works")).toBe(true);
    expect(await controller.selectModel("openai/gpt-4o")).toBe(true);
    expect(previous.baseUrl).toBeUndefined();
    expect(previous.auth).toBeUndefined();
    expect(await controller.configCommand("set maxTurns 4")).toBe(true);
    expect(loaded).toEqual(["openai-compatible", "openai"]);
    expect(await readdir(root)).toEqual([]);
  });
});

test("selected model and explicit output budget reach the next provider request and reset to catalog", async () => {
  await withTempDir(async root => {
    const bodies: Array<Record<string, unknown>> = [];
    const controller = await fixture(root, async settings => createOpenAIModel({
      apiKey: "fixture-key", model: settings.model, maxTokens: settings.maxOutput,
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(encodeSse(TEXT_STREAM_EVENTS), { headers: { "Content-Type": "text/event-stream" } });
      },
    }));
    expect(await controller.selectModel("openai/custom-model")).toBe(true);
    expect(controller.effectiveBudgets()).toEqual({ contextWindow: 32768, maxOutput: 16384 });
    expect(await controller.configCommand("set maxOutput 1234")).toBe(true);
    expect(await controller.configCommand("set contextWindow 9000")).toBe(true);
    expect(controller.describeConfig()).toContain("contextWindow: 9000 [current-session override; explicit limit]");
    await controller.submit("hello");
    expect(bodies[0]).toMatchObject({ model: "custom-model", max_output_tokens: 1234 });
    expect(await controller.configCommand("reset maxOutput")).toBe(true);
    expect(await controller.selectModel("openai/gpt-4o")).toBe(true);
    await controller.submit("again");
    expect(bodies[1]).toMatchObject({ model: "gpt-4o", max_output_tokens: 16384 });
    expect(controller.effectiveBudgets()).toEqual({ contextWindow: 9000, maxOutput: 16384 });
    expect(await controller.configCommand("reset contextWindow")).toBe(true);
    expect(controller.effectiveBudgets().contextWindow).toBe(128000);
    expect(controller.describeConfig()).toContain("contextWindow: 128000 [catalog]");
    expect(await readdir(root)).toEqual([]);
  });
});

test("model picker cancellation leaves selection intact and turns reject edits", async () => {
  await withTempDir(async root => {
    const controller = await fixture(root);
    controller.openModelPicker();
    controller.searchModels("openai/gpt-4o");
    controller.closeModelPicker();
    expect(controller.snapshot().modelPicker).toBeUndefined();
    expect(controller.snapshot().modelId).toBe("claude-sonnet-4-6");
    controller.setModel(createScriptedModel({ waitForAbort: true }), "anthropic", "claude-sonnet-4-6");
    const turn = controller.submit("working");
    expect(await controller.selectModel("openai/gpt-4o")).toBe(false);
    expect(await controller.configCommand("set maxTurns 3 --scope project")).toBe(false);
    expect(await controller.configCommand("set maxTurns 1 --scope user")).toBe(false);
    controller.cancel();
    await turn;
    expect(await readdir(root)).toEqual([]);
  });
});

test("an edited context budget drives compaction before the next actual request", async () => {
  await withTempDir(async root => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const session = createSession();
    for (let i = 0; i < 12; i++) {
      session.append({ type: "user", id: `u${i}`, content: [{ type: "text", text: `task ${i} ${"context ".repeat(100)}` }] });
      session.append({ type: "assistant", id: `a${i}`, content: [{ type: "text", text: "progress" }] });
    }
    const configEditor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root });
    let sawSummary = false;
    const summary = ["## Goal", "continue", "## Constraints", "none", "## Progress", "twelve turns", "## Key Decisions", "keep context", "## Current State", "ready", "## Next Steps", "continue", "## Files", "none"].join("\n");
    const controller = new TuiController({
      session, sessionId: "context-budget", workspace, configEditor,
      provider: "anthropic", modelId: "claude-sonnet-4-6", model: createScriptedModel(), contextManager: createContextManager(workspace),
      stageSettings: async settings => ({
        model: createScriptedModel({ provider: settings.provider, id: settings.model, responses: [{ text: summary }, request => {
          sawSummary = request.context.some(section => section.content.includes("twelve turns"));
          return { text: "continued" };
        }] }),
        contextManager: createContextManager(workspace, { contextWindow: settings.contextWindow }),
      }),
    });
    expect(await controller.configCommand("set contextWindow 1000")).toBe(true);
    await controller.submit("next");
    expect(session.items.some(item => item.type === "compaction")).toBe(true);
    expect(sawSummary).toBe(true);
    expect(controller.snapshot().transcript.some(entry => entry.text === "continued")).toBe(true);
  });
});

test("configuration view and session notices hide runtime URL credentials and structured connection values", async () => {
  await withTempDir(async root => {
    await mkdir(join(root, ".schway"));
    await writeFile(join(root, ".schway/config.json"), JSON.stringify({
      provider: "openai-compatible", baseUrl: "https://user:password@example.test/v1?token=secret-query#fragment",
      headers: { "x-custom": "sensitive-header" }, extraBody: { nested: "sensitive-body" },
    }));
    const controller = await fixture(root);
    expect(await controller.configCommand("set baseUrl https://next:password2@example.test/v2?key=hidden2")).toBe(true);
    const text = controller.describeConfig() + controller.snapshot().transcript.map(entry => entry.text).join("\n");
    for (const value of ["password", "secret-query", "password2", "hidden2", "sensitive-header", "sensitive-body"]) expect(text).not.toContain(value);
    expect(text).toContain("https://example.test/v2");
    expect(await readFile(join(root, ".schway/config.json"), "utf8")).not.toContain("password2");
    expect(await readFile(join(root, ".schway/config.json"), "utf8")).not.toContain("hidden2");
    expect(await controller.configCommand("set baseUrl https://example.test/v3 --scope project")).toBe(true);
    const persisted = JSON.parse(await readFile(join(root, ".schway/config.json"), "utf8"));
    expect(persisted.baseUrl).toBe("https://example.test/v3");
    expect(persisted.headers).toEqual({ "x-custom": "sensitive-header" });
    expect(persisted.extraBody).toEqual({ nested: "sensitive-body" });
  });
});

test("persisted URL credential failures retain the live model and never echo submitted secrets", async () => {
  await withTempDir(async root => {
    await mkdir(join(root, ".schway"));
    const path = join(root, ".schway/config.json");
    const original = '{"provider":"openai-compatible","baseUrl":"https://example.test/v1","maxTurns":7}';
    await writeFile(path, original);
    let staged = false;
    const controller = await fixture(root, async () => {
      staged = true;
      return createScriptedModel();
    });
    const snapshot = controller.snapshot();
    const sentinel = "unregistered-url-secret-sentinel";
    for (const scope of ["user", "project"]) {
      for (const url of [`https://user:${sentinel}@example.test/v2`, `https://example.test/v2?token=${sentinel}`]) {
        expect(await controller.configCommand(`set baseUrl ${url} --scope ${scope}`)).toBe(false);
        const error = controller.snapshot().transcript.at(-1)?.text;
        expect(error).toContain("session scope");
        expect(error).not.toContain(sentinel);
        expect(await readFile(path, "utf8")).toBe(original);
        expect(controller.snapshot().modelId).toBe(snapshot.modelId);
        expect(controller.describeConfig()).toContain("https://example.test/v1");
      }
    }
    expect(staged).toBe(false);
    expect(await readdir(root)).toEqual([".schway"]);
    await controller.submit("still usable");
    expect(controller.snapshot().transcript.some(entry => entry.text === "previous usable")).toBe(true);
  });
});

test("provider failure, invalid edits and cancelled staging retain files and usable model", async () => {
  await withTempDir(async root => {
    let release: (() => void) | undefined;
    let block = false;
    const controller = await fixture(root, async () => {
      if (block) await new Promise<void>(resolve => { release = resolve; });
      throw new Error("Cannot load provider sk-test-secret");
    });
    for (const command of ["set maxTurns 0", "set apiKey sk-test-secret", "set provider invalid", "set maxTurns 3 --scope invalid"]) expect(await controller.configCommand(command)).toBe(false);
    expect(await controller.selectModel("openai/gpt-4o")).toBe(false);
    expect(controller.snapshot().provider).toBe("anthropic");
    expect(controller.snapshot().transcript.map(entry => entry.text).join("\n")).not.toContain("sk-test-secret");
    block = true;
    const pending = controller.configCommand("set maxTurns 3 --scope project");
    while (!release) await Bun.sleep(1);
    expect(controller.running).toBe(true);
    expect(await controller.configCommand("set maxTurns 2")).toBe(false);
    expect(controller.openModelPicker()).toBe(false);
    controller.cancel(); release();
    expect(await pending).toBe(false);
    expect(await readdir(root)).toEqual([]);
    expect(controller.running).toBe(false);
    await controller.submit("still works");
    expect(controller.snapshot().transcript.some(entry => entry.text === "previous usable")).toBe(true);
  });
});

test("project edits after session switch target the active primary workspace", async () => {
  await withTempDir(async root => {
    const nextRoot = join(root, "next");
    await mkdir(join(nextRoot, ".schway"), { recursive: true });
    await writeFile(join(nextRoot, ".schway/config.json"), '{"maxTurns":6}');
    const controller = await fixture(root);
    const workspace = { root: nextRoot, launchCwd: nextRoot, extraRoots: [] };
    expect(await controller.switchSession(createSession(), "resumed", { workspace, contextManager: createContextManager(workspace) })).toBe(true);
    expect(controller.describeConfig()).toContain("maxTurns: 6 [project]");
    expect(await controller.configCommand("set maxTurns 9 --scope project")).toBe(true);
    expect(JSON.parse(await readFile(join(nextRoot, ".schway/config.json"), "utf8"))).toEqual({ maxTurns: 9 });
    expect(await readdir(root)).toEqual(["next"]);
  });
});

test("controller picker searches, navigates, marks active and accepts an unknown model", async () => {
  await withTempDir(async (root) => {
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const configEditor = await loadConfigEditor({ home: join(root, "home"), workspaceRoot: root });
    const controller = new TuiController({
      session: createSession(), sessionId: "picker", workspace,
      provider: "anthropic", modelId: "claude-sonnet-4-6",
      model: createScriptedModel(), contextManager: createContextManager(workspace), configEditor,
      stageSettings: async settings => ({ model: createScriptedModel({ provider: settings.provider, id: settings.model, text: "selected" }), contextManager: createContextManager(workspace, { contextWindow: settings.contextWindow }) }),
    });
    expect(controller.openModelPicker()).toBe(true);
    expect(controller.snapshot().modelPicker?.entries[0]?.active).toBe(true);
    controller.searchModels("gpt");
    expect(controller.snapshot().modelPicker?.entries[0]?.provider).toBe("openai");
    controller.moveModelPicker(1);
    expect(controller.snapshot().modelPicker?.selectedIndex).toBe(1);
    controller.searchModels("openai/new-unknown");
    expect(controller.snapshot().modelPicker?.entries[0]).toMatchObject({ modelId: "new-unknown", provider: "openai", contextWindow: 32768, maxOutput: 16384, custom: true });
    expect(await controller.selectPickerModel()).toBe(true);
    expect(controller.snapshot().modelId).toBe("new-unknown");
    expect(controller.snapshot().modelPicker).toBeUndefined();
    expect(controller.describeConfig()).toContain("current-session override");
    await controller.submit("hi");
    expect(controller.snapshot().transcript.some(entry => entry.text === "selected")).toBe(true);
  });
});
