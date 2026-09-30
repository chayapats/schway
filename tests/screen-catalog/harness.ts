import { ConfigEditor } from "../../src/config/editing.ts";
import { openRouterModelCapabilities, parseModelList } from "../../src/model/model-list.ts";
import { createTestRenderer } from "@opentui/core/testing";
import type { TextareaRenderable } from "@opentui/core";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuiController, type TuiSnapshot, type TuiControllerOptions } from "../../src/tui/controller.ts";
import { createConversationView } from "../../src/tui/view.ts";
import { dispatchEditorInput } from "../../src/tui/commands.ts";
import { createContextManager } from "../../src/context/manager.ts";
import { createSession } from "../../src/session/session.ts";
import { createJsonlSession, sessionsDirectory } from "../../src/session/jsonl.ts";
import { createToolRegistry } from "../../src/tools/registry.ts";
import { loadExtensions } from "../../src/extensions/loader.ts";
import { readTool } from "../../src/tools/read.ts";
import { editTool } from "../../src/tools/edit.ts";
import { bashTool } from "../../src/tools/bash.ts";
import { createScriptedModel, type ScriptedTurn } from "../helpers/scripted-model.ts";
import { grokSubscriptionIdentity } from "../../src/auth/store.ts";
import { fakeCredentialStore } from "../helpers/credential-store.ts";
import type { Screen, Variant } from "./screens.ts";
import { serializeScreen } from "./format.ts";

/** Fixed animation time keeps reduced-motion fixtures independent of wall time. */
export const CATALOG_VIEW_NOW_MS = 1_000_000;
/** Real input, controller and renderer owned by one disposable catalog variant. */
export type ScreenHarness = Awaited<ReturnType<typeof buildScreen>>;
const stopped = (signal?: AbortSignal) => signal?.aborted ? Promise.resolve() : new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));

