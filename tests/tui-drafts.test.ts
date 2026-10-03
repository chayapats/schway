import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createTestRenderer } from "@opentui/core/testing";
import { TextareaRenderable } from "@opentui/core";
import { mkdir, readFile, readdir, writeFile, chmod, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { createJsonlSession, loadJsonlSession, sessionsDirectory } from "../src/session/jsonl.ts";
import { flushDraftOnExit } from "../src/drafts/exit.ts";
import { openDraftStore } from "../src/drafts/store.ts";
import { TuiController } from "../src/tui/controller.ts";
import { createConversationView, type ConversationViewOptions } from "../src/tui/view.ts";
import { createContextManager } from "../src/context/manager.ts";
import { dispatchEditorInput } from "../src/tui/commands.ts";
import { handleSlashCommand } from "../src/tui/app.ts";
import { loadConfigEditor } from "../src/config/editing.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { withTempDir } from "./helpers.ts";
import { openUndoStore } from "../src/undo/store.ts";
import { reapDraftCheckpointWorker } from "./fixtures/draft-exit-worker.ts";

async function setup(home: string, resume?: string, submit?: ConversationViewOptions["submit"], options: {
  beforeView?(controller: TuiController): void;
  motion?: ConversationViewOptions["motion"];
  env?: Record<string, string>;
} = {}) {
  const workspace = { root: home, launchCwd: home, extraRoots: [] };
  const directory = sessionsDirectory(home);
  const session = resume ? await loadJsonlSession({ directory, id: resume }) : await createJsonlSession({ directory, workspace, deferred: true });
  const controller = new TuiController({ home, session, workspace, sessionId: session.header.id, provider: "scripted", modelId: "test", model: createScriptedModel({ text: "accepted" }), contextManager: createContextManager(workspace, { home }), credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ model: createScriptedModel() }) } });
  options.beforeView?.(controller);
  const terminal = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true, exitOnCtrlC: false, exitSignals: [] });
  const config = await loadConfigEditor({ home, workspaceRoot: home });
  const ctx = { controller, home, workspaceRoot: home, skillScope: { workspaceRoot: home }, sessionsDir: directory, settings: () => config.settings, env: {}, secrets: [], finishQuit() {}, stderr: { write() {} } };
  let submission: Promise<unknown> | undefined;
  const view = createConversationView(terminal.renderer, { controller, home, workspaceRoot: home, env: options.env ?? {}, motion: options.motion, secrets: ["credential-sentinel"], draftPersistence: true, quit() {}, submit: (value, accepted) => submission = submit ? submit(value, accepted) : dispatchEditorInput(value, controller, command => handleSlashCommand(command.name, command.args, ctx), accepted) });
  const editor = terminal.renderer.root.findDescendantById("prompt") as TextareaRenderable;
  const saved = () => openDraftStore({ home, workspaceRoot: home, sessionId: session.header.id }).checkpoint?.text;
  const close = () => { view.destroy(); controller.dispose(); terminal.renderer.destroy(); };
  return { ...terminal, controller, session, view, editor, saved, close, ctx, submitted: () => submission };
}
async function idle(ui: Awaited<ReturnType<typeof setup>>) { await Bun.sleep(550); ui.view.refresh(); await ui.renderOnce(); }
async function artifacts(home: string) {
  const directory = join(home, ".schway/drafts");
  let names: string[]; try { names = await readdir(directory); } catch { return ""; }
  return (await Promise.all(names.map(name => readFile(join(directory, name), "utf8")))).join("\n");
}

test("renderer checkpoints a deferred multiline draft, offers recent recovery, discards and clears accepted input", async () => withTempDir(async home => {
  const first = await setup(home);
  expect(await readdir(sessionsDirectory(home))).toEqual([]);
  await first.mockInput.pasteBracketedText("ภาษาไทย line one\nline two"); await idle(first);
  expect(first.saved()).toBe("ภาษาไทย line one\nline two");
  const id = first.session.header.id; first.close();
  const fresh = await setup(home);
  await fresh.controller.offerRecentSession(sessionsDirectory(home)); fresh.view.refresh();
  expect(fresh.editor.plainText).toBe("");
  expect(fresh.controller.snapshot().recentSession?.id).toBe(id);
  expect(fresh.controller.snapshot().recentSession?.title).toBe("Unsent draft"); fresh.close();
  const reopened = await setup(home, id);
  expect(reopened.editor.plainText).toBe("ภาษาไทย line one\nline two");
  reopened.resize(44, 18); await reopened.renderOnce();
  expect(reopened.captureCharFrame()).toContain("Draft restored · Alt+D discard");
  reopened.mockInput.pressKey("d", { meta: true }); reopened.view.refresh();
  expect(reopened.editor.plainText).toBe(""); expect(reopened.saved()).toBeUndefined();
  await reopened.mockInput.pasteBracketedText("accepted task"); await idle(reopened);
  reopened.mockInput.pressEnter(); await reopened.submitted();
  expect(reopened.saved()).toBeUndefined(); expect(await artifacts(home)).not.toContain("accepted task");
  reopened.close();
}));

