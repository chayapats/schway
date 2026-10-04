import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentLoop } from "../src/agent/loop.ts";
import type { RuntimeEvent } from "../src/agent/events.ts";
import { runCli } from "../src/cli/runtime.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createHistoryCollector, historyTurnIdentity, type HistoryObservation } from "../src/history/collector.ts";
import { HISTORY_PAGE_SIZE, type HistoryTurnFinalize } from "../src/history/records.ts";
import { historyFilePath, openHistoryStore, type HistoryStore } from "../src/history/store.ts";
import { buildHistoryTimeline, historyUndoTarget } from "../src/history/timeline.ts";
import { createJsonlSession, loadJsonlSession, sessionsDirectory, type JsonlSession } from "../src/session/jsonl.ts";
import { bashTool } from "../src/tools/bash.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { writeTool } from "../src/tools/write.ts";
import { openUndoStore, pruneUndoStore } from "../src/undo/store.ts";
import type { Workspace } from "../src/workspace/workspace.ts";
import { createScriptedModel, type ScriptedTurn } from "./helpers/scripted-model.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function temp() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "schway-history-collector-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function setup() {
  const dir = await temp();
  const home = join(dir, "home"), root = join(dir, "work");
  await mkdir(root, { recursive: true });
  const workspace: Workspace = { root, launchCwd: root, extraRoots: [] };
  const session = await createJsonlSession({ directory: sessionsDirectory(home), workspace });
  return { home, root, workspace, session, store: openHistoryStore({ home }) };
}
const NOT_CAPTURED: HistoryObservation = { status: "unavailable", reason: "not-captured" };

/** Run one accepted turn through the shared loop while a collector records its evidence. */
async function turn(ctx: Awaited<ReturnType<typeof setup>>, prompt: string | undefined, responses: ScriptedTurn[], options: { abortOn?: (event: RuntimeEvent) => boolean; store?: HistoryStore; observation?: HistoryObservation; clock?: () => number } = {}) {
  if (prompt !== undefined) ctx.session.append({ type: "user", id: crypto.randomUUID(), content: [{ type: "text", text: prompt }] });
  const identity = historyTurnIdentity(ctx.session, ctx.root, "tui")!;
  const collector = createHistoryCollector({ store: options.store ?? ctx.store, identity, clock: options.clock, now: () => new Date("2026-01-15T09:30:00.000Z") });
  const started = await collector.start();
  const abort = new AbortController();
  for await (const event of runAgentLoop({ session: ctx.session, model: createScriptedModel({ responses }), contextManager: createContextManager(ctx.workspace),
    tools: createToolRegistry([writeTool, bashTool]), workspace: ctx.workspace, signal: abort.signal, undo: openUndoStore({ home: ctx.home }) })) {
    collector.observe(event);
    if (options.abortOn?.(event)) abort.abort();
  }
  const finalized = await collector.finalize({ observation: options.observation ?? NOT_CAPTURED });
  return { collector, started, finalized, identity };
}
async function timeline(ctx: { home: string; session: JsonlSession }) {
  return buildHistoryTimeline(await openHistoryStore({ home: ctx.home }).read(ctx.session.rootId), ctx.session);
}

