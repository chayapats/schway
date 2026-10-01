import { afterEach, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { BoxRenderable, RGBA, TextareaRenderable, TextRenderable, type TextChunk } from "@opentui/core";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createConversationView } from "../src/tui/view.ts";
import { TuiController } from "../src/tui/controller.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { withTempDir } from "./helpers.ts";
import { SPLASH_DURATION_MS, SPLASH_ACCENT_DURATION_MS, SPLASH_LOGO, SPLASH_MIN_SIZE, SPLASH_TAGLINE, SplashCanvas, createSplashScene, renderSplashFrame } from "../src/tui/splash.ts";
import { resolveMotion } from "../src/tui/motion-policy.ts";
import { shimmer, spinnerFrame } from "../src/tui/motion.ts";
import { highlightCode } from "../src/tui/highlight.ts";
import { keyHintChunks } from "../src/tui/hints.ts";
import { statusPill } from "../src/tui/presentation.ts";
import { readGitHead } from "../src/tui/git-head.ts";
import { createTranscriptItem, markdownStyle } from "../src/tui/transcript-view.ts";
import { TUI_THEMES, mixColor, tint } from "../src/tui/theme.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const text = (chunks: readonly TextChunk[]) => chunks.map(chunk => chunk.text).join("");
const theme = TUI_THEMES.dark;

/** Build a disposable real renderer with an injected animation clock and observable startup lifecycle. */
async function view(options: { width?: number; height?: number; splash?: "full" | "accent" | "none"; onSplashPlayed?: () => void; beforePaint?: boolean; motion?: "full" | "reduced" | "off" } = {}) {
  const terminal = await createTestRenderer({ width: options.width ?? 90, height: options.height ?? 26, kittyKeyboard: true });
  const workspace = { root: "/project", launchCwd: "/project", extraRoots: [] };
  const controller = new TuiController({
    session: createSession(), workspace, provider: "scripted", modelId: "test-model", sessionId: "motion",
    model: createScriptedModel({ responses: [] }), contextManager: createContextManager(workspace), secrets: [],
    credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ model: createScriptedModel() }) },
  });
  let liveCalls = 0;
  const requestLive = terminal.renderer.requestLive.bind(terminal.renderer);
  terminal.renderer.requestLive = () => { liveCalls++; requestLive(); };
  const clock = { now: 10_000 };
  if (options.beforePaint) terminal.renderer.requestLive = () => {};
  const ui = createConversationView(terminal.renderer, {
    controller, workspaceRoot: "/project", home: "/home/test", env: {}, secrets: [], quit() {}, submit: async () => {},
    motion: options.motion ?? "full", splash: options.splash ?? "full", onSplashPlayed: options.onSplashPlayed, now: () => clock.now, version: "9.9.9",
  });
  cleanups.push(() => { ui.destroy(); controller.dispose(); terminal.renderer.destroy(); });
  if (options.beforePaint) ui.destroy();
  else await terminal.renderOnce();
  const editor = terminal.renderer.root.findDescendantById("prompt") as TextareaRenderable;
  return { ...terminal, ui, clock, editor, liveCalls: () => liveCalls, splash: () => terminal.renderer.root.findDescendantById("splash") };
}

test("splash scenes are deterministic per seed and cover the screen until the radial reveal", () => {
  expect(createSplashScene(7)).toEqual(createSplashScene(7));
  expect(createSplashScene(7).path).not.toEqual(createSplashScene(8).path);
  expect(SPLASH_MIN_SIZE).toEqual({ width: SPLASH_LOGO[0]!.length + 6, height: 16 });
  const canvas = new SplashCanvas();
  const scene = createSplashScene(1);
  const row = (t: number, y: number) => { renderSplashFrame(canvas, scene, t, 80, 24, theme, "1.2.3"); return canvas.chars.slice(y * 80, y * 80 + 80).join(""); };
  const top = Math.max(2, Math.floor((24 - SPLASH_LOGO.length) / 2) - 2);
  // Ghost wordmark before the strike, lightning while it crosses, tagline and version during the hold.
  expect(row(0, top)).toContain(SPLASH_LOGO[0]!.join("").trim());
  expect(canvas.covered.every(cell => cell === 1)).toBe(true);
  renderSplashFrame(canvas, scene, 300, 80, 24, theme);
  expect(canvas.chars.some(char => "━╲╱█".includes(char))).toBe(true);
  expect(row(1400, top + SPLASH_LOGO.length + 1)).toContain(`${SPLASH_TAGLINE}  v1.2.3`);
  // By the end every cell is uncovered, so the UI underneath is fully visible.
  renderSplashFrame(canvas, scene, SPLASH_DURATION_MS, 80, 24, theme);
  expect(canvas.covered.every(cell => cell === 0)).toBe(true);
  expect(SPLASH_DURATION_MS).toBe(2000);
});

