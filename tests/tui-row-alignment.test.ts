import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { TextareaRenderable, TextRenderable } from "@opentui/core";
import { createConversationView } from "../src/tui/view.ts";
import { TuiController } from "../src/tui/controller.ts";
import { dispatchEditorInput } from "../src/tui/commands.ts";
import { handleSlashCommand } from "../src/tui/app.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { createJsonlSession } from "../src/session/jsonl.ts";
import { resolveWorkspace } from "../src/workspace/workspace.ts";
import { loadConfigEditor } from "../src/config/editing.ts";
import { withTempDir } from "./helpers.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const GOLDENS = join(import.meta.dir, "screen-catalog", "goldens");
const VARIANTS = ["dark-120", "dark-80", "dark-50", "light-120", "light-80", "light-50", "nocolor-dark-120", "nocolor-dark-80", "nocolor-dark-50"];

/** Text rows of one catalog golden, or undefined when the variant is not recorded. */
function goldenRows(screen: string, variant: string): string[] | undefined {
  try {
    const text = readFileSync(join(GOLDENS, screen, `${variant}.golden`), "utf8");
    return text.slice(text.indexOf("== text\n") + 8, text.indexOf("\n== styles")).split("\n");
  } catch { return undefined; }
}

/** Terminal cell where `needle` starts on `row`. */
const cellOf = (row: string, needle: string) => Bun.stringWidth(row.slice(0, row.indexOf(needle)));

/** Render the real conversation view over a scripted model. */
async function setup(width: number, height = 30) {
  const ui = await createTestRenderer({ width, height, kittyKeyboard: true, exitOnCtrlC: false });
  const workspace = { root: "/project", launchCwd: "/project", extraRoots: [] };
  const controller = new TuiController({
    session: createSession(), workspace, provider: "scripted", modelId: "test-model", sessionId: "alignment-session",
    model: createScriptedModel(), contextManager: createContextManager(workspace), secrets: [],
    credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ model: createScriptedModel() }) },
  });
  const copied: string[] = [];
  ui.renderer.copyToClipboardOSC52 = text => { copied.push(text); return true; };
  const view = createConversationView(ui.renderer, { controller, workspaceRoot: "/project", home: "/home/test", env: {}, secrets: [], quit() {}, submit: async () => {} });
  cleanups.push(() => { view.destroy(); controller.dispose(); ui.renderer.destroy(); });
  const settle = async () => { view.refresh(); await ui.flush(); view.refresh(); await ui.flush(); };
  await settle();
  const label = (id: string) => (ui.renderer.root.findDescendantById(`message-${id}`)!.getChildren()[0] as TextRenderable).plainText;
  const toolIds = () => controller.snapshot().transcript.filter(entry => entry.kind === "tool").map(entry => entry.id);
  return { ...ui, controller, settle, copied, label, toolIds, editor: ui.renderer.root.findDescendantById("prompt") as TextareaRenderable };
}

/** Finish one tool call whose first output line becomes its target. */
function finishTool(controller: TuiController, id: string, name: string, target: string, details?: unknown) {
  controller.applyEvent({ type: "tool.started", toolCallId: id, name });
  controller.applyEvent({ type: "tool.finished", toolCallId: id, name, status: "success", content: `${target}\nsecond line`, ...(details ? { details } : {}) });
}

const THAI_TARGET = "ผลลัพธ์ภาษาไทย 🧪 ก้ำ 👩‍💻 ".repeat(6).trim();

test("every model-picker golden starts each selectable row's text in one column and keeps the selected marker", () => {
  let checked = 0;
  for (const variant of VARIANTS) {
    const rows = goldenRows("model-picker", variant);
    if (!rows) continue;
    checked++;
    const names = ["GPT-6 Astra", "fake-coder", "Browse all models", "Connect a provider"];
    const found = names.map(name => rows.find(row => row.includes(name) && !row.includes("Choose model")));
    for (const [index, row] of found.entries()) expect(row, `${variant}: ${names[index]}`).toBeDefined();
    const columns = found.map((row, index) => cellOf(row!, names[index]!));
    expect(new Set(columns).size, `${variant}: ${columns.join(",")}`).toBe(1);
    expect(found[0]!.trimStart().startsWith("› GPT-6 Astra"), variant).toBe(true);
    for (const row of found.slice(1)) expect(row!.includes("›"), variant).toBe(false);
  }
  expect(checked).toBe(VARIANTS.length);
});

