import { expect, test } from "bun:test";
import { ReaderSnapshot, READER_SOURCE_LIMIT, type ReaderPosition } from "../src/tui/reader.ts";

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
