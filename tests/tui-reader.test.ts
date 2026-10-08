import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { ScrollBoxRenderable, TextareaRenderable, TextRenderable } from "@opentui/core";
import { ReaderSnapshot, READER_SOURCE_LIMIT, type ReaderPosition } from "../src/tui/reader.ts";
import { alignTable, createReaderDocument, paintReader, panReader, readerLayout } from "../src/tui/reader-view.ts";
import { createConversationView } from "../src/tui/view.ts";
import { TuiController, type TuiControllerOptions } from "../src/tui/controller.ts";
import type { MotionMode } from "../src/tui/motion.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { ConfigEditor } from "../src/config/editing.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { editTool } from "../src/tools/edit.ts";
import { TUI_THEMES } from "../src/tui/theme.ts";
import { withTempDir } from "./helpers.ts";
import { createScriptedModel, type ScriptedTurnFactory } from "./helpers/scripted-model.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";

const target = { id: "code-message-0", messageId: "message", kind: "code" as const };
const viewport = { columns: 50, rows: 8, wrap: true };

test("captures canonical code bytes and line endings separately from readable rows", () => {
  const source = "const value = 'ไทย 🧪';\r\n\treturn value;\n";
  const reader = new ReaderSnapshot(target, source, { streaming: true });
  const view = reader.view({ offset: 0, horizontal: 0 }, viewport);
  expect(reader.copy()).toEqual({ text: source, complete: true });
  expect(reader.streaming).toBe(true);
  expect(view.rows.map(row => row.text)).toEqual(["const value = 'ไทย 🧪';", "    return value;", ""]);
  expect(view.rows.map(row => row.line)).toEqual([1, 2, 3]);
  expect(reader.source).toBe(source);
  expect(reader.target).toEqual(target);
});

test("rejects unsanitized retained control sequences rather than changing canonical copy", () => {
  for (const source of ["safe\x1b[31mred", "\x1b]52;c;payload\x07", "a\rb", "\x00", "\x85"]) {
    expect(() => new ReaderSnapshot(target, source)).toThrow("Reader source must already be sanitized");
  }
  expect(new ReaderSnapshot(target, "ไทย\t🧪\r\n").copy().text).toBe("ไทย\t🧪\r\n");
});

test("retains target identity and a stable snapshot independently of later capture changes", () => {
  const mutable = { ...target };
  let text = "partial";
  const reader = new ReaderSnapshot(mutable, text, { streaming: true });
  mutable.messageId = "changed"; text += " completion";
  expect(reader.target.messageId).toBe("message");
  expect(reader.copy().text).toBe("partial");
  expect(new ReaderSnapshot(target, text).copy().text).toBe("partial completion");
});

test("every code grapheme is reachable by vertical navigation at 120/80/50 columns", () => {
  const source = `${"ก้🧪 café ".repeat(900)}\r\n\n${"z".repeat(8000)}\nend`;
  const reader = new ReaderSnapshot(target, source);
  for (const columns of [120, 80, 50]) {
    const options = { columns, rows: 1, wrap: true };
    let position: ReaderPosition = { offset: 0, horizontal: 0 };
    const visited: string[] = [];
    for (let count = 0; count < 2000; count++) {
      const row = reader.view(position, options).rows[0]!;
      expect(Bun.stringWidth(row.text)).toBeLessThanOrEqual(columns);
      visited.push(reader.source.slice(row.start, row.end));
      const next = reader.move(position, options, { rows: 1 });
      if (next.offset === position.offset) break;
      position = next;
    }
    expect(visited.join("")).toBe(source.replace(/\r?\n/g, ""));
    for (let page = 0; page < 10 && position.offset > 0; page++) position = reader.move(position, options, { rows: -200 });
    expect(position.offset).toBe(0);
  }
});

test("wrap toggles and resizes preserve a canonical source anchor in Thai and emoji", () => {
  const source = "abc ".repeat(60) + "ก้🧪 target " + "z".repeat(120);
  const reader = new ReaderSnapshot(target, source);
  const position = reader.positionAt(source.indexOf("🧪") + 1);
  expect(position.offset).toBe(source.indexOf("🧪"));
  for (const columns of [120, 80, 50, 1]) for (const wrap of [true, false]) {
    const view = reader.view(position, { columns, rows: 3, wrap });
    expect(view.position).toEqual(position);
    expect(view.rows[0]!.start).toBeLessThanOrEqual(position.offset);
    expect(view.rows[0]!.end).toBeGreaterThan(position.offset);
    expect(view.rows.every(row => Bun.stringWidth(row.text) <= columns)).toBe(true);
  }
});

test("horizontal clipping never returns half an emoji or Thai combining cluster", () => {
  const reader = new ReaderSnapshot(target, "a🧪ก้Z\tend");
  const view = reader.view({ offset: 0, horizontal: 2 }, { columns: 3, rows: 1, wrap: false });
  expect(view.rows[0]!.text).toBe(" ก้Z");
  expect(view.rows[0]!.clippedLeft).toBe(true);
  expect(view.rows[0]!.clippedRight).toBe(true);
  expect(reader.view({ offset: 0, horizontal: 1 }, { columns: 1, rows: 1, wrap: false }).rows[0]!.text).toBe(" ");
  expect(reader.copy().text).toBe("a🧪ก้Z\tend");
});

test("table source preserves boundaries, empty cells and links with reachable horizontal content", () => {
  const source = "| Name | Empty | Link | Far column |\n| --- | --- | --- | --- |\n| ไทย | | [link](https://example.test) | last |\n";
  const reader = new ReaderSnapshot({ ...target, id: "table-message-0", kind: "table" }, source);
  const first = reader.view({ offset: 0, horizontal: 0 }, { columns: 15, rows: 5, wrap: true });
  expect(first.wrap).toBe(false);
  expect(first.rows[0]!.text).toBe("| Name | Empty ");
  const right = reader.view({ offset: 0, horizontal: 40 }, { columns: 15, rows: 5, wrap: true });
  expect(right.rows[2]!.text).toContain("last");
  expect(reader.copy()).toEqual({ text: source, complete: true });
});

test("reader search reuses normalized literal matching with exact canonical source anchors", () => {
  const source = "e\u0301\r\nÉ\nİx ก้ 🧪\n";
  const reader = new ReaderSnapshot(target, source);
  const found = reader.search("é");
  expect(found.matches.map(match => [match.start, match.end])).toEqual([[0, 2], [4, 5]]);
  expect(found.matches.map(match => source.slice(match.start, match.end))).toEqual(["e\u0301", "É"]);
  expect(found.matches.every(match => match.targetId === target.id && match.messageId === target.messageId)).toBe(true);
  const ids = found.matches.map(match => match.id);
  reader.view(reader.positionAt(4), viewport);
  expect(reader.search("É").matches.map(match => match.id)).toEqual(ids);
  expect(reader.search("i").matches.map(match => source.slice(match.start, match.end))).toEqual(["İ"]);
  expect(reader.search("🧪").matches.map(match => source.slice(match.start, match.end))).toEqual(["🧪"]);
  expect(reader.search("missing")).toEqual({ matches: [], limited: false });
  expect(reader.search("")).toEqual({ matches: [], limited: false });
});