test("the focused tool row in inspection-tool keeps the unfocused columns with › in its leading cell", () => {
  let checked = 0;
  for (const variant of [...VARIANTS, "dark-40", "light-40", "nocolor-dark-40"]) {
    const focused = goldenRows("inspection-tool", variant)?.find(row => row.includes(" READ "));
    const unfocused = goldenRows("inspection-unfocused", variant)?.find(row => row.includes(" READ "));
    if (!focused || !unfocused) continue;
    checked++;
    const marker = focused.indexOf("›");
    expect(marker, variant).toBeGreaterThanOrEqual(0);
    expect(unfocused[marker], variant).toBe(" ");
    for (const needle of ["✓", "READ", "ผลลัพธ์"]) expect(cellOf(focused, needle), `${variant} ${needle}`).toBe(cellOf(unfocused, needle));
    // Only the disclosure differs: the focused result is expanded.
    expect(focused.slice(0, marker) + " " + focused.slice(marker + 1).replace("▾", "▸"), variant).toBe(unfocused);
  }
  expect(checked).toBeGreaterThanOrEqual(12);
});

test("completed-turn and stopped-tool goldens start every built-in tool target in one column", () => {
  let checked = 0;
  for (const screen of ["completed-turn", "stopped-tool"]) for (const variant of [...VARIANTS, "dark-40", "light-40", "nocolor-dark-40"]) {
    const rows = goldenRows(screen, variant);
    if (!rows) continue;
    const starts = rows.flatMap(row => {
      const match = row.match(/^\s*[›\s][✓!−●⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+(READ|EDIT|WRITE|BASH|LS|FIND|GREP)\s+(?=\S)/u);
      return match ? [Bun.stringWidth(match[0])] : [];
    });
    if (starts.length < 2) continue;
    checked++;
    expect(new Set(starts).size, `${screen}/${variant}: ${starts.join(",")}`).toBe(1);
  }
  expect(checked).toBeGreaterThanOrEqual(12);
});

for (const width of [80, 40]) {
  test(`one completed row per built-in tool starts every target in one column at ${width} columns`, async () => {
    const ui = await setup(width);
    const tools = ["read", "ls", "find", "grep", "edit", "write", "bash"];
    for (const name of tools) finishTool(ui.controller, `call-${name}`, name, name === "read" ? THAI_TARGET : `${name}-target.ts`, name === "bash" ? { exitCode: 0 } : undefined);
    await ui.settle();
    const labels = ui.toolIds().map(ui.label);
    expect(labels).toHaveLength(tools.length);
    const starts = labels.map((label, index) => {
      expect(Bun.stringWidth(label), label).toBeLessThanOrEqual(width - 2);
      expect(label).toContain(` ${tools[index]!.toUpperCase()}`);
      return Bun.stringWidth(label.match(/^.[✓!−] +\S+ +/u)![0]);
    });
    expect(new Set(starts).size, starts.join(",")).toBe(1);
    // The frame shows each label on one row, unclipped by the terminal edge.
    const frame = ui.captureCharFrame().split("\n");
    for (const label of labels) expect(frame.some(row => row.includes(label.trimEnd()))).toBe(true);
    // A clipped Thai and emoji target keeps whole graphemes.
    const target = labels[0]!.slice(labels[0]!.indexOf("ผ")).trimEnd().replace(/\s*▸$/, "").replace(/…$/, "");
    const boundaries = new Set([0]);
    let offset = 0;
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(THAI_TARGET)) boundaries.add(offset += segment.length);
    expect(THAI_TARGET.startsWith(target)).toBe(true);
    expect(boundaries.has(target.length), target).toBe(true);
    // The shell outcome and disclosure stay visible.
    expect(labels[6]).toContain("Exit 0");
    expect(labels[6]!.trimEnd().endsWith("▸")).toBe(true);
  });
}

