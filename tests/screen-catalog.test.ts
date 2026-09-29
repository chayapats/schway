import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { RGBA, type CapturedFrame } from "@opentui/core";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { SCREENS, variantsFor } from "./screen-catalog/screens.ts";
import { renderScreen } from "./screen-catalog/harness.ts";
import { parseScreen, serializeScreen } from "./screen-catalog/format.ts";
import { buildGallery } from "./screen-catalog/gallery.ts";

const directory = join(import.meta.dir, "screen-catalog/goldens");
const update = process.env.SCHWAY_UPDATE_SCREENS === "1";
const fixedTime = "2026-01-15T09:30:00.000Z";
const expected = new Set(SCREENS.flatMap(screen => variantsFor(screen).map(variant => `${screen.id}/${variant.id}.golden`)));
const index = SCREENS.map(screen => screen.id).join("\n") + "\n";
let originalFetch: typeof fetch;
async function files(root: string): Promise<string[]> {
  try { return (await Promise.all((await readdir(root, { withFileTypes: true })).map(async entry => entry.isDirectory() ? (await files(join(root, entry.name))).map(file => `${entry.name}/${file}`) : [entry.name]))).flat(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
async function prune(root: string, prefix = ""): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = prefix + entry.name, path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (![...expected].some(file => file.startsWith(`${relative}/`))) await rm(path, { recursive: true });
      else await prune(path, `${relative}/`);
    } else if (relative !== "index.txt" && !expected.has(relative)) await rm(path);
  }
}
beforeAll(async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(() => { throw new Error("screen catalog must not use the network"); }, { preconnect: originalFetch.preconnect }) as typeof fetch;
  if (update) { await mkdir(directory, { recursive: true }); await prune(directory); await writeFile(join(directory, "index.txt"), index); }
});
afterAll(() => { globalThis.fetch = originalFetch; setSystemTime(); });

// Longest-common-subsequence diff keeps insertions from turning every following row into noise.
function diff(expected: string, actual: string): string {
  const a = expected.split("\n"), b = actual.split("\n");
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  let i = 0, j = 0; const changed: string[] = [];
  while ((i < a.length || j < b.length) && changed.length < 60) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; }
    else if (i < a.length && (j === b.length || table[i + 1]![j]! >= table[i]![j + 1]!)) changed.push(`- ${a[i++]}`);
    else changed.push(`+ ${b[j++]}`);
  }
  return changed.join("\n");
}
for (const screen of SCREENS) for (const variant of variantsFor(screen)) test(`screen ${screen.id} ${variant.id}`, async () => {
  setSystemTime(new Date(fixedTime));
  const actual = await renderScreen(screen, variant);
  const relative = `tests/screen-catalog/goldens/${screen.id}/${variant.id}.golden`, path = join(directory, screen.id, `${variant.id}.golden`);
  if (update) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, actual); return; }
  if (!await Bun.file(path).exists()) throw new Error(`Missing golden ${relative}. Run: bun run screens:update`);
  const wanted = await readFile(path, "utf8");
  if (wanted !== actual) throw new Error(`Golden mismatch ${relative}. Run: bun run screens:update\n${diff(wanted, actual)}`);
}, 15_000);