test("search is limited truthfully at 20000 results without changing the copy source", () => {
  const reader = new ReaderSnapshot(target, "x ".repeat(20_001));
  expect(reader.search("x").matches).toHaveLength(20_000);
  expect(reader.search("x").limited).toBe(true);
  expect(reader.copy().complete).toBe(true);
  expect(new ReaderSnapshot(target, "x ".repeat(20_000)).search("x").limited).toBe(false);
});

test("source cap is grapheme-safe, explicit for search and copy, and excludes partial CRLF", () => {
  const source = "x".repeat(READER_SOURCE_LIMIT - 1) + "🧪tail";
  const reader = new ReaderSnapshot(target, source);
  expect(reader.source.length).toBe(READER_SOURCE_LIMIT - 1);
  expect(reader.truncated).toBe(true);
  expect(reader.copy()).toEqual({ text: "x".repeat(READER_SOURCE_LIMIT - 1), complete: false });
  expect(reader.search("missing").limited).toBe(true);
  expect(reader.view({ offset: 0, horizontal: 0 }, viewport).sourceTruncated).toBe(true);
  const crlf = new ReaderSnapshot(target, "x".repeat(READER_SOURCE_LIMIT - 1) + "\r\nmore");
  expect(crlf.source.endsWith("\r")).toBe(false);
  expect(new ReaderSnapshot(target, "x".repeat(READER_SOURCE_LIMIT)).truncated).toBe(false);
});

test("large sources and hostile viewport sizes materialize only a bounded window", () => {
  const reader = new ReaderSnapshot(target, "a\n".repeat(400_000));
  const last = reader.positionAt(reader.source.length);
  expect(reader.view(last, viewport).rows.map(row => row.text)).toEqual([""]);
  const huge = reader.view({ offset: 0, horizontal: 0 }, { columns: 1e9, rows: 1e9, wrap: true });
  expect(huge.rows.length).toBeLessThanOrEqual(200);
  expect(huge.columns).toBeLessThanOrEqual(1000);
  expect(huge.viewportLimited).toBe(true);
  expect(reader.view({ offset: NaN, horizontal: Infinity }, { columns: NaN, rows: Infinity, wrap: true }).rows.length).toBeLessThanOrEqual(200);
});

test("pathological combining clusters are bounded in the readable view with explicit substitution", () => {
  const source = "a" + "\u0301".repeat(100_000) + " end";
  const reader = new ReaderSnapshot(target, source);
  const row = reader.view({ offset: 0, horizontal: 0 }, viewport).rows[0]!;
  expect(row.text.length).toBeLessThan(2000);
  expect(row.substituted).toBe(true);
  expect(reader.copy()).toEqual({ text: source, complete: true });
});

test("every grapheme boundary is idempotent, including Thai beside leading emoji surrogates", () => {
  const source = "ก้🧪 café 👨‍👩‍👧‍👦\r\n🇹🇭\n";
  const reader = new ReaderSnapshot(target, source);
  for (const part of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(source)) {
    for (let offset = part.index; offset < part.index + part.segment.length; offset++) {
      const position = reader.positionAt(offset);
      expect(position.offset).toBe(part.index);
      expect(reader.positionAt(position.offset)).toEqual(position);
      expect(reader.view(position, viewport).position).toEqual(position);
    }
  }
});

test("page navigation is reversible over wrapped Unicode and preserves horizontal position", () => {
  const source = "start\n" + "ab🧪ก้\t".repeat(400) + "\n\nend";
  const reader = new ReaderSnapshot(target, source);
  for (const columns of [120, 80, 50, 2, 1]) {
    const options = { columns, rows: 8, wrap: true };
    const start = { offset: 0, horizontal: 5 };
    const page = reader.move(start, options, { rows: 8, columns: 50 });
    expect(page.horizontal).toBe(5);
    expect(reader.move(page, options, { rows: -8 })).toEqual(start);
    const visible = reader.view(page, options);
    expect(visible.rows).toHaveLength(8);
    expect(visible.rows.every(row => Bun.stringWidth(row.text) <= columns)).toBe(true);
    expect(visible.hasBefore).toBe(true);
    expect(visible.hasAfter).toBe(true);
  }
  const unwrapped = { ...viewport, wrap: false };
  expect(reader.move({ offset: 0, horizontal: 5 }, unwrapped, { columns: -100 })).toEqual({ offset: 0, horizontal: 0 });
  expect(reader.move({ offset: 0, horizontal: 0 }, unwrapped, { columns: 7 })).toEqual({ offset: 0, horizontal: 7 });
});

test("search ranges cross canonical line endings and retain combining-cluster boundaries", () => {
  const source = "e\u0301\r\nÉ 🧪ก้";
  const reader = new ReaderSnapshot(target, source);
  const match = reader.search("é\r\né").matches[0]!;
  expect([match.start, match.end]).toEqual([0, 5]);
  expect(source.slice(match.start, match.end)).toBe("e\u0301\r\nÉ");
  expect(reader.search("ก").matches.map(match => source.slice(match.start, match.end))).toEqual(["ก้"]);
  expect(reader.search("x".repeat(READER_SOURCE_LIMIT + 1))).toEqual({ matches: [], limited: true });
});

test("a large single wrapped line exposes its tail without retaining all wrapped rows", () => {
  const reader = new ReaderSnapshot(target, "x".repeat(250_000) + "🧪 tail");
  const options = { columns: 1, rows: 3, wrap: true };
  const tail = reader.positionAt(reader.source.indexOf("tail"));
  expect(reader.view(tail, options).rows.map(row => row.text)).toEqual(["t", "a", "i"]);
  const previous = reader.move(tail, options, { rows: -200 });
  expect(reader.move(previous, options, { rows: 200 }).offset).toBe(tail.offset);
  expect(reader.view(tail, options).rows).toHaveLength(3);
});