test("splash overlays startup, forwards the skipping key to the editor, and never runs when gated", async () => {
  const ui = await view();
  expect(ui.splash()).toBeDefined();
  expect(ui.captureCharFrame()).toContain("███████╗");
  expect(ui.editor.showCursor).toBe(false);
  await ui.mockInput.typeText("h");
  await ui.renderOnce();
  expect(ui.splash()).toBeUndefined();
  expect(ui.editor.plainText).toBe("h");
  expect(ui.editor.showCursor).toBe(true);
  expect(ui.captureCharFrame()).toContain("schway");

  // Unskipped, the overlay removes itself once its timeline has been shown.
  const timed = await view();
  expect(timed.splash()).toBeDefined();
  timed.clock.now += SPLASH_DURATION_MS + 1;
  timed.ui.refresh();
  expect(timed.splash()).toBeUndefined();

  for (const gated of [await view({ width: SPLASH_MIN_SIZE.width - 1 }), await view({ height: SPLASH_MIN_SIZE.height - 1 }), await view({ motion: "reduced" }), await view({ splash: "none" })]) {
    expect(gated.splash()).toBeUndefined();
    expect(gated.captureCharFrame()).not.toContain("███████╗");
  }
});

test("status bar shows one colored state pill with model and context, and the composer is a raised block", async () => {
  const ui = await view({ splash: "none", motion: "off" });
  const frame = ui.captureCharFrame();
  expect(frame).toContain("● READY");
  expect(frame).toContain("scripted/test-model");
  expect(frame).toContain("ctx ~");
  expect(frame).toContain("▄▄▄▄");
  expect(frame).toContain("▀▀▀▀");
  expect((ui.renderer.root.findDescendantById("composer") as BoxRenderable).backgroundColor.equals(RGBA.fromHex(theme.surface))).toBe(true);
  expect((ui.renderer.root.findDescendantById("top-bar") as BoxRenderable).backgroundColor.equals(RGBA.fromHex(theme.surface))).toBe(true);
  expect(frame.split("\n")[0]).toContain("⚡ schway  /project");
});

test("motion policy, spinner, and shimmer respect reduced and off modes", () => {
  expect(resolveMotion({})).toBe("full");
  expect(resolveMotion({ SCHWAY_MOTION: "OFF" })).toBe("off");
  expect(resolveMotion({ SCHWAY_MOTION: "reduced" })).toBe("reduced");
  expect(resolveMotion({ NO_COLOR: "1" })).toBe("reduced");
  expect(resolveMotion({ NO_COLOR: "1", SCHWAY_MOTION: "full" })).toBe("full");
  expect(resolveMotion({ TERM: "dumb" })).toBe("reduced");
  expect(spinnerFrame(0, "full")).not.toBe(spinnerFrame(80, "full"));
  expect(spinnerFrame(0, "off")).toBe("●");
  expect(text(shimmer("Running tools", 500, theme.muted, theme.text, "full"))).toBe("Running tools");
  expect(shimmer("Running tools", 500, theme.muted, theme.text, "reduced")).toHaveLength(1);
});

