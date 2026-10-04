import { afterEach, expect, test } from "bun:test";
import { BoxRenderable, type CapturedFrame } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createTranscriptItem, markdownStyle } from "../src/tui/transcript-view.ts";
import type { TuiTranscriptEntry } from "../src/tui/controller-types.ts";
import { TuiController } from "../src/tui/controller.ts";
import { createConversationView } from "../src/tui/view.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseScreen, serializeScreen, type ScreenGolden } from "./screen-catalog/format.ts";
import { mixColor, readableForeground, resolveTheme, TEXT_ROLES, textOn, themeOn, tint, TUI_THEMES, type TuiTheme } from "../src/tui/theme.ts";

// Independent measurement of the emitted RGB bytes, not the resolver's search intermediates.
function contrast(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255);
    const linear = channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
  };
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("selected sign-in metadata reaches 4.5 on its actual composed dark background", () => {
  const original = "#8b95a7", background = "#33475e";
  expect(contrast(original, background)).toBeCloseTo(3.1560, 4);
  const foreground = readableForeground(original, background);
  expect(foreground).toMatch(/^#[0-9a-f]{6}$/);
  expect(contrast(foreground!, background)).toBeGreaterThanOrEqual(4.5);
});

function expectReadable(role: string, preferred: string, background: string): string {
  const result = readableForeground(preferred, background);
  expect(result, `${role}: resolved RGB inputs must produce a foreground`).toMatch(/^#[0-9a-f]{6}$/i);
  const ratio = contrast(result!, background);
  expect(ratio, `${role}: ${result} on ${background} measures ${ratio}:1`).toBeGreaterThanOrEqual(4.5);
  if (contrast(preferred, background) >= 4.5) expect(result, `${role}: preserve the passing foreground`).toBe(preferred);
  return result!;
}

test("contrast measurement agrees with numeric reference pairs and byte rounding boundaries", () => {
  expect(contrast("#000000", "#ffffff")).toBe(21);
  expect(contrast("#abcdef", "#abcdef")).toBe(1);
  expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.4781, 4);
  expect(contrast("#767676", "#ffffff")).toBeCloseTo(4.5422, 4);
  expect(contrast("#747474", "#000000")).toBeCloseTo(4.4929, 4);
  expect(readableForeground("#777777", "#ffffff")).toBe("#767676");
  expect(readableForeground("#747474", "#000000")).toBe("#757575");
});

// Actual composed style runs from the #245 catalog at 09c943c, plus captured focus/animation states.
const observed = [
  ["NO_COLOR dark selected metadata/diff number", "#8b95a7", "#4a505a", 2.6891],
  ["dark added-line number", "#8b95a7", "#374a48", 3.1110],
  ["dark removed-line number", "#8b95a7", "#4e3f48", 3.2674],
  ["light selected metadata", "#545e6c", "#c7d2d6", 4.2629],
  ["light added-line number", "#545e6c", "#c9d3ca", 4.2741],
  ["light removed-line number", "#545e6c", "#dacbc7", 4.1784],
  ["dark selected deletes metadata", "#beae8e", "#33475e", 4.3720],
  ["NO_COLOR dark selected deletes metadata", "#b9c0cc", "#4a505a", 4.4368],
  ["dark neutral Not connected pill", "#8b95a7", "#303641", 4.0209],
  ["dark search-selected secondary text", "#8b95a7", "#2c3444", 4.1354],
  ["light search-selected secondary text", "#545e6c", "#c5c9cf", 3.9535],
  ["light search-selected You heading", "#0a5894", "#c5c9cf", 4.4527],
  ["NO_COLOR light selected metadata/diff number", "#545e6c", "#c9ccca", 4.0611],
  ["dark flash success label", "#8fd19e", "#466157", 3.7909],
  ["light flash success label", "#19612f", "#9bb6a1", 3.4379],
  ["NO_COLOR dark flash disclosure/output", "#8b95a7", "#646973", 1.8254],
  ["NO_COLOR light flash disclosure/output", "#545e6c", "#9ca0a0", 2.4884],
  ["dark Waiting pill at fade start", "#0e1117", "#31433f", 1.8045],
  ["light Waiting pill at fade start", "#ffffff", "#d3dcd4", 1.4040],
  ["NO_COLOR dark Waiting pill at fade start", "#0e1117", "#444951", 2.0856],
  ["NO_COLOR light Waiting pill at fade start", "#f7f7f4", "#d3d5d3", 1.3751],
  ["light Waiting pill during fade", "#ffffff", "#467fa7", 4.3262],
] as const;

for (const [role, preferred, background, measured] of observed) test(`${role} is readable on the observed background`, () => {
  expect(contrast(preferred, background), role).toBeCloseTo(measured, 4);
  const result = expectReadable(role, preferred, background);
  expect(result).not.toBe(preferred);
  // Keep intermediate semantic colors; a global black/white replacement would flatten every role.
  expect(result).not.toBe("#000000");
  expect(result).not.toBe("#ffffff");
});

const themes = [
  ["dark", resolveTheme("dark", null, {})],
  ["light", resolveTheme("light", null, {})],
  ["NO_COLOR dark", resolveTheme("dark", null, { NO_COLOR: "1" })],
  ["NO_COLOR light", resolveTheme("light", null, { NO_COLOR: "1" })],
] as const;

/** Every resolved background that carries text, named by the rendered role that composes it. */
function supportedBackgrounds(theme: TuiTheme): [string, string][] {
  const backgrounds: [string, string][] = [
    ["canvas", theme.background], ["surface", theme.surface], ["surface 2", theme.surface2],
    ["selected/focused row", tint(theme, theme.accent)], ["added diff line", tint(theme, theme.success)], ["removed diff line", tint(theme, theme.error)],
    ["search highlight", theme.border], ["neutral status pill", tint(theme, theme.muted, theme.surface)], ["ready status pill", tint(theme, theme.success, theme.surface)],
    ["reasoning chip", tint(theme, theme.violet, theme.surface)], ["inline code", tint(theme, theme.code)], ["error block", mixColor(theme.background, theme.error, 0.12)],
  ];
  for (const fraction of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
    backgrounds.push([`completion flash at ${fraction}`, mixColor(mixColor(theme.surface2, theme.success, 0.35), theme.surface2, fraction)]);
    const fill = mixColor(tint(theme, theme.success, theme.surface), theme.accent, fraction);
    backgrounds.push([`status pill fade at ${fraction}`, fill], [`status pill sweep at ${fraction}`, mixColor(fill, theme.core, 0.28)]);
  }
  return backgrounds;
}

for (const [label, theme] of themes) test(`${label} text roles read at 4.5:1 on every supported background`, () => {
  const before = JSON.stringify(theme);
  const failures: string[] = [];
  const check = (role: string, background: string, name: string, color: string) => {
    const ratio = contrast(color, background);
    if (ratio < 4.5) failures.push(`${label} ${role} on ${name} (${background}) measures ${ratio.toFixed(2)}:1`);
  };
  for (const [name, background] of supportedBackgrounds(theme)) {
    const ink = themeOn(theme, background);
    for (const role of TEXT_ROLES) check(role, background, name, ink[role]);
    check("deletes metadata", background, name, textOn(mixColor(theme.warning, theme.muted, 0.5), background));
    check("on-fill status word", background, name, textOn(theme.onFill, background));
  }
  for (const fill of ["accent", "warning", "error"] as const) check("on-fill status word", theme[fill], `${fill} pill`, textOn(theme.onFill, theme[fill]));
  expect(failures).toEqual([]);
  expect(JSON.stringify(theme)).toBe(before);
});

for (const [label, theme] of themes) test(`${label} keeps the calm hierarchy instead of brightening every muted token`, () => {
  // Base canvases already pass, so the palette is returned untouched.
  for (const background of [theme.background, theme.surface, theme.surface2]) expect(themeOn(theme, background)).toBe(theme);
  for (const [name, background] of supportedBackgrounds(theme)) {
    const ink = themeOn(theme, background);
    for (const role of TEXT_ROLES) if (contrast(theme[role], background) >= 4.5) expect(ink[role], `${label} ${role} on ${name}`).toBe(theme[role]);
    // Secondary text stays quieter than primary text wherever both share a fill unchanged by primary text.
    if (theme.muted !== theme.text && ink.text === theme.text) expect(contrast(ink.muted, background), `${label} muted vs text on ${name}`).toBeLessThan(contrast(ink.text, background));
  }
});

test("unresolved colors pass through without a numerical claim", () => {
  for (const unresolved of ["default", "idx7", "#ffffff80"]) {
    expect(textOn("#8b95a7", unresolved)).toBe("#8b95a7");
    expect(themeOn(TUI_THEMES.dark, unresolved)).toBe(TUI_THEMES.dark);
  }
});

test("already-readable foreground spelling and case stay byte-for-byte unchanged", () => {
  for (const preferred of ["#abcdef", "#ABCDEF", "#aBcDeF", "#FFFFFF"]) {
    expect(readableForeground(preferred, "#000000")).toBe(preferred);
  }
  expect(readableForeground("#0A0b0C", "#FFFFFF")).toBe("#0A0b0C");
});

test("rounded grayscale adjustments match the nearest passing byte across every background", () => {
  const gray = (value: number) => `#${value.toString(16).padStart(2, "0").repeat(3)}`;
  for (let value = 0; value <= 255; value++) {
    const background = gray(value);
    // Exhaustive byte-domain oracle, independent of the resolver's bounded blend search.
    const candidates = Array.from({ length: 256 }, (_, byte) => byte)
      .filter(byte => contrast(gray(byte), background) >= 4.5)
      .sort((a, b) => Math.abs(a - value) - Math.abs(b - value) || a - b);
    const result = expectReadable(`gray background ${value}`, background, background);
    expect(result).toBe(gray(candidates[0]!));
  }
});

test("unresolved or unsupported colors return no numerical contrast claim", () => {
  for (const unresolved of ["default", "idx7", "red", "transparent", "#abc", "#ffffff80", "#00000000", "#ffffffFF", "#gggggg", "#1234567", " #ffffff", "#ffffff\n", ""]) {
    expect(readableForeground("#8b95a7", unresolved), `background ${JSON.stringify(unresolved)}`).toBeUndefined();
    expect(readableForeground(unresolved, "#33475e"), `foreground ${JSON.stringify(unresolved)}`).toBeUndefined();
  }
});

/**
 * Decorative style runs exempt from the 4.5:1 text requirement. Each carries no necessary
 * information: meaning is always repeated by adjacent words, glyphs or layout.
 */
const DECORATIVE: readonly { name: string; glyphs: RegExp; roles: readonly (keyof TuiTheme)[] }[] = [
  { name: "raised-surface half-block edges", glyphs: /^[▄▀]+$/, roles: ["surface", "surface2"] },
  { name: "rules, dividers and empty context-meter cells", glyphs: /^[━│─]+$/, roles: ["border"] },
  { name: "user and error left bars", glyphs: /^▌+$/, roles: ["accent", "error"] },
  { name: "top-bar lightning brand mark", glyphs: /^⚡$/, roles: ["bolt"] },
];

/** Theme that produced a golden variant; NO_COLOR variants carry a nocolor- prefix. */
function variantTheme(variant: string): TuiTheme {
  return resolveTheme(variant.includes("light") ? "light" : "dark", null, variant.startsWith("nocolor-") ? { NO_COLOR: "1" } : {});
}

/** Split a rendered row into terminal cells so style ranges index wide and combining text correctly. */
function cells(line: string): string[] {
  const out: string[] = [];
  for (const char of line) {
    const width = Bun.stringWidth(char);
    if (width === 0) { if (out.length) out[out.length - 1] += char; continue; }
    out.push(char, ...Array<string>(width - 1).fill(""));
  }
  return out;
}

/** Visible text style runs of a screen with their measured ratios. */
function textRuns(screen: ScreenGolden) {
  return screen.styles.map(run => ({ ...run, text: cells(screen.text[run.row] ?? "").slice(run.start, run.end).join("") })).filter(run => run.text.trim());
}

/** Describe every text run below 4.5:1 that is not a documented decorative exception, plus unresolved colors. */
function unreadableRuns(screen: ScreenGolden, theme: TuiTheme): string[] {
  const failures: string[] = [];
  for (const run of textRuns(screen)) {
    const where = `${screen.screen}/${screen.variant} row ${run.row} ${JSON.stringify(run.text.trim())}`;
    // Terminal defaults, indexed slots and alpha need the terminal to resolve them; never claim a ratio.
    if (!/^#[0-9a-f]{6}$/.test(run.fg) || !/^#[0-9a-f]{6}$/.test(run.bg)) { failures.push(`${where}: unresolved ${run.fg} on ${run.bg} needs manual inspection`); continue; }
    if (run.attrs.includes("d") || run.attrs.includes("h")) failures.push(`${where}: dim or hidden text cannot count toward contrast`);
    const ratio = contrast(run.fg, run.bg);
    if (ratio >= 4.5) continue;
    const decorative = DECORATIVE.find(entry => entry.glyphs.test(run.text.trim()) && entry.roles.some(role => theme[role] === run.fg));
    if (!decorative) failures.push(`${where}: ${run.fg} on ${run.bg} measures ${ratio.toFixed(2)}:1`);
  }
  return failures;
}

const goldens = join(import.meta.dir, "screen-catalog/goldens");
const golden = (screen: string, variant: string) => parseScreen(readFileSync(join(goldens, screen, `${variant}.golden`), "utf8"));

test("every text run in the committed screen catalog reads at 4.5:1 on its composed background", () => {
  const failures: string[] = [];
  let measured = 0;
  for (const screen of readdirSync(goldens)) {
    if (screen === "index.txt") continue;
    for (const file of readdirSync(join(goldens, screen))) {
      const parsed = parseScreen(readFileSync(join(goldens, screen, file), "utf8"));
      measured += textRuns(parsed).length;
      failures.push(...unreadableRuns(parsed, variantTheme(parsed.variant)));
    }
  }
  expect(measured).toBeGreaterThan(1000);
  expect(failures).toEqual([]);
});

// The audit's measured pairs, located in real catalog style runs; failures name role, theme and ratio.
const AUDIT: readonly { role: string; screen: string; variant: string; text: string; background: string; audited?: number }[] = [
  { role: "sign-in selected row metadata", screen: "sign-in-chooser", variant: "dark-80", text: "recommended · browser", background: "#33475e", audited: 3.16 },
  { role: "sign-in selected row metadata", screen: "sign-in-chooser", variant: "nocolor-dark-80", text: "recommended · browser", background: "#4a505a", audited: 2.69 },
  { role: "added-line number", screen: "completed-turn", variant: "dark-80", text: "2 │", background: "#374a48", audited: 3.11 },
  { role: "removed-line number", screen: "completed-turn", variant: "dark-80", text: "2 │", background: "#4e3f48", audited: 3.27 },
  { role: "selected-row secondary text", screen: "sign-in-chooser", variant: "light-80", text: "recommended · browser", background: "#c7d2d6", audited: 4.26 },
  { role: "added-line number", screen: "completed-turn", variant: "light-80", text: "2 │", background: "#c9d3ca" },
  { role: "removed-line number", screen: "completed-turn", variant: "light-80", text: "2 │", background: "#dacbc7" },
  { role: "added-line number", screen: "completed-turn", variant: "nocolor-dark-80", text: "2 │", background: "#4a505a" },
  { role: "selected destructive deletes metadata", screen: "command-palette-groups", variant: "dark-80", text: "· deletes", background: "#33475e" },
  { role: "selected destructive deletes metadata", screen: "command-palette-groups", variant: "nocolor-dark-80", text: "· deletes", background: "#4a505a" },
  { role: "neutral status pill", screen: "first-run", variant: "dark-80", text: "Not connected", background: "#303641" },
  { role: "neutral status pill", screen: "first-run", variant: "nocolor-dark-80", text: "Not connected", background: "#303641" },
  { role: "search highlight secondary text", screen: "read-only-search-matches", variant: "dark-80", text: "Read the project", background: "#2c3444" },
  { role: "search highlight secondary text", screen: "read-only-search-matches", variant: "light-80", text: "Read the project", background: "#c5c9cf" },
  { role: "search highlight You heading", screen: "running-search", variant: "light-80", text: "You", background: "#c5c9cf" },
  { role: "focused tool output", screen: "inspection-tool", variant: "dark-80", text: "Second result line", background: "#33475e" },
  { role: "focused tool output", screen: "inspection-tool", variant: "light-80", text: "Second result line", background: "#c7d2d6" },
  { role: "focused tool output", screen: "inspection-tool", variant: "nocolor-dark-80", text: "Second result line", background: "#4a505a" },
];

for (const pair of AUDIT) test(`${pair.role} (${pair.variant}) reads at 4.5:1 in the rendered catalog`, () => {
  const runs = textRuns(golden(pair.screen, pair.variant)).filter(run => run.text.includes(pair.text) && run.bg === pair.background);
  expect(runs.length, `${pair.role} (${pair.variant}): no ${JSON.stringify(pair.text)} run on ${pair.background}`).toBeGreaterThan(0);
  for (const run of runs) {
    const ratio = contrast(run.fg, run.bg);
    expect(ratio, `${pair.role} (${pair.variant}) measures ${ratio.toFixed(2)}:1 (audit: ${pair.audited ?? "below 4.5"}:1)`).toBeGreaterThanOrEqual(4.5);
  }
});

test("the catalog sweep reports low-contrast text, unresolved colors and dim text by role and ratio", () => {
  const theme = TUI_THEMES.dark;
  const fixture = (fg: string, bg: string, text: string, attrs = "-"): ScreenGolden => ({
    screen: "fixture", title: "Fixture", description: "Fixture.", variant: "dark-10", cols: 10, rows: 1, cursor: { x: 1, y: 1, visible: false },
    text: [text], styles: [{ row: 0, start: 0, end: Bun.stringWidth(text), fg, bg, attrs }],
  });
  expect(unreadableRuns(fixture(theme.muted, "#33475e", "metadata"), theme)).toEqual(["fixture/dark-10 row 0 \"metadata\": #8b95a7 on #33475e measures 3.16:1"]);
  expect(unreadableRuns(fixture(theme.surface, theme.background, "▄▄▄"), theme)).toEqual([]);
  // A decorative glyph in a text role is still text.
  expect(unreadableRuns(fixture(theme.muted, "#33475e", "━━"), theme)).toHaveLength(1);
  expect(unreadableRuns(fixture("default", theme.background, "x"), theme)[0]).toContain("needs manual inspection");
  expect(unreadableRuns(fixture(theme.text, theme.background, "x", "d"), theme)[0]).toContain("dim or hidden");
});

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

/** Capture a real renderer frame as parsed style runs. */
function capture(terminal: { captureSpans(): CapturedFrame }, variant: string): ScreenGolden {
  return parseScreen(serializeScreen(terminal.captureSpans(), { screen: "live", title: "Live", description: "Live frame.", variant, cursor: { x: 1, y: 1, visible: false } }));
}

async function transcriptRow(theme: TuiTheme, entry: TuiTranscriptEntry, clock = { now: 0 }) {
  const terminal = await createTestRenderer({ width: 60, height: 12 });
  terminal.renderer.setBackgroundColor(theme.background);
  const syntax = markdownStyle(theme);
  cleanups.push(() => { syntax.destroy(); terminal.renderer.destroy(); });
  const canvas = new BoxRenderable(terminal.renderer, { backgroundColor: theme.background, flexDirection: "column", width: "100%", height: "100%" });
  terminal.renderer.root.add(canvas);
  const row = createTranscriptItem(terminal.renderer, entry, theme, syntax, () => {}, { now: () => clock.now, mode: "full" });
  canvas.add(row.root);
  return { terminal, row };
}

const ANSWER = "Plan:\n\n- check the [guide](https://example.com/guide) first\n- run `bun test`\n\n1. Read the README\n2. Ship";

for (const [label, theme] of themes) {
  const variant = `${label.startsWith("NO_COLOR") ? "nocolor-" : ""}${label.includes("light") ? "light" : "dark"}-60`;
  test(`${label} search-highlighted answers recolor Markdown text in place and restore it`, async () => {
    const entry: TuiTranscriptEntry = { id: "answer", kind: "assistant", text: ANSWER };
    const { terminal, row } = await transcriptRow(theme, entry);
    row.update(entry, false, false, 58);
    await terminal.renderOnce();
    const plain = terminal.captureCharFrame();
    const target = row.searchSegments()[0]!.target;
    row.setSearchMatch(true);
    await terminal.renderOnce();
    // Same text and the same search targets: only colors change.
    expect(terminal.captureCharFrame()).toBe(plain);
    expect(row.searchSegments()[0]!.target).toBe(target);
    expect(target.isDestroyed).toBe(false);
    const selected = capture(terminal, variant);
    expect(textRuns(selected).some(run => run.bg === theme.border)).toBe(true);
    expect(unreadableRuns(selected, theme)).toEqual([]);
    row.setSearchMatch(false);
    await terminal.renderOnce();
    const restored = capture(terminal, variant);
    expect(textRuns(restored).find(run => run.text.includes("(https://example.com/guide)"))?.fg).toBe(theme.muted);
    expect(unreadableRuns(restored, theme)).toEqual([]);
  });

  test(`${label} focused, flashing and search-highlighted tool rows keep output and line numbers readable`, async () => {
    const clock = { now: 0 };
    const entry: TuiTranscriptEntry = { id: "tool", kind: "tool", toolName: "bash", toolStatus: "running", text: "partial", toolSummary: "bun test" };
    const { terminal, row } = await transcriptRow(theme, entry, clock);
    row.update(entry, true, false, 58);
    const done: TuiTranscriptEntry = { ...entry, toolStatus: "success", shellOutcome: { kind: "exit", code: 0 }, text: "12 pass\nSecond result line" };
    row.update(done, true, false, 58);
    for (const at of [0, 60, 150, 300]) {
      clock.now = at;
      row.tick();
      await terminal.renderOnce();
      expect(unreadableRuns(capture(terminal, variant), theme), `flash at ${at}ms`).toEqual([]);
    }
    row.update(done, true, false, 58, undefined, true);
    await terminal.renderOnce();
    expect(unreadableRuns(capture(terminal, variant), theme)).toEqual([]);
    row.update(done, true, false, 58);
    row.setSearchMatch(true);
    await terminal.renderOnce();
    expect(unreadableRuns(capture(terminal, variant), theme)).toEqual([]);

    const edit: TuiTranscriptEntry = { id: "edit", kind: "tool", toolName: "edit", toolStatus: "success", text: "", toolSummary: "src/a.ts",
      diffRows: [{ sign: "-", line: 2, text: "return lo;" }, { sign: "+", line: 2, text: "return hi;" }] };
    const diff = await transcriptRow(theme, edit);
    diff.row.update(edit, true, false, 58, undefined, true);
    await diff.terminal.renderOnce();
    const frame = capture(diff.terminal, variant);
    expect(frame.text.join("\n")).toContain("│+return hi;");
    expect(unreadableRuns(frame, theme)).toEqual([]);
  });
}

for (const [label, theme] of themes) test(`${label} status pill words stay readable while the fill fades between tones`, async () => {
  const terminal = await createTestRenderer({ width: 90, height: 20 });
  const workspace = { root: "/project", launchCwd: "/project", extraRoots: [] };
  const controller = new TuiController({
    session: createSession(), workspace, provider: "scripted", modelId: "test-model", sessionId: "contrast",
    model: createScriptedModel({ waitForAbort: true, text: "never" }), contextManager: createContextManager(workspace), secrets: [],
  });
  const clock = { now: 10_000 };
  const env = { SCHWAY_THEME: label.includes("light") ? "light" : "dark", ...(label.startsWith("NO_COLOR") ? { NO_COLOR: "1" } : {}) };
  const ui = createConversationView(terminal.renderer, {
    controller, workspaceRoot: "/project", home: "/home/test", env, secrets: [], quit() {}, submit: async () => {},
    motion: "full", splash: "none", now: () => clock.now, version: "9.9.9",
  });
  cleanups.push(() => { controller.cancel(); ui.destroy(); controller.dispose(); terminal.renderer.destroy(); });
  await terminal.renderOnce();
  const variant = `${label.startsWith("NO_COLOR") ? "nocolor-" : ""}${env.SCHWAY_THEME}-90`;
  const footer = (frame: ScreenGolden) => ({ ...frame, styles: frame.styles.filter(run => frame.text[run.row]?.includes("◆")) });
  expect(capture(terminal, variant).text.join("\n")).toContain("Ready");
  void controller.submit("go");
  await Bun.sleep(20);
  expect(controller.running).toBe(true);
  ui.refresh();
  // The clock is frozen at the tone change, so the pill shows the previous fill under the new label.
  for (const elapsed of [0, 40, 90, 140, 200]) {
    clock.now = 10_000 + elapsed;
    await terminal.renderOnce();
    const frame = footer(capture(terminal, variant));
    expect(frame.text.join("\n")).not.toContain("Ready");
    expect(unreadableRuns(frame, theme), `${label} pill at ${elapsed}ms`).toEqual([]);
  }
});
