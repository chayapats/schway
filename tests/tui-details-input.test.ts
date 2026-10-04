import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { createConversationView, type ConversationViewOptions } from "../src/tui/view.ts";
import { TuiController, type TuiControllerOptions } from "../src/tui/controller.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { ConfigEditor } from "../src/config/editing.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { bashTool } from "../src/tools/bash.ts";
import { writeTool } from "../src/tools/write.ts";
import { withTempDir } from "./helpers.ts";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function setup(overrides: Partial<TuiControllerOptions> = {}, options: Partial<ConversationViewOptions> = {}, kittyKeyboard = false) {
  const terminal = await createTestRenderer({ width: 80, height: 24, kittyKeyboard, exitOnCtrlC: false });
  const workspace = { root: "/project", launchCwd: "/project", extraRoots: [] };
  const session = createSession();
  const controller = new TuiController({ session, workspace, sessionId: "details-input", provider: "scripted", modelId: "fixture",
    model: createScriptedModel(), contextManager: createContextManager(workspace), changeTracking: "off", secrets: ["fixture-secret"],
    credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ model: createScriptedModel() }) }, ...overrides });
  let quits = 0;
  const view = createConversationView(terminal.renderer, { controller, workspaceRoot: workspace.root, home: "/home/test", env: {}, secrets: ["fixture-secret"],
    motion: "off", submit: async () => {}, quit: () => { quits++; }, ...options });
  let closed = false;
  const close = () => { if (!closed) { closed = true; view.destroy(); controller.dispose(); terminal.renderer.destroy(); } };
  cleanups.push(close);
  const editor = terminal.renderer.root.findDescendantById("prompt") as TextareaRenderable;
  const transcript = terminal.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable;
  const settle = async () => { view.refresh(); await terminal.flush(); };
  const input = async (bytes: string) => {
    const decoded = Promise.withResolvers<void>();
    const received = () => decoded.resolve();
    terminal.renderer.keyInput.prependListener("keypress", received);
    const timer = setTimeout(() => decoded.reject(new Error("Terminal input was not decoded")), 1000);
    try { terminal.renderer.stdin.emit("data", Buffer.from(bytes)); await decoded.promise; }
    finally { clearTimeout(timer); terminal.renderer.keyInput.off("keypress", received); }
    await settle();
  };
  await settle();
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 2000;
    while (!predicate() && Date.now() < deadline) await settle();
    expect(predicate(), "Expected controller state before deadline").toBe(true);
  };
  return { ...terminal, controller, session, view, editor, transcript, settle, input, waitFor, close, quits: () => quits };
}

const aliases = [
  ["SS3 F2", "\x1bOQ", false], ["CSI F2", "\x1b[12~", false],
  ["Linux F2", "\x1b[[B", false], ["CSI letter F2", "\x1b[Q", false],
  ["Kitty F2", "\x1b[57365;1u\x1b[57365;1:3u", true],
  ["Kitty Ctrl+I", "\x1b[105;5u\x1b[105;5:3u", true],
  ["modifyOtherKeys Ctrl+I", "\x1b[27;5;105~", false],
] as const;

for (const [name, bytes, kitty] of aliases) test(`${name} opens structured notice Details once and Esc restores the editor and viewport`, async () => {
  const ui = await setup({}, {}, kitty);
  for (let index = 0; index < 30; index++) ui.controller.notice(`Earlier message ${index}`);
  ui.controller.notice("Saved locally · F2 details", "Diagnostic fixture-secret\n" + "evidence\n".repeat(30));
  ui.editor.setText("ร่างภาษาไทย\nยังไม่ส่ง 🧪"); ui.editor.cursorOffset = 9; ui.editor.setSelection(3, 9);
  await ui.settle(); ui.transcript.stickyScroll = false; ui.transcript.scrollTo(4); await ui.flush();
  const before = { text: ui.editor.plainText, cursor: ui.editor.cursorOffset, selection: ui.editor.getSelectedText(), scroll: ui.transcript.scrollTop };
  const count = ui.controller.snapshot().transcript.length;
  await ui.input(bytes);
  expect(ui.controller.snapshot().transcript).toHaveLength(count + 1);
  expect(ui.controller.snapshot().transcript.at(-1)?.text).toContain("Diagnostic ***");
  expect(ui.captureCharFrame()).not.toContain("fixture-secret");
  expect(ui.controller.snapshot().noticeDetailsAvailable).toBe(false);
  await ui.input("\x1b");
  expect({ text: ui.editor.plainText, cursor: ui.editor.cursorOffset, selection: ui.editor.getSelectedText(), scroll: ui.transcript.scrollTop }).toEqual(before);
  expect(ui.session.items).toHaveLength(0);
});

