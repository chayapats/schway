import { expect, test } from "bun:test";
import { readFile, access, writeFile, chmod, rm, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import type { TextareaRenderable } from "@opentui/core";
import { createContextManager } from "../src/context/manager.ts";
import { createJsonlSession, loadJsonlSession } from "../src/session/jsonl.ts";
import type { Session } from "../src/session/session.ts";
import { editTool } from "../src/tools/edit.ts";
import { writeTool } from "../src/tools/write.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { TuiController } from "../src/tui/controller.ts";
import { dispatchEditorInput } from "../src/tui/commands.ts";
import { createConversationView } from "../src/tui/view.ts";
import { withTempDir } from "./helpers.ts";
import { createScriptedModel, type ScriptedTurn, type ScriptedTurnFactory } from "./helpers/scripted-model.ts";

const original = "export function clamp(n, lo, hi) {\n  return Math.max(lo, n);\n}\n";
const modified = original.replace("Math.max(lo, n)", "Math.min(hi, Math.max(lo, n))");
const responses: ScriptedTurn[] = [
  { toolCalls: [{ id: "edit-clamp", name: "edit", arguments: { path: "clamp.ts", edits: [{ oldText: "Math.max(lo, n)", newText: "Math.min(hi, Math.max(lo, n))" }] } },
    { id: "write-new", name: "write", arguments: { path: "src/new.ts", content: "export const newFile = true;\n" } }] },
  { text: "Updated the files." },
];

async function setup(root: string, session?: Session, extra: ScriptedTurnFactory[] = [], turns: ScriptedTurnFactory[] = responses) {
  const home = join(root, "home"), directory = join(home, "sessions");
  const workspace = { root, launchCwd: root, extraRoots: [] };
  session ??= await createJsonlSession({ directory, workspace });
  const controller = new TuiController({ session, sessionId: session.rootId, workspace, home, provider: "scripted", modelId: "scripted",
    model: createScriptedModel({ responses: [...turns, ...extra] }), contextManager: createContextManager(workspace, { home }),
    tools: createToolRegistry([editTool, writeTool]), changeTracking: "off" });
  const terminal = await createTestRenderer({ width: 80, height: 30, kittyKeyboard: true });
  const view = createConversationView(terminal.renderer, { controller, home, workspaceRoot: root, env: {}, secrets: [], quit() {},
    submit: (value, accepted) => dispatchEditorInput(value, controller, command => command.name === "undo" ? controller.undoCommand(command.args) : Promise.resolve(false), accepted) });
  const editor = terminal.renderer.root.findDescendantById("prompt") as TextareaRenderable;
  const settle = async () => { view.refresh(); await terminal.flush(); };
  const waitFor = async (ready: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!ready() && Date.now() < deadline) { await Bun.sleep(5); await settle(); }
    expect(ready()).toBe(true); await settle();
  };
  const send = async (text: string) => { await terminal.mockInput.typeText(text); terminal.mockInput.pressEnter(); await waitFor(() => editor.plainText !== text); await controller.waitForIdle(); await settle(); };
  return { ...terminal, view, controller, session, home, directory, editor, settle, waitFor, send,
    dispose: async () => { view.destroy(); controller.dispose(); terminal.renderer.destroy(); await controller.waitForIdle(); } };
}

test("rendered undo previews and restores edited files, deletes created files, and informs the next request", async () => {
  await withTempDir(async root => {
    await writeFile(join(root, "clamp.ts"), original);
    let sawNote = false;
    const ui = await setup(root, undefined, [request => {
      expect(request.items.find(item => item.id === ui.session.items.find(item => item.type === "turn_undo")?.id)).toEqual({ type: "user", id: expect.any(String), content: [{ type: "text", text: "The user undid your file changes from the previous turn: clamp.ts, src/new.ts." }] });
      const undoIndex = request.items.findIndex(item => item.id === ui.session.items.find(item => item.type === "turn_undo")?.id);
      expect(request.items[undoIndex + 1]).toMatchObject({ type: "user", content: [{ type: "text", text: "Continue" }] });
      sawNote = true; return { text: "Understood." };
    }]);
    try {
      await ui.send("Fix clamp");
      expect(await readFile(join(root, "clamp.ts"), "utf8")).toBe(modified);
      await ui.send("/undo"); await ui.waitFor(() => !!ui.controller.snapshot().undoPreview);
      const frame = ui.captureCharFrame();
      expect(frame).toContain("Undo turn 1 · Enter undo · Esc cancel");
      expect(frame).toContain("restore"); expect(frame).toContain("delete");
      expect(frame).toContain("Math.min(hi");
      ui.mockInput.pressEnter(); await ui.waitFor(() => !ui.controller.snapshot().undoPreview);
      expect(await readFile(join(root, "clamp.ts"), "utf8")).toBe(original);
      await expect(access(join(root, "src/new.ts"))).rejects.toThrow();
      expect(ui.session.items.filter(item => item.type === "turn_undo")).toHaveLength(1);
      expect(ui.captureCharFrame()).toContain("Undid turn 1 · 2 files");
      await ui.send("Continue"); expect(sawNote).toBe(true);
      await ui.send("/undo"); expect(ui.controller.snapshot().transcript.at(-1)?.text).toBe("Nothing to undo");
    } finally { await ui.dispose(); }
  });
});