test("late accepted handoff cannot clear a newer completed checkpoint", async () => withTempDir(async home => {
  let accept: (() => void) | undefined;
  let resolve!: () => void;
  const gate = new Promise<void>(done => { resolve = done; });
  const ui = await setup(home, undefined, async (_value, accepted) => { accept = accepted; await gate; });
  try {
    await ui.mockInput.pasteBracketedText("old submission"); await idle(ui);
    ui.mockInput.pressEnter(); expect(accept).toBeDefined();
    ui.editor.setText("newer completed draft"); ui.view.refresh(); await idle(ui);
    expect(ui.saved()).toBe("newer completed draft");
    accept!(); resolve(); await ui.submitted();
    expect(ui.saved()).toBe("newer completed draft");
    expect(ui.editor.plainText).toBe("newer completed draft");
  } finally { resolve(); ui.close(); }
}));

test("draft status stops claiming a saved revision as soon as newer ordinary text arrives", async () => withTempDir(async home => {
  const ui = await setup(home);
  try {
    ui.editor.setText("previous completed ไทย draft");
    expect(ui.view.flushDraft()).toEqual({ saved: true, failed: false });
    ui.view.refresh(); await ui.renderOnce();
    ui.editor.setText("newer unsaved ไทย 🧪 draft"); ui.editor.cursorOffset = 4;
    ui.view.refresh(); await ui.renderOnce();
    expect(ui.captureCharFrame()).not.toMatch(/Draft (?:checkpoint )?saved|Draft restored/);
    expect(ui.saved()).toBe("previous completed ไทย draft");
    expect(ui.editor.cursorOffset).toBe(4);
    expect(ui.view.flushDraft()).toEqual({ saved: true, failed: false });
    expect(ui.saved()).toBe("newer unsaved ไทย 🧪 draft");
  } finally { ui.close(); }
}));

for (const newer of [false, true]) test(`failed draft cleanup retains ${newer ? "newer unsaved text and its exit task" : "confirmation of unchanged saved text"}`, async () => withTempDir(async home => {
  const ui = await setup(home);
  try {
    ui.editor.setText("previous completed ไทย draft"); ui.view.flushDraft();
    const store = openDraftStore({ home, workspaceRoot: home, sessionId: ui.session.header.id });
    if (newer) { ui.editor.setText("newer unsaved ไทย draft"); ui.view.refresh(); }
    ui.editor.cursorOffset = 3;
    await writeFile(`${store.path}.lock`, "uncertain writer", { mode: 0o600 });
    ui.mockInput.pressKey("d", { meta: true }); ui.view.refresh(); await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("Draft cleanup failed · Alt+D retry");
    expect(ui.editor.plainText).toBe(newer ? "newer unsaved ไทย draft" : "previous completed ไทย draft");
    expect(ui.editor.cursorOffset).toBe(3);
    expect(ui.saved()).toBe("previous completed ไทย draft");
    const frozen = ui.view.freezeDraftForExit();
    expect(frozen.saved).toBe(!newer);
    if (newer) expect(frozen.task).toMatchObject({ text: "newer unsaved ไทย draft", sessionId: ui.session.header.id });
    else expect(frozen).toEqual({ saved: true, failed: true });
  } finally { ui.close(); }
}));

test("recovered draft waits for an owning panel to restore the actual composer without clearing saved bytes", async () => withTempDir(async home => {
  const workspace = { root: home, launchCwd: home, extraRoots: [] };
  const session = await createJsonlSession({ directory: sessionsDirectory(home), workspace });
  const text = "ร่างที่กู้คืน 🧪\nยังไม่ส่ง";
  const store = openDraftStore({ home, workspaceRoot: home, sessionId: session.header.id }); store.save(text, 1);
  const before = await readFile(store.path);
  const ui = await setup(home, session.header.id, undefined, { beforeView: controller => controller.openCommandHelp() });
  try {
    await ui.renderOnce(); const panel = ui.captureCharFrame();
    ui.view.flushDraft();
    ui.mockInput.pressEscape(); ui.view.refresh(); await ui.renderOnce();
    expect(await readFile(store.path)).toEqual(before);
    expect(ui.editor.plainText).toBe(text);
    expect(panel).not.toMatch(/Recovered draft|Draft restored/);
    expect(ui.captureCharFrame()).toContain("Draft restored · Alt+D discard");
  } finally { ui.close(); }
}));

