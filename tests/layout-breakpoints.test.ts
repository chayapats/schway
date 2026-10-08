import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { LAYOUT_BREAKPOINTS, bodyPadding, bodyWidth } from "../src/tui/layout.ts";
import { SCREENS } from "./screen-catalog/screens.ts";
import { sweepFrame } from "./helpers/screen-sweep.ts";

// Each content-width rule switches at its terminal-column breakpoint (#307): the view compares its body width with
// `bodyWidth(breakpoint)`, so these frames pin the terminal width where each rule changes.
let originalFetch: typeof fetch;
const gitEnvironment = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"] as const;
const originalGitEnvironment = new Map<string, string | undefined>();
beforeAll(() => {
  for (const key of gitEnvironment) { originalGitEnvironment.set(key, process.env[key]); process.env[key] = "/dev/null"; }
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(() => { throw new Error("layout tests must not use the network"); }, { preconnect: originalFetch.preconnect }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch; setSystemTime();
  for (const key of gitEnvironment) { const value = originalGitEnvironment.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

/** Text rows of one catalog screen rendered at `cols` columns in the dark theme. */
async function rows(id: string, cols: number) {
  setSystemTime(new Date("2026-01-15T09:30:00.000Z"));
  const frame = await sweepFrame(SCREENS.find(screen => screen.id === id)!, cols);
  return { text: frame.golden.text, status: frame.golden.text[frame.state.status!]! };
}

test("body width keeps each content-width rule at its terminal breakpoint", () => {
  expect(bodyWidth(LAYOUT_BREAKPOINTS.compactStatusPill)).toBe(32);
  expect(bodyWidth(LAYOUT_BREAKPOINTS.approvalRequiredLabel)).toBe(40);
  expect(bodyWidth(LAYOUT_BREAKPOINTS.oneLineHistoryRows)).toBe(60);
  expect(bodyWidth(LAYOUT_BREAKPOINTS.fullHistoryColumns)).toBe(100);
  expect([59, 60].map(bodyPadding)).toEqual([1, 2]);
  // Body width steps back only at the padding change (57 at 59 columns, 56 at 60); no content-width rule switches there,
  // so every rule keeps one result on each side of its breakpoint.
  for (const name of ["compactStatusPill", "approvalRequiredLabel", "oneLineHistoryRows", "fullHistoryColumns"] as const) {
    const breakpoint = LAYOUT_BREAKPOINTS[name], limit = bodyWidth(breakpoint);
    for (let columns = 20; columns <= 140; columns++) expect(bodyWidth(columns) < limit, `${name} at ${columns}`).toBe(columns < breakpoint);
  }
});

test("the status pill is compact at 33 columns and not at 34", async () => {
  expect((await rows("running-empty", 33)).status).toMatch(/Receiving(?! \d)/);
  expect((await rows("running-empty", 34)).status).toContain("Receiving 4.0s");
});

test("the session picker shows its Last activity line at 51 and 52 columns; #333 removed the 50-column short form", async () => {
  for (const cols of [51, 52]) expect((await rows("session-picker", cols)).text.join("\n")).toContain("Last activity: ");
});

test("history rows use two lines at 63 columns and one line at 64", async () => {
  const narrow = (await rows("history-list", 63)).text, wide = (await rows("history-list", 64)).text;
  expect(narrow.some(row => row.includes("Stopped · 01-15 09:30"))).toBe(true);
  expect(narrow.some(row => /^\s+1 file · 1 cmd · Save clamp/.test(row))).toBe(true);
  expect(wide.some(row => /Stopped {2}01-15 09:30 {2}1 file · 1 cmd {3}3\.0s {2}Save/.test(row))).toBe(true);
});

test("history columns are compact at 103 columns and full at 104", async () => {
  const compact = (await rows("history-list", 103)).text.join("\n"), full = (await rows("history-list", 104)).text.join("\n");
  expect(compact).toContain("01-15 09:30  1 file · 1 cmd ");
  expect(compact).not.toContain("UTC");
  expect(full).toContain("2026-01-15 09:30 UTC  1 file · 1 command ");
});