test("Esc restores a typed draft without changing files, the store or the session", async () => {
  await withTempDir(async root => {
    await writeFile(join(root, "clamp.ts"), original);
    const ui = await setup(root);
    try {
      await ui.send("Fix clamp");
      await ui.mockInput.pasteBracketedText("Keep this draft");
      ui.editor.cursorOffset = 4;
      const records = [...ui.session.items];
      const { openUndoStore } = await import("../src/undo/store.ts");
      const before = await openUndoStore({ home: ui.home }).list(ui.session.rootId);
      await ui.controller.undoCommand(""); await ui.settle();
      ui.mockInput.pressEscape(); await ui.settle();
      expect(ui.editor.plainText).toBe("Keep this draft"); expect(ui.editor.cursorOffset).toBe(4);
      expect(await readFile(join(root, "clamp.ts"), "utf8")).toBe(modified);
      expect(await readFile(join(root, "src/new.ts"), "utf8")).toContain("newFile");
      expect(ui.session.items).toEqual(records);
      expect(await openUndoStore({ home: ui.home }).list(ui.session.rootId)).toEqual(before);
    } finally { await ui.dispose(); }
  });
});

test("later edits are skipped in preview and at apply time, without overwriting their bytes", async () => {
  await withTempDir(async root => {
    await writeFile(join(root, "clamp.ts"), original);
    const ui = await setup(root);
    try {
      await ui.send("Fix clamp");
      await writeFile(join(root, "clamp.ts"), "external change\n");
      await ui.send("/undo");
      expect(ui.captureCharFrame()).toContain("changed since · skip");
      ui.mockInput.pressEnter(); await ui.waitFor(() => !ui.controller.snapshot().undoPreview);
      expect(await readFile(join(root, "clamp.ts"), "utf8")).toBe("external change\n");
      expect(ui.session.items.at(-1)).toMatchObject({ type: "turn_undo", reverted: [{ path: "src/new.ts", action: "deleted" }], skipped: [{ path: "clamp.ts", reason: "changed" }],
        note: "The user undid your file changes from the previous turn: src/new.ts. clamp.ts was not reverted because it changed afterwards." });
      await ui.send("/undo"); expect(ui.controller.snapshot().transcript.at(-1)?.text).toBe("Nothing to undo");
    } finally { await ui.dispose(); }
  });
});

test("all files changed since leaves the turn available and appends no undo record", async () => {
  await withTempDir(async root => {
    await writeFile(join(root, "clamp.ts"), original);
    const ui = await setup(root);
    try {
      await ui.send("Fix clamp");
      await writeFile(join(root, "clamp.ts"), "external"); await writeFile(join(root, "src/new.ts"), "external");
      await ui.send("/undo");
      expect(ui.controller.snapshot().undoPreview).toBeUndefined();
      expect(ui.controller.snapshot().transcript.at(-1)?.text).toBe("Nothing to undo · every file changed since");
      expect(ui.session.items.some(item => item.type === "turn_undo")).toBe(false);
      await writeFile(join(root, "clamp.ts"), modified);
      await ui.send("/undo"); expect(ui.controller.snapshot().undoPreview).toBeDefined();
      await writeFile(join(root, "clamp.ts"), "raced edit");
      ui.mockInput.pressEnter(); await ui.waitFor(() => !ui.controller.snapshot().undoPreview);
      expect(ui.session.items.some(item => item.type === "turn_undo")).toBe(false);
      expect(await readFile(join(root, "clamp.ts"), "utf8")).toBe("raced edit");
      expect(ui.controller.snapshot().transcript.at(-1)?.text).toBe("Nothing to undo · every file changed since");
    } finally { await ui.dispose(); }
  });
});