test("empty edits, explicit discard and accepted input remove saved status", async () => withTempDir(async home => {
  const ui = await setup(home);
  try {
    for (const action of ["empty", "discard", "accept"]) {
      ui.editor.setText(`Saved ไทย ${action}`); ui.view.flushDraft(); ui.view.refresh(); await ui.renderOnce();
      expect(ui.captureCharFrame()).toContain("Draft saved · Alt+D discard");
      if (action === "empty") { ui.editor.setText(""); ui.view.refresh(); }
      else if (action === "discard") ui.mockInput.pressKey("d", { meta: true });
      else { ui.mockInput.pressEnter(); await ui.submitted(); }
      ui.view.refresh(); await ui.renderOnce();
      expect(ui.editor.plainText).toBe("");
      expect(ui.captureCharFrame()).not.toMatch(/Draft saved|Draft restored/);
      expect(ui.view.flushDraft()).toEqual({ saved: false, failed: false });
      expect(ui.saved()).toBeUndefined();
    }
  } finally { ui.close(); }
}));

for (const state of ["saved", "restored", "failed"] as const) {
  for (const motion of ["full", "reduced", "off"] as const) {
    test(`draft ${state} keeps its status and usable action with ${motion} motion at safety widths`, async () => withTempDir(async home => {
      const text = "ร่างภาษาไทย 🧪\nยังไม่ส่ง";
      let resume: string | undefined;
      if (state === "restored") {
        const session = await createJsonlSession({ directory: sessionsDirectory(home), workspace: { root: home, launchCwd: home, extraRoots: [] } });
        resume = session.header.id;
        openDraftStore({ home, workspaceRoot: home, sessionId: resume }).save(text, 1);
      }
      const ui = await setup(home, resume, undefined, { motion, env: motion === "off" ? { NO_COLOR: "1" } : { SCHWAY_THEME: motion === "reduced" ? "light" : "dark" } });
      try {
        if (state !== "restored") {
          if (state === "failed") {
            ui.editor.setText("Previously saved"); ui.view.flushDraft();
            const store = openDraftStore({ home, workspaceRoot: home, sessionId: ui.session.header.id });
            await writeFile(`${store.path}.lock`, "uncertain writer", { mode: 0o600 });
          }
          ui.editor.setText(text); ui.view.flushDraft();
        }
        ui.editor.cursorOffset = 3;
        for (const width of [24, 29, 30, 40, 50, 80, 120]) {
          ui.resize(width, 8); ui.view.refresh(); await ui.renderOnce();
          const frame = ui.captureCharFrame();
          expect(frame).toContain(state === "failed" ? "Draft not saved" : `Draft ${state}`);
          expect(frame).toContain(state === "failed" ? width === 24 ? "Select, Ctrl+C copy" : "Select text, Ctrl+C copy" : "Alt+D discard");
          if (state === "failed") expect(frame).toContain("Ctrl+C");
          expect(frame).toContain("Auto"); expect(frame).toContain("Enter send");
          expect(ui.editor.plainText).toBe(text); expect(ui.editor.cursorOffset).toBe(3);
          const status = ui.renderer.root.findDescendantById("draft-status")!;
          expect(status.y).toBeGreaterThanOrEqual(ui.editor.y + ui.editor.height);
          expect(status.y + status.height).toBeLessThanOrEqual(8);
        }
      } finally { ui.close(); }
    }));
  }
}

test("a failed empty edit offers cleanup retry and retains the prior saved bytes until confirmation", async () => withTempDir(async home => {
  const ui = await setup(home);
  try {
    ui.editor.setText("Previously saved ไทย"); ui.view.flushDraft();
    const store = openDraftStore({ home, workspaceRoot: home, sessionId: ui.session.header.id });
    await writeFile(`${store.path}.lock`, "uncertain writer", { mode: 0o600 });
    ui.editor.setText(""); expect(ui.view.flushDraft()).toEqual({ saved: false, failed: true });
    ui.resize(24, 8); ui.view.refresh(); await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("Draft cleanup failed");
    expect(ui.captureCharFrame()).toContain("Alt+D retry");
    expect(ui.saved()).toBe("Previously saved ไทย"); expect(ui.editor.plainText).toBe("");
    await unlink(`${store.path}.lock`); ui.mockInput.pressKey("d", { meta: true }); ui.view.refresh(); await ui.renderOnce();
    expect(ui.saved()).toBeUndefined(); expect(ui.captureCharFrame()).not.toMatch(/Draft saved|Draft restored|Draft cleanup failed/);
    expect(ui.view.freezeDraftForExit()).toEqual({ saved: false, failed: false });
  } finally { ui.close(); }
}));