test("empty snapshots and capped first clusters remain readable without fabricating copy bytes", () => {
  const empty = new ReaderSnapshot(target, "");
  expect(empty.view({ offset: -10, horizontal: -20 }, viewport).rows.map(row => row.text)).toEqual([""]);
  expect(empty.move({ offset: 0, horizontal: 0 }, viewport, { rows: 200 })).toEqual({ offset: 0, horizontal: 0 });
  expect(empty.copy()).toEqual({ text: "", complete: true });
  const longCluster = new ReaderSnapshot(target, "a" + "\u0301".repeat(READER_SOURCE_LIMIT));
  expect(longCluster.copy()).toEqual({ text: "", complete: false });
  expect(longCluster.view({ offset: 0, horizontal: 0 }, viewport).sourceTruncated).toBe(true);
});

test("repeated tail reads and navigation at the source cap finish under a bounded subprocess deadline", async () => {
  const moduleUrl = new URL("../src/tui/reader.ts", import.meta.url).href;
  const script = `import {ReaderSnapshot} from ${JSON.stringify(moduleUrl)};
    const reader = new ReaderSnapshot({id:'large',messageId:'message',kind:'code'},'a'.repeat(7_999_996)+'tail');
    const viewport = {columns:50,rows:20,wrap:true};
    const position = reader.positionAt(7_999_900);
    let checked = 0;
    for(let i=0;i<64;i++) {
      const view = reader.view(position,viewport);
      if(view.rows[0].start !== 7_999_900 || view.rows.length !== 2) throw Error('Incorrect tail');
      const previous = reader.move(position,viewport,{rows:-20});
      if(reader.move(previous,viewport,{rows:20}).offset !== position.offset) throw Error('Incorrect page anchor');
      const unwrapped = reader.view(position,{...viewport,wrap:false});
      if(unwrapped.rows[0].text.length !== 50) throw Error('Incorrect horizontal window');
      if(reader.search('tail').matches[0]?.start !== 7_999_996) throw Error('Incorrect canonical search anchor');
      checked++;
    }
    console.log(checked);`;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { stdout: "pipe", stderr: "pipe" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      child.exited.then(code => ({ completed: true, code })),
      new Promise<{ completed: boolean; code: number }>(resolve => {
        timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ completed: false, code: -1 }); }, 5000);
      }),
    ]);
    await child.exited;
    expect(outcome).toEqual({ completed: true, code: 0 });
    expect(await new Response(child.stdout).text()).toBe("64\n");
    expect(await new Response(child.stderr).text()).toBe("");
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}, 10_000);

test("sparse checkpoints preserve tab columns across CRLF and wrap-cache eviction", () => {
  const source = "ก้🧪\t".repeat(1200) + "\r\n" + "abc\t".repeat(1500) + "TAIL";
  const reader = new ReaderSnapshot(target, source);
  const position = reader.positionAt(source.indexOf("TAIL"));
  expect(position.horizontal).toBe(6000);
  expect(reader.view(position, { columns: 50, rows: 1, wrap: false }).rows[0]!.text).toBe("TAIL");
  for (const columns of [120, 80, 50, 40, 24, 1, 80]) {
    const view = reader.view(position, { columns, rows: 4, wrap: true });
    expect(view.position).toEqual(position);
    expect(view.rows[0]!.line).toBe(2);
    expect(view.rows.map(row => row.text).join("")).toContain("TAIL");
  }
});

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

/** Render the real conversation view with a scripted model and a recording clipboard transport. */
async function setup(width = 80, height = 24, options: { overrides?: Partial<TuiControllerOptions>; motion?: MotionMode; env?: Record<string, string | undefined> } = {}) {
  const ui = await createTestRenderer({ width, height, kittyKeyboard: true, exitOnCtrlC: false });
  const workspace = { root: "/project", launchCwd: "/project", extraRoots: [] };
  const controller = new TuiController({
    session: createSession(), workspace, provider: "scripted", modelId: "test-model", sessionId: "reader-session",
    model: createScriptedModel(), contextManager: createContextManager(workspace), secrets: ["secret-sentinel"],
    credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ model: createScriptedModel() }) }, ...options.overrides,
  });
  const copied: string[] = [];
  let clipboard: boolean | "throw" = true;
  let quit = false;
  ui.renderer.copyToClipboardOSC52 = text => { if (clipboard === "throw") throw new Error("Clipboard unavailable"); if (clipboard) copied.push(text); return clipboard; };
  const view = createConversationView(ui.renderer, {
    controller, workspaceRoot: options.overrides?.workspace?.root ?? "/project", home: "/home/test", env: options.env ?? {}, secrets: ["secret-sentinel"], motion: options.motion,
    quit: () => { quit = true; }, submit: async () => {},
  });
  cleanups.push(() => { view.destroy(); controller.dispose(); ui.renderer.destroy(); });
  const settle = async () => { await Bun.sleep(1); view.refresh(); await ui.flush(); view.refresh(); await ui.flush(); };
  await settle();
  const find = <T>(id: string) => ui.renderer.root.findDescendantById(id) as T;
  const readerText = () => find<TextRenderable>("reader-text").plainText;
  const reading = () => !!find<{ visible: boolean }>("reader-panel").visible;
  const hints = () => find<TextRenderable>("hints").plainText;
  const waitFor = async (predicate: () => boolean, label: string) => {
    const start = performance.now();
    while (!predicate()) {
      if (performance.now() - start > 3000) throw new Error(`Timed out waiting for ${label}\n${ui.captureCharFrame()}`);
      await settle();
    }
  };
  return { ...ui, controller, view, copied, settle, readerText, reading, hints, waitFor, didQuit: () => quit,
    editor: find<TextareaRenderable>("prompt"), transcript: find<ScrollBoxRenderable>("transcript"),
    setClipboard: (value: boolean | "throw") => { clipboard = value; } };
}

const longCode = ["const first = 'ไทย ก้ 🧪';", `const wide = '${"abcdefghij".repeat(20)}END';`, ...Array.from({ length: 40 }, (_, index) => `line ${index + 3}\tvalue ${index}`), "const last = 'TAIL ✓';"].join("\n");
const wideTable = [
  "| Name | Empty | Link | Notes | Fifth column | Sixth column | Seventh column | Last column |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ...Array.from({ length: 30 }, (_, index) => `| ไทย ${index} | | [docs](https://example.test/${index}) | escaped \\| pipe | five ${index} | six ${index} | seven ${index} | far ${index} |`),
].join("\n");