/** Build an isolated final-size renderer and scripted dependencies for one screen. */
export async function buildScreen(screen: Screen, variant: Variant) {
  let temp: string | undefined;
  let home = "/home/test", root = "/project", sessionDirectory: string | undefined;
  let activityTime = 10_000, loginCalled = false;
  const palette = screen.id.startsWith("command-palette");
  const disk = palette || ["completed-turn", "review-panel", "recent-work-resume"].includes(screen.id);
  if (disk) {
    temp = await realpath(await mkdtemp(join(tmpdir(), "catalog-")));
    home = join(temp, "home"); root = join(home, "demo"); await mkdir(root, { recursive: true });
    if (["completed-turn", "review-panel"].includes(screen.id)) {
      await writeFile(join(root, "clamp.ts"), "export function clamp(n: number, lo: number, hi: number) {\n  return Math.max(lo, n);\n}\n");
      const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.com", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.com", GIT_AUTHOR_DATE: "2026-01-15T09:00:00Z", GIT_COMMITTER_DATE: "2026-01-15T09:00:00Z" };
      for (const args of [["init", "-q", "-b", "main"], ["add", "clamp.ts"], ["-c", "commit.gpgsign=false", "commit", "-qm", "Initial fixture"]]) {
        const result = Bun.spawnSync(["git", ...args], { cwd: root, env });
        if (result.exitCode) throw new Error(result.stderr.toString());
      }
    }
  }
  const workspace = { root, launchCwd: root, extraRoots: [] };
  const session = createSession();
  if (screen.id === "recent-work-resume") {
    sessionDirectory = sessionsDirectory(home);
    const prior = await createJsonlSession({ directory: sessionDirectory, workspace });
    prior.append({ type: "user", id: "previous-user", content: [{ type: "text", text: "Refactor the session loader" }] }, { type: "assistant", id: "previous-assistant", content: [{ type: "text", text: "Separated loading and validation." }] });
  }
  if (screen.id === "compaction") for (let i = 0; i < 2; i++) session.append({ type: "user", id: `user-${i}`, content: [{ type: "text", text: `Explain session loading step ${i + 1}.` }] }, { type: "assistant", id: `assistant-${i}`, content: [{ type: "text", text: "Read the records, validate them, and restore the conversation." }] });
  let responses: ScriptedTurn[] = [{ text: "Ready." }];
  if (screen.id === "streaming-answer") responses = [{ chunks: ["## Plan\n\n", "Reading the **config** loader first.\n\n", "- Check `src/config/config.ts`\n- Then"], waitForAbort: true }];
  if (["failed-turn", "no-color"].includes(screen.id)) responses = Array.from({ length: 3 }, () => ({ error: "Service unavailable", status: 503 }));
  if (screen.id === "retry-countdown") responses = [{ error: "busy", status: 503, headers: { "Retry-After": "3" } }];
  if (screen.id === "compaction") responses = [{ waitForAbort: true }];
  if (screen.id === "narrow-layout") responses = [{ text: "| Option | Speed | Use |\n| --- | --- | --- |\n| Read | Fast | Inspect |\n| Edit | Fast | Change |\n| Bash | Varies | Verify |\n\n```ts\nconst lo = 0;\nconst hi = 10;\nconst n = 12;\nMath.min(hi, Math.max(lo, n));\n```" }];
  let tools = createToolRegistry();
  if (["completed-turn", "review-panel"].includes(screen.id)) {
    tools = createToolRegistry([readTool, editTool, bashTool]);
    responses = [
      { toolCalls: [{ id: "read-clamp", name: "read", arguments: { path: "clamp.ts" } }] },
      { toolCalls: [{ id: "edit-clamp", name: "edit", arguments: { path: "clamp.ts", edits: [{ oldText: "return Math.max(lo, n);", newText: "return Math.min(hi, Math.max(lo, n));" }] } }] },
      { toolCalls: [{ id: "check-clamp", name: "bash", arguments: { command: "printf 'ok\\n'" } }] },
      { text: "Fixed clamp so it respects the upper bound." },
    ];
  }
  if (screen.id === "parallel-tools") {
    const names = ["read", "grep", "bash"];
    tools = createToolRegistry(names.map(name => ({ name, description: `Gated ${name} fixture`, execution: "parallel" as const, inputSchema: { type: "object", properties: {} }, execute: async (_input, context) => { await stopped(context.signal); return { content: "Stopped." }; } })));
    responses = [{ toolCalls: names.map(name => ({ id: `parallel-${name}`, name, arguments: {} })) }];
  }
  const fresh = ["first-run", "sign-in-chooser", "chatgpt-more-options", "grok-more-options", "endpoint-url-empty", "endpoint-url-error", "subscription-sign-in"].includes(screen.id);
  const picker = screen.id === "model-picker";
  const store = fakeCredentialStore();
  const options: TuiControllerOptions = {
    session, workspace, home, tools, maxConcurrentTools: 3, provider: fresh || picker ? "openai" : "scripted", modelId: fresh ? "" : picker ? "gpt-6-astra" : "scripted-model", sessionId: "catalog-session",
    model: fresh ? undefined : createScriptedModel({ id: "scripted-model", responses }), contextManager: createContextManager(workspace, { home, ...(screen.id === "compaction" ? { keepTurns: 1 } : {}) }),
    appearanceEnvironment: variant.theme, activityClock: () => activityTime,
    agentClock: { now: () => 10_000, sleep: async (_ms, signal) => { if (screen.id === "retry-countdown") await stopped(signal); } },
    credentials: { store, grokLogin: async ({ device, signal, onApproval, onSaved }) => {
      if (screen.id === "grok-plan-error") {
        await store.set(grokSubscriptionIdentity(), JSON.stringify({ accessToken: "fixture-access", obtainedAt: 1 })); onSaved?.();
        return { ok: false, message: "Your Grok plan doesn't include API access. Use an xAI API key instead." };
      }
      onApproval(device ? { kind: "device", verificationUri: "https://x.ai/device", userCode: "ABCD-EFGH" } : { kind: "browser" });
      await stopped(signal); return { ok: false, message: "Cancelled." };
    }, env: picker ? { OPENAI_API_KEY: "fixture-key" } : {}, reload: async () => ({ model: createScriptedModel() }), listRouteModels: async () => ["gpt-6-astra", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-4.1"].map(id => ({ id })), codexLogin: async ({ signal }) => { loginCalled = true; await stopped(signal); return { ok: false, message: "Cancelled." }; } },
  };
  if (palette) {
    await Bun.write(join(root, ".agents/skills/grill-me/SKILL.md"), "---\nname: grill-me\ndescription: Stress-test a plan\n---\nTask");
    await Bun.write(join(root, "node_modules/greeting-pkg/package.json"), JSON.stringify({ name: "greeting-pkg", schway: { extensions: ["main.ts"] } }));
    await Bun.write(join(root, "node_modules/greeting-pkg/main.ts"), "export default ctx => ctx.registerCommand({ name: 'greet', description: 'Say hello', execute() {} });");
    await Bun.write(join(root, ".schway/config.json"), JSON.stringify({ packages: ["greeting-pkg"] }));
    await Bun.write(join(root, "local.ts"), "export default ctx => ctx.registerCommand({ name: 'local', description: 'Local action', execute() {} });");
    const loaded = await loadExtensions({ modules: ["local.ts"], workspace, home, tools });
    options.tools = loaded.tools; options.extensions = loaded.runtime;
  }
  if (screen.id.startsWith("endpoint-url")) {
    options.configEditor = new ConfigEditor({}, { user: join(home, "config.json"), project: join(root, "config.json") });
    options.stageSettings = async next => ({ model: createScriptedModel({ id: next.model }), contextManager: createContextManager(workspace) });
  }
  if (screen.id === "thinking-controls") {
    const baseUrl = "https://openrouter.ai/api/v1", model = "meta/muse-spark-1.3-contributor";
    const capabilities = openRouterModelCapabilities(parseModelList({ data: [{ id: model, reasoning: {
      mandatory: true, supported_efforts: ["max", "xhigh", "high", "medium", "low", "minimal"], default_effort: "medium",
    } }] }, "OpenRouter", baseUrl));
    options.configEditor = new ConfigEditor({ cli: { provider: "openai-compatible", model, baseUrl } },
      { user: join(home, "config.json"), project: join(root, "config.json") }, capabilities);
    options.provider = "openai-compatible"; options.modelId = model; options.baseUrl = baseUrl;
  }
  const terminal = await createTestRenderer({ width: variant.cols, height: variant.rows, kittyKeyboard: true });
  const controller = new TuiController(options);
  const view = createConversationView(terminal.renderer, { controller, secrets: [], workspaceRoot: root, home, env: { SCHWAY_THEME: variant.theme, ...(variant.noColor ? { NO_COLOR: "1" } : {}) }, motion: "reduced", splash: false, now: () => CATALOG_VIEW_NOW_MS, quit: () => {}, openUrl: async () => {}, submit: (value, accepted) => dispatchEditorInput(value, controller, (command, accepted) => command.name === "login" ? controller.login(command.args, accepted) : Promise.resolve(false), accepted) });
  const settle = async () => { await Bun.sleep(1); view.refresh(); await terminal.flush(); };
  const waitFor = async (predicate: (snapshot: TuiSnapshot) => boolean) => {
    const start = performance.now();
    while (!predicate(controller.snapshot())) {
      if (performance.now() - start > 10_000) throw new Error(`Screen ${screen.id} timed out\n${terminal.captureCharFrame()}`);
      await settle();
    }
  };
  await settle();
  return { ...terminal, controller, view, session, sessionDirectory, editor: terminal.renderer.root.findDescendantById("prompt") as TextareaRenderable, loginCalled: () => loginCalled, settle, waitFor,
    advance: () => { activityTime += screen.elapsed ?? 0; },
    dispose: async () => { view.destroy(); controller.dispose(); terminal.renderer.destroy(); await controller.waitForIdle(); if (temp) await rm(temp, { recursive: true, force: true }); },
  };
}
/** Reach the named state, capture all spans and dispose every owned resource. */
export async function renderScreen(screen: Screen, variant: Variant): Promise<string> {
  const ui = await buildScreen(screen, variant);
  try {
    await screen.drive(ui); await ui.waitFor(snapshot => screen.ready(snapshot, ui)); ui.advance(); await ui.settle();
    if (!screen.ready(ui.controller.snapshot(), ui)) throw new Error(`Screen ${screen.id} left its ready state before capture\n${ui.captureCharFrame()}`);
    const cursor = ui.renderer.getCursorState();
    return serializeScreen(ui.captureSpans(), { screen: screen.id, title: screen.title, description: screen.description, variant: variant.id, cursor });
  } finally { await ui.dispose(); }
}
