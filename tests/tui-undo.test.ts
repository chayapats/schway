import { expect, test } from "bun:test";
import { readFile, access, writeFile, chmod, rm, mkdir, readdir, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import type { TextareaRenderable } from "@opentui/core";
import { createContextManager } from "../src/context/manager.ts";
import { createJsonlSession, loadJsonlSession } from "../src/session/jsonl.ts";
import type { Session } from "../src/session/session.ts";
import { bashTool } from "../src/tools/bash.ts";
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

/** Create a rendered scripted conversation with real session and undo storage in a temporary workspace. */
async function setup(root: string, session?: Session, extra: ScriptedTurnFactory[] = [], turns: ScriptedTurnFactory[] = responses, changeTracking: "off" | "on-demand" = "off", extraRoots: string[] = []) {
  const home = join(root, "home"), directory = join(home, "sessions");
  const workspace = { root, launchCwd: root, extraRoots };
  session ??= await createJsonlSession({ directory, workspace });
  const controller = new TuiController({ session, sessionId: session.rootId, workspace, home, provider: "scripted", modelId: "scripted",
    model: createScriptedModel({ responses: [...turns, ...extra] }), contextManager: createContextManager(workspace, { home }),
    tools: createToolRegistry([editTool, writeTool, bashTool]), changeTracking });
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

for (const tool of ["edit", "write"] as const) for (const mode of [0o755, 0o600, 0o640]) {
  test(`${tool} and resumed undo preserve ${mode.toString(8)} permissions`, async () => {
    await withTempDir(async root => {
      const path = join(root, "run.sh");
      await writeFile(path, "before"); await chmod(path, mode);
      const ui = await setup(root, undefined, [], [{ toolCalls: [{ id: "change", name: tool, arguments: tool === "edit"
        ? { path: "run.sh", edits: [{ oldText: "before", newText: "after" }] } : { path: "run.sh", content: "after" } }] }, { text: "Done." }]);
      let resumed: Awaited<ReturnType<typeof setup>> | undefined;
      try {
        await ui.send("Change the file");
        expect(await readFile(path, "utf8")).toBe("after"); expect((await stat(path)).mode & 0o777).toBe(mode);
        await ui.dispose();
        resumed = await setup(root, await loadJsonlSession({ directory: ui.directory, id: ui.session.rootId }));
        await resumed.send("/undo"); await resumed.controller.applyUndo();
        expect(await readFile(path, "utf8")).toBe("before"); expect((await stat(path)).mode & 0o777).toBe(mode);
      } finally { if (resumed) await resumed.dispose(); else await ui.dispose(); }
    });
  });
}

test("mode-only changes before preview protect existing and created files with new metadata", async () => {
  await withTempDir(async root => {
    await writeFile(join(root, "clamp.ts"), original); await chmod(join(root, "clamp.ts"), 0o755);
    const ui = await setup(root);
    try {
      await ui.send("Fix clamp");
      await chmod(join(root, "clamp.ts"), 0o600); await chmod(join(root, "src/new.ts"), 0o400);
      await ui.send("/undo");
      expect(ui.controller.snapshot().undoPreview).toBeUndefined();
      expect(ui.controller.snapshot().transcript.at(-1)?.text).toBe("Nothing to undo · every file changed since");
      expect(await readFile(join(root, "clamp.ts"), "utf8")).toBe(modified);
      expect(await readFile(join(root, "src/new.ts"), "utf8")).toContain("newFile");
      expect(ui.session.items.some(item => item.type === "turn_undo")).toBe(false);
    } finally { await ui.dispose(); }
  });
});

for (const changed of ["clamp.ts", "src/new.ts"] as const) {
  test(`undo skips ${changed} chmod to 0000 after preview instead of reporting a restore failure`, async () => {
    await withTempDir(async root => {
      const path = join(root, changed);
      await writeFile(join(root, "clamp.ts"), original, { mode: 0o600 });
      const ui = await setup(root);
      try {
        await ui.send("Fix clamp"); await chmod(path, 0o600);
        // Refresh the settled mode so the fixture tests only the preview/apply interval.
        const { openUndoStore } = await import("../src/undo/store.ts"), store = openUndoStore({ home: ui.home });
        const turn = (await store.list(ui.session.rootId))[0]!; await store.settle(turn, path, false);
        await ui.send("/undo"); await chmod(path, 0o000);
        await ui.controller.applyUndo();
        expect(ui.controller.snapshot().undoPreview).toBeUndefined();
        expect(ui.session.items.at(-1)).toMatchObject({ type: "turn_undo", skipped: [{ path: changed, reason: "changed" }] });
        expect((await stat(path)).mode & 0o777).toBe(0o000);
        await chmod(path, 0o600);
        expect(await readFile(path, "utf8")).toBe(changed === "clamp.ts" ? modified : "export const newFile = true;\n");
      } finally { await chmod(path, 0o600).catch(() => {}); await ui.dispose(); }
    });
  });
}

test("legacy undo preserves a pre-preview chmod with an explicit Details caveat and leaves the manifest untouched", async () => {
  await withTempDir(async root => {
    const path = join(root, "clamp.ts"); await writeFile(path, original); await chmod(path, 0o755);
    const ui = await setup(root);
    try {
      await ui.send("Fix clamp");
      const { openUndoStore } = await import("../src/undo/store.ts");
      const manifest = (await openUndoStore({ home: ui.home }).list(ui.session.rootId))[0]!;
      for (const file of manifest.files) { delete file.beforeMode; delete file.afterMode; }
      const manifestPath = join(ui.home, ".schway/undo", ui.session.rootId, "turns", `${manifest.turnId}.json`);
      const legacy = JSON.stringify(manifest); await writeFile(manifestPath, legacy);
      await chmod(path, 0o640);
      await ui.send("/undo"); expect(ui.controller.snapshot().undoPreview?.files[0]?.action).toBe("restore");
      expect(ui.controller.inspectNoticeDetails()).toBe(true);
      expect(ui.controller.snapshot().transcript.at(-1)?.text).toContain("Original permissions were unavailable");
      expect(ui.controller.snapshot().transcript.at(-1)?.text).toContain("Permission changes before this preview cannot be verified");
      await ui.controller.applyUndo();
      expect(await readFile(path, "utf8")).toBe(original); expect((await stat(path)).mode & 0o777).toBe(0o640);
      expect(await readFile(manifestPath, "utf8")).toBe(legacy);
    } finally { await ui.dispose(); }
  });
});

test("permission-only captured turns are eligible and restore their original mode", async () => {
  await withTempDir(async root => {
    const path = join(root, "clamp.ts"); await writeFile(path, original); await chmod(path, 0o755);
    const ui = await setup(root, undefined, [], [{ text: "Done." }]);
    try {
      await ui.send("Change permissions fixture");
      const { openUndoStore } = await import("../src/undo/store.ts"), store = openUndoStore({ home: ui.home });
      const turn = { sessionId: ui.session.rootId, turnId: ui.session.items.find(item => item.type === "user")!.id, turnNumber: 1 };
      await store.capture(turn, path); await chmod(path, 0o600); await store.settle(turn, path, true);
      await ui.send("/undo"); expect(ui.controller.snapshot().undoPreview?.files[0]?.action).toBe("restore");
      await ui.controller.applyUndo();
      expect(await readFile(path, "utf8")).toBe(original); expect((await stat(path)).mode & 0o777).toBe(0o755);
    } finally { await ui.dispose(); }
  });
});

test("missing and symlink targets are skipped without touching their replacements", async () => {
  await withTempDir(async root => {
    const path = join(root, "clamp.ts"); await writeFile(path, original);
    const ui = await setup(root);
    try {
      await ui.send("Fix clamp");
      const other = join(root, "other"); await writeFile(other, modified); await chmod(other, 0o600);
      await rm(path); await symlink(other, path); await rm(join(root, "src/new.ts"));
      await ui.send("/undo"); expect(ui.controller.snapshot().undoPreview).toBeUndefined();
      expect(await readFile(other, "utf8")).toBe(modified); expect((await stat(other)).mode & 0o777).toBe(0o600);
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
      expect(ui.captureCharFrame()).toContain("Shell changes can't be detected here");
      const { openUndoStore } = await import("../src/undo/store.ts");
      expect((await openUndoStore({ home }).list(id))[0]?.shell).toEqual({ detection: "unavailable" });
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

/** Exercise real undo files in an isolated child with deterministic I/O faults or a permissive umask. */
async function undoFilesystemProbe(root: string, scenario: string) {
  const source = join(import.meta.dir, "../src");
  const script = `
    import { mock } from "bun:test";
    import { dirname, join } from "node:path";
    const fs = await import("node:fs/promises");
    const realWrite = fs.writeFile, realUnlink = fs.unlink, realRead = fs.readFile, realRename = fs.rename, realOpen = fs.open;
    const handles = new WeakMap();
    const root = ${JSON.stringify(root)}, scenario = ${JSON.stringify(scenario)};
    if (scenario === "private-mode") process.umask(0o000);
    const path = join(root, "clamp.ts"), created = join(root, "new.ts");
    let armed = false, preparations = 0, prepared = false, tempMode, creationMode, beforeRenameMode;
    let preparedPath, stagingMode, checkedMode, stagedBytes;
    mock.module("node:fs/promises", () => ({ ...fs,
      open: async (destination, flags, mode) => {
        const handle = await realOpen(destination, flags, mode);
        handles.set(handle, destination);
        if (armed && String(destination).startsWith(path + ".")) creationMode = mode;
        return handle;
      },
      writeFile: async (destination, content, options) => {
        await realWrite(destination, content, options);
        destination = typeof destination === "object" ? handles.get(destination) : destination;
        if (!armed || !String(destination).startsWith(path + ".") || !String(destination).endsWith(".tmp")) return;
        if (scenario === "delete-failure") return;
        armed = false; preparations++;
        if (scenario === "private-mode") {
          tempMode = (await fs.stat(destination)).mode & 0o777;
          return;
        }
        if (scenario === "staged-restore-change") { prepared = true; preparedPath = destination; return; }
        if (scenario === "check-failure") { prepared = true; return; }
        if (scenario.startsWith("prepare")) {
          if (scenario.includes("chmod")) await fs.chmod(path, 0o600);
          else await realWrite(path, "later save");
          if (scenario === "prepare-and-delete-change") await realWrite(created, "later created save");
          if (scenario === "prepare-chmod-and-delete") await fs.chmod(created, 0o600);
        } else {
          throw Object.assign(new Error(scenario + " internal temp path: " + destination), { code: scenario });
        }
      },
      rename: async (temporary, destination) => {
        if (scenario === "private-mode" && destination === path) beforeRenameMode = (await fs.stat(temporary)).mode & 0o777;
        return realRename(temporary, destination);
      },
      readFile: async (...args) => {
        if (prepared && args[0] === path) {
          prepared = false;
          if (scenario === "staged-restore-change") {
            stagingMode = (await fs.stat(dirname(preparedPath))).mode & 0o777;
            checkedMode = (await fs.stat(preparedPath)).mode & 0o777;
            stagedBytes = await realRead(preparedPath, "utf8");
            await fs.chmod(path, 0o640);
            return realRead(...args);
          }
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
    await realWrite(path, "before", scenario === "private-mode" ? { mode: 0o600 } : undefined);
    if (scenario === "staged-restore-change") await fs.chmod(path, 0o644);
    await store.capture(turn, path); await realWrite(path, "after");
    if (scenario === "staged-restore-change") await fs.chmod(path, 0o600);
    await store.settle(turn, path, true);
    await store.capture(turn, created); await realWrite(created, "created"); await store.settle(turn, created, true);
    if (scenario === "prepare-legacy-chmod") {
      const manifestPath = join(root, ".schway/undo", session.rootId, "turns/user.json");
      const manifest = JSON.parse(await realRead(manifestPath, "utf8"));
      for (const file of manifest.files) { delete file.beforeMode; delete file.afterMode; }
      await realWrite(manifestPath, JSON.stringify(manifest));
    }
    const workspace = { root, launchCwd: root, extraRoots: [] };
    const controller = new TuiController({ session, sessionId: session.rootId, workspace, home: root,
      provider: "scripted", modelId: "fixture", contextManager: createContextManager(workspace) });
    try {
      await controller.undoCommand("");
      armed = true;
      await controller.applyUndo();
      const snapshot = controller.snapshot();
      const detailsAvailable = controller.inspectNoticeDetails();
      let defaults;
      if (scenario === "private-mode") {
        const { writeTool } = await import(${JSON.stringify(join(source, "tools/write.ts"))});
        const { editTool } = await import(${JSON.stringify(join(source, "tools/edit.ts"))});
        await writeTool.execute({ path: "ordinary.txt", content: "one" }, { workspace });
        const write = (await fs.stat(join(root, "ordinary.txt"))).mode & 0o777;
        await editTool.execute({ path: "ordinary.txt", edits: [{ oldText: "one", newText: "two" }] }, { workspace });
        defaults = { write, edit: (await fs.stat(join(root, "ordinary.txt"))).mode & 0o777,
          content: await fs.readFile(join(root, "ordinary.txt"), "utf8") };
      }
      console.log(JSON.stringify({ preparations, tempMode, creationMode, beforeRenameMode, defaults, stagingMode, checkedMode, stagedBytes,
        restoredMode: (await fs.stat(path)).mode & 0o777, bytes: await fs.readFile(path, "utf8"),
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

for (const scenario of ["prepare-chmod-and-delete", "prepare-legacy-chmod"]) {
  test(`${scenario} rejects mode drift after preview and removes prepared replacements`, async () => {
    await withTempDir(async root => {
      const result = await undoFilesystemProbe(root, scenario);
      expect(result.preparations).toBe(1); expect(result.bytes).toBe("after");
      expect(result.restoredMode).toBe(0o600); expect(result.temps).toEqual([]);
      if (scenario === "prepare-chmod-and-delete") {
        expect(result.createdBytes).toBe("created"); expect(result.record).toBeUndefined();
      } else {
        expect(result.record.skipped).toEqual([{ path: "clamp.ts", reason: "changed" }]);
        expect(result.details).toContain("Permission changes before this preview cannot be verified");
      }
    });
  });
}

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

test("undo keeps a restored public mode behind private staging when final validation rejects the restore", async () => {
  await withTempDir(async root => {
    const result = await undoFilesystemProbe(root, "staged-restore-change");
    expect(result.preparations).toBe(1); expect(result.stagingMode).toBe(0o700);
    expect(result.creationMode).toBe(0o600); expect(result.checkedMode).toBe(0o644); expect(result.stagedBytes).toBe("before");
    expect(result.bytes).toBe("after"); expect(result.restoredMode).toBe(0o640); expect(result.temps).toEqual([]);
    expect(result.record).toMatchObject({ reverted: [{ path: "new.ts", action: "deleted" }], skipped: [{ path: "clamp.ts", reason: "changed" }] });
  });
});

test.skipIf(process.platform === "win32")("undo restoration creates and publishes owner-only bytes under a permissive umask while ordinary file tools keep their defaults", async () => {
  await withTempDir(async root => {
    const result = await undoFilesystemProbe(root, "private-mode");
    expect(result.preparations).toBe(1);
    expect(result.creationMode).toBe(0o600); expect(result.tempMode).toBe(0o600);
    expect(result.beforeRenameMode).toBe(0o600); expect(result.restoredMode).toBe(0o600);
    expect(result.bytes).toBe("before"); expect(result.temps).toEqual([]);
    expect(result.record.reverted).toEqual([{ path: "clamp.ts", action: "restored" }, { path: "new.ts", action: "deleted" }]);
    expect(result.defaults).toEqual({ write: 0o666, edit: 0o666, content: "two" });
  });
});


test("rendered repeated undo walks three turns and cancellation preserves the candidate", async () => {
  await withTempDir(async root => {
    const turns: ScriptedTurn[] = [];
    for (let n = 1; n <= 3; n++) {
      await writeFile(join(root, `${n}.ts`), "before");
      turns.push({ toolCalls: [{ id: `edit-${n}`, name: "edit", arguments: { path: `${n}.ts`, edits: [{ oldText: "before", newText: "after" }] } }] }, { text: "Done." });
    }
    const ui = await setup(root, undefined, [], turns);
    try {
      for (let n = 1; n <= 3; n++) await ui.send(`Turn ${n}`);
      for (let n = 3; n >= 1; n--) {
        await ui.send("/undo");
        expect(ui.controller.snapshot().undoPreview?.turnNumber).toBe(n);
        if (n === 2) {
          ui.mockInput.pressEscape(); await ui.settle(); await ui.send("/undo");
          expect(ui.controller.snapshot().undoPreview?.turnNumber).toBe(2);
        }
        ui.mockInput.pressEnter(); await ui.waitFor(() => !ui.controller.snapshot().undoPreview);
        expect(await readFile(join(root, `${n}.ts`), "utf8")).toBe("before");
        if (n === 2) expect(ui.session.items.filter(item => item.type === "turn_undo").at(-1)?.note).toStartWith("The user undid your file changes from turn 2:");
      }
      await ui.send("/undo");
      expect(ui.controller.snapshot().undoPreview).toBeUndefined();
      expect(ui.captureCharFrame()).toContain("Nothing to undo");
    } finally { await ui.dispose(); }
  });
});


test("shell paths are previewed without diffs or writes and shell-only turns are skipped", async () => {
  await withTempDir(async root => {
    const git = Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: root });
    expect(git.exitCode).toBe(0);
    await writeFile(join(root, ".git/info/exclude"), "/home/\n");
    await writeFile(join(root, "a.ts"), "before");
    const ui = await setup(root, undefined, [], [
      { toolCalls: [{ id: "edit", name: "edit", arguments: { path: "a.ts", edits: [{ oldText: "before", newText: "after" }] } },
        { id: "shell", name: "bash", arguments: { command: "mkdir -p gen; echo x > gen/out.json" } }] }, { text: "Done." },
      { toolCalls: [{ id: "shell-only", name: "bash", arguments: { command: "echo y > gen/other.json" } }] }, { text: "Done." },
    ], "on-demand");
    try {
      await ui.send("Edit and generate"); await ui.send("Generate another"); await ui.send("/undo");
      expect(ui.controller.snapshot().undoPreview?.turnNumber).toBe(1);
      expect(ui.captureCharFrame()).toContain("gen/out.json");
      expect(ui.captureCharFrame()).toContain("changed by shell · not undoable");
      ui.mockInput.pressArrow("down"); await ui.settle();
      expect(ui.controller.snapshot().undoPreview?.files[1]?.rows).toEqual([]);
      ui.mockInput.pressEnter(); await ui.waitFor(() => !ui.controller.snapshot().undoPreview);
      expect(await readFile(join(root, "a.ts"), "utf8")).toBe("before");
      expect(await readFile(join(root, "gen/out.json"), "utf8")).toBe("x\n");
    } finally { await ui.dispose(); }
  });
});

test("non-Git write undo restores bytes and names unavailable shell detection", async () => {
  await withTempDir(async root => {
    await writeFile(join(root, "a.ts"), "before");
    const ui = await setup(root, undefined, [], [
      { toolCalls: [{ id: "write", name: "write", arguments: { path: "a.ts", content: "after" } }] }, { text: "Done." },
    ], "on-demand");
    try {
      await ui.send("Write file"); await ui.send("/undo");
      expect(ui.captureCharFrame()).toContain("Shell changes can't be detected here");
      ui.mockInput.pressEnter(); await ui.waitFor(() => !ui.controller.snapshot().undoPreview);
      expect(await readFile(join(root, "a.ts"), "utf8")).toBe("before");
    } finally { await ui.dispose(); }
  });
});


test("disposing during delayed shell persistence does not publish cancellation recovery", async () => {
  await withTempDir(async root => {
    const script = `
      import { mock } from "bun:test";
      const fs = await import("node:fs/promises");
      const write = fs.writeFile;
      let saved, release, started;
      const saving = new Promise(resolve => saved = resolve);
      const gate = new Promise(resolve => release = resolve);
      const requesting = new Promise(resolve => started = resolve);
      mock.module("node:fs/promises", () => ({ ...fs, writeFile: async (...args) => {
        await write(...args);
        if (String(args[0]).includes(".json.") && String(args[0]).endsWith(".tmp")) { saved(); await gate; }
      }}));
      const { TuiController } = await import(${JSON.stringify(join(import.meta.dir, "../src/tui/controller.ts"))});
      const { createSession } = await import(${JSON.stringify(join(import.meta.dir, "../src/session/session.ts"))});
      const { createContextManager } = await import(${JSON.stringify(join(import.meta.dir, "../src/context/manager.ts"))});
      const { createScriptedModel } = await import(${JSON.stringify(join(import.meta.dir, "helpers/scripted-model.ts"))});
      const root = ${JSON.stringify(root)}, workspace = { root, launchCwd: root, extraRoots: [] };
      const controller = new TuiController({ session: createSession(), workspace, home: root, provider: "scripted", modelId: "scripted",
        model: createScriptedModel({ responses: [() => { started(); return { waitForAbort: true }; }] }),
        contextManager: createContextManager(workspace), changeTracking: "off" });
      const turn = controller.submit("Wait");
      await requesting; controller.cancel(); await saving;
      controller.dispose(); const before = controller.snapshot().transcript.length;
      release(); await turn;
      const snapshot = controller.snapshot();
      console.log(JSON.stringify({ recovery: snapshot.recovery, outcome: snapshot.outcome, before, after: snapshot.transcript.length }));
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, error).toBe(0);
    const result = JSON.parse(output);
    expect(result.recovery).toBeUndefined(); expect(result.outcome).toBeUndefined(); expect(result.after).toBe(result.before);
  });
});


test("a partial later undo consumes its turn and older hashes still protect skipped files", async () => {
  await withTempDir(async root => {
    for (const path of ["a.ts", "b.ts", "c.ts"]) await writeFile(join(root, path), "before");
    const call = (path: string, oldText: string, newText: string) => ({ id: path, name: "edit", arguments: { path, edits: [{ oldText, newText }] } });
    const ui = await setup(root, undefined, [], [
      { toolCalls: [call("a.ts", "before", "first"), call("b.ts", "before", "first")] }, { text: "First." },
      { toolCalls: [call("a.ts", "first", "second"), call("c.ts", "before", "second")] }, { text: "Second." },
    ]);
    try {
      await ui.send("First"); await ui.send("Second"); await writeFile(join(root, "a.ts"), "later save");
      await ui.send("/undo"); ui.mockInput.pressEnter(); await ui.waitFor(() => !ui.controller.snapshot().undoPreview);
      expect(await readFile(join(root, "c.ts"), "utf8")).toBe("before");
      await ui.send("/undo"); expect(ui.controller.snapshot().undoPreview?.turnNumber).toBe(1);
      expect(ui.captureCharFrame()).toContain("changed since · skip");
      ui.mockInput.pressEnter(); await ui.waitFor(() => !ui.controller.snapshot().undoPreview);
      expect(await readFile(join(root, "a.ts"), "utf8")).toBe("later save");
      expect(await readFile(join(root, "b.ts"), "utf8")).toBe("before");
      expect(ui.session.items.filter(item => item.type === "turn_undo").at(-1)).toMatchObject({ turnNumber: 1, skipped: [{ path: "a.ts", reason: "changed" }] });
    } finally { await ui.dispose(); }
  });
});

test("repeated undo on the same file restores each previous post-image", async () => {
  await withTempDir(async root => {
    await writeFile(join(root, "a.ts"), "original");
    const ui = await setup(root, undefined, [], [
      { toolCalls: [{ id: "first", name: "write", arguments: { path: "a.ts", content: "first" } }] }, { text: "First." },
      { toolCalls: [{ id: "second", name: "write", arguments: { path: "a.ts", content: "second" } }] }, { text: "Second." },
    ]);
    try {
      await ui.send("First"); await ui.send("Second");
      for (const expected of ["first", "original"]) {
        await ui.send("/undo"); ui.mockInput.pressEnter(); await ui.waitFor(() => !ui.controller.snapshot().undoPreview);
        expect(await readFile(join(root, "a.ts"), "utf8")).toBe(expected);
      }
    } finally { await ui.dispose(); }
  });
});

test("file-tool writes under an attached root remain undoable", async () => {
  await withTempDir(async temp => {
    const root = join(temp, "work"), attached = join(temp, "attached");
    await mkdir(root); await mkdir(attached); await writeFile(join(attached, "a.ts"), "before");
    const ui = await setup(root, undefined, [], [
      { toolCalls: [{ id: "attached", name: "write", arguments: { path: join(attached, "a.ts"), content: "after" } }] }, { text: "Done." },
    ], "on-demand", [attached]);
    try {
      await ui.send("Edit attached file"); await ui.send("/undo");
      expect(ui.controller.snapshot().undoPreview?.files[0]?.absolutePath).toBe(join(attached, "a.ts"));
      ui.mockInput.pressEnter(); await ui.waitFor(() => !ui.controller.snapshot().undoPreview);
      expect(await readFile(join(attached, "a.ts"), "utf8")).toBe("before");
    } finally { await ui.dispose(); }
  });
});


test("pruned turns are silently skipped by the rendered undo stack", async () => {
  await withTempDir(async root => {
    const ui = await setup(root, undefined, [], [
      { toolCalls: [{ id: "first", name: "write", arguments: { path: "a.ts", content: "first" } }] }, { text: "First." },
      { toolCalls: [{ id: "second", name: "write", arguments: { path: "b.ts", content: "second" } }] }, { text: "Second." },
    ]);
    try {
      await ui.send("First"); await ui.send("Second");
      const { openUndoStore, pruneUndoStore } = await import("../src/undo/store.ts");
      const store = openUndoStore({ home: ui.home });
      const target = (await store.list(ui.session.rootId)).find(m => m.turnNumber === 2)!;
      target.createdAt = "2000-01-01T00:00:00Z";
      await writeFile(join(ui.home, ".schway", "undo", ui.session.rootId, "turns", `${target.turnId}.json`), JSON.stringify(target));
      await pruneUndoStore({ home: ui.home, maxAgeDays: 30, maxSizeBytes: 100000 });
      await ui.send("/undo"); expect(ui.controller.snapshot().undoPreview?.turnNumber).toBe(1);
      ui.mockInput.pressEnter(); await ui.waitFor(() => !ui.controller.snapshot().undoPreview);
      await expect(access(join(root, "a.ts"))).rejects.toThrow();
      expect(await readFile(join(root, "b.ts"), "utf8")).toBe("second");
      await ui.send("/undo"); expect(ui.captureCharFrame()).toContain("Nothing to undo");
    } finally { await ui.dispose(); }
  });
});
