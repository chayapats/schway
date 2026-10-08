import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import type { ScrollBoxRenderable } from "@opentui/core";
import { SCREENS } from "./screen-catalog/screens.ts";
import { buildScreen } from "./screen-catalog/harness.ts";
import { sliceCells, sweepFrameFailures } from "./helpers/screen-invariants.ts";
import { sweepFrame } from "./helpers/screen-sweep.ts";

// Narrow undo and review panels (#307): notes and explanations wrap at words and ` · ` segments, diff continuations keep
// a blank hanging gutter, and paging and file selection behave as before.
let originalFetch: typeof fetch;
const gitEnvironment = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"] as const;
const originalGitEnvironment = new Map<string, string | undefined>();
beforeAll(() => {
  for (const key of gitEnvironment) { originalGitEnvironment.set(key, process.env[key]); process.env[key] = "/dev/null"; }
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(() => { throw new Error("narrow wrap tests must not use the network"); }, { preconnect: originalFetch.preconnect }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch; setSystemTime();
  for (const key of gitEnvironment) { const value = originalGitEnvironment.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

const screen = (id: string) => SCREENS.find(item => item.id === id)!;
/** One catalog screen at `cols` columns with the rows of its diff area as shown from the diff text column. */
async function panel(id: string, cols: number) {
  setSystemTime(new Date("2026-01-15T09:30:00.000Z"));
  const frame = await sweepFrame(screen(id), cols);
  const diff = frame.state.diff!;
  return { frame, area: frame.golden.text.slice(diff.top, diff.bottom + 1).map(row => sliceCells(row, diff.x).trimEnd()) };
}

for (const cols of [29, 32]) test(`an undo note wraps whole words at ${cols} columns`, async () => {
  const { area } = await panel("undo-preview", cols);
  const note = area.slice(0, area.indexOf("─ clamp.ts ─"));
  expect(note.length).toBe(2);
  expect(note.join(" ")).toBe("1 change without saved undo stays");
});

test("an undo read-only explanation keeps Alt+R review on one row at 41 columns", async () => {
  const { area } = await panel("undo-shell-only", 41);
  expect(area).toContain("Undo leaves this file as it is");
  expect(area).toContain("Alt+R review");
  expect(area.some(row => row.endsWith("Alt+R"))).toBe(false);
});

// The undo fixture's longest line fits at 59 columns; tests/tui-undo.test.ts covers a longer undo line there.
for (const [id, widths] of [["undo-preview", [24, 40]], ["review-panel", [24, 40, 59]]] as const) for (const cols of widths) test(`${id} diff continuations keep a hanging gutter at ${cols} columns`, async () => {
  const { frame, area } = await panel(id, cols);
  // A wrapped numbered row continues under a blank 6-cell gutter, never under the line numbers.
  const wrapped = area.findIndex((row, index) => /^ +\d+ (?:│[-+ ]|[-+ ] )/.test(row) && /^ {6}\S/.test(area[index + 1] ?? ""));
  expect(wrapped).toBeGreaterThanOrEqual(0);
  expect(sweepFrameFailures(frame).filter(failure => failure.invariant === "S3")).toEqual([]);
});

// Kitty key encodings of PgDn and PgUp, as the catalog's renderer decodes them.
const PAGE_DOWN = "\x1b[57355u", PAGE_UP = "\x1b[57354u";
/** Send one key's bytes to the renderer and let the view repaint. */
async function press(ui: Awaited<ReturnType<typeof buildScreen>>, bytes: string) {
  ui.renderer.stdin.emit("data", Buffer.from(bytes));
  await ui.settle();
}

/** Build a screen at a short size where the diff overflows, and reach its ready state. */
async function open(id: string, cols: number, rows: number) {
  setSystemTime(new Date("2026-01-15T09:30:00.000Z"));
  const ui = await buildScreen(screen(id), { id: `wrap-${cols}x${rows}`, theme: "dark", cols, rows, noColor: false });
  await screen(id).drive(ui); await ui.waitFor(snapshot => screen(id).ready(snapshot, ui)); await ui.settle();
  return { ui, diff: ui.renderer.root.findDescendantById("change-review-diff") as ScrollBoxRenderable };
}

test("PgUp/PgDn scroll the wrapped review diff and ↑↓ selects the next file and resets it", async () => {
  const { ui, diff } = await open("review-staged-unstaged", 24, 20);
  try {
    expect(diff.scrollHeight).toBeGreaterThan(diff.viewport.height);
    await press(ui, PAGE_DOWN);
    expect(diff.scrollTop).toBeGreaterThan(0);
    await press(ui, PAGE_UP);
    expect(diff.scrollTop).toBe(0);
    await press(ui, PAGE_DOWN);
    ui.mockInput.pressArrow("down");
    await ui.waitFor(snapshot => snapshot.changeReview?.selected === 1);
    await ui.settle();
    expect(diff.scrollTop).toBe(0);
  } finally { await ui.dispose(); }
});

test("PgUp/PgDn scroll the wrapped undo diff and ↑↓ selects the next file and resets it", async () => {
  const { ui, diff } = await open("undo-preview", 24, 20);
  try {
    expect(diff.scrollHeight).toBeGreaterThan(diff.viewport.height);
    await press(ui, PAGE_DOWN);
    expect(diff.scrollTop).toBeGreaterThan(0);
    await press(ui, PAGE_UP);
    expect(diff.scrollTop).toBe(0);
    await press(ui, PAGE_DOWN);
    ui.mockInput.pressArrow("down"); await ui.settle();
    expect(ui.controller.snapshot().undoPreview?.selected).toBe(1);
    expect(diff.scrollTop).toBe(0);
    expect(ui.controller.snapshot().undoPreview?.files[1]?.path).toBe("src/util/range.ts");
  } finally { await ui.dispose(); }
});