test("sibling-only turns are not targeted and an undo on any branch prevents a second undo", async () => {
  await withTempDir(async root => {
    await writeFile(join(root, "clamp.ts"), original);
    const ui = await setup(root);
    try {
      const sibling = ui.session.forkBranch(ui.session.rootId);
      await ui.send("Fix clamp");
      ui.session.selectBranch("main"); ui.controller.replaceSession(ui.session, ui.session.rootId);
      await ui.send("/undo");
      expect(ui.controller.snapshot().undoPreview).toBeUndefined(); expect(ui.controller.snapshot().transcript.at(-1)?.text).toBe("Nothing to undo");
      ui.session.selectBranch(sibling); ui.controller.replaceSession(ui.session, ui.session.rootId);
      const head = ui.session.items.at(-1)!.id;
      await ui.send("/undo"); ui.mockInput.pressEnter(); await ui.waitFor(() => !ui.controller.snapshot().undoPreview);
      const other = ui.session.forkBranch(head); ui.controller.replaceSession(ui.session, ui.session.rootId);
      expect(ui.session.activeBranchId).toBe(other);
      expect(ui.session.items.some(item => item.type === "turn_undo")).toBe(false);
      await ui.send("/undo"); expect(ui.controller.snapshot().transcript.at(-1)?.text).toBe("Nothing to undo");
    } finally { await ui.dispose(); }
  });
});

test("restart and resume previews the same durable files and rebuilds the undo transcript", async () => {
  await withTempDir(async root => {
    await writeFile(join(root, "clamp.ts"), original);
    const first = await setup(root);
    await first.send("Fix clamp"); const id = first.session.rootId, directory = first.directory;
    await first.dispose();
    const resumed = await loadJsonlSession({ directory, id });
    const ui = await setup(root, resumed);
    try {
      await ui.send("/undo"); expect(ui.controller.snapshot().undoPreview?.files.map(file => file.path)).toEqual(["clamp.ts", "src/new.ts"]);
      ui.mockInput.pressEnter(); await ui.waitFor(() => !ui.controller.snapshot().undoPreview);
      expect(await readFile(join(root, "clamp.ts"), "utf8")).toBe(original);
    } finally { await ui.dispose(); }
    const latest = await setup(root, await loadJsonlSession({ directory, id }));
    try { expect(latest.controller.snapshot().transcript.at(-1)?.text).toBe("✓ Undid turn 1 · 2 files"); }
    finally { await latest.dispose(); }
  });
});

test("partial failures stay in a final result panel and Enter never retries them", async () => {
  await withTempDir(async root => {
    await writeFile(join(root, "clamp.ts"), original);
    const ui = await setup(root);
    try {
      await ui.send("Fix clamp"); await ui.send("/undo");
      await chmod(join(root, "src"), 0o500);
      ui.mockInput.pressEnter(); await ui.waitFor(() => !!ui.controller.snapshot().undoPreview?.result);
      expect(ui.controller.snapshot().undoPreview?.files[1]?.status).toContain("could not restore ·");
      expect(ui.session.items.at(-1)).toMatchObject({ type: "turn_undo", reverted: [{ path: "clamp.ts", action: "restored" }], skipped: [{ path: "src/new.ts", reason: "failed" }],
        note: "The user undid your file changes from the previous turn: clamp.ts. src/new.ts could not be reverted." });
      await chmod(join(root, "src"), 0o700); ui.mockInput.pressEnter(); await ui.settle();
      expect(await readFile(join(root, "src/new.ts"), "utf8")).toContain("newFile");
      expect(ui.session.items.filter(item => item.type === "turn_undo")).toHaveLength(1);
      ui.mockInput.pressEscape(); await ui.settle(); expect(ui.controller.snapshot().undoPreview).toBeUndefined();
    } finally { await chmod(join(root, "src"), 0o700); await ui.dispose(); }
  });
});