test("R reads code and tables while existing tool and code identities keep their order", async () => {
  const ui = await setup(100, 30);
  ui.controller.applyEvent({ type: "tool.started", toolCallId: "first-tool", name: "read" });
  ui.controller.applyEvent({ type: "tool.finished", toolCallId: "first-tool", name: "read", status: "success", content: "tool output" });
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "```txt\nalpha\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```txt\nbeta\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n" } });
  ui.controller.applyEvent({ type: "model.finished" });
  await ui.settle();
  const id = ui.controller.snapshot().transcript.find(entry => entry.kind === "assistant")!.id;
  for (const target of [`code-${id}-0`, `code-${id}-1`, `table-${id}-0`, `table-${id}-1`]) expect(ui.renderer.root.findDescendantById(target)).toBeDefined();
  ui.transcript.scrollTo(0); await ui.settle();
  ui.mockInput.pressKey("i", { meta: true }); await ui.settle();
  const toolId = ui.controller.snapshot().transcript.find(entry => entry.kind === "tool")!.id;
  const focused = () => {
    const label = (node: unknown) => ((node as { getChildren(): unknown[] }).getChildren()[0] as { getChildren(): TextRenderable[] }).getChildren()[0]!.plainText;
    if ((ui.renderer.root.findDescendantById(`message-${toolId}`)!.getChildren()[0] as TextRenderable).plainText.startsWith(" › ")) return "tool";
    return [`code-${id}-0`, `table-${id}-0`, `code-${id}-1`, `table-${id}-1`].find(target => label(ui.renderer.root.findDescendantById(target)).includes("›")) ?? "none";
  };
  const order: string[] = [];
  for (let step = 0; step < 5; step++) { order.push(focused()); ui.mockInput.pressArrow("down"); await ui.settle(); }
  // Tables join in rendered order without renumbering the existing code ordinals.
  expect(order).toEqual(["tool", `code-${id}-0`, `table-${id}-0`, `code-${id}-1`, `table-${id}-1`]);
  // Tool: R neither copies nor opens.
  for (let step = 0; step < 5; step++) ui.mockInput.pressArrow("up");
  await ui.settle();
  ui.mockInput.pressKey("r"); await ui.settle();
  expect(ui.reading()).toBe(false);
  expect(ui.copied).toEqual([]);
  // Duplicate identical tables are distinct, source-ordered targets that copy their own Markdown.
  for (let step = 0; step < 4; step++) ui.mockInput.pressArrow("down");
  await ui.settle();
  expect(focused()).toBe(`table-${id}-1`);
  ui.mockInput.pressEnter(); await ui.settle();
  expect(ui.copied).toEqual(["| A | B |\n| --- | --- |\n| 1 | 2 |"]);
  for (let step = 0; step < 3; step++) ui.mockInput.pressArrow("up");
  await ui.settle();
  expect(focused()).toBe(`code-${id}-0`);
  ui.mockInput.pressEnter(); await ui.settle();
  expect(ui.copied.at(-1)).toBe("alpha");
  ui.mockInput.pressKey("r"); await ui.settle();
  expect(ui.reading()).toBe(true);
  expect(ui.readerText()).toContain("Read code · txt");
  expect(ui.copied).toHaveLength(2);
  expect(ui.renderer.root.findDescendantById("composer")!.visible).toBe(false);
});

for (const width of [120, 80, 50]) test(`reader reaches every code and table cell at ${width} columns and copies canonical source`, async () => {
  const ui = await setup(width, 24);
  await ui.mockInput.pasteBracketedText("ร่าง 🧪 draft");
  ui.editor.cursorOffset = 4;
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "```ts\n" + longCode + "\n```\n\n" + wideTable + "\n" } });
  ui.controller.applyEvent({ type: "model.finished" });
  await ui.settle();
  ui.transcript.scrollTo(0); await ui.settle();
  const scroll = ui.transcript.scrollTop;
  ui.mockInput.pressKey("i", { meta: true }); await ui.settle();
  ui.mockInput.pressKey("r"); await ui.settle();
  expect(ui.readerText()).toContain("Read code · ts");
  expect(ui.readerText()).toContain("Lines 1–");
  // Horizontal: the wide line's tail is reachable without wrapping.
  for (let step = 0; step < 20 && !ui.readerText().includes("END'"); step++) { ui.mockInput.pressArrow("right"); await ui.settle(); }
  expect(ui.readerText()).toContain("END';");
  expect(ui.readerText()).toContain("‹");
  ui.mockInput.pressKey("HOME"); await ui.settle();
  // Vertical: End reaches the final line, PgUp returns towards the top.
  ui.mockInput.pressKey("END"); await ui.settle();
  expect(ui.readerText()).toContain("TAIL ✓");
  ui.mockInput.pressKey("HOME"); await ui.settle();
  expect(ui.readerText()).toContain("ไทย ก้ 🧪");
  // Wrapping keeps the anchored source line at the top.
  for (let step = 0; step < 5; step++) ui.mockInput.pressArrow("down");
  await ui.settle();
  const firstBody = () => ui.readerText().split("\n").find(line => /^\s*\d+ /.test(line))!.trim().split(" ")[0];
  expect(firstBody()).toBe("6");
  ui.mockInput.pressKey("w"); await ui.settle();
  expect(firstBody()).toBe("6");
  expect(ui.hints()).toContain("W unwrap");
  ui.resize(width === 50 ? 80 : 50, 24); await ui.settle();
  expect(firstBody()).toBe("6");
  ui.resize(width, 24); await ui.settle();
  ui.mockInput.pressKey("w"); await ui.settle();
  expect(firstBody()).toBe("6");
  ui.mockInput.pressKey("c"); await ui.settle();
  expect(ui.copied).toEqual([longCode]);
  ui.mockInput.pressEscape(); await ui.settle();
  expect(ui.reading()).toBe(false);
  expect(ui.captureCharFrame()).toContain("› ts");
  // Table: pinned header, column position, every column reachable, Markdown source copy.
  ui.mockInput.pressArrow("down"); await ui.settle();
  ui.mockInput.pressKey("r"); await ui.settle();
  expect(ui.readerText()).toContain("Read table");
  expect(ui.readerText()).toContain("Aligned columns · C copy Markdown source");
  for (let page = 0; page < 3; page++) ui.mockInput.pressKey("\u001b[6~");
  await ui.settle();
  const tableLines = ui.readerText().split("\n");
  const header = tableLines.findIndex(line => line.includes("Name"));
  expect(header).toBeGreaterThan(0);
  expect(tableLines[header + 1]).toContain("─");
  expect(ui.readerText()).not.toContain("ไทย 0 ");
  const seen = new Set<string>();
  for (let step = 0; step < 12; step++) {
    for (const cell of ["Name", "Empty", "Link", "Notes", "Fifth column", "Sixth column", "Seventh column", "Last column", "far 29", "[docs](https://example.test/2"]) if (ui.readerText().includes(cell)) seen.add(cell);
    ui.mockInput.pressArrow("right"); await ui.settle();
  }
  ui.mockInput.pressKey("END"); await ui.settle();
  for (let step = 0; step < 12; step++) {
    if (ui.readerText().includes("far 29")) seen.add("far 29");
    ui.mockInput.pressArrow("right"); await ui.settle();
  }
  expect([...seen].sort()).toEqual(["Empty", "Fifth column", "Last column", "Link", "Name", "Notes", "Seventh column", "Sixth column", "[docs](https://example.test/2", "far 29"].sort());
  expect(ui.readerText()).toMatch(/Columns \d+–8 of 8|Col \d+–8\/8/);
  ui.mockInput.pressKey("c"); await ui.settle();
  expect(ui.copied).toEqual([longCode, wideTable]);
  ui.mockInput.pressEscape(); await ui.settle();
  expect(ui.captureCharFrame()).toContain("› table");
  ui.mockInput.pressEscape(); await ui.settle();
  expect(ui.transcript.scrollTop).toBe(scroll);
  expect(ui.editor.plainText).toBe("ร่าง 🧪 draft");
  expect(ui.editor.cursorOffset).toBe(4);
  expect(ui.editor.focused).toBe(true);
});