test("an empty exit retains the cleanup task when a previous saved draft remains", async () => withTempDir(async home => {
  const ui = await setup(home);
  try {
    ui.editor.setText("Previously saved ไทย"); ui.view.flushDraft();
    const store = openDraftStore({ home, workspaceRoot: home, sessionId: ui.session.header.id });
    await writeFile(`${store.path}.lock`, "uncertain writer", { mode: 0o600 });
    ui.editor.setText(""); expect(ui.view.flushDraft()).toEqual({ saved: false, failed: true });
    expect(ui.view.freezeDraftForExit()).toMatchObject({
      saved: false, failed: false, task: { text: "", sessionId: ui.session.header.id },
    });
    expect(ui.saved()).toBe("Previously saved ไทย");
  } finally { ui.close(); }
}));

for (const draft of [
  { text: "", cursor: 0, exitFailed: false },
  { text: "ยังไม่ได้บันทึก 🧪", cursor: 3, exitFailed: true },
]) test(`unavailable draft storage ${draft.text ? "retains ordinary input and reports exit failure" : "does not report an empty exit as a failed save"}`, async () => withTempDir(async home => {
  await mkdir(join(home, ".schway"), { recursive: true });
  await writeFile(join(home, ".schway/drafts"), "not a directory", { mode: 0o600 });
  const ui = await setup(home);
  try {
    ui.editor.setText(draft.text); ui.editor.cursorOffset = draft.cursor;
    expect(ui.view.flushDraft()).toEqual({ saved: false, failed: true });
    ui.mockInput.pressKey("d", { meta: true }); ui.view.refresh(); await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("Draft recovery unavailable · Enter start a task");
    expect(ui.editor.plainText).toBe(draft.text); expect(ui.editor.cursorOffset).toBe(draft.cursor);
    expect(ui.view.freezeDraftForExit()).toEqual({ saved: false, failed: draft.exitFailed });
    expect(await readFile(join(home, ".schway/drafts"), "utf8")).toBe("not a directory");
  } finally { ui.close(); }
}));

test("credential surfaces suppress ordinary pending text, masked keys and callback commands across every draft artifact", async () => withTempDir(async home => {
  const ui = await setup(home);
  try {
    await ui.mockInput.pasteBracketedText("pending ordinary text");
    await ui.controller.login("openai"); ui.view.refresh();
    await ui.mockInput.pasteBracketedText("credential-sentinel");
    ui.editor.setText("ordinary while credential UI open"); await idle(ui);
    ui.view.flushDraft();
    expect(await artifacts(home)).toBe("");
    ui.controller.cancel(); ui.view.refresh();
    await ui.controller.login(""); ui.view.refresh();
    ui.mockInput.pressTab();
    while (ui.controller.snapshot().loginChooser!.selectedId !== "chatgpt-callback") ui.mockInput.pressArrow("down");
    ui.mockInput.pressEnter();
    await ui.mockInput.pasteBracketedText("callback-masked-sentinel"); await idle(ui);
    expect(ui.controller.snapshot().loginCallbackEntry).toBeDefined();
    expect(await artifacts(home)).not.toContain("sentinel");
    ui.controller.cancel(); ui.view.refresh();
    ui.controller.cancel(); ui.view.refresh();
    ui.controller.cancel(); ui.view.refresh();
    ui.editor.setText("/login codex --code http://localhost/auth/callback?code=callback-sentinel&state=nonce"); await idle(ui);
    ui.view.flushDraft();
    expect(await artifacts(home)).not.toContain("sentinel");
    expect(await artifacts(home)).not.toContain("ordinary while");
  } finally { ui.close(); }
}));

