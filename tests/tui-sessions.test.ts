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
import { handleSlashCommand } from "../src/tui/app.ts";
import { dispatchEditorInput } from "../src/tui/commands.ts";
import { createConversationView } from "../src/tui/view.ts";
import { resolveWorkspace } from "../src/workspace/workspace.ts";
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
      expect(terminal.captureCharFrame()).toContain(`Last activity: ${expected}`);
      for (const [width, height] of [[44, 18], [24, 8]]) {
        terminal.resize(width!, height!); view.refresh(); await terminal.flush();
        expect(terminal.captureCharFrame()).toContain(expected.slice(0, 16).replace("T", " "));
        expect(terminal.captureCharFrame()).toContain("Enter Esc");
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