test("reader clipboard reports transport true, false and throw while keeping reader state", async () => {
  const ui = await setup(80, 24);
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "```ts\n" + longCode + "\n```" } });
  ui.controller.applyEvent({ type: "model.finished" });
  await ui.settle();
  ui.mockInput.pressKey("i", { meta: true }); await ui.settle();
  ui.mockInput.pressKey("r");
  // A copy before the reader has been painted is never queued.
  ui.mockInput.pressKey("c");
  expect(ui.copied).toEqual([]);
  await ui.settle();
  expect(ui.captureCharFrame()).toContain("Showing reader · C copy again");
  for (let step = 0; step < 7; step++) ui.mockInput.pressArrow("down");
  ui.mockInput.pressArrow("right");
  await ui.settle();
  const before = ui.readerText();
  for (const result of [false, "throw"] as const) {
    ui.setClipboard(result);
    ui.mockInput.pressKey("c"); await ui.settle();
    expect(ui.copied).toEqual([]);
    expect(ui.captureCharFrame()).toContain("Clipboard unavailable");
    expect(ui.reading()).toBe(true);
    expect(ui.readerText()).toBe(before);
  }
  ui.setClipboard(true);
  ui.mockInput.pressKey("c"); await ui.settle();
  expect(ui.copied).toEqual([longCode]);
  expect(ui.captureCharFrame()).toContain("Copied code · Esc back");
  expect(ui.copied[0]).not.toContain("‹");
  expect(ui.readerText()).toBe(before);
});

test("streaming code opens as a stable snapshot and reopening refreshes it", async () => {
  for (const motion of ["off", "reduced", "full"] as const) {
    const ui = await setup(80, 24, { motion });
    ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "| Col | Value |\n| --- | --- |\n| one | ไทย |\n\n```txt\npartial line\n" } });
    await ui.settle();
    ui.mockInput.pressKey("i", { meta: true }); await ui.settle();
    ui.mockInput.pressArrow("down"); await ui.settle();
    ui.mockInput.pressKey("r"); await ui.settle();
    expect(ui.readerText()).toContain("Snapshot · Esc back");
    expect(ui.readerText()).toContain("partial line");
    ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "appended line\n```\n" } });
    await ui.settle();
    expect(ui.readerText()).not.toContain("appended line");
    ui.mockInput.pressKey("c"); await ui.settle();
    expect(ui.copied.at(-1)).toBe("partial line");
    // Reopening while the answer still streams refreshes the snapshot; a caret never joins a closed fence.
    ui.mockInput.pressEscape(); await ui.settle();
    ui.mockInput.pressKey("r"); await ui.settle();
    expect(ui.readerText()).toContain("appended line");
    expect(ui.readerText()).toContain("Snapshot · Esc back");
    ui.mockInput.pressKey("c"); await ui.settle();
    expect(ui.copied.at(-1)).toBe("partial line\nappended line");
    ui.controller.applyEvent({ type: "model.finished" });
    await ui.settle();
    expect(ui.readerText()).toContain("Snapshot · Esc back");
    expect(ui.controller.snapshot().transcript).toHaveLength(1);
    ui.mockInput.pressEscape(); await ui.settle();
    ui.mockInput.pressKey("r"); await ui.settle();
    expect(ui.readerText()).toContain("appended line");
    expect(ui.readerText()).not.toContain("Snapshot");
    ui.mockInput.pressEscape(); await ui.settle();
    // The table never includes the streaming caret, even under full motion.
    ui.mockInput.pressArrow("up"); await ui.settle();
    ui.mockInput.pressKey("c"); await ui.settle();
    expect(ui.copied.at(-1)).toBe("| Col | Value |\n| --- | --- |\n| one | ไทย |");
    cleanups.splice(0).reverse().forEach(cleanup => cleanup());
  }
});

test("a streaming table snapshot excludes the presentation caret under full motion", async () => {
  const ui = await setup(80, 24, { motion: "full" });
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "| Col | Value |\n| --- | --- |\n| one | two |" } });
  await ui.settle();
  ui.mockInput.pressKey("i", { meta: true }); await ui.settle();
  ui.mockInput.pressKey("r"); await ui.settle();
  expect(ui.readerText()).toContain("Read table");
  expect(ui.readerText()).toContain("Snapshot · Esc back");
  expect(ui.readerText()).not.toContain("▍");
  ui.mockInput.pressKey("c"); await ui.settle();
  expect(ui.copied).toEqual(["| Col | Value |\n| --- | --- |\n| one | two |"]);
});