test("renderer switches between workspaces without crossing pending checkpoints", async () => withTempDir(async home => {
  const ui = await setup(home);
  const secondRoot = join(home, "second-workspace"); await mkdir(secondRoot);
  const workspace = { root: secondRoot, launchCwd: secondRoot, extraRoots: [] };
  const second = await createJsonlSession({ directory: sessionsDirectory(home), workspace, deferred: true });
  try {
    await ui.mockInput.pasteBracketedText("first pending draft");
    expect(await ui.controller.switchSession(second, second.header.id, { workspace, contextManager: createContextManager(workspace, { home }) })).toBe(true);
    ui.view.refresh(); expect(ui.editor.plainText).toBe("");
    await ui.mockInput.pasteBracketedText("second pending draft"); await idle(ui);
    expect(ui.saved()).toBe("first pending draft");
    expect(openDraftStore({ home, workspaceRoot: secondRoot, sessionId: second.header.id }).checkpoint?.text).toBe("second pending draft");
    const firstWorkspace = { root: home, launchCwd: home, extraRoots: [] };
    expect(await ui.controller.switchSession(ui.session, ui.session.header.id, { workspace: firstWorkspace, contextManager: createContextManager(firstWorkspace, { home }) })).toBe(true);
    ui.view.refresh(); expect(ui.editor.plainText).toBe("first pending draft");
    ui.resize(44, 18); await ui.renderOnce(); expect(ui.editor.plainText).toBe("first pending draft");
  } finally { ui.close(); }
}));

test("conflicting checkpoint and explicit deletion operate through renderer and dispatcher without false saved state", async () => withTempDir(async home => {
  const ui = await setup(home);
  try {
    await ui.mockInput.pasteBracketedText("previous completed"); await idle(ui);
    const store = openDraftStore({ home, workspaceRoot: home, sessionId: ui.session.header.id });
    await writeFile(`${store.path}.lock`, "uncertain writer", { mode: 0o600 });
    ui.editor.setText("memory retained on failure"); await idle(ui);
    expect(ui.captureCharFrame()).toContain("Draft not saved"); expect(ui.saved()).toBe("previous completed");
    expect(ui.editor.plainText).toBe("memory retained on failure");
    expect(ui.view.flushDraft()).toEqual({ saved: false, failed: true });
    const frozen = ui.view.freezeDraftForExit();
    expect(frozen.saved).toBe(false);
    expect(frozen.task?.text).toBe("memory retained on failure");
  } finally { ui.close(); }
}));

test("explicit session deletion removes draft content and stale handles cannot resurrect it", async () => withTempDir(async home => {
  const ui = await setup(home);
  const id = ui.session.header.id;
  await ui.mockInput.pasteBracketedText("delete this private draft"); await idle(ui);
  const stale = openDraftStore({ home, workspaceRoot: home, sessionId: id });
  expect(await handleSlashCommand("delete-session", id, ui.ctx)).toBe(false);
  expect(await handleSlashCommand("new", "", ui.ctx)).toBe(true); ui.view.refresh();
  const undo = join(home, ".schway/undo", id);
  const other = join(home, ".schway/undo/other");
  await mkdir(undo, { recursive: true }); await mkdir(other, { recursive: true });
  await writeFile(join(undo, "retained"), "bytes"); await writeFile(join(other, "retained"), "other bytes");
  expect(await handleSlashCommand("delete-session", id, ui.ctx)).toBe(true);
  await expect(readdir(undo)).rejects.toThrow();
  expect(await readFile(join(other, "retained"), "utf8")).toBe("other bytes");
  expect(await artifacts(home)).not.toContain("delete this private draft");
  expect(await readdir(sessionsDirectory(home))).not.toContain(`${id}.jsonl`);
  expect(() => stale.save("resurrection", 1)).toThrow();
  ui.close();
}));

async function runProcess(home: string, mode: string, resume?: string) {
  const blockedExit = mode === "blocked-exit" || mode === "blocked-exit-cleanup";
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/draft-process.ts"), home, mode, ...(resume ? [resume] : [])], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  const stderr = new Response(child.stderr).text();
  const decoder = new TextDecoder();
  let buffer = "";
  const bounded = async <T>(promise: Promise<T>, timeout: number, message: string): Promise<T> => {
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { watchdog = setTimeout(() => reject(Error(message)), timeout); })]); }
    finally { clearTimeout(watchdog); }
  };
  const next = (timeoutMs = 6000): Promise<Record<string, any>> => bounded((async () => {
    while (!buffer.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw Error(`fixture ended: ${await stderr}`);
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1); return JSON.parse(line);
  })(), timeoutMs, "fixture output timed out");
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill(blockedExit ? "SIGTERM" : "SIGKILL");
      try { await bounded(child.exited, 2500, "fixture shutdown timed out"); }
      catch (error) {
        // If graceful fixture cleanup fails, the parent still owns its recorded worker and process.
        if (blockedExit) {
          const owner = await readFile(join(home, "exit-worker-pid"), "utf8").then(text => { try { return JSON.parse(text); } catch { return undefined; } }, () => undefined);
          if (owner?.parent === child.pid && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, "SIGKILL"); } catch { /* Already gone. */ }
          }
        }
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await bounded(child.exited, 1500, "fixture could not be reaped");
        throw error;
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); await stderr; }
  })();
  return { child, next, stop };
}