test("three scripted turns keep identities and observed outcomes across a restart", async () => {
  const ctx = await setup();
  await turn(ctx, "Create the note", [{ toolCalls: [{ id: "w1", name: "write", arguments: { path: "note.txt", content: "one\ntwo\n" } }] }, { text: "Created." }]);
  await turn(ctx, "Run the failing check", [{ toolCalls: [{ id: "b1", name: "bash", arguments: { command: "printf 'bad\\n'; exit 3" } }] }, { text: "The check failed." }]);
  await turn(ctx, "Explain slowly", [{ chunks: ["Thinking"], waitForAbort: true }], { abortOn: event => event.type === "model.delta" });
  const users = ctx.session.items.filter(item => item.type === "user").map(item => item.id);
  // A new process reloads the saved session and reads only the sidecar.
  const reloaded = await loadJsonlSession({ directory: sessionsDirectory(ctx.home), id: ctx.session.header.id });
  const view = await timeline({ home: ctx.home, session: reloaded });
  expect(view.turns.map(row => [row.ordinal, row.turnId, row.outcome])).toEqual([[3, users[2], "stopped"], [2, users[1], "completed"], [1, users[0], "completed"]]);
  const [stopped, failing, created] = view.turns;
  expect(created!.files.items).toEqual([{ path: "note.txt", source: "tool", added: 2, removed: 0 }]);
  expect(created!.task).toBe("Create the note");
  // A completed turn with a nonzero command keeps the observed exit, not a test verdict.
  expect(failing!.commands).toMatchObject({ total: 1, nonzero: 1, items: [{ command: "printf 'bad\\n'; exit 3", exitCode: 3, ended: "exit", status: "success" }] });
  expect(stopped!.files.total).toBe(0);
  expect(stopped!.unknownDurations).toBe(0);
  expect(view.status).toBe("ok");
});

test("continuing the same accepted turn folds attempts into one row with the latest outcome", async () => {
  const ctx = await setup();
  let now = 0;
  const clock = () => now;
  const first = await turn(ctx, "Try twice", [{ toolCalls: [{ id: "b1", name: "bash", arguments: { command: "exit 0" } }] }, { error: "Service unavailable", status: 400 }],
    { clock, abortOn: event => { if (event.type === "tool.finished") now += 1500; return false; } });
  expect(first.finalized.state).toBe("saved");
  now = 10_000;
  const second = await turn(ctx, undefined, [{ toolCalls: [{ id: "b2", name: "bash", arguments: { command: "exit 0" } }] }, { text: "Done." }],
    { clock: () => now, abortOn: event => { if (event.type === "tool.finished") now += 500; return false; } });
  expect(second.identity.turnId).toBe(first.identity.turnId);
  expect(second.collector.attemptId).not.toBe(first.collector.attemptId);
  const view = await timeline(ctx);
  expect(view.turns).toHaveLength(1);
  expect(view.turns[0]).toMatchObject({ outcome: "completed", activeMs: 2000, unknownDurations: 0, commands: { total: 2, exitZero: 2 } });
  expect(view.turns[0]!.attempts.map(attempt => attempt.outcome)).toEqual(["failed", "completed"]);
});

test("duplicate finalization and duplicate delivery never add turns or observations", async () => {
  const ctx = await setup();
  const { collector } = await turn(ctx, "Write once", [{ toolCalls: [{ id: "w1", name: "write", arguments: { path: "a.txt", content: "a\n" } }] }, { text: "ok" }]);
  // Same evidence again: idempotent, no second line.
  expect((await collector.finalize({ observation: NOT_CAPTURED })).state).toBe("saved");
  // A repeated runtime result for the same call is ignored.
  collector.observe({ type: "tool.finished", toolCallId: "w1", name: "write", status: "success", content: "Wrote a.txt", details: { path: "a.txt", resolvedPath: join(ctx.root, "a.txt"), created: true, lineCount: 1 } });
  expect((await collector.finalize({ observation: NOT_CAPTURED })).state).toBe("saved");
  const path = historyFilePath(ctx.home, ctx.session.rootId);
  let lines = (await readFile(path, "utf8")).trim().split("\n");
  expect(lines.filter(line => line.includes('"turn_finalize"'))).toHaveLength(1);
  // Changed evidence is a new revision; the highest revision wins and a replayed line changes nothing.
  expect((await collector.finalize({ observation: { status: "captured", paths: [join(ctx.root, "b.txt")] } })).state).toBe("saved");
  lines = (await readFile(path, "utf8")).trim().split("\n");
  const finals = lines.filter(line => line.includes('"turn_finalize"'));
  expect(finals.map(line => (JSON.parse(line) as HistoryTurnFinalize).revision)).toEqual([1, 2]);
  await appendFile(path, `${finals[0]}\n${lines[1]}\n`);
  const view = await timeline(ctx);
  expect(view.turns).toHaveLength(1);
  expect(view.turns[0]!.attempts).toHaveLength(1);
  expect(view.turns[0]!.files.items.map(file => [file.path, file.source])).toEqual([["a.txt", "tool"], ["b.txt", "shell"]]);
  expect(view.elsewhere).toBe(1);
});