test("F2 without details is inert and legacy Tab still completes commands", async () => {
  const ui = await setup();
  ui.editor.setText("/mo"); await ui.settle();
  await ui.input("\x1bOQ");
  expect(ui.editor.plainText).toBe("/mo"); expect(ui.session.items).toHaveLength(0);
  await ui.input("\x1b[Z"); expect(ui.controller.snapshot().approvalMode).toBe("auto");
  await ui.input("\t"); expect(ui.editor.plainText).toBe("/model ");
  ui.editor.setText("draft"); ui.editor.gotoBufferEnd(); await ui.settle();
  await ui.input("\x1b[Z"); expect(ui.controller.snapshot().approvalMode).toBe("ask");
  await ui.input("\n"); expect(ui.editor.plainText).toBe("draft\n"); expect(ui.session.items).toHaveLength(0);
});

test("model Details Esc restores the selected exact model and query before closing the picker", async () => {
  const ui = await setup({ provider: "openai", modelId: "gpt-4.1",
    credentials: { store: fakeCredentialStore(), env: { OPENAI_API_KEY: "fixture-secret" }, reload: async () => ({ model: createScriptedModel() }),
      listRouteModels: async () => [{ id: "gpt-4.1", contextWindow: 100000, maxOutput: 1000 }] } });
  ui.editor.setText("เก็บร่าง 🧪"); ui.editor.cursorOffset = 3; ui.editor.setSelection(1, 3);
  const draft = { text: ui.editor.plainText, cursor: ui.editor.cursorOffset, selection: ui.editor.getSelectedText() };
  ui.controller.openModelPicker();
  const deadline = Date.now() + 2000;
  while (ui.controller.snapshot().modelPicker?.loading && Date.now() < deadline) await ui.settle();
  expect(ui.controller.snapshot().modelPicker?.loading).toBe(false);
  ui.controller.searchModels("gpt-4.1"); await ui.settle();
  const before = ui.controller.snapshot().modelPicker!;
  expect(before.entries[before.selectedIndex]?.kind).toBe("model");
  await ui.input("\x1bOQ"); expect(ui.controller.snapshot().modelPicker?.details).toBe(true);
  await ui.input("\x1b");
  expect(ui.controller.snapshot().modelPicker).toMatchObject({ query: before.query, selectedIndex: before.selectedIndex, details: false });
  await ui.input("\x1b"); expect(ui.controller.snapshot().modelPicker).toBeUndefined();
  expect({ text: ui.editor.plainText, cursor: ui.editor.cursorOffset, selection: ui.editor.getSelectedText() }).toEqual(draft);
});

for (const bytes of ["\x1bOQ", "\x1b[105;5u\x1b[105;5:3u"]) test(`Details ${JSON.stringify(bytes)} uses recovery state after its primary hint changes`, async () => {
  const ui = await setup({ model: undefined, startupError: "unknown model fixture-secret" }, {}, true);
  ui.editor.setText("ยังไม่ส่ง 🧪"); ui.editor.cursorOffset = 2; await ui.settle();
  expect(ui.captureCharFrame()).toContain("F2 details");
  expect(ui.controller.snapshot().recovery?.actions).toContain("details");
  const recovery = ui.controller.snapshot().recovery;
  await ui.input(bytes);
  expect(ui.controller.snapshot().transcript.at(-1)?.text).toContain("unknown model ***");
  expect(ui.captureCharFrame()).not.toContain("fixture-secret");
  await ui.input("\x1b");
  expect(ui.controller.snapshot().recovery).toEqual(recovery);
  expect(ui.editor.plainText).toBe("ยังไม่ส่ง 🧪"); expect(ui.editor.cursorOffset).toBe(2);
  expect(ui.session.items).toHaveLength(0);
});

