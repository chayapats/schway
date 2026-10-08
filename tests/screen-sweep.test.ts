import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { SCREENS } from "./screen-catalog/screens.ts";
import { applySweepExemptions, escExitFailures, formatSweepFailure, sweepFrameFailures, type SweepExemption, type SweepFailure, type SweepFrame } from "./helpers/screen-invariants.ts";
import { SWEEP_EVIDENCE_FRAMES, SWEEP_EXEMPTIONS, SWEEP_SMOKE, sweepFrame, sweepWidths } from "./helpers/screen-sweep.ts";

// Breakpoint sweep (#307): `SCHWAY_SCREEN_SWEEP=1` (`bun run screens:sweep`) renders every catalog screen one column either
// side of each layout breakpoint and checks S1–S5; plain `bun test` runs only the smoke subset.
const full = process.env.SCHWAY_SCREEN_SWEEP === "1";
const fixedTime = "2026-01-15T09:30:00.000Z";
const gitEnvironment = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"] as const;
const originalGitEnvironment = new Map<string, string | undefined>();
let originalFetch: typeof fetch;
beforeAll(() => {
  for (const key of gitEnvironment) { originalGitEnvironment.set(key, process.env[key]); process.env[key] = "/dev/null"; }
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(() => { throw new Error("screen sweep must not use the network"); }, { preconnect: originalFetch.preconnect }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch; setSystemTime();
  for (const key of gitEnvironment) { const value = originalGitEnvironment.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

/** Render one screen at each width and return every S1–S5 failure, before exemptions. */
async function sweep(screenId: string, widths: readonly number[]): Promise<{ frames: SweepFrame[]; failures: SweepFailure[] }> {
  const screen = SCREENS.find(item => item.id === screenId)!;
  const frames: SweepFrame[] = [];
  for (const width of widths) { setSystemTime(new Date(fixedTime)); frames.push(await sweepFrame(screen, width)); }
  return { frames, failures: [...frames.flatMap(sweepFrameFailures), ...escExitFailures(frames)] };
}

/** Name each failure's screen, width, invariant and row, then print the frame it came from. */
function report(failures: readonly SweepFailure[], frames: readonly SweepFrame[]): string {
  return failures.map(failure => {
    const frame = frames.find(item => item.width === failure.width)!;
    return `${formatSweepFailure(failure)}\n${frame.golden.text.map((row, index) => `${String(index).padStart(2)}|${row}`).join("\n")}`;
  }).join("\n\n");
}

/** Check the remaining failures of one sweep and record which exemptions it used. */
function check(failures: readonly SweepFailure[], frames: readonly SweepFrame[], used: Set<SweepExemption>): void {
  const result = applySweepExemptions(failures, SWEEP_EXEMPTIONS);
  for (const exemption of result.used) used.add(exemption);
  if (result.remaining.length) throw new Error(`Breakpoint sweep failed:\n${report(result.remaining, frames)}`);
}

test("no sweep exemption covers an audit evidence frame", () => {
  const covered = SWEEP_EVIDENCE_FRAMES.filter(frame => SWEEP_EXEMPTIONS.some(entry => entry.screen === frame.screen && entry.invariant === frame.invariant && (entry.width === undefined || entry.width === frame.width)));
  expect(covered).toEqual([]);
  for (const entry of SWEEP_EXEMPTIONS) expect(SCREENS.some(screen => screen.id === entry.screen), entry.screen).toBe(true);
});

if (full) {
  const used = new Set<SweepExemption>();
  let swept = 0;
  for (const screen of SCREENS) test(`sweep ${screen.id}`, async () => {
    const { frames, failures } = await sweep(screen.id, sweepWidths(screen.id));
    swept++;
    check(failures, frames, used);
  }, 600_000);
  test("every sweep exemption covers a failure", () => {
    // A focused run cannot tell a stale entry from one for a screen it skipped.
    if (swept < SCREENS.length) return;
    expect(SWEEP_EXEMPTIONS.filter(entry => !used.has(entry))).toEqual([]);
  });
} else {
  test("sweep smoke: undo and review panels hold S1–S5 either side of 40 columns", async () => {
    for (const { screen, widths } of SWEEP_SMOKE) {
      const { frames, failures } = await sweep(screen, widths);
      expect(frames.map(frame => frame.width)).toEqual([...widths]);
      check(failures, frames, new Set());
      // The smoke frames exercise the diff gutter check and the hint row the view set.
      expect(frames.every(frame => !!frame.state.diff?.lines.length && !!frame.state.hint?.text)).toBe(true);
    }
  }, 30_000);
}