test("code highlighting, key chips, and pills keep text exact while adding color", () => {
  const code = 'export function add(a: number, b = 2) {\n  // sum\n  return a + b + "x";\n}\n# not a comment in ts';
  const chunks = highlightCode(code, "ts", theme);
  expect(text(chunks)).toBe(code);
  const colorOf = (token: string) => chunks.find(chunk => chunk.text === token)?.fg;
  expect(colorOf("export")?.equals(RGBA.fromHex(theme.violet))).toBe(true);
  expect(colorOf("number")?.equals(RGBA.fromHex(theme.cyan))).toBe(true);
  expect(colorOf('"x"')?.equals(RGBA.fromHex(theme.success))).toBe(true);
  expect(colorOf("// sum")?.equals(RGBA.fromHex(theme.muted))).toBe(true);
  expect(text(highlightCode("echo hi # note", "sh", theme))).toBe("echo hi # note");
  expect(highlightCode("echo hi # note", "sh", theme).at(-1)?.text).toBe("# note");

  const hint = "Enter send · Ctrl+F find · Files/Git unchanged · / commands";
  const styled = keyHintChunks(hint, { key: theme.text, chip: theme.border, action: theme.muted });
  expect(text(styled)).toBe(hint);
  expect(styled.find(chunk => chunk.text === "Ctrl+F")?.bg?.equals(RGBA.fromHex(theme.border))).toBe(true);
  expect(styled.find(chunk => chunk.text === "Files/Git unchanged")?.bg).toBeUndefined();

  expect(statusPill({ readiness: "ready", status: "idle" })).toEqual({ label: "READY", tone: "ready", spinning: false });
  expect(statusPill({ readiness: "loading", status: "idle" }).label).toBe("CHECKING");
  expect(statusPill({ readiness: "ready", status: "error" }).tone).toBe("attention");
  expect(mixColor("#000000", "#ffffff", 0.5)).toBe("#808080");
  expect(tint(theme, theme.accent)).toBe(mixColor(theme.surface2, theme.accent, 0.22));
});

test("status pill distinguishes neutral setup and gives checks and activity precedence", () => {
  expect(statusPill({ readiness: "not-connected", status: "idle" }, true)).toEqual({ label: "NOT CONNECTED", tone: "neutral", spinning: false });
  expect(statusPill({ readiness: "not-connected", status: "error" }).label).toBe("ATTENTION");
  expect(statusPill({ readiness: "not-connected", status: "running" }).label).toBe("WORKING");
  expect(statusPill({ readiness: "connect", status: "error" }).label).toBe("ATTENTION");
  expect(statusPill({ readiness: "loading", status: "error" }).label).toBe("CHECKING");
  expect(statusPill({ readiness: "loading", status: "running", activity: { operationId: 1, phase: "streaming", elapsedMs: 0, activeTools: 0, toolNames: [], cancellation: "none" } }).label).toBe("CHECKING");
  expect(statusPill({ readiness: "not-connected", status: "error", activity: { operationId: 1, phase: "waiting", elapsedMs: 0, activeTools: 0, toolNames: [], cancellation: "none" } }).label).toBe("WAITING 0s");
});

test("git head names the branch, a detached commit, or a worktree branch without spawning Git", async () => {
  await withTempDir(async dir => {
    expect(readGitHead(dir)).toBeUndefined();
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, ".git/HEAD"), "ref: refs/heads/feat/voltage\n");
    expect(readGitHead(dir)).toBe("feat/voltage");
    await writeFile(join(dir, ".git/HEAD"), `${"a1b2c3d".padEnd(40, "0")}\n`);
    expect(readGitHead(dir)).toBe("a1b2c3d");
    const worktree = join(dir, "wt");
    await mkdir(join(dir, ".git/worktrees/wt"), { recursive: true });
    await mkdir(worktree);
    await writeFile(join(dir, ".git/worktrees/wt/HEAD"), "ref: refs/heads/side\n");
    await writeFile(join(worktree, ".git"), "gitdir: ../.git/worktrees/wt\n");
    expect(readGitHead(worktree)).toBe("side");
  });
});

test("tool rows animate a spinner while running and flash success on completion", async () => {
  const terminal = await createTestRenderer({ width: 70, height: 10 });
  cleanups.push(() => terminal.renderer.destroy());
  const clock = { now: 0 };
  const syntax = markdownStyle(theme);
  cleanups.push(() => syntax.destroy());
  const entry = { id: "t1", kind: "tool" as const, text: "partial", toolName: "bash", toolStatus: "running" as const, toolSummary: "bun test" };
  const row = createTranscriptItem(terminal.renderer, entry, theme, syntax, () => {}, { now: () => clock.now, mode: "full" });
  terminal.renderer.root.add(row.root);
  row.update(entry, false, false, 68);
  await terminal.renderOnce();
  const first = terminal.captureCharFrame();
  expect(first).toContain(" BASH ");
  expect(first).toContain("bun test");
  expect(first).toContain("running…");
  clock.now = 80;
  expect(row.tick()).toBe(true);
  await terminal.renderOnce();
  expect(terminal.captureCharFrame().split("\n")[0]).not.toBe(first.split("\n")[0]);

  row.update({ ...entry, toolStatus: "success", text: "done" }, false, false, 68);
  expect(row.root.backgroundColor.equals(RGBA.fromHex(theme.surface2))).toBe(false);
  expect(row.tick()).toBe(true);
  clock.now = 1000;
  expect(row.tick()).toBe(false);
  expect(row.root.backgroundColor.equals(RGBA.fromHex(theme.surface2))).toBe(true);
  await terminal.renderOnce();
  expect(terminal.captureCharFrame()).toContain("✓");
});

