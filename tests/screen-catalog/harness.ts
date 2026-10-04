import { ConfigEditor } from "../../src/config/editing.ts";
import { Database } from "bun:sqlite";
import { openDraftStore } from "../../src/drafts/store.ts";
import { openUndoStore } from "../../src/undo/store.ts";
import { handleSlashCommand } from "../../src/tui/app.ts";
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
import { createJsonlSession, loadJsonlSession, sessionsDirectory } from "../../src/session/jsonl.ts";
import { createToolRegistry } from "../../src/tools/registry.ts";
import { loadExtensions } from "../../src/extensions/loader.ts";
import { readTool } from "../../src/tools/read.ts";
import { editTool } from "../../src/tools/edit.ts";
import { bashTool } from "../../src/tools/bash.ts";
import { writeTool } from "../../src/tools/write.ts";
import { createScriptedModel, type ScriptedTurn } from "../helpers/scripted-model.ts";
import { MARKDOWN_ANSWER } from "../helpers/markdown-answer.ts";
import { codexSubscriptionIdentity, grokSubscriptionIdentity } from "../../src/auth/store.ts";
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
  const draft = screen.id.startsWith("draft-");
  const reviewScope = screen.id === "review-multi-turn" || screen.id === "review-staged-unstaged";
  const undoLimit = ["undo-shell-only", "undo-shell-only-review", "undo-older-target", "undo-detection-unavailable"].includes(screen.id);
  const resumedReview = screen.id.startsWith("resumed-review");
  const disk = screen.id === "details-recovery" || draft || palette || (screen.id.startsWith("model-picker") || screen.id === "details-model") || ["approval-command", "approval-edit", "completed-turn", "stopped-tool", "large-edit", "review-panel", "details-review", "undo-preview", "undo-preview-no-git", "delete-session-busy", "recent-work-resume", "narrow-layout"].includes(screen.id) || reviewScope || undoLimit || resumedReview;
  if (disk) {
    temp = await realpath(await mkdtemp(join(tmpdir(), "catalog-")));
    home = join(temp, "home"); root = join(home, "demo"); await mkdir(root, { recursive: true });
    if (screen.id === "narrow-layout") {
      root = join(home, "Projects", "very-long-directory-name", "schway");
      await mkdir(join(root, ".git"), { recursive: true });
      await writeFile(join(root, ".git/HEAD"), "ref: refs/heads/feature/a-very-long-branch-name-for-testing\n");
    }
    if (["completed-turn", "stopped-tool", "large-edit", "review-panel", "details-review", "undo-preview", "undo-preview-no-git"].includes(screen.id) || reviewScope || undoLimit || resumedReview) {
      await writeFile(join(root, "clamp.ts"), "export function clamp(n: number, lo: number, hi: number) {\n  return Math.max(lo, n);\n}\n");
      const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.com", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.com", GIT_AUTHOR_DATE: "2026-01-15T09:00:00Z", GIT_COMMITTER_DATE: "2026-01-15T09:00:00Z" };
      if (screen.id !== "undo-preview-no-git" && screen.id !== "undo-detection-unavailable" && screen.id !== "resumed-review-no-git") for (const args of [["init", "-q", "-b", "main"], ["add", "clamp.ts"], ["-c", "commit.gpgsign=false", "commit", "-qm", "Initial fixture"]]) {
        const result = Bun.spawnSync(["git", ...args], { cwd: root, env });
        if (result.exitCode) throw new Error(result.stderr.toString());
      }
    }
  }
  const workspace = { root, launchCwd: root, extraRoots: [] };
  // A resumed review reloads a saved conversation from disk, so no live turn record exists; the earlier edit is still in the working tree.
  let resumed: Awaited<ReturnType<typeof loadJsonlSession>> | undefined;
  if (resumedReview) {
    if (screen.id !== "resumed-review-clean") {
      await writeFile(join(root, "clamp.ts"), "export function clamp(n: number, lo: number, hi: number) {\n  return Math.min(hi, Math.max(lo, n));\n}\n");
      await writeFile(join(root, "notes.md"), "Clamp respects the upper bound.\n");
    }
    const saved = await createJsonlSession({ directory: sessionsDirectory(home), workspace });
    saved.append({ type: "user", id: "saved-user", content: [{ type: "text", text: "Fix the clamp upper bound" }] }, { type: "assistant", id: "saved-answer", content: [{ type: "text", text: "Fixed clamp so it respects the upper bound." }] });
    resumed = await loadJsonlSession({ directory: sessionsDirectory(home), id: saved.header.id });
  }
  const durableSession = draft ? await createJsonlSession({ directory: sessionsDirectory(home), workspace }) : undefined;
  const session = durableSession ?? resumed ?? createSession();
  const draftStore = durableSession ? openDraftStore({ home, workspaceRoot: root, sessionId: durableSession.header.id }) : undefined;
  if (draftStore) draftStore.save(screen.id === "draft-restored" ? "ร่างภาษาไทย\nยังไม่ส่ง 🧪" : "Previously saved", 1);
  if (screen.id === "recent-work-resume") {
    sessionDirectory = sessionsDirectory(home);
    const prior = await createJsonlSession({ directory: sessionDirectory, workspace });
    prior.append({ type: "user", id: "previous-user", content: [{ type: "text", text: "Refactor the session loader" }] }, { type: "assistant", id: "previous-assistant", content: [{ type: "text", text: "Separated loading and validation." }] });
  }
  if (screen.id === "compaction") for (let i = 0; i < 2; i++) session.append({ type: "user", id: `user-${i}`, content: [{ type: "text", text: `Explain session loading step ${i + 1}.` }] }, { type: "assistant", id: `assistant-${i}`, content: [{ type: "text", text: "Read the records, validate them, and restore the conversation." }] });
  let responses: ScriptedTurn[] = [{ text: "Ready." }];
  if (["streaming-answer", "running-search"].includes(screen.id)) responses = [{ chunks: ["## Plan\n\n", "Reading the **config** loader first.\n\n", "- Check `src/config/config.ts`\n- Then"], waitForAbort: true }];
  if (screen.id === "stopped-streaming") responses = [{ chunks: ["## Partial answer\n\n", "อ่านไฟล์แล้ว 🧪\n\n", "The next step is"], waitForAbort: true }];
  if (["failed-turn", "no-color", "details-recovery"].includes(screen.id)) responses = Array.from({ length: 3 }, () => ({ error: "Service unavailable", status: 503 }));
  if (screen.id === "retry-countdown") responses = [{ error: "busy", status: 503, headers: { "Retry-After": "3" } }];
  if (screen.id === "compaction") responses = [{ waitForAbort: true }];
  if (screen.id === "narrow-layout") responses = [{ text: "| Option | Speed | Use |\n| --- | --- | --- |\n| Read | Fast | Inspect |\n| Edit | Fast | Change |\n| Bash | Varies | Verify |\n\n```ts\nconst lo = 0;\nconst hi = 10;\nconst n = 12;\nMath.min(hi, Math.max(lo, n));\n```" }];
  if (screen.id === "table-and-code") responses = [{ text: MARKDOWN_ANSWER }];
  let tools = createToolRegistry();
  if (screen.id === "stopped-tool") {
    tools = createToolRegistry([writeTool, bashTool]);
    responses = [
      { toolCalls: [{ id: "saved-file", name: "write", arguments: { path: "saved.txt", content: "Completed work ไทย 🧪\n" } }] },
      { toolCalls: [{ id: "active-shell", name: "bash", arguments: { command: "printf 'Ready to stop\\n'; sleep 30", timeout: 5_000 } }] },
    ];
  }
  if (["completed-turn", "large-edit", "review-panel", "details-review", "undo-preview", "undo-preview-no-git"].includes(screen.id)) {
    tools = createToolRegistry([readTool, editTool, writeTool, bashTool]);
    responses = [
      { toolCalls: [{ id: "call_fixture_read", name: "read", arguments: { path: "clamp.ts" } }] },
      { toolCalls: [{ id: "fc_fixture1234", name: "edit", arguments: { path: "clamp.ts", edits: [{ oldText: "return Math.max(lo, n);", newText: screen.id === "large-edit" ? Array.from({ length: 13 }, (_, i) => `const step${i} = n;`).join("\n") : "return Math.min(hi, Math.max(lo, n));" }] } }] },
      ...(screen.id === "completed-turn" || screen.id === "undo-preview" ? [{ toolCalls: [{ id: "call_fixture_write", name: "write", arguments: { path: "src/util/range.ts", content: Array.from({ length: 42 }, (_, i) => `// Range line ${i + 1}`).join("\n") + "\n" } }] }] : []),
      ...(screen.id === "undo-preview" ? [{ toolCalls: [{ id: "undo-readme", name: "write", arguments: { path: "README.md", content: "Changes made during the turn.\n" } }] }] : []),
      { toolCalls: [{ id: "b1234", name: "bash", arguments: { command: screen.id === "undo-preview" ? "mkdir -p gen; printf 'generated\\n' > gen/out.json" : "printf 'ok\\n'" } }] },
      { text: screen.id === "large-edit" ? "Updated the clamp implementation." : "Fixed clamp so it respects the upper bound." },
    ];
  }
  if (reviewScope) {
    tools = createToolRegistry([editTool, writeTool]);
    const fix = { toolCalls: [{ id: "call_fixture_fix", name: "edit", arguments: { path: "clamp.ts", edits: [{ oldText: "return Math.max(lo, n);", newText: "return Math.min(hi, Math.max(lo, n));" }] } }] };
    responses = screen.id === "review-multi-turn"
      ? [fix, { text: "Fixed the upper bound." }, { toolCalls: [{ id: "call_fixture_type", name: "edit", arguments: { path: "clamp.ts", edits: [{ oldText: "hi: number) {", newText: "hi: number): number {" }] } }] }, { text: "Added the return type." }]
      : [fix, { toolCalls: [{ id: "call_fixture_notes", name: "write", arguments: { path: "notes.md", content: "Clamp respects the upper bound.\n" } }] }, { text: "Fixed clamp and added notes." }];
  }
  if (undoLimit) {
    tools = createToolRegistry([editTool, bashTool]);
    const generate = { toolCalls: [{ id: "generate", name: "bash", arguments: { command: "mkdir -p gen; printf 'generated\\n' > gen/out.json" } }] };
    responses = screen.id === "undo-older-target"
      ? [{ toolCalls: [{ id: "fix", name: "edit", arguments: { path: "clamp.ts", edits: [{ oldText: "return Math.max(lo, n);", newText: "return Math.min(hi, Math.max(lo, n));" }] } }] },
        { text: "Fixed clamp so it respects the upper bound." }, generate, { text: "Generated the output file." }]
      : [generate, { text: "Generated the output file." }];
  }
  if (screen.id === "approval-command" || screen.id === "approval-edit") {
    tools = createToolRegistry([editTool, bashTool]);
    await writeFile(join(root, "clamp.ts"), "export function clamp(n: number, lo: number, hi: number) {\n  return Math.max(lo, n);\n}\n");
    responses = [{ toolCalls: [screen.id === "approval-command"
      ? { id: "approval-command", name: "bash", arguments: { command: "bun test --filter clamp" } }
      : { id: "approval-edit", name: "edit", arguments: { path: "clamp.ts", edits: [{ oldText: "  return Math.max(lo, n);", newText: "  return Math.min(hi, Math.max(lo, n));" }] } }] }];
  }
  if (screen.id === "parallel-tools") {
    const names = ["read", "grep", "bash"];
    tools = createToolRegistry(names.map(name => ({ name, description: `Gated ${name} fixture`, execution: "parallel" as const, inputSchema: { type: "object", properties: {} }, execute: async (_input, context) => { await stopped(context.signal); return { content: "Stopped." }; } })));
    responses = [{ toolCalls: names.map(name => ({ id: `call_fixture_parallel_${name}`, name, arguments: name === "bash" ? { command: "bun test" } : name === "grep" ? { pattern: "clamp" } : { path: "clamp.ts" } })) }];
  }
  const fresh = ["first-run", "disconnected-search", "sign-in-chooser", "chatgpt-more-options", "grok-more-options", "endpoint-url-empty", "endpoint-url-error", "subscription-sign-in"].includes(screen.id);
  const picker = screen.id === "model-picker" || screen.id === "details-model";
  const unconnectedPicker = screen.id === "model-picker-unconnected";
  const store = fakeCredentialStore();
  const options: TuiControllerOptions = {
    session, workspace, home, tools, maxConcurrentTools: 3, provider: fresh || picker ? "openai" : "scripted", modelId: fresh || unconnectedPicker ? "" : picker ? "gpt-6-astra" : "scripted-model", sessionId: durableSession?.header.id ?? resumed?.header.id ?? "catalog-session",
    model: fresh || unconnectedPicker ? undefined : createScriptedModel({ id: "scripted-model", responses }), contextManager: createContextManager(workspace, { home, ...(screen.id === "compaction" ? { keepTurns: 1 } : {}) }),
    appearanceEnvironment: variant.theme, activityClock: () => activityTime,
    onRuntimeEvent: event => { if (event.type === "tool.finished") activityTime += 1200; },
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
  if (screen.id === "details-recovery") options.changeTracking = "off";
  // Exercise real diagnostic redaction before layout so temporary-root bytes never enter goldens.
  if (screen.id === "details-review" || resumedReview) options.secrets = [temp!];
  if (screen.id === "approval-command" || screen.id === "approval-edit") options.configEditor = new ConfigEditor({ cli: { approval: { mode: "ask" } } }, { user: join(home, "config.json"), project: join(root, "config.json") });
  if (screen.id === "approval-modes-help") options.configEditor = new ConfigEditor({}, { user: join(home, "config.json"), project: join(root, "config.json") });
  if (picker || unconnectedPicker) {
    options.configEditor = new ConfigEditor(picker ? { cli: { provider: "openai", model: "gpt-6-astra", openaiAuth: "codex", baseUrl: "http://localhost:8787/v1", auth: "none" } } : {},
      { user: join(home, "config.json"), project: join(root, "config.json") });
    options.stageSettings = async next => ({ model: createScriptedModel({ id: next.model }), contextManager: createContextManager(workspace) });
    if (picker) {
      await store.set(codexSubscriptionIdentity(), "fixture-token");
      options.model = createScriptedModel({ provider: "codex-subscription", id: "gpt-6-astra" });
      options.credentials!.env = {};
      options.credentials!.listSubscriptionCatalog = async () => [
        { id: "gpt-6-astra", contextWindow: 1050000, maxOutput: 128000, supportedThinking: ["off", "high"] },
        { id: "gpt-6-sol", contextWindow: 400000, maxOutput: 128000, supportedThinking: ["high"] },
      ];
      options.credentials!.listRouteModels = async () => [{ id: "fake-coder", contextWindow: 32768 }];
    }
  }
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
  let undoLock: Database | undefined;
  if (screen.id === "delete-session-busy") {
    sessionDirectory = sessionsDirectory(home); await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(sessionDirectory, "saved-session.jsonl"), JSON.stringify({ type: "session", version: 4, id: "saved-session", createdAt: new Date().toISOString(), workspaceRoot: root, launchCwd: root, extraRoots: [] }) + "\n");
    await openUndoStore({ home }).recordShell({ sessionId: "saved-session", turnId: "saved-turn", turnNumber: 1 }, { detection: "unavailable" });
    undoLock = new Database(join(home, ".schway", "undo.lock"));
    undoLock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  }
  const deletionContext = screen.id === "delete-session-busy" ? { controller, home, workspaceRoot: root, skillScope: { workspaceRoot: root }, sessionsDir: sessionDirectory!, settings: () => new ConfigEditor({}, { user: join(home, "config.json"), project: join(root, "config.json") }).settings, env: {}, secrets: [], finishQuit() {}, stderr: { write() {} } } : undefined;
  const view = createConversationView(terminal.renderer, { controller, draftPersistence: draft, secrets: options.secrets ?? [], workspaceRoot: root, home, env: { SCHWAY_THEME: variant.theme, ...(variant.noColor ? { NO_COLOR: "1" } : {}) }, motion: "reduced", splash: "none", now: () => CATALOG_VIEW_NOW_MS, quit: () => {}, openUrl: async () => {}, submit: (value, accepted) => dispatchEditorInput(value, controller, (command, accepted) => command.name === "login" ? controller.login(command.args, accepted) : command.name === "undo" ? controller.undoCommand(command.args) : command.name === "delete-session" && deletionContext ? handleSlashCommand(command.name, command.args, deletionContext) : Promise.resolve(false), accepted) });
  const settle = async () => { await Bun.sleep(1); view.refresh(); await terminal.flush(); };
  const waitFor = async (predicate: (snapshot: TuiSnapshot) => boolean) => {
    const start = performance.now();
    while (!predicate(controller.snapshot())) {
      if (performance.now() - start > 10_000) throw new Error(`Screen ${screen.id} timed out\n${terminal.captureCharFrame()}`);
      await settle();
    }
  };
  await settle();
  return { ...terminal, controller, view, session, sessionDirectory, secrets: options.secrets ?? [], draftStore, root, editor: terminal.renderer.root.findDescendantById("prompt") as TextareaRenderable, loginCalled: () => loginCalled, settle, waitFor,
    advance: () => { activityTime += screen.elapsed ?? 0; },
    dispose: async () => { view.destroy(); controller.dispose(); terminal.renderer.destroy(); await controller.waitForIdle(); undoLock?.close(); if (temp) await rm(temp, { recursive: true, force: true }); },
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
