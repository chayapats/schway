import { expect, test, spyOn } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { TextareaRenderable, ScrollBoxRenderable } from "@opentui/core";
import * as fileSystem from "node:fs/promises";
import { mkdir, readFile, writeFile, rm, symlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createJsonlSession, loadJsonlSession } from "../src/session/jsonl.ts";
import { createContextManager } from "../src/context/manager.ts";
import { loadConfigEditor } from "../src/config/editing.ts";
import { TuiController, type TuiControllerOptions } from "../src/tui/controller.ts";
import { handleSlashCommand, sessionLoadStatus } from "../src/tui/app.ts";
import { dispatchEditorInput } from "../src/tui/commands.ts";
import { createConversationView } from "../src/tui/view.ts";
import { resolveWorkspace } from "../src/workspace/workspace.ts";
import { SessionResumeError } from "../src/tui/controller-sessions.ts";
import { historyTimeLabel } from "../src/tui/controller-history.ts";
import { daysAgoLabel, fitSessionPickerHint, relativeActivityLabel, sessionPanelLines, sessionPickerHint, utcMinuteLabel } from "../src/tui/session-picker-view.ts";
import { SessionLoadError } from "../src/session/jsonl.ts";
import { withTempDir } from "./helpers.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";

const user = (text: string) => ({ type: "user" as const, id: crypto.randomUUID(), content: [{ type: "text" as const, text }] });
async function fixture(home: string, root = home, overrides: Partial<TuiControllerOptions> = {}) {
  const workspace = await resolveWorkspace(root);
  const directory = join(home, "sessions");
  const session = await createJsonlSession({ directory, workspace });
  let calls = 0;
  const model = createScriptedModel({ responses: [() => { calls++; return { text: "answer" }; }] });
  const controller = new TuiController({ session, workspace, model, sessionId: session.header.id, provider: "scripted", modelId: "test", contextManager: createContextManager(workspace, { home }), ...overrides });
  const config = await loadConfigEditor({ home, workspaceRoot: workspace.root });
  const ctx = { controller, home, workspaceRoot: workspace.root, skillScope: { workspaceRoot: workspace.root }, sessionsDir: directory, settings: () => config.settings, env: {}, secrets: [], finishQuit: () => {}, stderr: { write: () => {} } };
  return { workspace, directory, session, controller, ctx, calls: () => calls, open: () => handleSlashCommand("sessions", "", ctx) };
}

test("dispatcher discovers >20 by committed activity, searches and pages without revisiting storage", async () => {
  await withTempDir(async home => {
    const f = await fixture(home);
    const sessions = [];
    for (let i = 0; i < 28; i++) {
      const s = await createJsonlSession({ directory: f.directory, workspace: f.workspace });
      s.append(user(`task ${i === 15 ? "needle" : i}`)); sessions.push(s);
    }
    await Bun.sleep(3);
    sessions[0]!.append(user("old creation recent task"));
    const path = join(f.directory, `${sessions[0]!.header.id}.jsonl`);
    const before = await readFile(path, "utf8");
    await f.open();
    expect(f.controller.snapshot().sessionPicker?.entries[0]?.title).toBe("old creation recent task");
    expect(f.controller.snapshot().sessionPicker?.total).toBe(29);
    f.controller.moveSessionPicker(24);
    expect(f.controller.snapshot().sessionPicker?.offset).toBe(24);
    expect(f.controller.snapshot().sessionPicker!.entries.length).toBeLessThanOrEqual(8);
    await rm(join(f.directory, `${sessions[15]!.header.id}.jsonl`));
    f.controller.searchSessions("task needle");
    expect(f.controller.snapshot().sessionPicker?.entries[0]?.title).toBe("task needle");
    expect(await f.controller.selectPickerSession()).toBe(false);
    expect(f.controller.snapshot().sessionId).toBe(f.session.header.id);
    f.controller.searchSessions("no matching task");
    expect(f.controller.snapshot().sessionPicker?.total).toBe(0);
    f.controller.closeSessionPicker();
    expect(await readFile(path, "utf8")).toBe(before);
    expect(f.calls()).toBe(0);
    f.controller.dispose();
  });
});

test("canonical current-workspace scope accepts subdirectory and symlink and explicitly exposes other roots", async () => {
  await withTempDir(async home => {
    const root = join(home, "project"), other = join(home, "other"), sub = join(root, "sub"), alias = join(home, "alias");
    await mkdir(join(root, ".git"), { recursive: true }); await mkdir(sub); await mkdir(other); await symlink(root, alias);
    const f = await fixture(home, root);
    for (const cwd of [root, sub, alias, other]) {
      const s = await createJsonlSession({ directory: f.directory, workspace: await resolveWorkspace(cwd) }); s.append(user(`task at ${cwd}`));
    }
    for (const cwd of [root, sub, alias]) {
      const local = await fixture(home, cwd);
      await local.open();
      expect(local.controller.snapshot().sessionPicker?.entries.every(row => row.workspaceRoot === root)).toBe(true);
      local.controller.toggleSessionScope();
      expect(local.controller.snapshot().sessionPicker?.entries.some(row => row.workspaceRoot === other)).toBe(true);
      local.controller.dispose();
    }
    f.controller.dispose();
  });
});