for (const timesOut of [false, true]) test(`checkpoint fixture reap ${timesOut ? "timeout kills its worker" : "waits for real exit"} and clears its watchdog`, async () => {
  const worker = Bun.spawn([process.execPath, "--eval", timesOut ? "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)" : "process.exit(7)"], { stdout: "ignore", stderr: "ignore" });
  worker.unref();
  const setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout;
  const active = new Set<ReturnType<typeof setTimeout>>();
  const setSpy = spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimer>) => { const timer = Reflect.apply(setTimer, globalThis, args); active.add(timer); return timer; }) as typeof setTimer);
  const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(timer => { active.delete(timer as ReturnType<typeof setTimeout>); Reflect.apply(clearTimer, globalThis, [timer]); });
  try {
    if (timesOut) {
      await expect(reapDraftCheckpointWorker(worker, 20)).rejects.toThrow("did not reap before its deadline");
      expect(await reapDraftCheckpointWorker(worker)).toBe(137);
    } else expect(await reapDraftCheckpointWorker(worker)).toBe(7);
    expect(active.size).toBe(0);
    expect(timesOut ? worker.signalCode : worker.exitCode).toBe(timesOut ? "SIGKILL" : 7);
  } finally {
    setSpy.mockRestore(); clearSpy.mockRestore();
    if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
    await reapDraftCheckpointWorker(worker);
  }
});

test("fixture output timeout cancels its pending read and reaps the fixture", async () => withTempDir(async home => {
  const silent = await runProcess(home, "silent-fixture");
  try { await expect(silent.next(50)).rejects.toThrow("fixture output timed out"); }
  finally { await silent.stop(); }
  expect(await silent.child.exited).toBe(137);
  expect(silent.child.signalCode).toBe("SIGKILL");
  await silent.stop(); // Cleanup remains safe if both an assertion and its caller request it.
}));

test("fixture assertion cleanup stops and reaps an observed checkpoint worker before app output", async () => withTempDir(async home => {
  const session = await createJsonlSession({ directory: sessionsDirectory(home), workspace: { root: home, launchCwd: home, extraRoots: [] } });
  openDraftStore({ home, workspaceRoot: home, sessionId: session.header.id }).save("previous completed checkpoint", 1);
  const blocked = await runProcess(home, "blocked-exit-cleanup", session.header.id);
  const failure = new Error("simulated fixture assertion failure");
  let pid = 0;
  const earlyAssertion = async () => {
    try {
      pid = (await blocked.next()).checkpointWorkerSpawned;
      expect(pid).toBeGreaterThan(0);
      throw failure;
    } finally { await blocked.stop(); }
  };
  await expect(earlyAssertion()).rejects.toBe(failure);
  expect(await blocked.child.exited).toBe(0);
  expect(() => process.kill(pid, 0)).toThrow();
  expect(await Bun.file(join(home, "exit-worker-pid")).exists()).toBe(false);
  expect(openDraftStore({ home, workspaceRoot: home, sessionId: session.header.id }).checkpoint?.text).toBe("previous completed checkpoint");
  expect((await readdir(join(home, ".schway/drafts"))).filter(name => !name.endsWith(".json"))).toEqual([]);
}), 12_000);

test("actual app survives killed checkpoint process and reopens same session without submitting", async () => withTempDir(async home => {
  const first = await runProcess(home, "checkpoint");
  let id: string;
  try { id = (await first.next()).checkpoint; expect(id!).toBeString(); } finally { await first.stop(); }
  const resumed = await runProcess(home, "reopen", id!);
  try {
    const recovery = await resumed.next(); expect(recovery.recovered).toBe("unfinished Thai ภาษาไทย\nsecond line"); expect(recovery.frame).toContain("Draft restored");
    const exit = await resumed.next(); expect(exit.stopped).toBe(true); expect(exit.destroyed).toBe(true); expect(exit.stderr).toContain(`schway --resume ${id!}`);
  } finally { await resumed.stop(); }
}));