test("failed session append fences future turns after files were restored", async () => {
  await withTempDir(async root => {
    await writeFile(join(root, "clamp.ts"), original);
    const ui = await setup(root);
    try {
      await ui.send("Fix clamp"); await ui.send("/undo");
      const path = join(ui.directory, `${ui.session.rootId}.jsonl`);
      await rm(path); await mkdir(path);
      ui.mockInput.pressEnter(); await ui.waitFor(() => !ui.controller.snapshot().undoPreview);
      expect(await readFile(join(root, "clamp.ts"), "utf8")).toBe(original);
      expect(ui.controller.snapshot().transcript.at(-1)?.text).toBe("Files restored, but the session could not record the undo. The model will not be told.");
      expect(await ui.controller.submit("Continue")).toBe(false);
      expect(ui.session.items.some(item => item.type === "turn_undo")).toBe(false);
    } finally { await ui.dispose(); }
  });
});


test("binary pre-images restore exact bytes and keyboard selection survives narrow resize", async () => {
  await withTempDir(async root => {
    const bytes = Buffer.from([0xff, 0, 0x61, 0x0a]);
    await writeFile(join(root, "clamp.ts"), bytes);
    const ui = await setup(root, undefined, [], [
      { toolCalls: [{ id: "binary-write", name: "write", arguments: { path: "clamp.ts", content: "text now\n" } },
        { id: "new-write", name: "write", arguments: { path: "src/new.ts", content: "new\n" } }] }, { text: "Saved." },
    ]);
    try {
      await ui.send("Overwrite the files"); await ui.send("/undo");
      expect(ui.captureCharFrame()).toContain("Binary file · restore only");
      expect(ui.controller.snapshot().undoPreview?.files[0]?.status).toBe("restore");
      ui.resize(50, 30); await ui.settle(); expect(ui.captureCharFrame()).toContain("restore"); expect(ui.captureCharFrame()).toContain("delete");
      ui.mockInput.pressArrow("down"); await ui.settle();
      expect(ui.controller.snapshot().undoPreview?.selected).toBe(1);
      expect(ui.captureCharFrame()).toContain("│-new");
      ui.mockInput.pressKey("pagedown"); ui.mockInput.pressKey("pageup");
      ui.resize(120, 30); await ui.settle(); expect(ui.controller.snapshot().undoPreview?.selected).toBe(1);
      ui.mockInput.pressEnter(); await ui.waitFor(() => !ui.controller.snapshot().undoPreview);
      expect(await readFile(join(root, "clamp.ts"))).toEqual(bytes);
    } finally { await ui.dispose(); }
  });
});

test("one later-modified file opens no panel and missing blobs are skipped", async () => {
  await withTempDir(async root => {
    await writeFile(join(root, "clamp.ts"), original);
    const ui = await setup(root, undefined, [], [{ toolCalls: [responses[0]!.toolCalls![0]!] }, { text: "Edited." }]);
    try {
      await ui.send("Edit clamp");
      await writeFile(join(root, "clamp.ts"), "later"); await ui.send("/undo");
      expect(ui.controller.snapshot().transcript.at(-1)?.text).toBe("Nothing to undo · every file changed since");
      expect(ui.session.items.some(item => item.type === "turn_undo")).toBe(false);
      await writeFile(join(root, "clamp.ts"), modified);
      const directory = join(ui.home, ".schway/undo", ui.session.rootId, "blobs");
      for (const blob of await readdir(directory)) await rm(join(directory, blob));
      await ui.send("/undo"); expect(ui.controller.snapshot().undoPreview).toBeUndefined();
      expect(ui.controller.snapshot().transcript.at(-1)?.text).toBe("Nothing to undo · every file changed since");
      expect(await readFile(join(root, "clamp.ts"), "utf8")).toBe(modified);
    } finally { await ui.dispose(); }
  });
});

