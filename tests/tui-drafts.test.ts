import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { TextareaRenderable } from "@opentui/core";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

async function setup(home: string, resume?: string, submit?: ConversationViewOptions["submit"]) {
  const workspace = { root: home, launchCwd: home, extraRoots: [] };
  const directory = sessionsDirectory(home);
  const session = resume ? await loadJsonlSession({ directory, id: resume }) : await createJsonlSession({ directory, workspace, deferred: true });
  const controller = new TuiController({ home, session, workspace, sessionId: session.header.id, provider: "scripted", modelId: "test", model: createScriptedModel({ text: "accepted" }), contextManager: createContextManager(workspace, { home }), credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ model: createScriptedModel() }) } });
  const terminal = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true, exitOnCtrlC: false, exitSignals: [] });
  const config = await loadConfigEditor({ home, workspaceRoot: home });
  const ctx = { controller, home, workspaceRoot: home, skillScope: { workspaceRoot: home }, sessionsDir: directory, settings: () => config.settings, env: {}, secrets: [], finishQuit() {}, stderr: { write() {} } };
  let submission: Promise<unknown> | undefined;
  const view = createConversationView(terminal.renderer, { controller, home, workspaceRoot: home, env: {}, secrets: ["credential-sentinel"], draftPersistence: true, quit() {}, submit: (value, accepted) => submission = submit ? submit(value, accepted) : dispatchEditorInput(value, controller, command => handleSlashCommand(command.name, command.args, ctx), accepted) });
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
  expect(reopened.captureCharFrame()).toContain("Recovered draft · Alt+D discard");
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
  } finally { ui.close(); }
}));

test("explicit session deletion removes draft content and stale handles cannot resurrect it", async () => withTempDir(async home => {
  const ui = await setup(home);
  const id = ui.session.header.id;
  await ui.mockInput.pasteBracketedText("delete this private draft"); await idle(ui);
  const stale = openDraftStore({ home, workspaceRoot: home, sessionId: id });
  expect(await handleSlashCommand("delete-session", id, ui.ctx)).toBe(false);
  expect(await handleSlashCommand("new", "", ui.ctx)).toBe(true); ui.view.refresh();
  expect(await handleSlashCommand("delete-session", id, ui.ctx)).toBe(true);
  expect(await artifacts(home)).not.toContain("delete this private draft");
  expect(await readdir(sessionsDirectory(home))).not.toContain(`${id}.jsonl`);
  expect(() => stale.save("resurrection", 1)).toThrow();
  ui.close();
}));

async function runProcess(home: string, mode: string, resume?: string) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/draft-process.ts"), home, mode, ...(resume ? [resume] : [])], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  let buffer = "";
  const next = async (): Promise<Record<string, any>> => {
    const until = Date.now() + 6000;
    while (!buffer.includes("\n")) {
      if (Date.now() > until) throw Error("fixture output timed out");
      const chunk = await Promise.race([reader.read(), Bun.sleep(6000).then(() => { throw Error("fixture output timed out"); })]);
      if (chunk.done) throw Error(`fixture ended: ${await new Response(child.stderr).text()}`);
      buffer += new TextDecoder().decode(chunk.value);
    }
    const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1); return JSON.parse(line);
  };
  const stop = async () => { child.kill("SIGKILL"); await child.exited; reader.releaseLock(); };
  return { child, next, stop };
}

test("actual app survives killed checkpoint process and reopens same session without submitting", async () => withTempDir(async home => {
  const first = await runProcess(home, "checkpoint");
  let id: string;
  try { id = (await first.next()).checkpoint; expect(id!).toBeString(); } finally { await first.stop(); }
  const resumed = await runProcess(home, "reopen", id!);
  try {
    const recovery = await resumed.next(); expect(recovery.recovered).toBe("unfinished Thai ภาษาไทย\nsecond line"); expect(recovery.frame).toContain("Recovered draft");
    const exit = await resumed.next(); expect(exit.stopped).toBe(true); expect(exit.destroyed).toBe(true); expect(exit.stderr).toContain(`schway --resume ${id!}`);
  } finally { await resumed.stop(); }
}));

test("ordinary app exit flushes pending text and restores terminal; disk failure stays truthful", async () => withTempDir(async home => {
  const exit = await runProcess(home, "exit");
  try { const result = await exit.next(); expect(result.code).toBe(0); expect(result.stopped && result.destroyed).toBe(true); expect(result.stderr).toContain("checkpoint saved"); expect(await artifacts(home)).toContain("unfinished Thai"); } finally { await exit.stop(); }
  for (const mode of ["failure", "permission"]) {
    const isolated = join(home, mode); await mkdir(isolated);
    const previous = await createJsonlSession({ directory: sessionsDirectory(isolated), workspace: { root: isolated, launchCwd: isolated, extraRoots: [] } });
    openDraftStore({ home: isolated, workspaceRoot: isolated, sessionId: previous.header.id }).save("previous valid checkpoint", 1);
    const failure = await runProcess(isolated, mode, previous.header.id);
    try {
      const ui = await failure.next(); expect(ui.retained).toContain("unfinished Thai"); expect(ui.frame).toContain("Draft not saved");
      const result = await failure.next(); expect(result.stderr).toContain("checkpoint failed"); expect(result.stderr).not.toContain("checkpoint saved"); expect(result.destroyed).toBe(true);
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
  openDraftStore({ home, workspaceRoot: home, sessionId: session.header.id }).save("previous completed checkpoint", 1);
  const started = Date.now();
  const blocked = await runProcess(home, "blocked-exit", session.header.id);
  try {
    const result = await blocked.next();
    expect(Date.now() - started).toBeLessThan(2500);
    expect(result.stopped && result.destroyed).toBe(true);
    expect(result.stderr).toContain("checkpoint timed out");
    expect(await readFile(join(home, "exit-worker-state"), "utf8")).toBe("blocked");
    expect(result.stderr).not.toContain("checkpoint saved");
    expect(await blocked.child.exited).toBe(0);
    expect(openDraftStore({ home, workspaceRoot: home, sessionId: session.header.id }).checkpoint?.text).toBe("previous completed checkpoint");
    expect((await readdir(join(home, ".schway/drafts"))).filter(name => !name.endsWith(".json"))).toEqual([]);
  } finally { await blocked.stop(); }
}));


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
    expect(result.stderr).toBe("Draft checkpoint failed; unsaved input was not confirmed saved.\n");
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