test("explicit picker resume restores branch and attachments without tools, staged failure retains current session", async () => {
  await withTempDir(async home => {
    const other = join(home, "other"), attachment = join(home, "attached"); await mkdir(other); await mkdir(attachment);
    const f = await fixture(home);
    const saved = await createJsonlSession({ directory: f.directory, workspace: { root: other, launchCwd: other, extraRoots: [attachment] } });
    saved.append(user("main task"));
    const branch = saved.forkBranch(saved.rootId, "alternate"); saved.append(user("alternate task"));
    saved.append({ type: "assistant", id: "pending", content: [{ type: "tool_call", id: "never-replay", name: "read", arguments: { path: "private" } }] });
    await f.open(); f.controller.toggleSessionScope(); f.controller.searchSessions("alternate task");
    expect(f.controller.snapshot().sessionPicker?.entries[0]?.state).toContain("Interrupted");
    expect(f.controller.snapshot().sessionId).toBe(f.session.header.id);
    expect(await f.controller.selectPickerSession()).toBe(true);
    expect(f.controller.snapshot().sessionId).toBe(saved.header.id);
    expect(f.controller.snapshot().branchId).toBe(branch);
    expect(f.controller.workspaceIdentity()?.extraRoots).toEqual([attachment]);
    expect(f.controller.snapshot().transcript.some(item => item.text.includes("alternate task"))).toBe(true);
    expect(f.calls()).toBe(0);
    f.controller.dispose();
    const fail = await fixture(home, home, { loadWorkspaceExtensions: async () => { throw new Error("staged capability failed"); } });
    await fail.open(); fail.controller.toggleSessionScope(); fail.controller.searchSessions("alternate task");
    expect(await fail.controller.selectPickerSession()).toBe(false);
    expect(fail.controller.snapshot().sessionId).toBe(fail.session.header.id);
    expect(fail.controller.workspaceIdentity()?.root).toBe(home);
    fail.controller.dispose();
  });
});

test("corrupt, unsupported, empty, interrupted and legacy files remain recoverable without preview mutation", async () => {
  await withTempDir(async home => {
    const f = await fixture(home);
    const header = (id: string, version = 1, workspaceRoot = home) => JSON.stringify({ type: "session", version, id, workspaceRoot, launchCwd: workspaceRoot, extraRoots: [], createdAt: "2000-01-01T00:00:00Z" });
    await writeFile(join(f.directory, "corrupt.jsonl"), "not json\n");
    await writeFile(join(f.directory, "unsupported.jsonl"), header("unsupported", 999) + "\n");
    await writeFile(join(f.directory, "legacy.jsonl"), header("legacy") + "\n" + JSON.stringify({ ...user("legacy ordinary task"), parentId: "legacy" }) + "\n");
    await writeFile(join(f.directory, "torn.jsonl"), header("torn") + '\n{"partial":');
    await writeFile(join(f.directory, "missing.jsonl"), header("missing", 1, join(home, "gone")) + "\n");
    const before = await readFile(join(f.directory, "torn.jsonl"), "utf8");
    await f.open(); f.controller.toggleSessionScope();
    const rows = f.controller.snapshot().sessionPicker!.entries;
    expect(rows.find(row => row.id === "corrupt")?.state).toContain("Corrupt");
    expect(rows.find(row => row.id === "unsupported")?.state).toContain("Unsupported");
    expect(rows.find(row => row.id === "torn")?.state).toContain("Interrupted");
    expect(rows.find(row => row.id === "legacy")?.state).toContain("Legacy");
    expect(rows.find(row => row.id === "missing")?.state).toContain("unavailable");
    expect(await readFile(join(f.directory, "torn.jsonl"), "utf8")).toBe(before);
    f.controller.searchSessions("missing"); expect(await f.controller.selectPickerSession()).toBe(false);
    expect(f.controller.snapshot().sessionId).toBe(f.session.header.id);
    f.controller.searchSessions("legacy ordinary"); expect(await f.controller.selectPickerSession()).toBe(true);
    expect(f.controller.snapshot().sessionId).toBe("legacy");
    expect((await readdir(f.directory)).filter(name => name.endsWith(".jsonl"))).toHaveLength(6);
    f.controller.dispose();
  });
});

test("bounded discovery batches and previews exclude saved auth payloads, tolerate poisoned advisory metadata", async () => {
  await withTempDir(async home => {
    const f = await fixture(home);
    for (let i = 0; i < 105; i++) {
      const s = await createJsonlSession({ directory: f.directory, workspace: f.workspace });
      s.append(user(i === 0 ? "/login sentinel-secret" : i === 1 ? "https://localhost/callback?code=sentinel-code" : `bounded task ${i} ${"x".repeat(70000)}`));
    }
    for (const bad of ["null", "42", '"text"', '{"title":null}', " ".repeat(100000)]) {
      await writeFile(join(f.directory, `${f.session.header.id}.jsonl.meta`), bad);
      const loaded = await loadJsonlSession({ directory: f.directory, id: f.session.header.id });
      loaded.append(user("survives corrupt cache"));
      expect(loaded.items.at(-1)?.type).toBe("user");
    }
    const opened = spyOn(fileSystem, "open");
    try {
      await f.open();
      // Transcript and optional cache each use one bounded read per discovered file.
      expect(opened.mock.calls.length).toBe(200);
      const readCount = opened.mock.calls.length;
      f.controller.searchSessions("bounded"); f.controller.moveSessionPicker(8); f.controller.searchSessions("");
      expect(opened.mock.calls.length).toBe(readCount);
    } finally { opened.mockRestore(); }
    expect(f.controller.snapshot().sessionPicker?.total).toBe(100);
    expect(f.controller.snapshot().sessionPicker?.hasMore).toBe(true);
    await f.controller.loadMoreSessionPicker();
    expect(f.controller.snapshot().sessionPicker?.total).toBe(106);
    expect(f.controller.snapshot().sessionPicker?.hasMore).toBe(false);
    f.controller.searchSessions("sentinel"); expect(f.controller.snapshot().sessionPicker?.total).toBe(0);
    f.controller.searchSessions("bounded task");
    expect(f.controller.snapshot().sessionPicker?.entries.every(row => row.title.length <= 160 && row.state.includes("Partial"))).toBe(true);
    expect(f.calls()).toBe(0); f.controller.dispose();
  });
});