test("ordinary app exit flushes pending text and restores terminal; disk failure stays truthful", async () => withTempDir(async home => {
  const exit = await runProcess(home, "exit");
  try { const result = await exit.next(); expect(result.code).toBe(0); expect(result.stopped && result.destroyed).toBe(true); expect(result.stderr).toContain("Draft saved.\n"); expect(result.stderr).not.toContain("checkpoint"); expect(await artifacts(home)).toContain("unfinished Thai"); } finally { await exit.stop(); }
  for (const mode of ["failure", "permission"]) {
    const isolated = join(home, mode); await mkdir(isolated);
    const previous = await createJsonlSession({ directory: sessionsDirectory(isolated), workspace: { root: isolated, launchCwd: isolated, extraRoots: [] } });
    openDraftStore({ home: isolated, workspaceRoot: isolated, sessionId: previous.header.id }).save("previous valid checkpoint", 1);
    const failure = await runProcess(isolated, mode, previous.header.id);
    try {
      const ui = await failure.next(); expect(ui.retained).toContain("unfinished Thai"); expect(ui.frame).toContain("Draft not saved");
      const result = await failure.next(); expect(result.stderr).toContain("Draft saving failed; your latest text may not be saved.\n"); expect(result.stderr).not.toContain("Draft saved."); expect(result.stderr).not.toContain("checkpoint"); expect(result.destroyed).toBe(true);
      expect(await artifacts(isolated)).not.toContain("unfinished Thai");
      expect(openDraftStore({ home: isolated, workspaceRoot: isolated, sessionId: previous.header.id }).checkpoint?.text).toBe("previous valid checkpoint");
    } finally { await failure.stop(); }
  }
}), 20_000);

test("silent tool shutdown requests cancellation, restores terminal promptly and restart reports interruption without undo claims", async () => withTempDir(async home => {
  const tool = await runProcess(home, "tool");
  try {
    expect((await tool.next()).toolStarted).toBe(true);
    expect((await tool.next()).cancellationRequested).toBe(true);
    const exit = await tool.next(); expect(exit.destroyed && exit.stopped).toBe(true); expect(exit.stderr).toContain("completion was not confirmed");
    expect(await readFile(join(home, "tool-effect"), "utf8")).toBe("effect survives cancellation");
  } finally { await tool.stop(); }
  const id = (await readdir(sessionsDirectory(home))).find(name => name.endsWith(".jsonl"))!.slice(0, -6);
  const reopened = await runProcess(home, "reopen", id);
  try { const result = await reopened.next(); expect(result.frame.toLowerCase()).toContain("interrupted"); await reopened.next(); } finally { await reopened.stop(); }
}));


test("app exit kills a blocked checkpoint within its deadline and still restores the terminal", async () => withTempDir(async home => {
  const session = await createJsonlSession({ directory: sessionsDirectory(home), workspace: { root: home, launchCwd: home, extraRoots: [] } });
  const store = openDraftStore({ home, workspaceRoot: home, sessionId: session.header.id });
  store.save("previous completed checkpoint", 1);
  const started = Date.now();
  const blocked = await runProcess(home, "blocked-exit", session.header.id);
  try {
    const result = await blocked.next();
    expect(Date.now() - started).toBeLessThan(2500);
    expect(result.code).toBe(0);
    expect(result.stopped && result.destroyed).toBe(true);
    expect(result.stderr).toContain("Draft saving timed out; your latest text may not be saved.\n");
    expect(await readFile(join(home, "exit-worker-state"), "utf8")).toBe("blocked");
    expect(result.stderr).not.toContain("Draft saved.");
    expect(result.stderr).not.toContain("checkpoint");
    const reaped = await blocked.next();
    expect(reaped).toMatchObject({ checkpointWorkerReaped: true, exitCode: 137 });
    expect(reaped.pid).toBeNumber();
    expect(await blocked.child.exited).toBe(0);
    const directory = join(home, ".schway/drafts");
    const stale = (await readdir(directory)).filter(name => !name.endsWith(".json"));
    expect(stale).toHaveLength(2);
    expect(stale).toContain(`${basename(store.path)}.lock`);
    expect(stale.find(name => name.endsWith(".tmp"))).toStartWith(`${basename(store.path)}.`);
    expect(openDraftStore({ home, workspaceRoot: home, sessionId: session.header.id }).checkpoint?.text).toBe("previous completed checkpoint");
    expect((await readdir(directory)).filter(name => !name.endsWith(".json"))).toEqual([]);
  } finally { await blocked.stop(); }
}), 12_000);