test("reader search has stable matches, a no-match state and leaves conversation search unchanged", async () => {
  const ui = await setup(80, 24);
  const code = "start\n" + Array.from({ length: 30 }, (_, index) => index % 10 === 3 ? `needle ${index} é` : `filler ${index}`).join("\n") + "\nfinal é needle";
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "Before needle\n\n```txt\n" + code + "\n```" } });
  ui.controller.applyEvent({ type: "model.finished" });
  await ui.settle();
  ui.mockInput.pressKey("f", { ctrl: true }); await ui.mockInput.typeText("needle"); await ui.settle();
  const conversation = ui.captureCharFrame().match(/Find \d+\/\d+/)?.[0];
  expect(conversation).toBeDefined();
  ui.mockInput.pressEscape(); await ui.settle();
  ui.mockInput.pressKey("i", { meta: true }); await ui.settle();
  ui.mockInput.pressKey("r"); await ui.settle();
  const top = ui.readerText();
  ui.mockInput.pressKey("f", { ctrl: true }); await ui.settle();
  expect(ui.readerText()).toContain("Find in this block · Type a query");
  await ui.mockInput.typeText("missing"); await ui.settle();
  expect(ui.readerText()).toContain("Find: missing · No matches · Esc restore");
  for (let index = 0; index < 7; index++) ui.mockInput.pressBackspace();
  await ui.mockInput.typeText("needle"); await ui.settle();
  expect(ui.readerText()).toContain("Find: needle · 1/4");
  ui.mockInput.pressArrow("down"); ui.mockInput.pressArrow("down"); ui.mockInput.pressArrow("down"); await ui.settle();
  expect(ui.readerText()).toContain("4/4");
  expect(ui.readerText()).toContain("final é needle".normalize("NFD"));
  ui.mockInput.pressBackspace(); ui.mockInput.pressBackspace(); ui.mockInput.pressBackspace(); ui.mockInput.pressBackspace(); ui.mockInput.pressBackspace(); ui.mockInput.pressBackspace();
  await ui.mockInput.typeText("é"); await ui.settle();
  expect(ui.readerText()).toMatch(/Find: é · 1\/4/);
  ui.mockInput.pressEscape(); await ui.settle();
  expect(ui.reading()).toBe(true);
  expect(ui.readerText()).toBe(top);
  ui.mockInput.pressEscape(); await ui.settle();
  ui.mockInput.pressEscape(); await ui.settle();
  ui.mockInput.pressKey("f", { ctrl: true }); await ui.mockInput.typeText("needle"); await ui.settle();
  expect(ui.captureCharFrame().match(/Find \d+\/\d+/)?.[0]).toBe(conversation!);
  expect(ui.controller.snapshot().transcript).toHaveLength(1);
});

test("session and branch changes discard the reader and its return checkpoint", async () => {
  for (const change of ["session", "branch"] as const) {
    const ui = await setup(80, 20);
    const session = createSession([
      { type: "user", id: "user", content: [{ type: "text", text: "Task" }] },
      { type: "assistant", id: "same-message", content: [{ type: "text", text: "```txt\nfirst\n```" }] },
    ]);
    ui.controller.replaceSession(session, "reader-session");
    await ui.settle();
    ui.mockInput.pressKey("i", { meta: true }); await ui.settle();
    ui.mockInput.pressKey("r"); await ui.settle();
    expect(ui.reading()).toBe(true);
    if (change === "branch") session.forkBranch("same-message");
    ui.controller.replaceSession(session, change === "session" ? "another-session" : "reader-session");
    await ui.settle();
    expect(ui.reading()).toBe(false);
    expect(ui.editor.focused).toBe(true);
    ui.mockInput.pressKey("c"); await ui.settle();
    expect(ui.copied).toEqual([]);
    cleanups.splice(0).reverse().forEach(cleanup => cleanup());
  }
});

test("Ctrl+C in the reader copies a selection first, then cancels work or quits", async () => {
  const ui = await setup(80, 24);
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "```txt\nselect me\n```" } });
  ui.controller.applyEvent({ type: "model.finished" });
  await ui.settle();
  ui.mockInput.pressKey("i", { meta: true }); await ui.settle();
  ui.mockInput.pressKey("r"); await ui.settle();
  const text = ui.renderer.root.findDescendantById("reader-text")!;
  const row = ui.captureCharFrame().split("\n").findIndex(line => line.includes("select me"));
  const column = ui.captureCharFrame().split("\n")[row]!.indexOf("select me");
  expect(row).toBeGreaterThan(text.y - 1);
  await ui.mockMouse.drag(column, row, column + 5, row); await ui.settle();
  ui.mockInput.pressKey("c", { ctrl: true }); await ui.settle();
  expect(ui.copied).toEqual(["select"]);
  expect(ui.didQuit()).toBe(false);
  expect(ui.reading()).toBe(true);
  ui.mockInput.pressKey("c", { ctrl: true }); await ui.settle();
  expect(ui.didQuit()).toBe(true);
  expect(ui.copied).toEqual(["select"]);
});

test("Ctrl+C in the reader cancels running work without closing the reader", async () => {
  const ui = await setup(80, 24, { overrides: { model: createScriptedModel({ responses: [{ text: "```txt\nrunning\n```" }, { chunks: ["partial"], waitForAbort: true }] }) } });
  await ui.controller.submit("first"); await ui.settle();
  ui.mockInput.pressKey("i", { meta: true }); await ui.settle();
  ui.mockInput.pressKey("r"); await ui.settle();
  const turn = ui.controller.submit("second");
  await ui.waitFor(() => ui.controller.running, "running turn");
  ui.mockInput.pressKey("c", { ctrl: true }); await turn; await ui.settle();
  expect(ui.controller.running).toBe(false);
  expect(ui.didQuit()).toBe(false);
  expect(ui.reading()).toBe(true);
});

test("table alignment preserves every cell and labels the copied Markdown source", () => {
  const source = "| A | Empty | Link |\n| :-- | --- | --: |\n| ไทย 🧪 | | [x](https://e.test) |\n| escaped \\| pipe | extra | cells | beyond |";
  const aligned = alignTable(source)!;
  expect(aligned.text.split("\n")).toEqual([
    "A               │ Empty │ Link                │",
    "────────────────┼───────┼─────────────────────┼───────",
    "ไทย 🧪          │       │ [x](https://e.test) │",
    "escaped \\| pipe │ extra │ cells               │ beyond",
  ].map(line => line.trimEnd()));
  expect(aligned.columnStarts).toEqual([0, 18, 26, 48]);
  expect(alignTable("not | a table")).toBeUndefined();
  const document = createReaderDocument({ id: "table-m-0", messageId: "m", kind: "table" }, source, { title: "table", streaming: false });
  expect(document.copy.copy()).toEqual({ text: source, complete: true });
  expect(document.view.source).toBe(aligned.text);
  const layout = readerLayout(document, false, 60, 10, { approval: true, search: false });
  expect(layout.status).toEqual(["approval", "table"]);
  expect(layout.pinned).toBe(true);
  const text = paintReader({ document, layout, position: { offset: 0, horizontal: 0 }, columns: 60, rows: 10, theme: TUI_THEMES.dark }).chunks.map(chunk => chunk.text).join("");
  expect(text.split("\n")).toHaveLength(10);
  expect(text).toContain("◌ Approval waiting · Esc back to request");
  expect(text).toContain("Aligned columns · C copy Markdown source");
});