test("renderer keyboard, paste, resize and cross-workspace A→B→A preserve draft and viewport identity", async () => {
  await withTempDir(async home => {
    const f = await fixture(home);
    f.session.append(...Array.from({ length: 40 }, (_, i) => user(`Source saved conversation line ${i}`)));
    await handleSlashCommand("resume", f.session.header.id, f.ctx);
    const other = join(home, "other"); await mkdir(other);
    let destinationId = "";
    for (let i = 0; i < 24; i++) {
      const s = await createJsonlSession({ directory: f.directory, workspace: i === 15 ? { root: other, launchCwd: other, extraRoots: [] } : f.workspace });
      s.append(user(`saved task ${i === 15 ? "needle" : i}`));
      if (i === 15) {
        destinationId = s.header.id;
        s.append({ type: "assistant", id: "long-answer", content: [{ type: "text", text: Array.from({ length: 60 }, (_, j) => `Destination answer line ${j}`).join("\n\n") }] });
      }
    }
    const terminal = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true });
    const view = createConversationView(terminal.renderer, { controller: f.controller, home, workspaceRoot: home, env: {}, secrets: [], quit() {}, submit: (value, accepted) => dispatchEditorInput(value, f.controller, command => handleSlashCommand(command.name, command.args, f.ctx), accepted) });
    const editor = terminal.renderer.root.findDescendantById("prompt") as TextareaRenderable;
    const transcript = terminal.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable;
    const settle = async () => { await Bun.sleep(10); view.refresh(); await terminal.flush(); };
    const open = async () => {
      terminal.mockInput.pressKey("s", { meta: true }); await settle();
      for (let i = 0; i < 100 && (!f.controller.snapshot().sessionPicker || f.controller.snapshot().sessionPicker!.loading); i++) await settle();
      expect(f.controller.snapshot().sessionPicker?.loading).toBe(false);
      terminal.mockInput.pressKey("w", { ctrl: true }); await settle();
    };
    const select = async (query: string) => {
      await open(); await terminal.mockInput.pasteBracketedText(query); await settle();
      terminal.mockInput.pressEnter(); await settle();
      for (let i = 0; i < 100 && f.controller.snapshot().sessionPicker; i++) await settle();
      expect(f.controller.snapshot().sessionPicker).toBeUndefined();
    };
    try {
      await terminal.mockInput.pasteBracketedText("ordinary unsent\nmultiline draft"); await settle();
      transcript.scrollTo(3); await terminal.flush(); const before = transcript.scrollTop;
      await open();
      terminal.mockInput.pressKey("\x1b[6~"); await settle();
      expect(f.controller.snapshot().sessionPicker?.offset).toBe(8);
      await terminal.mockInput.pasteBracketedText("saved task needle"); await settle();
      expect(f.controller.snapshot().sessionPicker?.entries[0]?.title).toBe("saved task needle");
      terminal.resize(48, 18); await settle();
      expect(terminal.captureCharFrame()).toContain("saved task needle");
      expect(f.controller.snapshot().sessionId).toBe(f.session.header.id);
      terminal.mockInput.pressEscape(); await settle();
      expect(editor.plainText).toBe("ordinary unsent\nmultiline draft"); expect(editor.focused).toBe(true);
      expect(transcript.scrollTop).toBe(before);
      await select("saved task needle");
      expect(f.controller.snapshot().sessionId).toBe(destinationId);
      expect(f.controller.workspaceIdentity()?.root).toBe(other);
      expect(editor.plainText).toBe("");
      expect(transcript.scrollTop).toBeGreaterThan(before);
      await terminal.mockInput.pasteBracketedText("destination unsent\nother workspace"); await settle();
      transcript.scrollTo(7); await terminal.flush();
      await select(f.session.header.id);
      expect(f.controller.snapshot().sessionId).toBe(f.session.header.id);
      expect(editor.plainText).toBe("ordinary unsent\nmultiline draft");
      expect(transcript.scrollTop).toBe(before);
      await select(destinationId);
      expect(editor.plainText).toBe("destination unsent\nother workspace");
      expect(transcript.scrollTop).toBe(7);
      expect(f.calls()).toBe(0);
    } finally { view.destroy(); f.controller.dispose(); terminal.renderer.destroy(); }
  });
});

test("renderer keeps selected activity and essential controls visible beside long previews at narrow sizes", async () => {
  await withTempDir(async home => {
    const f = await fixture(home);
    f.session.append(user("A".repeat(160)));
    const expected = JSON.parse(await readFile(join(f.directory, `${f.session.header.id}.jsonl.meta`), "utf8")).activityAt as string;
    const terminal = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true });
    const view = createConversationView(terminal.renderer, { controller: f.controller, home, workspaceRoot: home, env: {}, secrets: [], quit() {}, submit: (value, accepted) => dispatchEditorInput(value, f.controller, command => handleSlashCommand(command.name, command.args, f.ctx), accepted) });
    try {
      terminal.mockInput.pressKey("s", { meta: true });
      for (let i = 0; i < 100 && (!f.controller.snapshot().sessionPicker || f.controller.snapshot().sessionPicker!.loading); i++) { await Bun.sleep(5); view.refresh(); await terminal.flush(); }
      view.refresh(); await terminal.flush();
      const exact = `${expected.slice(0, 16).replace("T", " ")} UTC`;
      expect(terminal.captureCharFrame()).toContain(`Last activity: ${exact}`);
      for (const [width, height] of [[44, 18], [24, 8]]) {
        terminal.resize(width!, height!); view.refresh(); await terminal.flush();
        const frame = terminal.captureCharFrame();
        expect(frame).toContain(width === 44 ? `Last activity: ${exact}` : "Last activity:");
        expect(frame).toContain("Enter resume");
        // The short terminal hides the footer hint row, so the status bar names Esc and the panel row keeps Enter.
        expect(frame).toContain("Esc back");
      }
    } finally { view.destroy(); f.controller.dispose(); terminal.renderer.destroy(); }
  });
});