test("catalog screen order and golden inventory are explicit", async () => {
  expect(SCREENS.map(s => s.id)).toEqual(["first-run", "sign-in-chooser", "subscription-sign-in", "model-picker", "command-palette", "thai-composer", "streaming-answer", "parallel-tools", "completed-turn", "failed-turn", "retry-countdown", "review-panel", "recent-work-resume", "compaction", "no-color", "narrow-layout"]);
  const unexpected = (await files(directory)).filter(file => file !== "index.txt" && !expected.has(file));
  if (!await Bun.file(join(directory, "index.txt")).exists() || await readFile(join(directory, "index.txt"), "utf8") !== index) unexpected.push("index.txt");
  if (unexpected.length) throw new Error(`Unexpected catalog files: ${unexpected.join(", ")}. Run: bun run screens:update`);
});
test("catalog repeated renders are byte-identical", async () => {
  for (const id of ["first-run", "streaming-answer", "completed-turn"]) {
    const screen = SCREENS.find(s => s.id === id)!, variant = variantsFor(screen).find(v => v.id === "dark-80")!;
    setSystemTime(new Date(fixedTime)); const first = await renderScreen(screen, variant);
    setSystemTime(new Date(fixedTime)); expect(await renderScreen(screen, variant)).toBe(first);
  }
}, 15_000);
test("catalog goldens contain no host paths, identities or changing timestamps", async () => {
  const username = userInfo().username;
  for (const file of await files(directory)) {
    const text = await readFile(join(directory, file), "utf8");
    // The required format identifier is itself "schway-screen"; scan the remaining payload.
    expect(text.replace(/^schway-screen 1\n/, "")).not.toMatch(/\/tmp\/|\/var\/folders\/|schway-|[0-9a-f]{8}-[0-9a-f]{4}-/);
    if (username.length > 3) expect(text).not.toContain(username);
    expect([...text.matchAll(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g)].map(match => match[0]).filter(time => time !== fixedTime)).toEqual([]);
  }
});
const fixture: CapturedFrame = { cols: 5, rows: 1, cursor: [4, 1], lines: [{ spans: [
  { text: "ก้", width: 1, fg: RGBA.fromInts(12, 34, 56, 128), bg: RGBA.defaultBackground(), attributes: 0x1ff },
  { text: "⚡", width: 2, fg: RGBA.fromInts(12, 34, 56, 128), bg: RGBA.defaultBackground(), attributes: 0xff },
  { text: "< ", width: 2, fg: RGBA.fromIndex(3), bg: RGBA.fromHex("#abcdef"), attributes: 0 },
] }] };
const fixtureMeta = { screen: "fixture", title: "Fixture", description: "A fixture with terminal colors.", variant: "dark-5", cursor: { x: 4, y: 1, visible: true } };
test("golden format preserves Thai, wide cells, alpha, color intent and all attributes", () => {
  const text = serializeScreen(fixture, fixtureMeta), parsed = parseScreen(text);
  expect(parsed).toEqual({ ...fixtureMeta, cols: 5, rows: 1, text: ["ก้⚡<"], styles: [
    { row: 0, start: 0, end: 3, fg: "#0c223880", bg: "default", attrs: "bdiukrhs" },
    { row: 0, start: 3, end: 5, fg: "idx3", bg: "#abcdef", attrs: "-" },
  ] });
  expect(text).not.toContain("\t"); expect(text.endsWith("\n")).toBe(true);
  expect(() => parseScreen(text.replace("schway-screen 1", "schway-screen 2"))).toThrow("version");
  expect(() => parseScreen(text.replace("size 5x1", "size 5x2"))).toThrow("row count");
});
test("gallery uses fixture goldens only and escapes cells without external assets", async () => {
  const temp = await mkdtemp(join(tmpdir(), "catalog-gallery-"));
  try {
    await writeFile(join(temp, "index.txt"), "fixture\nsecond\n");
    for (const id of ["fixture", "second"]) { await mkdir(join(temp, id)); await writeFile(join(temp, id, "dark-5.golden"), serializeScreen(fixture, { ...fixtureMeta, screen: id })); }
    const output = join(temp, "gallery.html"); await buildGallery(temp, output);
    const html = await readFile(output, "utf8");
    for (const needle of ['id="fixture"', 'id="second"', "#0c223880", "#abcdef", "&lt;", "outline:1px"]) expect(html).toContain(needle);
    expect(html).toMatch(/outline:1px[^>]*>&lt;<\/span>/);
    expect(html).not.toMatch(/https?:\/\/|<script\s+src/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
test("gallery and format stay independent of application code and screen recipes", async () => {
  for (const file of ["gallery.ts", "format.ts"]) {
    const imports = (await readFile(join(import.meta.dir, "screen-catalog", file), "utf8")).split("\n").filter(line => /^import /.test(line));
    expect(imports.join("\n")).not.toMatch(/src\/|screens\.ts/);
  }
});
