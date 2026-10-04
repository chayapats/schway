import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { RGBA, type CapturedFrame } from "@opentui/core";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { SCREENS, variantsFor } from "./screen-catalog/screens.ts";
import { renderScreen } from "./screen-catalog/harness.ts";
import { parseScreen, serializeScreen } from "./screen-catalog/format.ts";
import { TUI_THEMES } from "../src/tui/theme.ts";
import { buildGallery } from "./screen-catalog/gallery.ts";

const directory = join(import.meta.dir, "screen-catalog/goldens");
const update = process.env.SCHWAY_UPDATE_SCREENS === "1";
const fixedTime = "2026-01-15T09:30:00.000Z";
const expected = new Set(SCREENS.flatMap(screen => variantsFor(screen).map(variant => `${screen.id}/${variant.id}.golden`)));
const index = SCREENS.map(screen => screen.id).join("\n") + "\n";
let originalFetch: typeof fetch;
const gitEnvironment = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"] as const;
const originalGitEnvironment = new Map<string, string | undefined>();
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
  for (const key of gitEnvironment) { originalGitEnvironment.set(key, process.env[key]); process.env[key] = "/dev/null"; }
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(() => { throw new Error("screen catalog must not use the network"); }, { preconnect: originalFetch.preconnect }) as typeof fetch;
  if (update) { await mkdir(directory, { recursive: true }); await prune(directory); await writeFile(join(directory, "index.txt"), index); }
});
afterAll(() => {
  globalThis.fetch = originalFetch; setSystemTime();
  for (const key of gitEnvironment) { const value = originalGitEnvironment.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

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
  if (screen.id.startsWith("draft-")) {
    const text = parseScreen(actual).text.join("\n");
    expect(text).toContain(screen.id === "draft-restored" ? "Draft restored" : "Draft not saved");
    expect(text).toContain(screen.id === "draft-restored" ? "Alt+D discard" : variant.cols === 24 ? "Select, Ctrl+C copy" : "Select text, Ctrl+C copy");
    if (screen.id === "draft-not-saved") { expect(text).toContain("Ctrl+C"); expect(text).not.toContain("Draft saved"); }
    expect(text).not.toMatch(/checkpoint|NOT SAVED|Keep this window open/);
    expect(text).toContain("Auto"); expect(text).toContain(variant.rows === 8 ? "Enter send" : "Enter");
    expect(text).toContain("🧪");
  }
  if (screen.id.startsWith("review-")) {
    // Both scopes stay named in the primary view at every width, without opening Details.
    const text = parseScreen(actual).text.join("\n");
    expect(text).toContain(screen.id === "review-multi-turn" ? "Files from turn 2" : "Files from turn 1");
    expect(text).toContain("Current diff");
    expect(text).toContain("Esc back");
  }
  if (screen.id.startsWith("details-")) {
    const text = parseScreen(actual).text.join("\n");
    expect(text).not.toContain("Ctrl+I");
    if (screen.id === "details-unavailable") {
      expect(text).toContain("งานถัดไป 🧪"); expect(text).toContain("Enter send"); expect(text).not.toContain("Esc back");
    } else {
      expect(text).toContain("Esc back");
      if (screen.id === "details-model") { expect(text).toContain("gpt-6-astra"); expect(text).toContain("1,050,000 context"); }
      if (screen.id === "details-review") {
        expect(text).toContain("Commands:");
        // Rejoin the word-wrapped Details column; a scrollbar over the last column would drop letters.
        const lines = parseScreen(actual).text.map(line => (line.includes("│") ? line.slice(line.indexOf("│") + 1) : line).replace(/[▀▄█▐▌]+\s*$/, "").trim());
        expect(lines.some(line => line.endsWith("does no"))).toBe(false);
        // The stacked 50-column layout scrolls this sentence below the fold; side-by-side widths show it whole.
        if (variant.cols >= 80) expect(lines.join(" ")).toContain("does not restore files");
      }
      if (screen.id === "details-notice" || screen.id === "details-recovery") {
        expect(text).toContain("งานถัดไป 🧪");
        if (variant.rows > 8) expect(text).toContain(screen.id === "details-notice" ? "The choice could not be saved." : "No command exit evidence.");
      }
    }
  }
  if (screen.id.startsWith("inspection-")) {
    const text = parseScreen(actual).text.join("\n");
    expect(text).not.toContain("Alt+I copy");
    expect(text).not.toContain("Earlier hidden block");
    expect(text).not.toContain("Copied code");
    expect(text).toContain("งานถัดไป 🧪");
    if (screen.id === "inspection-code") {
      expect(text.split("\n").find(line => line.includes("› ts"))).toContain("C copy · Esc back");
      expect(text.split("\n").find(line => line.includes("json"))).toContain("Alt+I inspect");
    } else if (screen.id === "inspection-unfocused") {
      expect(text.match(/Alt\+I inspect/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(text).not.toContain("C copy");
    } else {
      expect(text).toMatch(/›.*READ/);
      expect(text).toContain("ผลลัพธ์ภาษาไทย 🧪");
      expect(text).toContain("Second result line");
      expect(text).toContain("Enter toggle");
      expect(text).toContain("C copy");
    }
  }
  if (screen.id.startsWith("stopped-") || screen.id === "failed-turn") {
    const frame = parseScreen(actual), text = frame.text.join("\n");
    const stopping = screen.id.startsWith("stopped-");
    expect(text).toContain(stopping ? "Stopped" : "Failed");
    expect(text).toContain("Ctrl+R continue");
    expect(frame.text.map(line => line.trim().replace(/^▌\s?/, "")).join(" ").replace(/\s+/g, " ")).toContain("Esc keep editing");
    expect(text).not.toContain("Cancelled");
    const outcomeRow = frame.text.findIndex(line => line.includes(stopping ? "− Stopped" : "✗ Failed"));
    expect(outcomeRow).toBeGreaterThanOrEqual(0);
    const theme = TUI_THEMES[variant.theme];
    expect(frame.styles.some(style => style.row === outcomeRow && style.fg === (stopping ? theme.muted : variant.noColor ? theme.text : theme.error))).toBe(true);
    if (stopping) {
      expect(text).not.toContain("! Error");
      expect(text).toContain("Ready");
      expect(text).toContain("งานถัดไป 🧪");
      expect(text).toContain("ยังไม่ส่ง");
      expect(text).toContain("Completed results kept");
      if (screen.id === "stopped-streaming") expect(text).toContain("Incomplete response");
      else {
        expect(text).toContain("saved.txt");
        expect(frame.text.find(line => line.includes(" BASH "))).toContain("Stopped");
        if (variant.cols >= 80) expect(text).toContain("1 command stopped");
      }
    } else expect(text).toContain("! Error");
  }
  if (screen.id.startsWith("shell-")) {
    const frame = parseScreen(actual);
    const rows = frame.text.filter(line => line.includes(" BASH "));
    if (screen.id.startsWith("shell-long-failure")) {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatch(/! +BASH.*Exit 1.*[▸▾]/);
      expect(rows[0]).not.toContain("✓");
      if (screen.id.endsWith("expanded")) {
        expect(frame.text.join("\n")).toContain("Exit code: 1");
        expect(frame.text.join("\n")).toContain("ตรวจผลลัพธ์ภาษาไทย 🧪");
      }
    } else {
      expect(rows).toHaveLength(8);
      for (const [index, label] of ["Exit 0", "Exit 7", "Stopped", "Stopped", "Timed out", "No exit observed", "No exit observed", "Tool error"].entries()) {
        expect(rows[index]).toContain(label);
        expect(rows[index]).toMatch(/[▸▾]/);
        if (index > 0) expect(rows[index]).not.toContain("✓");
      }
    }
  }
  const relative = `tests/screen-catalog/goldens/${screen.id}/${variant.id}.golden`, path = join(directory, screen.id, `${variant.id}.golden`);
  if (update) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, actual); return; }
  if (!await Bun.file(path).exists()) throw new Error(`Missing golden ${relative}. Run: bun run screens:update`);
  const wanted = await readFile(path, "utf8");
  if (wanted !== actual) throw new Error(`Golden mismatch ${relative}. Run: bun run screens:update\n${diff(wanted, actual)}`);
}, 15_000);

test("catalog screen order and golden inventory are explicit", async () => {
  expect(SCREENS.map(s => s.id)).toEqual(["first-run", "disconnected-search", "auto-mode", "read-only-mode", "ask-mode", "approval-modes-help", "read-only-search-empty", "read-only-search-matches", "read-only-search-no-matches", "approval-command", "approval-edit", "sign-in-chooser", "chatgpt-more-options", "grok-more-options", "endpoint-url-empty", "endpoint-url-error", "subscription-sign-in", "grok-browser-approval", "grok-device-approval", "grok-plan-error", "model-picker", "details-model", "model-picker-unconnected", "thinking-controls", "command-palette", "command-palette-groups", "command-palette-query", "thai-composer", "draft-restored", "draft-not-saved", "streaming-answer", "running-search", "parallel-tools", "completed-turn", "shell-long-failure", "shell-long-failure-expanded", "shell-outcomes", "large-edit", "stopped-streaming", "stopped-tool", "failed-turn", "details-notice", "details-recovery", "details-unavailable", "retry-countdown", "review-panel", "details-review", "review-multi-turn", "review-staged-unstaged", "undo-preview", "undo-preview-no-git", "undo-shell-only", "undo-older-target", "undo-detection-unavailable", "delete-session-busy", "recent-work-resume", "compaction", "no-color", "narrow-layout", "table-and-code", "inspection-unfocused", "inspection-code", "inspection-tool"]);
  const unexpected = (await files(directory)).filter(file => file !== "index.txt" && !expected.has(file));
  if (!await Bun.file(join(directory, "index.txt")).exists() || await readFile(join(directory, "index.txt"), "utf8") !== index) unexpected.push("index.txt");
  if (unexpected.length) throw new Error(`Unexpected catalog files: ${unexpected.join(", ")}. Run: bun run screens:update`);
});
test("catalog repeated renders are byte-identical", async () => {
  for (const id of ["first-run", "streaming-answer", "completed-turn", "review-panel", "review-multi-turn", "inspection-code", "stopped-streaming", "stopped-tool", "draft-restored", "draft-not-saved", "details-model", "details-review", "details-notice", "details-recovery", "details-unavailable"]) {
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

test("catalog ignores conflicting host Git diff configuration", async () => {
  const temp = await mkdtemp(join(tmpdir(), "catalog-git-config-"));
  try {
    const config = join(temp, "gitconfig");
    await writeFile(config, "[diff]\n\tnoPrefix = true\n\tmnemonicPrefix = true\n");
    const child = Bun.spawn([process.execPath, "test", "tests/screen-catalog.test.ts", "-t", "^screen review-panel dark-120$"], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env, SCHWAY_UPDATE_SCREENS: "0", GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: "/dev/null" }, stdout: "pipe", stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (exit !== 0) throw new Error(`Host Git configuration changed catalog output:\n${stdout}${stderr}`);
  } finally { await rm(temp, { recursive: true, force: true }); }
}, 15_000);