test("cancel during disk resume fences late publication and typed discovery query survives loading", async () => {
  await withTempDir(async home => {
    const f = await fixture(home);
    const saved = await createJsonlSession({ directory: f.directory, workspace: f.workspace }); saved.append(user("saved destination"));
    const opening = f.open();
    f.controller.searchSessions("saved destination");
    await opening;
    expect(f.controller.snapshot().sessionPicker?.query).toBe("saved destination");
    expect(f.controller.snapshot().sessionPicker?.total).toBe(1);
    const pending = f.controller.selectPickerSession();
    f.controller.closeSessionPicker();
    expect(await pending).toBe(false);
    expect(f.controller.snapshot().sessionId).toBe(f.session.header.id);
    expect(f.controller.snapshot().sessionPicker).toBeUndefined();
    expect(f.calls()).toBe(0); f.controller.dispose();
  });
});

test("recent-work controller and renderer keep assistant-only activity metadata unverified", async () => {
  await withTempDir(async home => {
    const f = await fixture(home);
    const saved = await createJsonlSession({ directory: f.directory, workspace: f.workspace });
    saved.append({ type: "assistant", id: "large-assistant", content: [{ type: "text", text: "x".repeat(70000) }] });
    const metadata = JSON.parse(await readFile(join(f.directory, `${saved.header.id}.jsonl.meta`), "utf8"));
    expect(metadata.activityAt).toBeString();
    await f.controller.offerRecentSession(f.directory);
    expect(f.controller.snapshot().recentSession).toMatchObject({ id: saved.header.id, activityAt: metadata.activityAt,
      previewIncomplete: true, title: "Recent conversation" });
    expect(f.controller.snapshot().recentSession?.hasWork).toBeUndefined();
    const terminal = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true });
    const view = createConversationView(terminal.renderer, { controller: f.controller, home, workspaceRoot: home, env: {}, secrets: [], quit() {},
      submit: (value, accepted) => dispatchEditorInput(value, f.controller, command => handleSlashCommand(command.name, command.args, f.ctx), accepted) });
    try {
      view.refresh(); await terminal.flush();
      expect(terminal.captureCharFrame()).toContain("Recent conversation");
      expect(terminal.captureCharFrame()).toContain("Resume saved work · Alt+B resume · /sessions browse");
      expect(f.calls()).toBe(0);
      await Bun.sleep(3);
      const meaningful = await createJsonlSession({ directory: f.directory, workspace: f.workspace });
      meaningful.append(user("Complete user record"));
      meaningful.append({ type: "assistant", id: "large-answer", content: [{ type: "text", text: "x".repeat(70000) }] });
      await f.controller.offerRecentSession(f.directory);
      expect(f.controller.snapshot().recentSession).toMatchObject({ id: meaningful.header.id, hasWork: true, title: "Complete user record" });
    } finally { view.destroy(); f.controller.dispose(); terminal.renderer.destroy(); }
  });
});

