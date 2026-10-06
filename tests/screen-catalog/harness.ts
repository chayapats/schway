import { ConfigEditor } from "../../src/config/editing.ts";
import { Database } from "bun:sqlite";
import { openDraftStore } from "../../src/drafts/store.ts";
import { openUndoStore } from "../../src/undo/store.ts";
import { openHistoryStore } from "../../src/history/store.ts";
import type { HistoryCommand, HistoryTelemetry } from "../../src/history/records.ts";
import { historyExcerpt } from "../../src/history/sanitize.ts";
import { handleSlashCommand } from "../../src/tui/app.ts";
import { openRouterModelCapabilities, parseModelList } from "../../src/model/model-list.ts";
import { createTestRenderer } from "@opentui/core/testing";
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { mkdtemp, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuiController, type TuiSnapshot, type TuiControllerOptions } from "../../src/tui/controller.ts";
import { createConversationView, PANEL_MODES, type PanelMode } from "../../src/tui/view.ts";
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
/** Fixture API key typed into masked entry; no golden may contain any part of it. */
export const CATALOG_API_KEY = "sk-catalog-fixture-4f7a9c2e1b";
/** Fixture browser callback pasted into masked entry; no golden may contain any part of it. */
export const CATALOG_CALLBACK = "http://localhost:1455/auth/callback?code=catalog-fixture-code&state=catalog-fixture-state";
/** Fixed time stamped on fixture session records so pickers show only the catalog clock. */
export const CATALOG_TIME = "2026-01-15T09:30:00.000Z";
/** Named panel sub-states the catalog must capture in addition to every `PANEL_MODES` entry. */
export const CATALOG_SUB_STATES: readonly { name: string; matches(mode: PanelMode | "", snapshot: TuiSnapshot, ui: ScreenHarness): boolean }[] = [
  { name: "tool approval with reason entry", matches: (mode, s) => mode === "tool-approval" && !!s.toolApproval?.enteringReason },
  { name: "tool approval with an overflowing diff", matches: (mode, s, ui) => {
    const scroll = ui.renderer.root.findDescendantById("tool-approval-scroll") as ScrollBoxRenderable | undefined;
    return mode === "tool-approval" && !!s.toolApproval?.diff && !!scroll && scroll.scrollHeight > scroll.viewport.height;
  } },
  { name: "branch tree with a branch selected", matches: (mode, s) => mode === "tree" && !!s.branchTree?.selectedBranchId },
  { name: "branch tree after Tab switches to a new fork", matches: (mode, s) => mode === "tree" && !!s.branchTree && !s.branchTree.selectedBranchId },
];
/** Panel mode and named sub-states each screen showed at capture, across every rendered variant. */
export const catalogCaptures = new Map<string, { modes: Set<PanelMode | "">; subStates: Set<string> }>();
/** Name every panel mode and required sub-state that no listed screen showed at capture. */
export function panelCoverageGaps(screenIds: readonly string[], captures: ReadonlyMap<string, { modes: ReadonlySet<PanelMode | "">; subStates: ReadonlySet<string> }>): string[] {
  const seen = screenIds.flatMap(id => captures.get(id) ? [captures.get(id)!] : []);
  return [
    ...PANEL_MODES.filter(mode => !seen.some(capture => capture.modes.has(mode))).map(mode => `panel mode "${mode}"`),
    ...CATALOG_SUB_STATES.filter(state => !seen.some(capture => capture.subStates.has(state.name))).map(state => `sub-state "${state.name}"`),
  ];
}
/** Write one version-4 session file whose IDs and commit times are fixed, for pickers and resume. */
async function writeFixtureSession(directory: string, id: string, root: string, operations: readonly Record<string, unknown>[]) {
  await mkdir(directory, { recursive: true });
  const header = { type: "session", version: 4, id, createdAt: CATALOG_TIME, workspaceRoot: root, launchCwd: root, extraRoots: [] };
  await writeFile(join(directory, `${id}.jsonl`), [header, ...operations].map(record => JSON.stringify(record)).join("\n") + "\n");
}
/** A complete user turn appended to `branchId` after `parentId`, committed at the catalog time. */
const fixtureTurn = (branchId: string, parentId: string, id: string, task: string, answer: string) => ({ type: "branch_append", version: 1, branchId, committedAt: CATALOG_TIME, entries: [
  { parentId, item: { type: "user", id: `${id}-user`, content: [{ type: "text", text: task }] } },
  { parentId: `${id}-user`, item: { type: "assistant", id: `${id}-answer`, content: [{ type: "text", text: answer }] } },
] });
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
  const historyScreen = screen.id.startsWith("history-");
  // Screens that run file-touching commands (/sessions, /resume, /login and the rest) always use a temporary home.
  const commandFiles = ["api-key-entry", "callback-entry", "session-picker", "branch-tree-continue", "branch-tree-fork", "command-routing"].includes(screen.id);
  const askEdit = screen.id === "approval-edit" || screen.id === "approval-deny-reason" || screen.id === "approval-diff-overflow";
  const disk = commandFiles || askEdit || screen.id === "details-recovery" || draft || palette || (screen.id.startsWith("model-picker") || screen.id === "details-model") || ["approval-command", "completed-turn", "stopped-tool", "large-edit", "review-panel", "details-review", "undo-preview", "undo-preview-no-git", "delete-session-busy", "recent-work-resume", "narrow-layout"].includes(screen.id) || reviewScope || undoLimit || resumedReview || historyScreen;
  if (disk) {
    temp = await realpath(await mkdtemp(join(tmpdir(), "catalog-")));
    home = join(temp, "home"); root = join(home, "demo"); await mkdir(root, { recursive: true });
    if (screen.id === "narrow-layout") {
      root = join(home, "Projects", "very-long-directory-name", "schway");
      await mkdir(join(root, ".git"), { recursive: true });
      await writeFile(join(root, ".git/HEAD"), "ref: refs/heads/feature/a-very-long-branch-name-for-testing\n");
    }
    if (["completed-turn", "stopped-tool", "large-edit", "review-panel", "details-review", "undo-preview", "undo-preview-no-git"].includes(screen.id) || reviewScope || undoLimit || resumedReview || historyScreen) {
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
    // Error states: Git refuses a corrupt index, or the saved workspace disappears after resume.
    if (screen.id === "resumed-review-git-failed") await writeFile(join(root, ".git", "index"), "not an index");
    if (screen.id === "resumed-review-unavailable") await rename(root, `${root}-moved`);
  }
  const durableSession = draft ? await createJsonlSession({ directory: sessionsDirectory(home), workspace }) : undefined;
  // History screens run real turns in a saved session so the controller records evidence beside it.
  const historySession = historyScreen ? await createJsonlSession({ directory: sessionsDirectory(home), workspace }) : undefined;
  if (screen.id === "history-missing-evidence") historySession!.append(
    { type: "user", id: "legacy-user-1", content: [{ type: "text", text: "Sketch the clamp helper" }] }, { type: "assistant", id: "legacy-answer-1", content: [{ type: "text", text: "Sketched it." }] },
    { type: "user", id: "legacy-user-2", content: [{ type: "text", text: "Name the bounds lo and hi" }] }, { type: "assistant", id: "legacy-answer-2", content: [{ type: "text", text: "Renamed them." }] });
  if (screen.id === "history-truncation") {
    // Synthetic evidence exercises record bounds without running hundreds of tools.
    const task = `Audit every generated fixture ${"and compare its snapshot ".repeat(8)}ไทย 🧪`;
    historySession!.append({ type: "user", id: "history-user", content: [{ type: "text", text: task }] }, { type: "assistant", id: "history-answer", content: [{ type: "text", text: "Audited the fixtures." }] });
    const excerpt = historyExcerpt(task, []);
    const store = openHistoryStore({ home }), id = historySession!.header.id;
    await store.start(id, { type: "turn_start", version: 1, turnId: "history-user", attemptId: "history-attempt", ordinal: 1, branchId: "main", parentId: historySession!.rootId,
      workspaceRoot: root, mode: "headless", startedAt: "2026-01-15T09:30:00.000Z", ...(excerpt.text ? { task: excerpt.text } : {}), ...(excerpt.truncated ? { taskTruncated: true as const } : {}) });
    const commands = Array.from({ length: 50 }, (_, index) => ({ id: index.toString(16).padStart(16, "0"), command: `bun test fixtures/case-${index + 1}.test.ts`, exitCode: index % 17 === 3 ? 1 : 0, ended: "exit" as const, status: "success" as const }));
    await store.finalize(id, { type: "turn_finalize", version: 1, turnId: "history-user", attemptId: "history-attempt", revision: 1, outcome: "completed", finishedAt: "2026-01-15T09:30:00.000Z", activeMs: 754_000,
      toolResults: 291, failedTools: 0, commands: { total: 61, exitZero: 57, nonzero: 4, unknown: 0, truncated: true, items: commands },
      files: { total: 230, truncated: true, items: Array.from({ length: 200 }, (_, index) => ({ path: `fixtures/__snapshots__/case-${index + 1}.snap`, source: "tool" as const, added: 3, removed: 1 })) },
      git: { status: "unavailable", reason: "headless" } });
  }
  if (screen.id.startsWith("history-timing")) await historyTimingFixture(screen.id, historySession!, home);
  const session = durableSession ?? resumed ?? historySession ?? createSession();
  const draftStore = durableSession ? openDraftStore({ home, workspaceRoot: root, sessionId: durableSession.header.id }) : undefined;
  if (draftStore) draftStore.save(screen.id === "draft-restored" ? "ร่างภาษาไทย\nยังไม่ส่ง 🧪" : "Previously saved", 1);
  if (screen.id === "recent-work-resume") {
    sessionDirectory = sessionsDirectory(home);
    const prior = await createJsonlSession({ directory: sessionDirectory, workspace });
    prior.append({ type: "user", id: "previous-user", content: [{ type: "text", text: "Refactor the session loader" }] }, { type: "assistant", id: "previous-assistant", content: [{ type: "text", text: "Separated loading and validation." }] });
  }
  if (screen.id === "compaction") for (let i = 0; i < 2; i++) session.append({ type: "user", id: `user-${i}`, content: [{ type: "text", text: `Explain session loading step ${i + 1}.` }] }, { type: "assistant", id: `assistant-${i}`, content: [{ type: "text", text: "Read the records, validate them, and restore the conversation." }] });
  let responses: ScriptedTurn[] = [{ text: "Ready." }];
  if (["streaming-answer", "running-search", "running-empty", "running-draft"].includes(screen.id)) responses = [{ chunks: ["## Plan\n\n", "Reading the **config** loader first.\n\n", "- Check `src/config/config.ts`\n- Then"], waitForAbort: true }];
  if (screen.id === "stopped-streaming") responses = [{ chunks: ["## Partial answer\n\n", "อ่านไฟล์แล้ว 🧪\n\n", "The next step is"], waitForAbort: true }];
  if (["failed-turn", "no-color", "details-recovery"].includes(screen.id)) responses = Array.from({ length: 3 }, () => ({ error: "Service unavailable", status: 503 }));
  if (screen.id === "retry-countdown") responses = [{ error: "busy", status: 503, headers: { "Retry-After": "3" } }];
  if (screen.id === "retry-rate-limit") responses = [{ error: "Too many requests", status: 429, headers: { "Retry-After": "20" } }];
  if (screen.id === "retry-network") responses = [{ error: "socket hang up", code: "ECONNRESET" }];
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
  if (historyScreen && screen.id !== "history-truncation") {
    tools = createToolRegistry([readTool, editTool, writeTool, bashTool]);
    responses = [
      { toolCalls: [{ id: "history-edit", name: "edit", arguments: { path: "clamp.ts", edits: [{ oldText: "return Math.max(lo, n);", newText: "return Math.min(hi, Math.max(lo, n));" }] } }] },
      { toolCalls: [{ id: "history-check", name: "bash", arguments: { command: "printf 'ok\\n'" } }] },
      { text: "Fixed clamp so it respects the upper bound." },
      { toolCalls: [{ id: "history-tests", name: "bash", arguments: { command: "printf 'clamp: 1 failing\\n'; exit 1" } }] },
      { text: "One clamp test still fails." },
      { toolCalls: [{ id: "history-notes", name: "write", arguments: { path: "notes.md", content: "Clamp notes ไทย 🧪\n" } }] },
      { toolCalls: [{ id: "history-wait", name: "bash", arguments: { command: "printf 'Ready to stop\\n'; sleep 30", timeout: 5_000 } }] },
    ];
  }
  if (screen.id === "approval-command" || askEdit) {
    tools = createToolRegistry([editTool, bashTool]);
    await writeFile(join(root, "clamp.ts"), "export function clamp(n: number, lo: number, hi: number) {\n  return Math.max(lo, n);\n}\n");
    // The overflow edit's diff is taller than the approval panel at 30 rows.
    const newText = screen.id === "approval-diff-overflow" ? Array.from({ length: 28 }, (_, i) => `  const bound${i + 1} = Math.min(hi, Math.max(lo, n + ${i}));`).join("\n") + "\n  return bound1;" : "  return Math.min(hi, Math.max(lo, n));";
    responses = [{ toolCalls: [screen.id === "approval-command"
      ? { id: "approval-command", name: "bash", arguments: { command: "bun test --filter clamp" } }
      : { id: screen.id, name: "edit", arguments: { path: "clamp.ts", edits: [{ oldText: "  return Math.max(lo, n);", newText }] } }] }];
  }
  if (screen.id === "reader-approval") {
    tools = createToolRegistry([bashTool]);
    responses = [{ toolCalls: [{ id: "reader-command", name: "bash", arguments: { command: "bun test --filter clamp" } }] }];
  }
  if (screen.id === "parallel-tools") {
    const names = ["read", "grep", "bash"];
    tools = createToolRegistry(names.map(name => ({ name, description: `Gated ${name} fixture`, execution: "parallel" as const, inputSchema: { type: "object", properties: {} }, execute: async (_input, context) => { await stopped(context.signal); return { content: "Stopped." }; } })));
    responses = [{ toolCalls: names.map(name => ({ id: `call_fixture_parallel_${name}`, name, arguments: name === "bash" ? { command: "bun test" } : name === "grep" ? { pattern: "clamp" } : { path: "clamp.ts" } })) }];
  }
  // Catalog run times come from the activity clock: each executed tool takes 1.2s and each completed model response 0.3s.
  tools = createToolRegistry(tools.definitions().map(definition => ({ ...definition,
    execute: async (input: unknown, context: Parameters<typeof definition.execute>[1]) => { try { return await definition.execute(input, context); } finally { activityTime += 1200; } } })));
  const timed = (model: ReturnType<typeof createScriptedModel>): ReturnType<typeof createScriptedModel> => ({ provider: model.provider, id: model.id,
    async *stream(request) { for await (const event of model.stream(request)) { if (event.type === "message_complete") activityTime += 300; yield event; } } });
  const fresh = ["first-run", "disconnected-search", "sign-in-chooser", "chatgpt-more-options", "grok-more-options", "endpoint-url-empty", "endpoint-url-error", "subscription-sign-in"].includes(screen.id);
  const picker = screen.id === "model-picker" || screen.id === "details-model";
  const unconnectedPicker = screen.id === "model-picker-unconnected";
  const store = fakeCredentialStore();
  const options: TuiControllerOptions = {
    session, workspace, home, tools, maxConcurrentTools: 3, provider: fresh || picker ? "openai" : "scripted", modelId: fresh || unconnectedPicker ? "" : picker ? "gpt-6-astra" : "scripted-model", sessionId: durableSession?.header.id ?? resumed?.header.id ?? historySession?.header.id ?? "catalog-session",
    model: fresh || unconnectedPicker ? undefined : timed(createScriptedModel({ id: "scripted-model", responses })), contextManager: createContextManager(workspace, { home, ...(screen.id === "compaction" ? { keepTurns: 1 } : {}) }),
    appearanceEnvironment: variant.theme, activityClock: () => activityTime,
    // A settled call that never executed still takes its 1.2s; executed calls already advanced the clock.
    onRuntimeEvent: event => { if (event.type === "tool.finished" && event.durationMs === undefined) activityTime += 1200; },
    agentClock: { now: () => activityTime, monotonicNow: () => activityTime, sleep: async (_ms, signal) => { if (screen.id.startsWith("retry-")) await stopped(signal); } },
    credentials: { store, grokLogin: async ({ device, signal, onApproval, onSaved }) => {
      if (screen.id === "grok-plan-error") {
        await store.set(grokSubscriptionIdentity(), JSON.stringify({ accessToken: "fixture-access", obtainedAt: 1 })); onSaved?.();
        return { ok: false, message: "Your Grok plan doesn't include API access. Use an xAI API key instead." };
      }
      onApproval(device ? { kind: "device", verificationUri: "https://x.ai/device", userCode: "ABCD-EFGH" } : { kind: "browser" });
      await stopped(signal); return { ok: false, message: "Cancelled." };
    }, env: picker ? { OPENAI_API_KEY: "fixture-key" } : {}, reload: async () => ({ model: createScriptedModel() }), listRouteModels: async () => ["gpt-6-astra", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-4.1"].map(id => ({ id })), codexLogin: async ({ signal }) => { loginCalled = true; await stopped(signal); return { ok: false, message: "Cancelled." }; } },
  };
  if (screen.id === "details-recovery" || screen.id === "resumed-review-off") options.changeTracking = "off";
  // Exercise real diagnostic redaction before layout so temporary-root bytes never enter goldens.
  if (screen.id === "details-review" || resumedReview) options.secrets = [temp!];
  if (screen.id === "approval-command" || askEdit) options.configEditor = new ConfigEditor({ cli: { approval: { mode: "ask" } } }, { user: join(home, "config.json"), project: join(root, "config.json") });
  if (screen.id === "command-routing") options.configEditor = new ConfigEditor({}, { user: join(home, "config.json"), project: join(root, "config.json") });
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
  if (screen.id === "session-picker") {
    // Fixed IDs, titles and commit times keep picker rows free of UUIDs and wall-clock timestamps.
    for (const [id, task, answer] of [["clamp-fix", "Fix the clamp upper bound", "Fixed clamp so it respects the upper bound."], ["config-loader", "Explain the config loader", "It merges defaults, user and project settings."], ["readme-summary", "Summarize the README", "Schway is a terminal coding agent."]] as const)
      await writeFixtureSession(sessionsDirectory(home), id, root, [fixtureTurn("main", id, `${id}-1`, task, answer)]);
  }
  if (screen.id.startsWith("branch-tree-")) {
    // Two named forks from the first complete turn, with the unnamed main branch active again.
    await writeFixtureSession(sessionsDirectory(home), "branch-demo", root, [
      fixtureTurn("main", "branch-demo", "first", "Fix the clamp upper bound", "Fixed clamp so it respects the upper bound."),
      fixtureTurn("main", "first-answer", "second", "Add a return type", "Added the return type."),
      { type: "branch_fork", version: 1, branchId: "inclusive", headId: "first-answer", name: "Inclusive bounds" },
      fixtureTurn("inclusive", "first-answer", "inclusive", "Make both bounds inclusive", "Both bounds are inclusive."),
      { type: "branch_fork", version: 1, branchId: "exclusive", headId: "first-answer", name: "Exclusive upper bound" },
      fixtureTurn("exclusive", "first-answer", "exclusive", "Make the upper bound exclusive", "The upper bound is exclusive."),
      { type: "branch_select", version: 1, branchId: "main", settlements: [] },
    ]);
  }
  // One production command context per screen, as the interactive app builds it after startup (skills use the live context manager), minus model creation and runtime keys.
  const secrets = options.secrets ?? [];
  const catalogConfig = new ConfigEditor({}, { user: join(home, "config.json"), project: join(root, "config.json") });
  const commandContext = { controller, home, workspaceRoot: root, skillScope: { workspaceRoot: root, manager: controller.activeContextManager() }, sessionsDir: sessionsDirectory(home), settings: () => catalogConfig.settings, env: {}, secrets, finishQuit() {}, stderr: { write() {} } };
  const view = createConversationView(terminal.renderer, { controller, draftPersistence: draft, secrets, workspaceRoot: root, home, env: { SCHWAY_THEME: variant.theme, ...(variant.noColor ? { NO_COLOR: "1" } : {}) }, motion: "reduced", splash: "none", now: () => CATALOG_VIEW_NOW_MS, quit: () => {}, openUrl: async () => {},
    submit: (value, accepted) => dispatchEditorInput(value, controller, (command, onAccepted) => handleSlashCommand(command.name, command.args, commandContext, command.raw, onAccepted), accepted) });
  const settle = async () => { await Bun.sleep(1); view.refresh(); await terminal.flush(); };
  const waitFor = async (predicate: (snapshot: TuiSnapshot) => boolean) => {
    const start = performance.now();
    while (!predicate(controller.snapshot())) {
      if (performance.now() - start > 10_000) throw new Error(`Screen ${screen.id} timed out\n${terminal.captureCharFrame()}`);
      await settle();
    }
  };
  await settle();
  return { ...terminal, controller, view, session, sessionDirectory, secrets, draftStore, root, editor: terminal.renderer.root.findDescendantById("prompt") as TextareaRenderable, loginCalled: () => loginCalled, settle, waitFor,
    advance: () => { activityTime += screen.elapsed ?? 0; },
    dispose: async () => { view.destroy(); controller.dispose(); terminal.renderer.destroy(); await controller.waitForIdle(); undoLock?.close(); if (temp) await rm(temp, { recursive: true, force: true }); },
  };
}
/** Reach the named state, capture all spans and dispose every owned resource. */
export async function renderScreen(screen: Screen, variant: Variant): Promise<string> {
  const ui = await buildScreen(screen, variant);
  try {
    await screen.drive(ui); await ui.waitFor(snapshot => screen.ready(snapshot, ui)); ui.advance(); await ui.settle();
    const snapshot = ui.controller.snapshot();
    if (!screen.ready(snapshot, ui)) throw new Error(`Screen ${screen.id} left its ready state before capture\n${ui.captureCharFrame()}`);
    const mode = ui.view.panelMode(), capture = catalogCaptures.get(screen.id) ?? { modes: new Set(), subStates: new Set() };
    capture.modes.add(mode);
    for (const state of CATALOG_SUB_STATES) if (state.matches(mode, snapshot, ui)) capture.subStates.add(state.name);
    catalogCaptures.set(screen.id, capture);
    const cursor = ui.renderer.getCursorState();
    return serializeScreen(ui.captureSpans(), { screen: screen.id, title: screen.title, description: screen.description, variant: variant.id, cursor });
  } finally { await ui.dispose(); }
}

/**
 * Synthetic, internally possible timing evidence for the `history-timing*` screens: each tool round is one model call,
 * the final answer one more, and a retried attempt one more; the turn spans exactly its active time.
 */
async function historyTimingFixture(id: string, session: Awaited<ReturnType<typeof createJsonlSession>>, home: string): Promise<void> {
  const task = "Check tomorrow's Bangkok weather and how long the drive to the airport takes";
  session.append({ type: "user", id: "timing-user", content: [{ type: "text", text: task }] }, { type: "assistant", id: "timing-answer", content: [{ type: "text", text: "Light rain; about 45 minutes." }] });
  const store = openHistoryStore({ home }), sessionId = session.header.id;
  const total = (value: number, reportedCalls: number) => ({ total: value, reportedCalls });
  // Cache not reported: one round runs two commands, then the answer, after one retried attempt (3 calls; the failed one reported nothing).
  // Partial: one command round, then the answer (2 calls); only one call reported cached input.
  // Default and details: three command rounds, then the answer (4 calls).
  const telemetry: HistoryTelemetry = id === "history-timing-cache-unreported"
    ? { modelCalls: 3, modelMs: 53_300, firstDelta: { minMs: 812, maxMs: 1400, calls: 2 }, retries: 1, retryWaitMs: 1000, toolCalls: 2, toolMs: 8500, approvalWaitMs: 4100,
      tokens: { input: total(162_000, 2), cachedInput: total(0, 0), output: total(3100, 2), reasoning: total(0, 0) } }
    : id === "history-timing-partial"
      ? { modelCalls: 2, modelMs: 56_800, firstDelta: null, retries: 0, retryWaitMs: 0, toolCalls: 1, toolMs: 400, approvalWaitMs: 0,
        tokens: { input: total(160_000, 2), cachedInput: total(65_536, 1), output: total(4100, 2), reasoning: total(3800, 1) } }
      : { modelCalls: 4, modelMs: 118_000, firstDelta: { minMs: 4700, maxMs: 31_000, calls: 4 }, retries: 0, retryWaitMs: 0, toolCalls: 3, toolMs: 81_400, approvalWaitMs: 0,
        tokens: { input: total(160_000, 4), cachedInput: total(129_600, 4), output: total(6000, 4), reasoning: total(4800, 4) } };
  const command = (index: number, text: string, durationMs: number, approvalWaitMs?: number): HistoryCommand => ({ id: index.toString(16).padStart(16, "0"), command: text, exitCode: 0,
    ended: "exit", status: "success", durationMs, ...(approvalWaitMs !== undefined ? { approvalWaitMs } : {}) });
  const commands = id === "history-timing-partial" ? [command(1, "date", 400)]
    : id === "history-timing-cache-unreported" ? [command(1, "date", 400), command(2, "curl -s wttr.in/Bangkok", 8100, 4100)]
      : [command(1, "curl -s wttr.in/Bangkok", 31_200), command(2, "curl -s 'https://maps.example/route?to=BKK'", 49_800), command(3, "date", 400)];
  // Model plus backoff plus tool time fits the active time, and the start and finish times span exactly that.
  const activeMs = telemetry.modelMs + telemetry.retryWaitMs + telemetry.toolMs + 600;
  const finishedAt = "2026-01-15T09:30:00.000Z", startedAt = new Date(Date.parse(finishedAt) - activeMs).toISOString();
  await store.start(sessionId, { type: "turn_start", version: 1, turnId: "timing-user", attemptId: "timing-attempt", ordinal: 1, branchId: "main", parentId: session.rootId,
    workspaceRoot: "/home/test/demo", mode: "tui", startedAt, task });
  await store.finalize(sessionId, { type: "turn_finalize", version: 1, turnId: "timing-user", attemptId: "timing-attempt", revision: 1, outcome: "completed", finishedAt,
    activeMs, toolResults: commands.length, failedTools: 0, commands: { total: commands.length, exitZero: commands.length, nonzero: 0, unknown: 0, truncated: false, items: commands },
    files: { total: 0, truncated: false, items: [] }, git: { status: "captured" }, telemetry });
}