test("headless file edits can be undone after interactive resume", async () => {
  await withTempDir(async root => {
    const { runCli } = await import("../src/cli/main.ts");
    const { fakeCredentialStore } = await import("./helpers/credential-store.ts");
    const { sessionsDirectory } = await import("../src/session/jsonl.ts");
    const home = join(root, "home");
    await writeFile(join(root, "clamp.ts"), original);
    expect(await runCli(["--model", "fixture", "-p", "Fix clamp"], { cwd: root, env: { HOME: home, OPENAI_API_KEY: "fixture" },
      model: createScriptedModel({ responses }), credentialStore: fakeCredentialStore(), stdout: { write() {} }, stderr: { write() {} } })).toBe(0);
    const directory = sessionsDirectory(home);
    const id = (await readdir(directory)).find(name => name.endsWith(".jsonl"))!.slice(0, -6);
    const ui = await setup(root, await loadJsonlSession({ directory, id }));
    try {
      await ui.send("/undo"); expect(ui.controller.snapshot().undoPreview?.turnNumber).toBe(1);
      ui.mockInput.pressEnter(); await ui.waitFor(() => !ui.controller.snapshot().undoPreview);
      expect(await readFile(join(root, "clamp.ts"), "utf8")).toBe(original);
      await expect(access(join(root, "src/new.ts"))).rejects.toThrow();
    } finally { await ui.dispose(); }
  });
});

test("undo command arguments and running turns never touch undo storage", async () => {
  await withTempDir(async root => {
    const ui = await setup(root, undefined, [], [{ text: "Working", waitForAbort: true }]);
    try {
      expect(await ui.controller.undoCommand("older")).toBe(false);
      expect(ui.controller.snapshot().transcript.at(-1)?.text).toBe("Usage: /undo");
      await ui.mockInput.typeText("Work"); ui.mockInput.pressEnter();
      await ui.waitFor(() => ui.controller.running);
      expect(await dispatchEditorInput("/undo", ui.controller, command => ui.controller.undoCommand(command.args))).toBe(false);
      expect(ui.controller.snapshot().transcript.at(-1)?.text).toBe("Wait for this turn · Esc stop");
      await expect(access(join(ui.home, ".schway/undo"))).rejects.toThrow();
    } finally { ui.controller.cancel(); await ui.dispose(); }
  });
});