const NOW = Date.parse("2026-01-15T09:30:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

test("relative activity covers every bucket boundary, day counts, missing, future and unparseable times", () => {
  const cases: [string | undefined, string][] = [
    [ago(0), "just now"], [ago(MIN - 1), "just now"], [ago(MIN), "1 min ago"], [ago(HOUR - 1), "59 min ago"],
    [ago(HOUR), "1 h ago"], [ago(2 * HOUR), "2 h ago"], [ago(DAY - 1), "23 h ago"],
    // Buckets use elapsed time only, so calendar midnight never makes older activity read newer.
    [ago(DAY), "yesterday"], [ago(DAY + 9 * HOUR + 31 * MIN), "yesterday"], [ago(2 * DAY - 1), "yesterday"],
    [ago(2 * DAY), "2 days ago"], [ago(7 * DAY - 1), "6 days ago"], [ago(7 * DAY), "2026-01-08"], [ago(400 * DAY), "2024-12-11"],
    [undefined, "activity unknown"], ["", "activity unknown"], ["not a time", "activity unknown"],
    [new Date(NOW + 5 * MIN).toISOString(), "2026-01-15"],
  ];
  for (const [value, label] of cases) expect([value, relativeActivityLabel(value, NOW)]).toEqual([value, label]);
  expect(relativeActivityLabel(ago(3 * DAY), NOW)).not.toContain("-");
  expect([daysAgoLabel(1), daysAgoLabel(2)]).toEqual(["1 day ago", "2 days ago"]);
  // Labels never move backwards as activity gets older, minute by minute across two weeks and both midnights.
  const order = ["just now", "min ago", "h ago", "yesterday", "days ago", "date"];
  const rank = (label: string) => /^\d{4}-/.test(label) ? 5 : order.findIndex(bucket => label === bucket || label.endsWith(bucket));
  let last = 0;
  for (let age = 0; age < 14 * DAY; age += 7 * MIN) { const next = rank(relativeActivityLabel(ago(age), NOW)); expect(next).toBeGreaterThanOrEqual(last); last = next; }
});

test("selected activity uses the /history minute format with an explicit zone", () => {
  const value = "2026-10-04T15:31:44.508Z";
  expect(utcMinuteLabel(value)).toBe("2026-10-04 15:31 UTC");
  expect(utcMinuteLabel(value)).toBe(historyTimeLabel({ startedAt: value }));
  expect(utcMinuteLabel("2026-10-04T17:31:44+02:00")).toBe("2026-10-04 15:31 UTC");
  expect(utcMinuteLabel(undefined)).toBeUndefined();
  expect(utcMinuteLabel("garbage")).toBeUndefined();
});

test("a picker resume failure clears on selection, query, scope or a new attempt, and survives a no-op query", async () => {
  await withTempDir(async home => {
    const f = await fixture(home);
    for (const task of ["alpha task", "beta task", "gamma task"]) { const s = await createJsonlSession({ directory: f.directory, workspace: f.workspace }); s.append(user(task)); }
    let attempts = 0;
    let release: (() => void) | undefined;
    const resume = async () => {
      attempts++;
      if (release === undefined && attempts === 5) await new Promise<void>(resolve => { release = resolve; });
      throw new SessionResumeError("Workspace unavailable", "Saved workspace unavailable: /gone. Restore the directory and retry.");
    };
    await f.controller.openSessionPicker(f.directory, resume);
    const picker = () => f.controller.snapshot().sessionPicker!;
    const fail = async () => { expect(await f.controller.selectPickerSession()).toBe(false); expect(picker().error).toBe("Workspace unavailable"); };
    await fail();
    expect(picker()).toMatchObject({ errorKind: "resume", errorDetails: expect.stringContaining("/gone") });
    f.controller.searchSessions(picker().query); expect(picker().error).toBe("Workspace unavailable");
    f.controller.moveSessionPicker(-1); expect(picker().error).toBe("Workspace unavailable");
    f.controller.moveSessionPicker(1); expect(picker().error).toBeUndefined();
    await fail();
    f.controller.searchSessions("task"); expect(picker().error).toBeUndefined();
    await fail();
    f.controller.toggleSessionScope(); expect(picker().error).toBeUndefined();
    await fail();
    const pending = f.controller.selectPickerSession();
    await Bun.sleep(1);
    expect(picker()).toMatchObject({ resuming: true, loading: false });
    expect(picker().error).toBeUndefined();
    release!(); expect(await pending).toBe(false);
    expect(picker()).toMatchObject({ resuming: false, error: "Workspace unavailable" });
    expect(f.controller.snapshot().sessionId).toBe(f.session.header.id);
    f.controller.dispose();
  });
});

test("a discovery failure describes the list until discovery succeeds and returns after a resume failure clears", async () => {
  await withTempDir(async home => {
    const f = await fixture(home);
    const blocked = join(home, "blocked");
    await writeFile(blocked, "not a directory");
    expect(await f.controller.openSessionPicker(blocked, async () => { throw new Error("unused"); })).toBe(false);
    const picker = () => f.controller.snapshot().sessionPicker!;
    expect(picker()).toMatchObject({ error: "Cannot load sessions", errorKind: "discovery", errorDetails: expect.stringContaining("Cannot discover sessions:") });
    f.controller.searchSessions("anything"); f.controller.toggleSessionScope(); f.controller.moveSessionPicker(1);
    expect(picker().error).toBe("Cannot load sessions");
    f.controller.toggleSessionPickerDetails(); expect(picker().details).toBe(true);
    f.controller.backSessionPicker(); expect(picker().details).toBe(false); expect(f.controller.snapshot().sessionPicker).toBeDefined();
    await rm(blocked); await mkdir(blocked);
    expect(await f.controller.loadMoreSessionPicker()).toBe(true);
    expect(picker().error).toBeUndefined();
    expect(picker().discoveryError).toBeUndefined();
    f.controller.backSessionPicker(); expect(f.controller.snapshot().sessionPicker).toBeUndefined();
    f.controller.dispose();
  });
});

/** Render the real view over a fixture controller with a fixed wall clock. */
async function pickerView(f: Awaited<ReturnType<typeof fixture>>, home: string, width: number, height: number) {
  const terminal = await createTestRenderer({ width, height, kittyKeyboard: true });
  const view = createConversationView(terminal.renderer, { controller: f.controller, home, workspaceRoot: home, env: { NO_COLOR: "1" }, secrets: [], quit() {}, wallClock: () => NOW,
    submit: (value, accepted) => dispatchEditorInput(value, f.controller, command => handleSlashCommand(command.name, command.args, f.ctx), accepted) });
  const settle = async () => { await Bun.sleep(5); view.refresh(); await terminal.flush(); view.refresh(); await terminal.flush(); };
  const waitFor = async (ready: () => boolean) => { for (let i = 0; i < 200 && !ready(); i++) await settle(); expect(ready()).toBe(true); await settle(); };
  const editor = terminal.renderer.root.findDescendantById("prompt") as TextareaRenderable;
  return { terminal, view, settle, waitFor, editor, frame: () => terminal.captureCharFrame(), dispose: () => { view.destroy(); terminal.renderer.destroy(); } };
}
const HINT_KEYS = /↑↓|Enter resume|Esc |Ctrl\+W|Ctrl\+L|PgUp|F2 /;
/** Rows that list picker key hints, excluding the status bar; the picker must show exactly one. */
const hintRows = (frame: string) => frame.split("\n").filter(row => HINT_KEYS.test(row) && !row.includes("◆"));

test("picker resume of a missing workspace names the reason, shows details on F2 and never points to /sessions", async () => {
  await withTempDir(async home => {
    const f = await fixture(home);
    const gone = join(home, "gone"); await mkdir(gone);
    const saved = await createJsonlSession({ directory: f.directory, workspace: { root: gone, launchCwd: gone, extraRoots: [] } }); saved.append(user("task in a removed folder"));
    await rm(gone, { recursive: true });
    const ui = await pickerView(f, home, 80, 24);
    try {
      await ui.terminal.mockInput.pasteBracketedText("unsent draft"); await ui.settle();
      const transcript = f.controller.snapshot().transcript.map(entry => entry.text);
      ui.terminal.mockInput.pressKey("s", { meta: true });
      await ui.waitFor(() => !!f.controller.snapshot().sessionPicker && !f.controller.snapshot().sessionPicker!.loading);
      ui.terminal.mockInput.pressKey("w", { ctrl: true }); await ui.settle();
      await ui.terminal.mockInput.pasteBracketedText("removed folder"); await ui.settle();
      ui.terminal.mockInput.pressEnter();
      await ui.waitFor(() => !!f.controller.snapshot().sessionPicker?.error);
      const status = hintRows(ui.frame());
      expect(status).toHaveLength(1);
      expect(status[0]!.trim()).toBe("Workspace unavailable · F2 details · Esc back");
      expect(status[0]!.trim().split(" · ")[0]!.split(" ").length).toBeLessThanOrEqual(6);
      expect(ui.frame()).not.toContain("Saved workspace unavailable");
      ui.terminal.renderer.stdin.emit("data", Buffer.from("\x1bOQ")); await ui.settle();
      expect(f.controller.snapshot().sessionPicker?.details).toBe(true);
      expect(ui.frame()).toContain("Saved workspace unavailable:");
      expect(ui.frame()).toContain("current session remains active");
      for (const text of [ui.frame(), ...f.controller.snapshot().transcript.map(entry => entry.text)]) expect(text).not.toContain("/sessions");
      expect(f.controller.snapshot().transcript.map(entry => entry.text)).toEqual(transcript);
      expect(f.controller.snapshot().sessionId).toBe(f.session.header.id);
      ui.terminal.mockInput.pressEscape(); await ui.settle();
      expect(f.controller.snapshot().sessionPicker?.details).toBe(false);
      ui.terminal.mockInput.pressEscape(); await ui.settle();
      expect(f.controller.snapshot().sessionPicker).toBeUndefined();
      expect(ui.editor.plainText).toBe("unsent draft");
      expect(f.controller.snapshot().transcript.map(entry => entry.text)).toEqual(transcript);
      // A typed resume with no picker open still names its way forward.
      expect(await handleSlashCommand("resume", "missing-session", f.ctx)).toBe(false);
      expect(f.controller.snapshot().transcript.at(-1)?.text).toContain("use /sessions for recoverable history");
    } finally { ui.dispose(); f.controller.dispose(); }
  });
});

test("picker shows one paired hint row with Esc back, keeps Enter resume narrow and drops it while loading, resuming or empty", async () => {
  await withTempDir(async home => {
    const f = await fixture(home);
    for (let i = 0; i < 3; i++) { const s = await createJsonlSession({ directory: f.directory, workspace: f.workspace }); s.append(user(`saved task ${i}`)); }
    const banned = /\^W|\^L|Esc restore|Enter confirm|T\d\d:\d\d:\d\d/;
    for (const [width, height] of [[120, 30], [80, 24], [50, 20], [40, 20]] as const) {
      const ui = await pickerView(f, home, width, height);
      try {
        // Loading: discovery is held open until the frame is checked.
        let open!: () => void;
        const gate = new Promise<void>(resolve => { open = resolve; });
        const real = fileSystem.readdir;
        const readdir = spyOn(fileSystem, "readdir").mockImplementation((async (...args: Parameters<typeof fileSystem.readdir>) => {
          if (args[0] === f.directory) await gate;
          return real(...args);
        }) as never);
        ui.terminal.mockInput.pressKey("s", { meta: true });
        await ui.waitFor(() => !!f.controller.snapshot().sessionPicker?.loading);
        let rows = hintRows(ui.frame());
        expect(rows).toHaveLength(1);
        expect(rows[0]!.trim()).toBe("Loading sessions… · Esc back");
        expect(ui.frame()).not.toContain("No results");
        expect(ui.frame()).not.toMatch(banned);
        open(); readdir.mockRestore();
        await ui.waitFor(() => f.controller.snapshot().sessionPicker?.loading === false);
        // Selected: Enter resume and Esc back at every width, other keys by priority.
        rows = hintRows(ui.frame());
        expect(rows).toHaveLength(1);
        expect(rows[0]).toContain("Enter resume"); expect(rows[0]).toContain("Esc back");
        expect(rows[0]).not.toContain("Ctrl+L");
        if (width >= 80) expect(rows[0]!.trim()).toBe("↑↓ select · Enter resume · Ctrl+W scope · Esc back · 1/4");
        expect(ui.frame()).not.toMatch(banned);
        // Sessions saved after the fixed clock show their date; the empty current session has no committed activity.
        expect(ui.frame()).toMatch(/ saved task \d · \d{4}-\d\d-\d\d\s/);
        if (width >= 80) expect(ui.frame()).toContain("● current · No task preview · activity unknown");
        // The search placeholder fits one row without breaking a word at 40 columns.
        expect(ui.frame()).toMatch(width < 50 ? /› Search sessions… *\n/ : /› Search tasks, workspace or session ID… *\n/);
        // Empty current workspace after a no-match query, then the narrow placeholder.
        await ui.terminal.mockInput.pasteBracketedText("zzz"); await ui.settle();
        rows = hintRows(ui.frame());
        expect(rows).toHaveLength(1);
        expect(rows[0]).toContain("No matching sessions"); expect(rows[0]).toContain("Esc back"); expect(rows[0]).not.toContain("Enter resume");
        expect(ui.frame()).not.toContain("Last activity");
        expect(ui.frame()).not.toContain("Nothing selected");
        expect(ui.frame()).not.toMatch(banned);
        // Resuming: a held resume replaces Enter resume with its own status.
        for (let i = 0; i < 3; i++) ui.terminal.mockInput.pressBackspace();
        await ui.settle();
        let finish!: () => void;
        f.controller.closeSessionPicker();
        await f.controller.openSessionPicker(f.directory, () => new Promise<boolean>(resolve => { finish = () => resolve(false); }));
        void f.controller.selectPickerSession(); await ui.settle();
        rows = hintRows(ui.frame());
        expect(rows).toHaveLength(1);
        expect(rows[0]!.trim()).toBe("Resuming session… · Esc back");
        expect(ui.frame()).not.toMatch(banned);
        finish(); await ui.settle();
        expect(ui.frame()).not.toMatch(banned);
        f.controller.closeSessionPicker(); await ui.settle();
      } finally { ui.dispose(); }
    }
    f.controller.dispose();
  });
});

test("empty scopes name their way forward and Ctrl+L appears only while more sessions can load", async () => {
  await withTempDir(async home => {
    const f = await fixture(home);
    await rm(join(f.directory, `${f.session.header.id}.jsonl`), { force: true });
    const ui = await pickerView(f, home, 120, 30);
    try {
      ui.terminal.mockInput.pressKey("s", { meta: true });
      await ui.waitFor(() => f.controller.snapshot().sessionPicker?.loading === false);
      expect(hintRows(ui.frame()).map(row => row.trim())).toEqual(["No saved sessions here yet · Ctrl+W other workspaces · Esc back"]);
      ui.terminal.mockInput.pressKey("w", { ctrl: true }); await ui.settle();
      expect(hintRows(ui.frame()).map(row => row.trim())).toEqual(["No saved sessions yet · Esc back"]);
      ui.terminal.mockInput.pressEscape(); await ui.settle();
      for (let i = 0; i < 101; i++) { const s = await createJsonlSession({ directory: f.directory, workspace: f.workspace }); s.append(user(`batch ${i}`)); }
      ui.terminal.mockInput.pressKey("s", { meta: true });
      await ui.waitFor(() => f.controller.snapshot().sessionPicker?.loading === false);
      expect(f.controller.snapshot().sessionPicker?.hasMore).toBe(true);
      expect(hintRows(ui.frame())[0]).toContain("Ctrl+L load more");
      ui.terminal.mockInput.pressKey("l", { ctrl: true });
      await ui.waitFor(() => f.controller.snapshot().sessionPicker?.hasMore === false && !f.controller.snapshot().sessionPicker?.loading);
      expect(hintRows(ui.frame())).toHaveLength(1);
      expect(ui.frame()).not.toContain("Ctrl+L");
      expect(ui.frame()).not.toContain("load more");
    } finally { ui.dispose(); f.controller.dispose(); }
  });
});

test("narrow hint fitting keeps the status and Esc back and drops actions by priority", () => {
  const base = { query: "", allWorkspaces: false, entries: [], selectedIndex: 0, offset: 0, total: 0, loading: false, hasMore: false };
  const fit = (picker: Parameters<typeof sessionPickerHint>[0], columns: number) => { const fitted = fitSessionPickerHint(sessionPickerHint(picker), columns); return [fitted.status, fitted.actions].filter(Boolean).join(" · "); };
  expect(fit({ ...base, error: "Cannot load sessions", errorDetails: "Cannot discover sessions: EACCES", errorKind: "discovery" }, 80)).toBe("Cannot load sessions · F2 details · Esc back");
  const failed = { ...base, total: 5, error: "Workspace unavailable", errorDetails: "Saved workspace unavailable", errorKind: "resume" as const };
  expect(fit(failed, 80)).toBe("Workspace unavailable · ↑↓ choose another · F2 details · Esc back");
  expect(fit(failed, 48)).toBe("Workspace unavailable · F2 details · Esc back");
  expect(fit(failed, 38)).toBe("Workspace unavailable · Esc back");
  expect(fit({ ...base, query: "zzz" }, 80)).toBe("No matching sessions · Edit search or Ctrl+W scope · Esc back");
  expect(fit({ ...base, query: "zzz" }, 48)).toBe("No matching sessions · Ctrl+W scope · Esc back");
  expect(fit({ ...base, query: "zzz" }, 38)).toBe("No matching sessions · Esc back");
  expect(fit(base, 56)).toBe("No saved sessions here yet · Ctrl+W scope · Esc back");
  expect(fit(base, 48)).toBe("No saved sessions here yet · Esc back");
  expect(fit(base, 38)).toBe("No saved sessions here yet · Esc back");
  const many = { ...base, total: 20, offset: 8, selectedIndex: 2, hasMore: true };
  expect(fit(many, 120)).toBe("↑↓ select · Enter resume · PgUp/PgDn page · Ctrl+W scope · Ctrl+L load more · Esc back · 11/20");
  expect(fit(many, 48)).toBe("↑↓ select · Enter resume · Esc back");
  expect(fit(many, 30)).toBe("Enter resume · Esc back");
  expect(fitSessionPickerHint(sessionPickerHint(many), 30, true).actions).toBe("↑↓ select · Enter resume");
});

test("a late resume failure is not shown against a row or query that changed while it ran", async () => {
  await withTempDir(async home => {
    const f = await fixture(home);
    for (const task of ["alpha task", "beta task"]) { const s = await createJsonlSession({ directory: f.directory, workspace: f.workspace }); s.append(user(task)); }
    let fail!: () => void;
    const resume = () => new Promise<boolean>((_resolve, reject) => { fail = () => reject(new SessionResumeError("Workspace unavailable", "Saved workspace unavailable: /gone.")); });
    await f.controller.openSessionPicker(f.directory, resume);
    const picker = () => f.controller.snapshot().sessionPicker!;
    // Typing while the resume runs re-filters the list and selects a different row.
    f.controller.searchSessions("alpha");
    const first = picker().entries[0]!.id;
    let pending = f.controller.selectPickerSession();
    await Bun.sleep(1);
    f.controller.searchSessions("beta");
    expect(picker().entries[0]!.id).not.toBe(first);
    fail(); expect(await pending).toBe(false);
    expect(picker()).toMatchObject({ resuming: false, query: "beta" });
    expect(picker().error).toBeUndefined();
    // The same row and query still show the failure when it arrives.
    pending = f.controller.selectPickerSession(); await Bun.sleep(1);
    fail(); expect(await pending).toBe(false);
    expect(picker().error).toBe("Workspace unavailable");
    f.controller.dispose();
  });
});

test("a failed load-more keeps loaded rows usable, names the failure and clears on a successful retry", async () => {
  await withTempDir(async home => {
    const f = await fixture(home);
    for (let i = 0; i < 101; i++) { const s = await createJsonlSession({ directory: f.directory, workspace: f.workspace }); s.append(user(`batch ${i}`)); }
    await f.controller.openSessionPicker(f.directory, async () => { throw new SessionResumeError("Workspace unavailable", "gone"); });
    const picker = () => f.controller.snapshot().sessionPicker!;
    expect(picker().hasMore).toBe(true);
    const failure = spyOn(fileSystem, "readdir").mockImplementation((async () => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); }) as never);
    try { expect(await f.controller.loadMoreSessionPicker()).toBe(false); } finally { failure.mockRestore(); }
    expect(picker()).toMatchObject({ error: "Cannot load more sessions", errorKind: "more", errorDetails: expect.stringContaining("EACCES") });
    const fit = (columns: number) => { const fitted = fitSessionPickerHint(sessionPickerHint(picker()), columns); return [fitted.status, fitted.actions].filter(Boolean).join(" · "); };
    expect(fit(120)).toBe("↑↓ select · Enter resume · PgUp/PgDn page · Ctrl+W scope · Ctrl+L load more · F2 details · Esc back · 1/100");
    expect(fit(38)).toBe("Enter resume · F2 details · Esc back");
    const lines = sessionPanelLines(picker(), { columns: 78, height: 24, visibleRows: 4, home, now: NOW });
    expect(lines.filter(line => line.tone === "error").map(line => line.text)).toEqual(["Cannot load more sessions"]);
    // Rows stay usable: moving works and a resume failure replaces, then returns, the load-more failure.
    f.controller.moveSessionPicker(1); expect(picker().offset + picker().selectedIndex).toBe(1);
    expect(await f.controller.selectPickerSession()).toBe(false);
    expect(picker().error).toBe("Workspace unavailable");
    f.controller.moveSessionPicker(1); expect(picker().error).toBe("Cannot load more sessions");
    expect(await f.controller.loadMoreSessionPicker()).toBe(true);
    expect(picker()).toMatchObject({ total: 102, hasMore: false });
    expect(picker().error).toBeUndefined();
    f.controller.dispose();
  });
});

