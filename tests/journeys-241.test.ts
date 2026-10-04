// Cross-feature journey regressions found while rerunning the #241 UX audit journeys across the integrated changes.
import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { TextareaRenderable, TextRenderable } from "@opentui/core";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSession, sessionsDirectory } from "../src/session/jsonl.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { editTool } from "../src/tools/edit.ts";
import { createContextManager } from "../src/context/manager.ts";
import type { Model } from "../src/model/model.ts";
import { TuiController } from "../src/tui/controller.ts";
import { createConversationView } from "../src/tui/view.ts";
import { dispatchEditorInput } from "../src/tui/commands.ts";
import { createReaderDocument, readerEnd, readerLayout, revealMatch, scrollReader } from "../src/tui/reader-view.ts";
import { keyboardGuideAvailability, nothingToInspectReason } from "../src/tui/palette.ts";
import { getGitDiffPreview, inspectGitStatus } from "../src/workspace/git.ts";
import { SESSION_BLOCKED_HINT } from "../src/tui/running-hints.ts";

type Outcome = { text: string } | { error: string; status: number } | { toolCalls: { id: string; name: string; arguments: unknown }[] };

/** A model whose turns wait until the test releases an outcome, so input can arrive mid-turn. */
function gatedModel() {
  const pending: ((outcome: Outcome) => void)[] = [];
  const prompts: string[] = [];
  let count = 0;
  const model = {
    provider: "scripted", id: "gated",
    async *stream(request: Parameters<Model["stream"]>[0]) {
      const users = request.items.filter(item => item.type === "user");
      prompts.push(users.at(-1)!.content.map(block => block.type === "text" ? block.text : "").join(""));
      const outcome = await new Promise<Outcome>((resolve, reject) => {
        pending.push(resolve);
        request.signal?.addEventListener("abort", () => { pending.splice(pending.indexOf(resolve), 1); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
      });
      count++;
      if ("error" in outcome) throw Object.assign(new Error(outcome.error), { status: outcome.status });
      if ("toolCalls" in outcome) {
        yield { type: "message_complete", message: { type: "assistant", id: `assistant-${count}`, content: outcome.toolCalls.map(call => ({ type: "tool_call", ...call })) } };
        return;
      }
      yield { type: "text_delta", text: outcome.text };
      yield { type: "message_complete", message: { type: "assistant", id: `assistant-${count}`, content: [{ type: "text", text: outcome.text }] } };
    },
  } as unknown as Model;
  return { model, prompts, waiting: () => pending.length, release: (outcome: Outcome) => pending.shift()!(outcome) };
}

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "F", GIT_AUTHOR_EMAIL: "f@example.com", GIT_COMMITTER_NAME: "F", GIT_COMMITTER_EMAIL: "f@example.com" };
function git(work: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: work, env: gitEnv });
  if (result.exitCode) throw new Error(result.stderr.toString());
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function repository(initGit = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "schway-241-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"), work = join(root, "work");
  await mkdir(work, { recursive: true });
  await writeFile(join(work, "note.txt"), "before\n");
  if (initGit) { git(work, "init", "-q", "-b", "main"); git(work, "add", "."); git(work, "-c", "commit.gpgsign=false", "commit", "-qm", "base"); }
  return { root, home, work };
}

const KEYS = {
  kitty: { altR: "\x1b[114;3u", altH: "\x1b[104;3u", altI: "\x1b[105;3u", ctrlF: "\x1b[102;5u", ctrlR: "\x1b[114;5u", f2: "\x1b[57365;1u\x1b[57365;1:3u", newline: "\x1b[13;2u", esc: "\x1b[27u" },
  legacy: { altR: "\x1br", altH: "\x1bh", altI: "\x1bi", ctrlF: "\x06", ctrlR: "\x12", f2: "\x1bOQ", newline: "\n", esc: "\x1b" },
} as const;
type Encoding = keyof typeof KEYS;