test("a real failing command and retained failed outcome are reachable by either alias", async () => withTempDir(async root => {
  const workspace = { root, launchCwd: root, extraRoots: [] };
  const ui = await setup({ workspace, contextManager: createContextManager(workspace), tools: createToolRegistry([bashTool]),
    model: createScriptedModel({ responses: [{ toolCalls: [{ id: "call_private_failure", name: "bash", arguments: { command: "printf 'fixture-secret\\n'; exit 7" } }] }, { error: "provider fixture-secret", status: 400 }] }) });
  try {
    await ui.controller.submit("Run the fixture command"); await ui.settle();
    expect(ui.controller.snapshot().outcome?.reason).toBe("failed"); expect(ui.captureCharFrame()).toContain("F2 details");
    await ui.input("\x1b"); expect(ui.controller.snapshot().recovery).toBeUndefined();
    for (const bytes of ["\x1bOQ", "\x1b[27;5;105~"]) {
      await ui.input(bytes);
      const details = ui.controller.snapshot().transcript.at(-1)!.text;
      expect(details).toContain("exit 7"); expect(details).toContain("provider ***"); expect(details).not.toContain("fixture-secret");
      await ui.input("\x1b");
    }
    expect(ui.session.items.filter(item => item.type === "user")).toHaveLength(1);
  } finally { ui.close(); }
}));

test("review Details toggles restore the same file and diff scroll before the selected draft", async () => withTempDir(async root => {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env, timeout: 5000, stdio: "pipe" });
  git("init", "-q"); await writeFile(join(root, "long.txt"), "before\n"); git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "baseline");
  const workspace = { root, launchCwd: root, extraRoots: [] };
  const ui = await setup({ workspace, contextManager: createContextManager(workspace), changeTracking: "on-demand", tools: createToolRegistry([writeTool]),
    model: createScriptedModel({ responses: [{ toolCalls: [{ id: "write-long", name: "write", arguments: { path: "long.txt", content: Array.from({ length: 80 }, (_, i) => `line ${i} ไทย 🧪`).join("\n") } }] }, { text: "Written" }] }) });
  try {
    await ui.controller.submit("Write the long file"); await ui.settle();
    ui.editor.setText("เก็บร่างไทย 🧪"); ui.editor.cursorOffset = 5; ui.editor.setSelection(2, 5);
    const draft = { text: ui.editor.plainText, cursor: ui.editor.cursorOffset, selection: ui.editor.getSelectedText(), scroll: ui.transcript.scrollTop };
    const opening = ui.controller.openChangeReview(); await ui.settle(); await opening; await ui.settle();
    const diff = ui.renderer.root.findDescendantById("change-review-diff") as ScrollBoxRenderable;
    diff.scrollTo(18); await ui.flush(); const scroll = diff.scrollTop; expect(scroll).toBeGreaterThan(0);
    const selected = ui.controller.snapshot().changeReview!.files[ui.controller.snapshot().changeReview!.selected]!.path;
    for (const bytes of ["\x1bOQ", "\x1b[27;5;105~"]) {
      await ui.input(bytes); expect(ui.controller.snapshot().changeReview?.showingDetails).toBe(true);
      await ui.input("\x1b"); expect(ui.controller.snapshot().changeReview?.showingDetails).toBe(false);
      expect(diff.scrollTop).toBe(scroll);
      expect(ui.controller.snapshot().changeReview!.files[ui.controller.snapshot().changeReview!.selected]!.path).toBe(selected);
    }
    await ui.input("\x1b"); expect(ui.controller.snapshot().changeReview).toBeUndefined();
    expect({ text: ui.editor.plainText, cursor: ui.editor.cursorOffset, selection: ui.editor.getSelectedText(), scroll: ui.transcript.scrollTop }).toEqual(draft);
  } finally { ui.close(); }
}));

test("credential entry retains masked input and never reveals retained notice details", async () => {
  let writes = 0;
  const store = { ...fakeCredentialStore(), async set() { writes++; } };
  const ui = await setup({ credentials: { store, env: {}, reload: async () => ({ model: createScriptedModel() }) } }, {}, true);
  ui.controller.notice("F2 details", "private diagnostic");
  expect(ui.controller.beginLogin("openai")).toBe(true); ui.controller.enterCredentialText("fixture-secret"); await ui.settle();
  const before = ui.controller.snapshot().credentialEntry;
  for (const bytes of ["\x1bOQ", "\x1b[105;5u\x1b[105;5:3u"]) await ui.input(bytes);
  expect(ui.controller.snapshot().credentialEntry).toEqual(before);
  expect(ui.controller.snapshot().noticeDetailsAvailable).toBe(true);
  expect(ui.captureCharFrame()).not.toContain("fixture-secret"); expect(ui.captureCharFrame()).not.toContain("private diagnostic");
  expect(writes).toBe(0);
});