test("picker resume load failures map to accurate short statuses", async () => {
  await withTempDir(async home => {
    expect(sessionLoadStatus(new SessionLoadError("not-found", "Session not found: x"))).toBe("Session not found");
    expect(sessionLoadStatus(new SessionLoadError("invalid-id", "Invalid session id: .."))).toBe("Invalid session ID");
    expect(sessionLoadStatus(new SessionLoadError("repair-failed", "EROFS"))).toBe("Session repair failed");
    expect(sessionLoadStatus(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }))).toBe("Session file unreadable");
    expect(sessionLoadStatus(new Error("Session file contains malformed interior JSON"))).toBe("Session file damaged or unsupported");
    const f = await fixture(home);
    const statusFor = async (id: string) => {
      try { await handleSlashCommand("resume", id, f.ctx, undefined, undefined, new AbortController().signal); return "resumed"; }
      catch (error) { return (error as SessionResumeError).status; }
    };
    // A file deleted after discovery, a torn tail whose repair write fails, and corrupt contents.
    expect(await statusFor("deleted-after-discovery")).toBe("Session not found");
    const torn = await createJsonlSession({ directory: f.directory, workspace: f.workspace }); torn.append(user("torn task"));
    const path = join(f.directory, `${torn.header.id}.jsonl`);
    await writeFile(path, (await readFile(path, "utf8")) + '{"partial":');
    const write = spyOn(fileSystem, "writeFile").mockImplementation((async () => { throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }); }) as never);
    try { expect(await statusFor(torn.header.id)).toBe("Session repair failed"); } finally { write.mockRestore(); }
    await writeFile(join(f.directory, "corrupt.jsonl"), "not json\n");
    expect(await statusFor("corrupt")).toBe("Session file damaged or unsupported");
    for (const status of ["Session not found", "Invalid session ID", "Session repair failed", "Session file unreadable", "Session file damaged or unsupported"]) expect(status.split(" ").length).toBeLessThanOrEqual(6);
    f.controller.dispose();
  });
});