async function setup(encoding: Encoding, width = 100, height = 30, options: { git?: boolean; tracking?: "off" | "on-demand" } = {}) {
  const { home, work } = await repository(options.git ?? true);
  const workspace = { root: work, launchCwd: work, extraRoots: [] };
  const session = await createJsonlSession({ directory: sessionsDirectory(home), workspace, deferred: true });
  const gate = gatedModel();
  const controller = new TuiController({
    home, session, workspace, sessionId: session.header.id, provider: "scripted", modelId: "gated", model: gate.model,
    contextManager: createContextManager(workspace, { home }), tools: createToolRegistry([editTool]), changeTracking: options.tracking ?? "on-demand", secrets: [],
    agentClock: { now: () => 0, sleep: async (_ms: number, signal?: AbortSignal) => signal?.throwIfAborted() },
  } as never);
  const terminal = await createTestRenderer({ width, height, kittyKeyboard: encoding === "kitty", exitOnCtrlC: false });
  terminal.renderer.copyToClipboardOSC52 = () => true;
  let submission: Promise<unknown> = Promise.resolve();
  const view = createConversationView(terminal.renderer, { controller, home, workspaceRoot: work, env: { NO_COLOR: "1" }, secrets: [], motion: "off", quit() {},
    submit: (value, accepted) => submission = dispatchEditorInput(value, controller, command =>
      command.name === "changes" ? controller.changesCommand(command.args) : command.name === "undo" ? controller.undoCommand(command.args) : Promise.resolve(false), accepted) });
  const find = <T>(id: string) => terminal.renderer.root.findDescendantById(id) as T;
  const editor = find<TextareaRenderable>("prompt");
  const settle = async () => { await Bun.sleep(2); view.refresh(); await terminal.flush(); view.refresh(); await terminal.flush(); };
  const waitFor = async (ready: () => boolean, label: string) => {
    const start = performance.now();
    while (!ready()) { if (performance.now() - start > 5000) throw new Error(`Timed out: ${label}\n${terminal.captureCharFrame()}`); await settle(); }
    await settle();
  };
  /** Send raw terminal bytes in one stdin read, as a terminal or SSH session may batch them. */
  const input = async (bytes: string) => { terminal.renderer.stdin.emit("data", Buffer.from(bytes)); await Bun.sleep(30); await settle(); };
  const enter = async () => { terminal.mockInput.pressEnter(); await Promise.race([submission, Bun.sleep(30)]); await settle(); };
  const type = async (text: string) => { await terminal.mockInput.typeText(text); await settle(); };
  /** Send a task and answer its model calls with the outcomes in order, repeating the last until the turn settles. */
  const turn = async (prompt: string, outcome: Outcome, ...more: Outcome[]) => {
    await type(prompt); await enter();
    await waitFor(() => gate.waiting() === 1, "turn waiting");
    const outcomes = [outcome, ...more];
    while (controller.running) { if (gate.waiting()) gate.release(outcomes.length > 1 ? outcomes.shift()! : outcomes[0]!); await Bun.sleep(5); }
    await settle();
  };
  let closed = false;
  cleanups.push(async () => { if (closed) return; closed = true; view.destroy(); controller.dispose(); terminal.renderer.destroy(); await controller.waitForIdle(); });
  await settle();
  return {
    ...terminal, ...gate, keys: KEYS[encoding], home, work, controller, session, editor, settle, waitFor, input, enter, type, turn,
    frame: () => terminal.captureCharFrame(),
    hints: () => find<TextRenderable>("hints").plainText,
    readerText: () => find<TextRenderable>("reader-text").plainText,
    transcript: find<{ scrollTo(y: number): void }>("transcript"),
  };
}

const escExit = /(^|· )Esc( |$)/;
const encodings: Encoding[] = ["kitty", "legacy"];

// D1: Up/Down history recall must use the editor's current layout, not the one from the previous render.
for (const encoding of encodings) test(`[${encoding}] Up after a multiline draft arrives in the same input read moves the cursor instead of recalling history`, async () => {
  const ui = await setup(encoding);
  await ui.turn("first prompt", { text: "one" });
  // Bracketed paste and the arrow arrive in one read, so no render happens between them.
  await ui.input("\x1b[200~line one\nline two\x1b[201~\x1b[A");
  expect(ui.editor.plainText).toBe("line one\nline two");
  expect(ui.editor.cursorOffset).toBe(8);
  ui.editor.setText(""); await ui.settle();
  // Typed newline key (Shift+Enter in kitty, Ctrl+J in a legacy terminal), then Up, all in one read.
  await ui.input(`line one${ui.keys.newline}line two\x1b[A`);
  expect(ui.editor.plainText).toBe("line one\nline two");
  expect(ui.editor.cursorOffset).toBe(8);
  // From the first row, Up still recalls history and Down restores the draft.
  await ui.input("\x1b[A");
  expect(ui.editor.plainText).toBe("first prompt");
  await ui.input("\x1b[B");
  expect(ui.editor.plainText).toBe("line one\nline two");
});