test("pending approval and its denial editor retain ownership over both Details aliases", async () => {
  const configEditor = new ConfigEditor({ cli: { approval: { mode: "ask" } } }, { user: "/unused-user.json", project: "/unused-project.json" });
  const ui = await setup({ configEditor, tools: createToolRegistry([bashTool]),
    model: createScriptedModel({ responses: [{ toolCalls: [{ id: "needs-approval", name: "bash", arguments: { command: "printf denied" } }] }, { text: "done" }] }) }, {}, true);
  ui.editor.setText("ordinary draft");
  const turn = ui.controller.submit("Ask first");
  try {
    await ui.waitFor(() => !!ui.controller.snapshot().toolApproval);
    ui.controller.notice("F2 details", "unrelated diagnostic"); await ui.settle();
    for (const reason of [false, true]) {
      if (reason) { ui.controller.moveToolApproval(2); ui.controller.chooseToolApproval(); await ui.settle(); ui.editor.setText("retain this reason"); }
      const before = ui.controller.snapshot().toolApproval; const text = ui.editor.plainText;
      for (const bytes of ["\x1bOQ", "\x1b[105;5u\x1b[105;5:3u"]) await ui.input(bytes);
      expect(ui.controller.snapshot().toolApproval).toEqual(before); expect(ui.editor.plainText).toBe(text);
      expect(ui.controller.snapshot().noticeDetailsAvailable).toBe(true); expect(ui.captureCharFrame()).not.toContain("unrelated diagnostic");
    }
  } finally { ui.controller.cancel(); await turn; ui.close(); }
});

for (const owner of ["search", "help", "preferences", "tree", "login"] as const) test(`${owner} retains input when Details is unavailable on that surface`, async () => {
  const configEditor = new ConfigEditor({}, { user: "/unused-user.json", project: "/unused-project.json" });
  const ui = await setup({ configEditor });
  ui.controller.notice("F2 details", "must stay hidden");
  if (owner === "search") await ui.input("\x06");
  else if (owner === "help") ui.controller.openCommandHelp();
  else if (owner === "preferences") ui.controller.openPreferences();
  else if (owner === "tree") ui.controller.openBranchTree();
  else ui.controller.openLoginChooser();
  await ui.settle(); const snapshot = ui.controller.snapshot(); const text = ui.editor.plainText;
  for (const bytes of ["\x1bOQ", "\x1b[27;5;105~"]) await ui.input(bytes);
  expect(ui.controller.snapshot()).toEqual(snapshot); expect(ui.editor.plainText).toBe(text);
  expect(ui.captureCharFrame()).not.toContain("must stay hidden"); expect(ui.quits()).toBe(0);
});


test("Details entered from inspection returns to the same painted block before the composer", async () => {
  const ui = await setup();
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "```txt\nตรวจสอบ 🧪\n```" } });
  ui.controller.applyEvent({ type: "model.finished" });
  ui.controller.notice("F2 details", "Local diagnostic");
  ui.editor.setText("ร่างเดิม"); ui.editor.cursorOffset = 3; await ui.settle();
  await ui.input("\x1bi"); expect(ui.editor.focused).toBe(false);
  const before = ui.captureCharFrame(); expect(before).toContain("C copy");
  await ui.input("\x1bOQ"); expect(ui.captureCharFrame()).toContain("Local diagnostic");
  await ui.input("\x1b"); expect(ui.editor.focused).toBe(false); expect(ui.captureCharFrame()).toContain("C copy");
  let copied = ""; ui.renderer.copyToClipboardOSC52 = text => { copied = text; return true; };
  await ui.input("c"); expect(copied).toBe("ตรวจสอบ 🧪");
  await ui.input("\x1b"); expect(ui.editor.focused).toBe(true);
  expect(ui.editor.plainText).toBe("ร่างเดิม"); expect(ui.editor.cursorOffset).toBe(3);
});

test("a same-ID session replacement discards the Details return bookmark", async () => {
  const ui = await setup();
  for (let index = 0; index < 30; index++) ui.controller.notice(`Earlier ${index}`);
  ui.controller.notice("F2 details", "Old diagnostic\n" + "old\n".repeat(30));
  await ui.settle(); ui.transcript.stickyScroll = false; ui.transcript.scrollTo(4); await ui.flush();
  await ui.input("\x1bOQ");
  const replacement = createSession([{ type: "assistant", id: "new-answer", content: [{ type: "text", text: "New conversation\n".repeat(45) }] }]);
  ui.controller.replaceSession(replacement, "details-input"); await ui.settle();
  ui.transcript.stickyScroll = false; ui.transcript.scrollTo(12); await ui.flush(); const scroll = ui.transcript.scrollTop;
  await ui.input("\x1b"); expect(ui.transcript.scrollTop).toBe(scroll);
  expect(ui.controller.snapshot().noticeDetailsAvailable).toBe(false);
  expect(ui.captureCharFrame()).not.toContain("Old diagnostic");
});