test("an extension tool name wider than five cells keeps its full uppercase name without overflow at 40 columns", async () => {
  const ui = await setup(40);
  finishTool(ui.controller, "ext-1", "lint_report", "src/index.ts");
  finishTool(ui.controller, "ext-2", "deploy_preview_now", "staging");
  finishTool(ui.controller, "read-1", "read", "src/index.ts");
  await ui.settle();
  const [lint, deploy, read] = ui.toolIds().map(ui.label);
  expect(lint).toContain(" LINT_REPORT ");
  expect(deploy).toContain(" DEPLOY_PREV… ");
  for (const label of [lint, deploy, read]) expect(Bun.stringWidth(label!)).toBeLessThanOrEqual(38);
  // Built-in pills pad to five cells; a wider name keeps its natural width.
  expect(read).toMatch(/ READ {3}src\/index\.ts/);
  expect(lint).toMatch(/ LINT_REPORT {2}src\/index\.ts/);
});

test("a very narrow tool row pads its kind only up to the room it has", async () => {
  const ui = await setup(15, 20);
  finishTool(ui.controller, "read-1", "read", "src/index.ts");
  finishTool(ui.controller, "ls-1", "ls", "src");
  await ui.settle();
  // At 15 columns the label box is 10 cells wide; padding past the pill's room would push the row beyond it.
  for (const label of ui.toolIds().map(ui.label)) expect(Bun.stringWidth(label)).toBeLessThanOrEqual(10);
});

for (const width of [80, 40]) {
  test(`Tab moves inspection focus across tool rows without moving or reclipping them at ${width} columns`, async () => {
    const ui = await setup(width);
    await ui.mockInput.pasteBracketedText("draft ภาษาไทย 🧪");
    ui.editor.cursorOffset = 4;
    finishTool(ui.controller, "first", "read", `${"wide/target/".repeat(12)}end.ts`);
    finishTool(ui.controller, "second", "grep", THAI_TARGET);
    finishTool(ui.controller, "third", "write", "src/util/range.ts");
    await ui.settle();
    const ids = ui.toolIds();
    const unfocused = ids.map(ui.label);
    // Both long targets fill the room and clip.
    expect(unfocused[0]!.includes("…") && unfocused[1]!.includes("…")).toBe(true);
    for (const label of unfocused) expect(label.startsWith(" ")).toBe(true);
    ui.mockInput.pressKey("i", { meta: true });
    await ui.settle();
    for (let step = 0; step < ids.length; step++) {
      if (step) { ui.mockInput.pressTab(); await ui.settle(); }
      const labels = ids.map(ui.label);
      for (const [index, label] of labels.entries()) {
        if (index === step) {
          expect(label.startsWith("›"), label).toBe(true);
          expect(` ${label.slice(1)}`).toBe(unfocused[index]!);
        } else expect(label).toBe(unfocused[index]!);
      }
      // The frame keeps every glyph, pill and target at the same cell.
      const row = ui.captureCharFrame().split("\n").find(line => line.includes(`›${labels[step]!.slice(1, 12)}`));
      expect(row, `step ${step}`).toBeDefined();
    }
    // Inspection still works: Enter toggles the result, C copies, Esc returns the draft and cursor.
    ui.mockInput.pressEnter(); await ui.settle();
    expect(ui.label(ids[2]!).trimEnd().endsWith("▾")).toBe(true);
    expect(ui.captureCharFrame()).toContain("second line");
    ui.mockInput.pressKey("c");
    expect(ui.copied).toEqual(["src/util/range.ts\nsecond line"]);
    ui.mockInput.pressEscape(); await ui.settle();
    expect(ui.editor.plainText).toBe("draft ภาษาไทย 🧪");
    expect(ui.editor.cursorOffset).toBe(4);
    expect(ui.label(ids[2]!).startsWith(" ")).toBe(true);
  });
}