// D3: the palette search is one line in every key encoding.
for (const encoding of encodings) test(`[${encoding}] newline keys in the palette search never add a line to the query`, async () => {
  const ui = await setup(encoding);
  await ui.type("ร่าง draft");
  await ui.input(ui.keys.altH);
  expect(ui.controller.commandHelpOpen).toBe(true);
  await ui.type("copy");
  await ui.input(ui.keys.newline);
  expect(ui.editor.plainText).toBe("copy");
  await ui.type("x");
  expect(ui.editor.plainText).toBe("copyx");
  expect(ui.controller.commandHelpOpen).toBe(true);
  expect(ui.frame()).not.toContain("No matches · Clear search");
  await ui.input(ui.keys.esc);
  expect(ui.controller.commandHelpOpen).toBe(false);
  expect(ui.editor.plainText).toBe("ร่าง draft");
});

// D4: revealing a search match near the end keeps the reader body full.
const table = (rows: number) => ["| Name | Value |", "| --- | --- |", ...Array.from({ length: rows }, (_, i) => `| row ${i} | six ${i} |`)].join("\n");
test("reader search reveal near the end stops at the last full page", () => {
  const document = createReaderDocument({ id: "table-m-0", messageId: "m", kind: "table" }, table(24), { title: "table", streaming: false });
  const layout = readerLayout(document, false, 60, 24, { approval: false, search: true });
  const match = document.view.search("six 22").matches[0]!;
  const revealed = revealMatch(document, layout, { offset: document.bodyStart, horizontal: 0 }, match);
  expect(document.view.view(revealed, layout.viewport).rows.length).toBe(layout.viewport.rows);
  expect(readerEnd(document, layout, 0).offset).toBe(revealed.offset);
  expect(scrollReader(document, layout, revealed, 1).offset).toBe(revealed.offset);
  // An early match keeps its one-third placement.
  const early = revealMatch(document, layout, { offset: document.bodyStart, horizontal: 0 }, document.view.search("six 10").matches[0]!);
  expect(early.offset).toBeLessThan(revealed.offset);
});

test("[kitty] reader Enter keep near the end of a table leaves no blank body rows and End does not move back", async () => {
  const ui = await setup("kitty");
  await ui.turn("summarize", { text: `Summary.\n\n${table(24)}\n\nDone.` });
  ui.transcript.scrollTo(0); await ui.settle();
  await ui.input(ui.keys.altI);
  await ui.input("r");
  expect(ui.readerText()).toContain("Read table");
  await ui.input(ui.keys.ctrlF);
  await ui.type("six 22");
  await ui.enter();
  const kept = ui.readerText();
  const lines = kept.split("\n");
  // Every row below the header shows table text; none is left blank.
  expect(lines.slice(1).every(line => line.trim().length > 0)).toBe(true);
  expect(kept).toContain("six 23");
  await ui.input("\x1b[F");
  expect(ui.readerText().split("\n")[0]).toBe(lines[0]);
});

// D5/D6: narrow hint rows keep the Esc way out in palette layers, slash suggestions and conversation search.
for (const encoding of encodings) test(`[${encoding} 40x20] palette, slash suggestions and Ctrl+F search keep their Esc exit`, async () => {
  const ui = await setup(encoding, 40, 20);
  await ui.turn("first task", { text: "line value 3 answer" });
  await ui.type("keep me");
  await ui.input(ui.keys.altH);
  expect(ui.hints()).toMatch(escExit);
  expect(ui.hints()).toContain("Enter insert");
  await ui.input("\t");
  expect(ui.hints()).toMatch(escExit);
  await ui.input(ui.keys.esc);
  if (ui.controller.commandHelpOpen) await ui.input(ui.keys.esc);
  expect(ui.editor.plainText).toBe("keep me");
  ui.editor.setText(""); await ui.settle();
  await ui.type("/");
  expect(ui.hints()).toContain("Esc dismiss");
  await ui.input(ui.keys.esc);
  ui.editor.setText(""); await ui.settle();
  await ui.input(ui.keys.ctrlF);
  await ui.type("value 3");
  expect(ui.hints()).toContain("Esc restore");
});