test("an interrupted or partially finalized turn stays incomplete with unknown time", async () => {
  const ctx = await setup();
  ctx.session.append({ type: "user", id: "crashed", content: [{ type: "text", text: "Crash midway" }] });
  const crashed = createHistoryCollector({ store: ctx.store, identity: historyTurnIdentity(ctx.session, ctx.root, "tui")! });
  expect((await crashed.start()).state).toBe("saved");
  // The process ends here: no finalization, no repair on read.
  let view = await timeline(ctx);
  expect(view.turns[0]).toMatchObject({ outcome: "incomplete", unknownDurations: 1, activeMs: 0, evidence: "recorded" });
  const before = await readFile(historyFilePath(ctx.home, ctx.session.rootId));
  await turn(ctx, undefined, [{ text: "Recovered." }]);
  view = await timeline(ctx);
  expect(view.turns[0]).toMatchObject({ outcome: "completed", unknownDurations: 1 });
  expect((await readFile(historyFilePath(ctx.home, ctx.session.rootId))).subarray(0, before.length).equals(before)).toBe(true);
});

test("a history storage failure keeps the saved conversation and reports what was not saved", async () => {
  const ctx = await setup();
  // A file where the history directory belongs makes every history write fail.
  await writeFile(join(ctx.home, ".schway", "history"), "not a directory");
  const result = await turn(ctx, "Write anyway", [{ toolCalls: [{ id: "w1", name: "write", arguments: { path: "kept.txt", content: "kept\n" } }] }, { text: "Saved." }]);
  expect(result.started.state).toBe("unsaved");
  expect(result.finalized.state).toBe("unsaved");
  expect(await readFile(join(ctx.root, "kept.txt"), "utf8")).toBe("kept\n");
  const reloaded = await loadJsonlSession({ directory: sessionsDirectory(ctx.home), id: ctx.session.header.id });
  expect(reloaded.items.map(item => item.type)).toEqual(["user", "assistant", "tool_result", "assistant"]);
  const view = await timeline({ home: ctx.home, session: reloaded });
  expect(view.turns[0]).toMatchObject({ evidence: "missing", task: "Write anyway" });
  expect(view.turns[0]!.outcome).toBeUndefined();
  // A store that throws mid-turn is isolated the same way.
  const failing: HistoryStore = { start: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }, finalize: async () => {}, read: ctx.store.read };
  const isolated = await turn(ctx, "Again", [{ text: "Fine." }], { store: failing });
  expect(isolated.started).toEqual({ state: "unsaved", reason: "Permission denied" });
});

test("evidence attaches only to the exact accepted user record on the selected branch", async () => {
  const ctx = await setup();
  await turn(ctx, "Main task", [{ text: "Main answer." }]);
  const mainUser = ctx.session.items[0]!.id;
  const fork = ctx.session.forkBranch(ctx.session.rootId, "alternate");
  await turn(ctx, "Fork task", [{ text: "Fork answer." }]);
  let view = await timeline(ctx);
  expect(view.turns.map(row => [row.ordinal, row.task])).toEqual([[1, "Fork task"]]);
  expect(view.elsewhere).toBe(1);
  ctx.session.selectBranch("main");
  view = await timeline(ctx);
  expect(view.turns.map(row => [row.turnId, row.task, row.outcome])).toEqual([[mainUser, "Main task", "completed"]]);
  // A forged start naming the right user record at the wrong graph position is ignored.
  const path = historyFilePath(ctx.home, ctx.session.rootId);
  const forged = JSON.parse((await readFile(path, "utf8")).split("\n")[1]!);
  await appendFile(path, `${JSON.stringify({ ...forged, attemptId: "forged", parentId: "elsewhere", task: "Forged" })}\n`);
  view = await timeline(ctx);
  expect(view.turns[0]!.attempts).toHaveLength(1);
  expect(fork).not.toBe("main");
});