test("model loading and connection group rows do not expose Details", async () => {
  const catalog = Promise.withResolvers<{ id: string }[]>();
  const ui = await setup({ provider: "openai", modelId: "fixture", credentials: { store: fakeCredentialStore(), env: { OPENAI_API_KEY: "fixture-secret" },
    reload: async () => ({ model: createScriptedModel() }), listRouteModels: () => catalog.promise } });
  ui.controller.openModelPicker(); await ui.settle();
  try {
    expect(ui.controller.snapshot().modelPicker?.loading).toBe(true);
    await ui.input("\x1bOQ"); expect(ui.controller.snapshot().modelPicker?.details).not.toBe(true);
    expect(ui.captureCharFrame()).not.toContain("F2 details");
  } finally { catalog.resolve([]); await ui.waitFor(() => !ui.controller.snapshot().modelPicker?.loading); }
  ui.controller.searchModels("no-model-match"); await ui.settle();
  expect(ui.controller.snapshot().modelPicker?.entries[ui.controller.snapshot().modelPicker!.selectedIndex]?.kind).not.toBe("model");
  await ui.input("\x1bOQ"); expect(ui.controller.snapshot().modelPicker?.details).not.toBe(true);
});

for (const size of [[24, 8], [50, 8], [80, 24]] as const) test(`Details keeps its return action visible at ${size.join("x")}`, async () => {
  const ui = await setup(); ui.resize(size[0], size[1]); await ui.settle();
  ui.controller.notice("F2 details", "ตรวจสอบ 🧪"); await ui.settle(); await ui.input("\x1bOQ");
  expect(ui.captureCharFrame()).toContain("Esc back");
  if (size[1] === 8) expect(ui.captureCharFrame()).toContain("Auto");
  await ui.input("\x1b"); expect(ui.captureCharFrame()).not.toContain("Esc back");
});


test("pending approval still owns Details while inspection hides its panel", async () => {
  const configEditor = new ConfigEditor({ cli: { approval: { mode: "ask" } } }, { user: "/unused-user.json", project: "/unused-project.json" });
  const ui = await setup({ configEditor, tools: createToolRegistry([bashTool]),
    model: createScriptedModel({ responses: [{ toolCalls: [{ id: "hidden-approval", name: "bash", arguments: { command: "printf denied" } }] }] }) });
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "```txt\nInspect this\n```" } });
  ui.controller.applyEvent({ type: "model.finished" }); await ui.settle(); await ui.input("\x1bi");
  const turn = ui.controller.submit("Ask first");
  try {
    await ui.waitFor(() => !!ui.controller.snapshot().toolApproval);
    ui.controller.notice("F2 details", "must stay hidden"); await ui.settle();
    expect(ui.editor.focused).toBe(false);
    expect(ui.renderer.root.findDescendantById("tool-approval-panel")?.visible).toBe(false);
    const approval = ui.controller.snapshot().toolApproval;
    for (const bytes of ["\x1bOQ", "\x1b[27;5;105~"]) await ui.input(bytes);
    expect(ui.controller.snapshot().toolApproval).toEqual(approval);
    expect(ui.controller.snapshot().noticeDetailsAvailable).toBe(true);
    expect(ui.captureCharFrame()).not.toContain("must stay hidden");
  } finally { ui.controller.cancel(); await turn; ui.close(); }
});

test("review without a live turn toggles Details through both aliases and explains the missing turn record", async () => {
  const ui = await setup(); await ui.controller.openChangeReview(); await ui.settle();
  expect(ui.controller.snapshot().outcome).toBeUndefined();
  expect(ui.captureCharFrame()).toContain("F2 details");
  for (const bytes of ["\x1bOQ", "\x1b[27;5;105~"]) {
    await ui.input(bytes);
    expect(ui.controller.snapshot().changeReview?.showingDetails).toBe(true);
    expect(ui.captureCharFrame()).toContain("Previous turn details unavailable");
    await ui.input(bytes);
    expect(ui.controller.snapshot().changeReview?.showingDetails).toBe(false);
  }
  expect(ui.session.items).toHaveLength(0);
});