test("every 40-column catalog hint row keeps the Esc exit its 50-column variant shows", async () => {
  const goldens = join(import.meta.dir, "screen-catalog", "goldens");
  const lastRow = async (path: string) => {
    const text = (await readFile(path, "utf8")).split("== text\n")[1]!.split("\n== styles")[0]!;
    return text.trimEnd().split("\n").at(-1)!.trim();
  };
  let compared = 0;
  for (const screen of await readdir(goldens, { withFileTypes: true })) {
    if (!screen.isDirectory()) continue;
    const files = await readdir(join(goldens, screen.name));
    for (const narrow of files.filter(file => /-40(x8)?\.golden$/.test(file))) {
      const wide = narrow.replace("-40", "-50");
      if (!files.includes(wide) || !escExit.test(await lastRow(join(goldens, screen.name, wide)))) continue;
      compared++;
      expect(await lastRow(join(goldens, screen.name, narrow)), `${screen.name}/${narrow}`).toMatch(escExit);
    }
  }
  // Palette, reader, inspection, search and draft screens all have narrow variants to compare.
  expect(compared).toBeGreaterThan(20);
});

// D7: a write-blocked session never offers Enter send from the palette or the Alt+I notice.
test("palette availability names the blocked-session keys instead of Enter send", () => {
  const context = { running: false, toolApproval: false, inspectable: false, details: false, blockedSubmit: SESSION_BLOCKED_HINT };
  const availability = keyboardGuideAvailability(context);
  expect(availability.cancel).toEqual({ available: false, reason: `Nothing running · ${SESSION_BLOCKED_HINT}` });
  expect(availability["inspect-copy"]).toEqual({ available: false, reason: `Nothing to inspect · ${SESSION_BLOCKED_HINT}` });
  expect(nothingToInspectReason({ running: false, blockedSubmit: "" })).toBe("Nothing to inspect · Enter send a task");
  expect(nothingToInspectReason({ running: true, blockedSubmit: SESSION_BLOCKED_HINT })).toBe("Nothing to inspect yet · Esc stop");
});

for (const encoding of encodings) test(`[${encoding}] blocked session: palette guide and Alt+I notice agree with the hint row`, async () => {
  const ui = await setup(encoding);
  await ui.turn("first task", { text: "plain answer" });
  await ui.type("next draft");
  ui.session.append = () => { throw new Error("disk full"); };
  await ui.enter();
  expect(ui.controller.snapshot().sessionWriteBlocked).toBe(true);
  expect(ui.hints()).toStartWith(SESSION_BLOCKED_HINT);
  await ui.input(ui.keys.altH);
  await ui.type("cancel");
  expect(ui.frame()).toContain(`! Nothing running · ${SESSION_BLOCKED_HINT}`);
  expect(ui.frame()).not.toContain("Enter send");
  await ui.input(ui.keys.esc);
  expect(ui.editor.plainText).toBe("next draft");
  await ui.input(ui.keys.altI);
  expect(ui.frame()).toContain(`Nothing to inspect · ${SESSION_BLOCKED_HINT}`);
  expect(ui.frame()).not.toContain("Enter send");
  expect(ui.prompts).toEqual(["first task"]);
});

// D8: a missing workspace directory is reported as such, not as a missing Git binary.
test("/changes status and diff report a missing workspace the way review does", async () => {
  const ui = await setup("legacy");
  await rename(ui.work, `${ui.work}-moved`);
  const status = await inspectGitStatus(ui.work);
  expect("error" in status && status.error).toContain(`workspace unavailable: ${ui.work} is missing`);
  const preview = await getGitDiffPreview(ui.work);
  expect("error" in preview && preview.error).not.toContain("git unavailable");
  for (const args of ["status", "diff"]) {
    expect(await ui.controller.changesCommand(args)).toBe(false);
    const text = ui.controller.snapshot().transcript.at(-1)!.text;
    expect(text).toBe(`Workspace unavailable · Restore ${ui.work}, then run /changes again`);
  }
  await rename(`${ui.work}-moved`, ui.work);
  expect(await ui.controller.changesCommand("status")).toBe(true);
});

// D11: Esc from F2 details or a panel returns to following the latest output.
const longAnswer = [...Array.from({ length: 40 }, (_, i) => `recovered line ${i}`), "END-MARKER"].join("\n");
for (const encoding of encodings) test(`[${encoding}] after F2 details and Esc, Ctrl+R continue shows the new answer`, async () => {
  const ui = await setup(encoding);
  await ui.turn("first task", { error: "Service unavailable", status: 503 });
  expect(ui.controller.snapshot().status).toBe("error");
  await ui.input(ui.keys.f2);
  expect(ui.frame()).toContain("Esc back");
  await ui.input(ui.keys.esc);
  await ui.input(ui.keys.ctrlR);
  await ui.waitFor(() => ui.waiting() === 1, "continue waiting");
  ui.release({ text: longAnswer });
  await ui.waitFor(() => !ui.controller.running, "continue done");
  expect(ui.frame()).toContain("END-MARKER");
  expect(ui.frame()).not.toContain("New activity");
});