for (const width of [80, 40]) {
  test(`session picker titles share one column and ↑↓ changes only the marker cell at ${width} columns`, async () => {
    await withTempDir(async home => {
      const workspace = await resolveWorkspace(home);
      const directory = join(home, "sessions");
      const session = await createJsonlSession({ directory, workspace });
      const controller = new TuiController({ session, workspace, model: createScriptedModel(), sessionId: session.header.id, provider: "scripted", modelId: "test", contextManager: createContextManager(workspace, { home }) });
      const config = await loadConfigEditor({ home, workspaceRoot: workspace.root });
      const ctx = { controller, home, workspaceRoot: workspace.root, skillScope: { workspaceRoot: workspace.root }, sessionsDir: directory, settings: () => config.settings, env: {}, secrets: [], finishQuit: () => {}, stderr: { write: () => {} } };
      const titles = ["Alpha clamp fix", "Beta ไทย 🧪 notes", "Gamma release"];
      for (const title of titles) {
        const saved = await createJsonlSession({ directory, workspace });
        saved.append({ type: "user", id: crypto.randomUUID(), content: [{ type: "text", text: title }] });
        await Bun.sleep(3);
      }
      const terminal = await createTestRenderer({ width, height: 30, kittyKeyboard: true, exitOnCtrlC: false });
      const view = createConversationView(terminal.renderer, { controller, home, workspaceRoot: home, env: {}, secrets: [], quit() {}, submit: (value, accepted) => dispatchEditorInput(value, controller, command => handleSlashCommand(command.name, command.args, ctx), accepted) });
      const settle = async () => { await Bun.sleep(5); view.refresh(); await terminal.flush(); };
      try {
        terminal.mockInput.pressKey("s", { meta: true }); await settle();
        for (let i = 0; i < 100 && (!controller.snapshot().sessionPicker || controller.snapshot().sessionPicker!.loading); i++) await settle();
        await settle();
        const rows = () => {
          const frame = terminal.captureCharFrame().split("\n");
          return titles.map(title => frame.find(row => row.includes(title.slice(0, 5)))!);
        };
        const before = rows();
        for (const [index, row] of before.entries()) expect(row, titles[index]).toBeDefined();
        const columns = before.map((row, index) => cellOf(row, titles[index]!.slice(0, 5)));
        expect(new Set(columns).size, columns.join(",")).toBe(1);
        const markerCell = columns[0]! - 2;
        const markerAt = (row: string) => [...row].findIndex((_, index) => Bun.stringWidth([...row].slice(0, index).join("")) === markerCell);
        const selectedTitle = controller.snapshot().sessionPicker!.entries[controller.snapshot().sessionPicker!.selectedIndex]!.title;
        const strip = (row: string) => { const chars = [...row]; chars[markerAt(row)] = " "; return chars.join(""); };
        for (const [index, row] of before.entries()) expect([...row][markerAt(row)]).toBe(titles[index] === selectedTitle ? "›" : " ");
        for (const key of ["down", "up"] as const) {
          const previous = rows();
          const previousIndex = controller.snapshot().sessionPicker!.selectedIndex;
          terminal.mockInput.pressArrow(key); await settle();
          expect(controller.snapshot().sessionPicker!.selectedIndex).not.toBe(previousIndex);
          const next = rows();
          expect(next.map(strip)).toEqual(previous.map(strip));
          const selected = controller.snapshot().sessionPicker!.entries[controller.snapshot().sessionPicker!.selectedIndex]!.title;
          for (const [index, row] of next.entries()) expect([...row][markerAt(row)], titles[index]).toBe(titles[index] === selected ? "›" : " ");
          expect(next).not.toEqual(previous);
        }
      } finally {
        view.destroy(); controller.dispose(); terminal.renderer.destroy();
      }
    });
  });
}