// Fault injection runs in a child so its filesystem hooks cannot affect other tests.
async function undoFilesystemProbe(root: string, scenario: string) {
  const source = join(import.meta.dir, "../src");
  const script = `
    import { mock } from "bun:test";
    import { join } from "node:path";
    const fs = await import("node:fs/promises");
    const realWrite = fs.writeFile, realUnlink = fs.unlink, realRead = fs.readFile;
    const root = ${JSON.stringify(root)}, scenario = ${JSON.stringify(scenario)};
    const path = join(root, "clamp.ts"), created = join(root, "new.ts");
    let armed = false, preparations = 0, prepared = false;
    mock.module("node:fs/promises", () => ({ ...fs,
      writeFile: async (destination, content, options) => {
        await realWrite(destination, content, options);
        if (!armed || !String(destination).startsWith(path + ".") || !String(destination).endsWith(".tmp")) return;
        if (scenario === "delete-failure") return;
        armed = false; preparations++;
        if (scenario === "check-failure") { prepared = true; return; }
        if (scenario.startsWith("prepare")) {
          await realWrite(path, "later save");
          if (scenario === "prepare-and-delete-change") await realWrite(created, "later created save");
        } else {
          throw Object.assign(new Error(scenario + " internal temp path: " + destination), { code: scenario });
        }
      },
      readFile: async (...args) => {
        if (prepared && args[0] === path) {
          prepared = false;
          throw Object.assign(new Error("EIO internal file read: " + path), { code: "EIO" });
        }
        return realRead(...args);
      },
      unlink: async destination => {
        if (armed && scenario === "delete-failure" && destination === created) {
          armed = false;
          throw Object.assign(new Error("UNKNOWN_DELETE internal path: " + destination), { code: "UNKNOWN_DELETE" });
        }
        return realUnlink(destination);
      },
    }));
    const { TuiController } = await import(${JSON.stringify(join(source, "tui/controller.ts"))});
    const { createSession } = await import(${JSON.stringify(join(source, "session/session.ts"))});
    const { createContextManager } = await import(${JSON.stringify(join(source, "context/manager.ts"))});
    const { openUndoStore } = await import(${JSON.stringify(join(source, "undo/store.ts"))});
    const session = createSession();
    session.append({ type: "user", id: "user", content: [{ type: "text", text: "Edit files" }] });
    const store = openUndoStore({ home: root });
    const turn = { sessionId: session.rootId, turnId: "user", turnNumber: 1 };
    await realWrite(path, "before");
    await store.capture(turn, path); await realWrite(path, "after"); await store.settle(turn, path, true);
    await store.capture(turn, created); await realWrite(created, "created"); await store.settle(turn, created, true);
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const controller = new TuiController({ session, sessionId: session.rootId, workspace, home: root,
      provider: "scripted", modelId: "fixture", contextManager: createContextManager(workspace) });
    try {
      await controller.undoCommand("");
      armed = true;
      await controller.applyUndo();
      const snapshot = controller.snapshot();
      const detailsAvailable = controller.inspectNoticeDetails();
      console.log(JSON.stringify({ preparations, bytes: await fs.readFile(path, "utf8"),
        createdBytes: await fs.readFile(created, "utf8").catch(() => null),
        rows: snapshot.undoPreview?.files.map(file => file.status), result: snapshot.undoPreview?.result,
        record: session.items.find(item => item.type === "turn_undo"), notice: snapshot.transcript.at(-1)?.text,
        temps: (await fs.readdir(root)).filter(name => name.endsWith(".tmp")), detailsAvailable,
        details: controller.snapshot().transcript.at(-1)?.text }));
    } finally { controller.dispose(); }
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(error).toBe(""); expect(code).toBe(0);
  return JSON.parse(output);
}

test("a destination saved during restore preparation is skipped, retained and not recorded as restored", async () => {
  await withTempDir(async root => {
    const result = await undoFilesystemProbe(root, "prepare-change");
    expect(result.preparations).toBe(1); expect(result.bytes).toBe("later save");
    expect(result.createdBytes).toBeNull(); expect(result.temps).toEqual([]);
    expect(result.record).toMatchObject({ reverted: [{ path: "new.ts", action: "deleted" }], skipped: [{ path: "clamp.ts", reason: "changed" }] });
  });
});

test("a later save also guards deletion and all apply-time changes write no undo record", async () => {
  await withTempDir(async root => {
    const result = await undoFilesystemProbe(root, "prepare-and-delete-change");
    expect(result.bytes).toBe("later save"); expect(result.createdBytes).toBe("later created save");
    expect(result.record).toBeUndefined(); expect(result.temps).toEqual([]);
    expect(result.notice).toBe("Nothing to undo · every file changed since");
  });
});

for (const [code, reason] of [["ENOSPC", "No space left on device"], ["UNKNOWN_STORAGE", "File operation failed"]]) {
  test(`undo ${code} failures use safe reasons while retaining diagnostics and cleaning prepared files`, async () => {
    await withTempDir(async root => {
      const result = await undoFilesystemProbe(root, code!);
      expect(result.bytes).toBe("after"); expect(result.createdBytes).toBeNull(); expect(result.temps).toEqual([]);
      expect(result.rows).toEqual([`could not restore · ${reason}`, "Deleted"]); expect(result.result).toBe(true);
      expect(result.record).toMatchObject({ reverted: [{ path: "new.ts", action: "deleted" }], skipped: [{ path: "clamp.ts", reason: "failed" }] });
      expect(result.detailsAvailable).toBe(true); expect(result.details).toContain(code);
      expect(result.details).toContain("internal temp path");
    });
  });
}

test("a deletion failure remains failed and successful restoration uses sentence case", async () => {
  await withTempDir(async root => {
    const result = await undoFilesystemProbe(root, "delete-failure");
    expect(result.bytes).toBe("before"); expect(result.createdBytes).toBe("created");
    expect(result.rows).toEqual(["Restored", "could not restore · File operation failed"]);
    expect(result.record).toMatchObject({ reverted: [{ path: "clamp.ts", action: "restored" }], skipped: [{ path: "new.ts", reason: "failed" }] });
  });
});

test("I/O failure during the final destination check is failed, rather than changed, and removes the replacement", async () => {
  await withTempDir(async root => {
    const result = await undoFilesystemProbe(root, "check-failure");
    expect(result.preparations).toBe(1); expect(result.bytes).toBe("after"); expect(result.temps).toEqual([]);
    expect(result.rows).toEqual(["could not restore · Could not read or write file", "Deleted"]);
    expect(result.record).toMatchObject({ reverted: [{ path: "new.ts", action: "deleted" }], skipped: [{ path: "clamp.ts", reason: "failed" }] });
  });
});