test("compaction keeps earlier turns and their evidence on the timeline", async () => {
  const ctx = await setup();
  await turn(ctx, "First", [{ text: "One." }]);
  await turn(ctx, "Second", [{ text: "Two." }]);
  const firstUser = ctx.session.items[0]!.id, secondUser = ctx.session.items[2]!.id;
  ctx.session.append({ type: "compaction", id: "summary", summary: "Earlier work summarized.", firstKeptId: secondUser });
  await turn(ctx, "Third", [{ text: "Three." }]);
  const view = await timeline(ctx);
  expect(view.turns.map(row => [row.task, row.evidence, row.outcome])).toEqual([["Third", "recorded", "completed"], ["Second", "recorded", "completed"], ["First", "recorded", "completed"]]);
  expect(view.turns[2]!.turnId).toBe(firstUser);
});

test("more than one page of turns stays available without a total cap", async () => {
  const ctx = await setup();
  for (let index = 0; index < HISTORY_PAGE_SIZE + 5; index++) await turn(ctx, `Task ${index + 1}`, [{ text: "ok" }]);
  const view = await timeline(ctx);
  expect(view.turns).toHaveLength(HISTORY_PAGE_SIZE + 5);
  expect(view.turns[0]!.task).toBe(`Task ${HISTORY_PAGE_SIZE + 5}`);
  expect(view.turns.at(-1)!.ordinal).toBe(1);
});

test("pruned undo pre-images leave observed history truthful while undo becomes unavailable", async () => {
  const ctx = await setup();
  await turn(ctx, "Edit for undo", [{ toolCalls: [{ id: "w1", name: "write", arguments: { path: "u.txt", content: "u\n" } }] }, { text: "ok" }]);
  const manifests = await openUndoStore({ home: ctx.home }).list(ctx.session.rootId);
  expect(historyUndoTarget(ctx.session, manifests)).toBe(ctx.session.items[0]!.id);
  await pruneUndoStore({ home: ctx.home, maxAgeDays: 0, maxSizeBytes: 0, now: new Date(Date.now() + 86_400_000) });
  expect(await openUndoStore({ home: ctx.home }).list(ctx.session.rootId)).toEqual([]);
  expect(historyUndoTarget(ctx.session, [])).toBeUndefined();
  const view = await timeline(ctx);
  expect(view.turns[0]!.files.items).toEqual([{ path: "u.txt", source: "tool", added: 1, removed: 0 }]);
});