test("capped sources show the limit and never claim a complete copy", () => {
  const source = "x".repeat(READER_SOURCE_LIMIT) + "omitted";
  const document = createReaderDocument({ id: "code-m-0", messageId: "m", kind: "code" }, source, { title: "txt", streaming: false });
  expect(document.copy.copy().complete).toBe(false);
  expect(document.copy.copy().text).not.toContain("omitted");
  const layout = readerLayout(document, true, 60, 12, { approval: false, search: false });
  expect(layout.status).toContain("truncated");
  const text = paintReader({ document, layout, position: { offset: 0, horizontal: 0 }, columns: 60, rows: 12, theme: TUI_THEMES.light }).chunks.map(chunk => chunk.text).join("");
  expect(text).toContain("Showing first 8,000,000 characters · C copy this part");
});

for (const outcome of ["approve", "deny", "cancel"] as const) test(`a deferred approval waits while reading and ${outcome} keeps the reader closed until an explicit return`, async () => withTempDir(async root => {
  await Bun.write(join(root, "note.txt"), "before");
  const workspace = { root, launchCwd: root, extraRoots: [] };
  const responses: ScriptedTurnFactory[] = [
    { text: "```ts\n" + longCode + "\n```" },
    { toolCalls: [{ id: "edit-call", name: "edit", arguments: { path: "note.txt", edits: [{ oldText: "before", newText: "after" }] } }] },
    { text: "done" },
  ];
  const ui = await setup(80, 24, { overrides: {
    workspace, contextManager: createContextManager(workspace), model: createScriptedModel({ responses }), tools: createToolRegistry([editTool]),
    configEditor: new ConfigEditor({ cli: { approval: { mode: "ask" } } }, { user: join(root, "user-config"), project: join(root, "project-config") }),
  } });
  await ui.mockInput.pasteBracketedText("ร่างต่อไป 🧪");
  ui.editor.cursorOffset = 2;
  await ui.controller.submit("show code"); await ui.settle();
  ui.mockInput.pressKey("i", { meta: true }); await ui.settle();
  ui.mockInput.pressKey("r"); await ui.settle();
  for (let step = 0; step < 6; step++) ui.mockInput.pressArrow("down");
  ui.mockInput.pressKey("f", { ctrl: true });
  await ui.mockInput.typeText("value 2"); await ui.settle();
  const saved = ui.readerText();
  expect(saved).toContain("Find: value 2 · 2/11");
  const turn = ui.controller.submit("edit");
  await ui.waitFor(() => !!ui.controller.snapshot().toolApproval && !ui.controller.snapshot().toolApproval!.loading, "approval");
  const request = ui.controller.snapshot().toolApproval;
  expect(ui.reading()).toBe(true);
  expect(ui.readerText()).toContain("◌ Approval waiting · Esc back to request");
  expect(ui.hints()).toStartWith("Esc back to request");
  // The status bar names the same Esc as the reader and its hint row, never a second verb.
  const footerText = () => (ui.renderer.root.findDescendantById("footer") as TextRenderable).plainText;
  expect(footerText().match(/Esc [a-z]+(?: [a-z]+)*/g)).toEqual(["Esc back to request"]);
  expect(ui.captureCharFrame()).toMatch(/◆ [A-Za-z-]+ +◌ Approval /);
  expect(ui.captureCharFrame()).not.toContain("Allow edit? · ask mode");
  // Navigation, copy and resize never answer the request.
  ui.mockInput.pressKey("\u001b[6~"); ui.mockInput.pressArrow("up"); ui.mockInput.pressArrow("down");
  ui.mockInput.pressKey("c");
  await ui.settle();
  expect(ui.copied).toEqual([]);
  for (const width of [120, 50, 80]) { ui.resize(width, 24); await ui.settle(); expect(ui.readerText()).toContain("Esc back to request"); }
  expect(ui.controller.snapshot().toolApproval).toEqual(request);
  expect(await Bun.file(join(root, "note.txt")).text()).toBe("before");
  // Leave search (Enter keeps the position), copy while the request waits, then search again for the checkpoint.
  ui.mockInput.pressEnter(); await ui.settle();
  ui.mockInput.pressKey("c"); await ui.settle();
  expect(ui.copied).toEqual([longCode]);
  expect(ui.controller.snapshot().toolApproval).toEqual(request);
  ui.mockInput.pressKey("f", { ctrl: true });
  await ui.mockInput.typeText("value 2c"); await ui.settle();
  const checkpoint = ui.readerText().split("\n").slice(1).join("\n");
  if (outcome === "cancel") {
    ui.mockInput.pressKey("c", { ctrl: true });
    await turn; await ui.settle();
    expect(ui.controller.snapshot().toolApproval).toBeUndefined();
    expect(ui.reading()).toBe(true);
    expect(ui.readerText()).not.toContain("Approval waiting");
    expect(await Bun.file(join(root, "note.txt")).text()).toBe("before");
    return;
  }
  ui.mockInput.pressEscape(); await ui.settle();
  expect(ui.reading()).toBe(false);
  expect(ui.captureCharFrame()).toContain("Allow edit? · ask mode");
  expect(ui.controller.snapshot().toolApproval).toEqual(request);
  if (outcome === "approve") ui.mockInput.pressEnter(); else ui.mockInput.pressEscape();
  await turn; await ui.settle();
  expect(await Bun.file(join(root, "note.txt")).text()).toBe(outcome === "approve" ? "after" : "before");
  expect(ui.reading()).toBe(false);
  expect(ui.editor.plainText).toBe("ร่างต่อไป 🧪");
  expect(ui.editor.cursorOffset).toBe(2);
  // Typing R in the composer never reopens the reader.
  await ui.mockInput.typeText("R"); await ui.settle();
  expect(ui.reading()).toBe(false);
  ui.mockInput.pressBackspace(); await ui.settle();
  ui.mockInput.pressKey("i", { meta: true }); await ui.settle();
  ui.mockInput.pressKey("r"); await ui.settle();
  expect(ui.reading()).toBe(true);
  // The saved snapshot, anchor and local search return; the body gains the row the approval status used.
  const restored = ui.readerText().split("\n"), before = checkpoint.split("\n");
  expect(restored.slice(1, before.length - 1)).toEqual(before.slice(1, -1));
  // While the approval waited, the find row named the Esc action it had then; once settled, Esc restores again.
  expect(before.at(-1)).toEndWith("Esc back to request");
  expect(restored.at(-1)).toBe(before.at(-1)!.replace("Esc back to request", "Esc restore"));
  expect(restored.at(-1)).toContain("Find: value 2c");
  ui.mockInput.pressEscape(); await ui.settle();
  ui.mockInput.pressEscape(); await ui.settle();
  ui.mockInput.pressKey("r"); await ui.settle();
  // A later ordinary reopen is a fresh snapshot at the top.
  expect(ui.readerText()).not.toContain("Find:");
}));