for (const encoding of encodings) test(`[${encoding}] palette opened and closed during a turn keeps following the streamed answer`, async () => {
  const ui = await setup(encoding);
  await ui.type("task"); await ui.enter();
  await ui.waitFor(() => ui.waiting() === 1, "turn waiting");
  await ui.input(ui.keys.altH);
  await ui.input(ui.keys.esc);
  expect(ui.controller.commandHelpOpen).toBe(false);
  ui.release({ text: longAnswer });
  await ui.waitFor(() => !ui.controller.running, "turn done");
  expect(ui.frame()).toContain("END-MARKER");
});

// D12: a reader notice ends with the reader, and any notice is repainted away when it expires.
for (const encoding of encodings) test(`[${encoding}] closing the reader clears its copy notice and the failed outcome returns`, async () => {
  const ui = await setup(encoding);
  await ui.turn("first task", { text: "ok\n\n```ts\nconst y = 2;\n```" });
  await ui.turn("second task", { error: "Service unavailable", status: 503 });
  expect(ui.frame()).toContain("✗ Failed");
  await ui.input(ui.keys.altI);
  await ui.input("r");
  await ui.input("c");
  expect(ui.frame()).toContain("Copied code · Esc back");
  await ui.input(ui.keys.esc);
  await ui.input(ui.keys.esc);
  expect(ui.frame()).not.toContain("Copied code");
  expect(ui.frame()).toContain("✗ Failed");
});

test("an expired notice is repainted away without further input", async () => {
  const ui = await setup("kitty");
  await ui.turn("first task", { text: "ok\n\n```ts\nconst y = 2;\n```" });
  await ui.input(ui.keys.altI);
  await ui.input("r");
  await ui.input("c");
  expect(ui.frame()).toContain("Copied code · Esc back");
  await Bun.sleep(2700);
  await ui.flush();
  expect(ui.frame()).not.toContain("Copied code");
}, 10_000);

// D2: Details for a review opened from the undo panel describe what was actually read.
const editTurn: Outcome[] = [{ toolCalls: [{ id: "edit-1", name: "edit", arguments: { path: "note.txt", edits: [{ oldText: "before", newText: "after" }] } }] }, { text: "Edited." }];
const undoReviewCases = [
  { name: "tracking off", git: true, tracking: "off" as const, says: "review read no Git state" },
  { name: "non-Git", git: false, tracking: "on-demand" as const, says: "Git found no repository enclosing this workspace" },
  { name: "Git", git: true, tracking: "on-demand" as const, says: "Current diff is read from Git when review opens" },
];
for (const encoding of encodings) for (const scenario of undoReviewCases) test(`[${encoding}] undo-panel review Details stay truthful (${scenario.name})`, async () => {
  const ui = await setup(encoding, 100, 30, scenario);
  await ui.turn("edit the note", editTurn[0]!, editTurn[1]!);
  expect(ui.controller.snapshot().outcome).toBeDefined();
  await ui.type("/undo");
  await ui.input(ui.keys.esc);
  await ui.enter();
  await ui.waitFor(() => !!ui.controller.snapshot().undoPreview, "undo panel");
  await ui.input(ui.keys.altR);
  await ui.waitFor(() => ui.controller.snapshot().changeReview?.loading === false, "undo review");
  await ui.input(ui.keys.f2);
  const review = ui.controller.snapshot().changeReview!;
  expect(review.showingDetails).toBe(true);
  expect(review.details).toContain(scenario.says);
  if (scenario.name !== "Git") expect(review.details).not.toContain("read from Git");
  expect(ui.frame()).toContain("paths in the undo panel");
});

// D9: a write-blocked session points /undo at commands that work as typed.
test("blocked session /undo names the same next step as the hint row", async () => {
  const ui = await setup("legacy");
  await ui.turn("first task", { text: "plain answer" });
  ui.session.append = () => { throw new Error("disk full"); };
  await ui.type("draft"); await ui.enter();
  expect(ui.controller.snapshot().sessionWriteBlocked).toBe(true);
  ui.editor.setText(""); await ui.settle();
  await ui.type("/undo");
  await ui.input(ui.keys.esc);
  await ui.enter();
  expect(ui.controller.snapshot().transcript.at(-1)!.text).toBe(`Session storage blocked · ${SESSION_BLOCKED_HINT}`);
  ui.editor.setText(""); await ui.settle();
  expect(ui.hints()).toStartWith(SESSION_BLOCKED_HINT);
});