test("a streaming answer shows a blinking caret outside code fences and none once settled", async () => {
  const terminal = await createTestRenderer({ width: 60, height: 8 });
  cleanups.push(() => terminal.renderer.destroy());
  const clock = { now: 0 };
  const syntax = markdownStyle(theme);
  cleanups.push(() => syntax.destroy());
  const entry = { id: "a1", kind: "assistant" as const, text: "Running the checks" };
  const row = createTranscriptItem(terminal.renderer, entry, theme, syntax, () => {}, { now: () => clock.now, mode: "full" });
  terminal.renderer.root.add(row.root);
  row.update(entry, false, true, 58);
  await terminal.renderOnce();
  expect(terminal.captureCharFrame()).toContain("Running the checks▍");
  clock.now = 600;
  row.tick();
  await terminal.renderOnce();
  expect(terminal.captureCharFrame()).not.toContain("▍");
  row.update({ ...entry, text: "```ts\nconst open" }, false, true, 58);
  clock.now = 0;
  row.tick();
  await terminal.renderOnce();
  expect(terminal.captureCharFrame()).not.toContain("▍");
  row.update({ ...entry, text: "Done." }, false, false, 58);
  await terminal.renderOnce();
  expect(terminal.captureCharFrame()).toContain("Done.");
  expect(terminal.captureCharFrame()).not.toContain("▍");
});


test("bolt accent forwards input immediately, paints no overlay and settles within 300 ms", async () => {
  const ui = await view({ splash: "accent" });
  const header = ui.renderer.root.findDescendantById("header") as TextRenderable;
  const color = () => header.chunks[0]!.fg!;
  expect(ui.splash()).toBeUndefined();
  expect(ui.editor.focused).toBe(true);
  expect(ui.liveCalls()).toBe(0);
  await ui.mockMouse.click(ui.editor.x + 1, ui.editor.y);
  expect(color().equals(RGBA.fromHex(theme.bolt))).toBe(false);
  await ui.mockInput.typeText("h");
  await ui.mockInput.pasteBracketedText("ello");
  expect(ui.editor.plainText).toBe("hello");
  ui.clock.now += 300;
  ui.ui.refresh();
  await ui.renderOnce();
  expect(color().equals(RGBA.fromHex(theme.bolt))).toBe(true);
  expect(SPLASH_ACCENT_DURATION_MS).toBeLessThanOrEqual(300);
  let requested = 0;
  const requestRender = ui.renderer.requestRender.bind(ui.renderer);
  ui.renderer.requestRender = () => { requested++; requestRender(); };
  await Bun.sleep(80);
  const settled = requested;
  await Bun.sleep(80);
  expect(requested).toBe(settled);
  expect(ui.liveCalls()).toBe(0);
});

test("full splash completion is recorded once only if an overlay has painted", async () => {
  for (const skip of ["time", "key", "paste", "click"] as const) {
    let recorded = 0;
    const ui = await view({ onSplashPlayed: () => { recorded++; } });
    expect(recorded).toBe(0);
    if (skip === "time") { ui.clock.now += SPLASH_DURATION_MS + 1; ui.ui.refresh(); }
    else if (skip === "key") await ui.mockInput.typeText("h");
    else if (skip === "paste") await ui.mockInput.pasteBracketedText("hello");
    else await ui.mockMouse.click(2, 2);
    await ui.renderOnce();
    expect(ui.splash()).toBeUndefined();
    expect(recorded).toBe(1);
    ui.ui.destroy();
    expect(recorded).toBe(1);
  }
  for (const options of [{ motion: "off" as const }, { motion: "reduced" as const }, { width: 40, height: 12 }, { splash: "none" as const }, { splash: "accent" as const }, { beforePaint: true }]) {
    let recorded = 0;
    const ui = await view({ ...options, onSplashPlayed: () => { recorded++; } });
    ui.ui.destroy();
    expect(recorded, JSON.stringify(options)).toBe(0);
  }
});
