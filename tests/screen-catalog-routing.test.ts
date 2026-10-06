import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TuiSnapshot } from "../src/tui/controller.ts";
import { PANEL_MODES, type PanelMode } from "../src/tui/view.ts";
import { buildScreen, type ScreenHarness } from "./screen-catalog/harness.ts";
import type { Screen } from "./screen-catalog/screens.ts";

// The catalog harness sends typed slash commands through the production handler, so each one reaches its real state.
let originalFetch: typeof fetch;
beforeAll(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(() => { throw new Error("screen catalog must not use the network"); }, { preconnect: originalFetch.preconnect }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = originalFetch; setSystemTime(); });

const probe: Screen = { id: "command-routing", title: "Command routing", description: "Typed commands reach the production handler.", drive: async () => {}, ready: () => true };
const variant = { id: "dark-80", theme: "dark" as const, cols: 80, rows: 30, noColor: false };
const lastText = (snapshot: TuiSnapshot) => snapshot.transcript.at(-1)?.text ?? "";

async function run(ui: ScreenHarness, command: string, reached: (snapshot: TuiSnapshot) => boolean) {
  const before = ui.controller.snapshot().transcript.length;
  await ui.mockInput.typeText(command); ui.mockInput.pressEnter();
  await ui.waitFor(snapshot => reached(snapshot) || snapshot.transcript.length > before && snapshot.status === "error");
  if (!reached(ui.controller.snapshot())) throw new Error(`${command} did not reach its state: ${lastText(ui.controller.snapshot())}`);
}
async function close(ui: ScreenHarness) {
  ui.mockInput.pressEscape();
  await ui.waitFor(() => ui.view.panelMode() === "");
  ui.editor.setText(""); await ui.settle();
}

test("typed built-in commands reach their real handler states in the catalog harness", async () => {
  setSystemTime(new Date("2026-01-15T09:30:00.000Z"));
  const ui = await buildScreen(probe, variant);
  try {
    // The probe runs in a temporary home with a fake credential store and no host environment.
    expect(ui.root.startsWith(await realpath(tmpdir()))).toBe(true);
    await run(ui, "/sessions", s => !!s.sessionPicker && !s.sessionPicker.loading);
    expect(ui.view.panelMode()).toBe("sessions");
    await close(ui);
    await run(ui, "/branch tree", s => !!s.branchTree);
    expect(ui.view.panelMode()).toBe("tree");
    await close(ui);
    await run(ui, "/help", () => ui.controller.commandHelpOpen);
    await ui.settle(); expect(ui.view.panelMode()).toBe("help");
    await close(ui);
    await run(ui, "/model", s => !!s.modelPicker);
    expect(ui.view.panelMode()).toBe("model");
    await close(ui);
    await run(ui, "/thinking", s => lastText(s).startsWith("Thinking: unset (effective: Provider default)"));
    await run(ui, "/changes", s => lastText(s) === "Not a Git workspace · Enter continue");
    await run(ui, "/context", s => lastText(s) === ui.controller.describeContext());
    await run(ui, "/config", s => !!s.preferences);
    expect(ui.view.panelMode()).toBe("preferences");
    await close(ui);
  } finally { await ui.dispose(); }
}, 30_000);

test("a typed skill invocation reaches the production skill path through its raw text", async () => {
  setSystemTime(new Date("2026-01-15T09:30:00.000Z"));
  const ui = await buildScreen(probe, variant);
  try {
    await Bun.write(join(ui.root, ".agents/skills/grill-me/SKILL.md"), "---\nname: grill-me\ndescription: Stress-test a plan\n---\nAsk hard questions.");
    await ui.controller.refreshCommands();
    await ui.mockInput.typeText("/grill-me the release plan"); ui.mockInput.pressEnter();
    await ui.waitFor(s => s.status === "idle" && s.transcript.some(row => row.kind === "assistant" && row.text === "Ready."));
    expect(ui.controller.snapshot().transcript.some(row => row.kind === "user" && row.text.includes("grill-me"))).toBe(true);
  } finally { await ui.dispose(); }
}, 30_000);

test("panel modes are a closed, frozen list that typecheck enforces", () => {
  // @ts-expect-error An unlisted panel string is not a PanelMode; a new panel must join PANEL_MODES and get a screen.
  const unlisted: PanelMode = "inspector";
  expect(PANEL_MODES as readonly string[]).not.toContain(unlisted);
  expect(Object.isFrozen(PANEL_MODES)).toBe(true);
  expect(new Set(PANEL_MODES).size).toBe(15);
});