const fixtureRoot = join(import.meta.dir, "fixtures/sessions");
for (const version of (await readdir(fixtureRoot)).sort()) test(`published ${version} session stays readable with explicit absent evidence`, async () => {
  const dir = await temp();
  const home = join(dir, "home"), root = join(dir, "project");
  await mkdir(root, { recursive: true });
  const expected = JSON.parse(await readFile(join(fixtureRoot, version, "expect.json"), "utf8")) as { sessionId: string };
  const directory = sessionsDirectory(home);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${expected.sessionId}.jsonl`);
  await writeFile(path, (await readFile(join(fixtureRoot, version, `${expected.sessionId}.jsonl`), "utf8")).replaceAll("__SCHWAY_FIXTURE_WORKSPACE__", JSON.stringify(root).slice(1, -1)));
  const loaded = await loadJsonlSession({ directory, id: expected.sessionId });
  const bytes = await readFile(path);
  const view = buildHistoryTimeline(await openHistoryStore({ home }).read(loaded.rootId), loaded);
  expect(view.status).toBe("missing");
  expect(view.turns.length).toBe(loaded.items.filter(item => item.type === "user").length);
  for (const row of view.turns) expect(row).toMatchObject({ evidence: "missing", files: { total: 0 }, commands: { total: 0 } });
  expect(view.turns.every(row => row.outcome === undefined)).toBe(true);
  expect((await readFile(path)).equals(bytes)).toBe(true);
  expect(await Bun.file(join(home, ".schway", "history")).exists()).toBe(false);
});

/** Run one headless task in-process, recording every Git process it starts. */
async function headless(home: string, cwd: string, responses: ScriptedTurn[]) {
  const realSpawn = Bun.spawn;
  const git: string[][] = [];
  Bun.spawn = ((command: string[], options: Parameters<typeof Bun.spawn>[1]) => {
    if (command[0] === "git") git.push(command);
    return realSpawn(command, options);
  }) as typeof Bun.spawn;
  const out: string[] = [], err: string[] = [];
  try {
    const code = await runCli(["-p", "Headless task", "--json"], { stdout: { write: text => { out.push(text); } }, stderr: { write: text => { err.push(text); } },
      env: { HOME: home }, cwd, model: createScriptedModel({ responses }), credentialStore: fakeCredentialStore() });
    return { code, stdout: out.join(""), stderr: err.join(""), git };
  } finally { Bun.spawn = realSpawn; }
}

test.each([["non-Git workspace", "on-demand", "headless"], ["tracking off", "off", "off"]] as const)("headless %s records Git evidence as unavailable without starting Git", async (_name, mode, reason) => {
  const dir = await temp();
  const home = join(dir, "home"), root = join(dir, "work");
  await mkdir(join(root, ".schway"), { recursive: true });
  await writeFile(join(root, ".schway", "config.json"), JSON.stringify({ git: { changeTracking: mode } }));
  const result = await headless(home, root, [{ toolCalls: [{ id: "w1", name: "write", arguments: { path: "h.txt", content: "h\n" } }, { id: "b1", name: "bash", arguments: { command: "exit 2" } }] }, { text: "Done." }]);
  expect(result.code).toBe(0);
  expect(result.git).toEqual([]);
  expect(result.stderr).not.toContain("History");
  const sessionId = (JSON.parse(result.stdout.split("\n")[0]!) as { sessionId: string }).sessionId;
  const session = await loadJsonlSession({ directory: sessionsDirectory(home), id: sessionId });
  const view = buildHistoryTimeline(await openHistoryStore({ home }).read(sessionId), session);
  expect(view.turns[0]).toMatchObject({ outcome: "completed", files: { items: [{ path: "h.txt", source: "tool" }] }, commands: { total: 1, nonzero: 1 } });
  expect(view.turns[0]!.attempts[0]).toMatchObject({ mode: "headless", git: { status: "unavailable", reason } });
  expect((await stat(historyFilePath(home, sessionId))).mode & 0o777).toBe(0o600);
});

test("a headless history failure is reported on stderr without changing the run result", async () => {
  const dir = await temp();
  const home = join(dir, "home"), root = join(dir, "work");
  await mkdir(join(home, ".schway"), { recursive: true });
  await mkdir(root, { recursive: true });
  await writeFile(join(home, ".schway", "history"), "blocked");
  const result = await headless(home, root, [{ text: "Fine." }]);
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("History not saved for this turn");
  expect(result.stdout).toContain('"agent.finished"');
});

test("history core modules never import the renderer or provider wire types", async () => {
  for (const file of ["records.ts", "sanitize.ts", "store.ts", "collector.ts", "timeline.ts"]) {
    const source = await Bun.file(join(import.meta.dir, "../src/history", file)).text();
    expect(source).not.toContain("@opentui");
    expect(source).not.toContain("/tui/");
    expect(source).not.toContain("providers/");
  }
});