test("frozen renderer exit snapshot refuses a competing writer's newer generation", async () => withTempDir(async home => {
  const ui = await setup(home);
  try {
    await ui.mockInput.pasteBracketedText("first checkpoint"); await idle(ui);
    ui.editor.setText("pending exit text");
    const frozen = ui.view.freezeDraftForExit(); expect(frozen.task).toBeDefined();
    const competing = openDraftStore({ home, workspaceRoot: home, sessionId: ui.session.header.id });
    competing.save("other process newer checkpoint", 1);
    expect(await flushDraftOnExit(frozen.task!)).toMatchObject({ failed: true, saved: false });
    expect(ui.saved()).toBe("other process newer checkpoint");
  } finally { ui.close(); }
}));


test("unexpected exit writer rejection still restores terminal and never reports saved", async () => withTempDir(async home => {
  const child = await runProcess(home, "flush-rejection");
  try {
    const result = await child.next();
    expect(result.stopped && result.destroyed).toBe(true);
    expect(result.stderr).toBe("Draft saving failed; your latest text may not be saved.\n");
    expect(await child.child.exited).toBe(0);
  } finally { await child.stop(); }
}));


test("cancelling a stalled splash-state read returns without opening the terminal", async () => withTempDir(async home => {
  const child = await runProcess(home, "splash-read-abort");
  try {
    const result = await child.next();
    expect(result).toMatchObject({ code: 0, stopped: false, destroyed: false, splashReads: 1, stderr: "" });
    expect(await child.child.exited).toBe(0);
    expect(await Bun.file(join(home, ".schway/ui-state.json")).exists()).toBe(false);
  } finally { await child.stop(); }
}));


test.skipIf(process.platform === "win32")("failed undo directory removal keeps the session file and reports deletion failure", async () => withTempDir(async home => {
  const ui = await setup(home); const id = ui.session.header.id;
  const blocked = join(home, ".schway", "undo", id, "blobs");
  ui.session.append({ type: "user", id: "accepted", content: [{ type: "text", text: "Saved turn" }] });
  try {
    expect(await handleSlashCommand("new", "", ui.ctx)).toBe(true);
    await mkdir(blocked, { recursive: true }); await writeFile(join(blocked, "data"), "retained"); await chmod(blocked, 0o500);
    expect(await handleSlashCommand("delete-session", id, ui.ctx)).toBe(false);
    expect(await Bun.file(join(sessionsDirectory(home), `${id}.jsonl`)).exists()).toBe(true);
    expect(ui.controller.snapshot().transcript.at(-1)?.text).toStartWith("Cannot delete session:");
  } finally { await chmod(blocked, 0o700); ui.close(); }
}));

test("busy session deletion shows the required reason and retry command while retaining details", async () => withTempDir(async home => {
  const ui = await setup(home), id = ui.session.header.id;
  ui.session.append({ type: "user", id: "accepted", content: [{ type: "text", text: "Saved turn" }] });
  await openUndoStore({ home }).recordShell({ sessionId: id, turnId: "accepted", turnNumber: 1 }, { detection: "unavailable" });
  const lock = new Database(join(home, ".schway", "undo.lock"));
  lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  try {
    expect(await handleSlashCommand("new", "", ui.ctx)).toBe(true);
    ui.view.refresh(); await ui.renderOnce();
    await ui.mockInput.pasteBracketedText(`/delete-session ${id}`); ui.mockInput.pressEnter(); await ui.submitted();
    ui.view.refresh(); await ui.renderOnce();
    expect(ui.controller.snapshot().transcript.at(-1)?.text).toBe("Cannot delete session: Undo store busy · /delete-session retry · Ctrl+I details");
    expect(ui.captureCharFrame()).toContain("/delete-session retry");
    expect(ui.captureCharFrame()).toMatch(/Ctrl\+I\s+(?:▌\s*)?details/);
    expect(ui.captureCharFrame()).toContain("Cannot delete session: Undo store busy");
    expect(ui.captureCharFrame()).not.toContain("UNDO_STORE_BUSY");
    expect(await Bun.file(join(sessionsDirectory(home), `${id}.jsonl`)).exists()).toBe(true);
    ui.mockInput.pressKey("i", { ctrl: true }); ui.view.refresh(); await ui.renderOnce();
    expect(ui.controller.snapshot().transcript.at(-1)?.text).toBe("Details · Esc keep editing\nUndo store busy");
  } finally { lock.close(); ui.close(); }
}));