test("reader search highlights matches with attributes visible without color and never in copy", () => {
  const source = "alpha needle\n\tneedle ไทย 🧪 needle";
  const document = createReaderDocument({ id: "code-m-0", messageId: "m", kind: "code" }, source, { title: "txt", streaming: false });
  const layout = readerLayout(document, false, 40, 8, { approval: false, search: true });
  const search = { query: "needle", selected: 1, origin: { offset: 0, horizontal: 0 } };
  const chunks = paintReader({ document, layout, position: { offset: 0, horizontal: 0 }, columns: 40, rows: 8, theme: { ...TUI_THEMES.dark }, search }).chunks;
  const marked = chunks.filter(chunk => (chunk.attributes ?? 0) !== 0 && chunk.text === "needle");
  expect(marked).toHaveLength(3);
  expect(new Set(marked.map(chunk => chunk.attributes)).size).toBe(2);
  expect(chunks.map(chunk => chunk.text).join("")).toContain("Find: needle · 2/3");
  expect(document.copy.copy().text).toBe(source);
});

const catalogTable = ["| Region | Owner | Q1 revenue | Q2 revenue | Change | Status | Notes | Follow-up |", "| --- | --- | ---: | ---: | ---: | --- | --- | --- |",
  ...Array.from({ length: 36 }, (_, index) => `| ภาค ${index + 1} | ${index % 3 ? "Dana" : ""} | ${(1200 + index * 37).toLocaleString("en-US")} | ${(1300 + index * 41).toLocaleString("en-US")} | +${(index % 9) + 1}% | ${index % 4 ? "On track" : "Review 🧪"} | [details](https://example.test/regions/${index + 1}) | Confirm the quarter-end forecast with finance |`)].join("\n");
const wideColumnTable = `| Key | Wide | Tail |\n| --- | --- | --- |\n| a | ${Array.from({ length: 30 }, (_, index) => `w${String(index).padStart(2, "0")}`).join(" ")} ${"z".repeat(38)} | end |`;

for (const width of [40, 50, 80, 120]) test(`horizontal navigation alone paints every table and code cell at ${width} columns`, () => {
  for (const [kind, source] of [["table", catalogTable], ["table", wideColumnTable], ["code", longCode]] as const) {
    const document = createReaderDocument({ id: `${kind}-m-0`, messageId: "m", kind }, source, { title: kind, streaming: false });
    const layout = readerLayout(document, false, width, 12, { approval: false, search: false });
    const columns = layout.viewport.columns;
    const covered = new Uint8Array(document.maxWidth);
    let horizontal = 0;
    for (let step = 0; step < 500; step++) {
      for (let cell = horizontal; cell < Math.min(document.maxWidth, horizontal + columns); cell++) covered[cell] = 1;
      const next = panReader(document, layout, { offset: 0, horizontal }, 1);
      if (next === horizontal) break;
      expect(next).toBeGreaterThan(horizontal);
      horizontal = next;
    }
    expect(covered.indexOf(0), `${kind} gap at ${width}`).toBe(-1);
    // Left mirrors Right back to the first column without skipping cells.
    const back = new Uint8Array(document.maxWidth);
    for (let step = 0; step < 500; step++) {
      for (let cell = horizontal; cell < Math.min(document.maxWidth, horizontal + columns); cell++) back[cell] = 1;
      const next = panReader(document, layout, { offset: 0, horizontal }, -1);
      if (next === horizontal) break;
      expect(next).toBeLessThan(horizontal);
      horizontal = next;
    }
    expect(horizontal).toBe(0);
    expect(back.indexOf(0), `${kind} gap leftwards at ${width}`).toBe(-1);
  }
});

test("the catalog table's widest cells are painted by Right alone in the 40-column app", async () => {
  const ui = await setup(40, 24);
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: catalogTable } });
  ui.controller.applyEvent({ type: "model.finished" });
  await ui.settle();
  ui.mockInput.pressKey("i", { meta: true }); await ui.settle();
  ui.mockInput.pressKey("r"); await ui.settle();
  let painted = "";
  for (let step = 0; step < 40; step++) { painted += ui.readerText(); ui.mockInput.pressArrow("right"); await ui.settle(); }
  for (const fragment of ["https://e", "xample.test/regi", "ons/1)", "Confirm the quarter-", "end forecast with finance"]) expect(painted).toContain(fragment);
  expect(ui.hints()).toStartWith("Esc back");
});

test("conversation search ignores code and table header chrome", async () => {
  const ui = await setup(80, 24);
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "```ts\nconst x = 1;\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |" } });
  ui.controller.applyEvent({ type: "model.finished" });
  await ui.settle();
  for (const query of ["inspect", "table", "Alt+I"]) {
    ui.mockInput.pressKey("f", { ctrl: true }); await ui.mockInput.typeText(query); await ui.settle();
    expect(ui.captureCharFrame()).toContain("No matches in this branch");
    ui.mockInput.pressEscape(); await ui.settle();
  }
  ui.mockInput.pressKey("f", { ctrl: true }); await ui.mockInput.typeText("const"); await ui.settle();
  expect(ui.captureCharFrame()).toContain("Find 1/1");
});

test("panning a source too large to measure stops at the widest line in view", () => {
  const source = Array.from({ length: 21_000 }, (_, index) => `${index % 7 ? "a" : "b"}`.repeat(100)).join("\n");
  const document = createReaderDocument({ id: "code-m-0", messageId: "m", kind: "code" }, source, { title: "txt", streaming: false });
  expect(document.maxWidth).toBe(Infinity);
  const layout = readerLayout(document, false, 50, 10, { approval: false, search: false });
  let horizontal = 0;
  for (let step = 0; step < 50; step++) horizontal = panReader(document, layout, { offset: 0, horizontal }, 1);
  expect(horizontal).toBe(100 - layout.viewport.columns);
});

test("pinned header matches stay distinguishable without color", () => {
  const source = "| Alpha | Beta | Alpha2 |\n| --- | --- | --- |\n| x | y | z |";
  const document = createReaderDocument({ id: "table-m-0", messageId: "m", kind: "table" }, source, { title: "table", streaming: false });
  const layout = readerLayout(document, false, 60, 10, { approval: false, search: true });
  const chunks = paintReader({ document, layout, position: { offset: 0, horizontal: 0 }, columns: 60, rows: 10, theme: TUI_THEMES.dark, search: { query: "alpha", selected: 0, origin: { offset: 0, horizontal: 0 } } }).chunks;
  const matches = chunks.filter(chunk => chunk.text === "Alpha");
  expect(matches).toHaveLength(2);
  expect(matches[0]!.attributes).not.toBe(matches[1]!.attributes);
  expect(chunks.find(chunk => chunk.text.includes("Beta"))!.attributes).not.toBe(0);
});
