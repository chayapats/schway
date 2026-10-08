import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import type { TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { ConfigEditor } from "../src/config/editing.ts";
import { createContextManager } from "../src/context/manager.ts";
import { createSession } from "../src/session/session.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import { TuiController } from "../src/tui/controller.ts";
import type { TuiSnapshot, TurnOutcome } from "../src/tui/controller-types.ts";
import { outcomeStripActions, readinessCardActions, surfaceOwnsInput, type InputOwners } from "../src/tui/background-hints.ts";
import { taskExamplesEligible } from "../src/tui/empty-guidance.ts";
import { formatOutcomeLine } from "../src/tui/presentation.ts";
import { PANEL_MODES, createConversationView } from "../src/tui/view.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { buildScreen, type ScreenHarness } from "./screen-catalog/harness.ts";
import type { Screen } from "./screen-catalog/screens.ts";

// Hints painted behind a panel, palette or details view must name only keys that act there (#301).
let originalFetch: typeof fetch;
beforeAll(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(() => { throw new Error("background hint tests must not use the network"); }, { preconnect: originalFetch.preconnect }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = originalFetch; setSystemTime(); });

const unowned: InputOwners = { panel: "", slashBrowsing: false, inspection: false, details: false, reader: false, toolApproval: false };
const owners: Partial<InputOwners>[] = [...PANEL_MODES.map(panel => ({ panel })), { slashBrowsing: true }, { inspection: true }, { details: true }, { reader: true }, { toolApproval: true }];
const snapshot = (change: Partial<TuiSnapshot> = {}) => ({ readiness: "ready", status: "idle", transcript: [], ...change }) as unknown as TuiSnapshot;

test("one ownership answer hides the task examples and the card action line together", () => {
  const ready = snapshot();
  expect(surfaceOwnsInput(unowned)).toBe(false);
  expect(taskExamplesEligible(ready, { draft: "", owned: surfaceOwnsInput(unowned), draftNotice: false })).toBe(true);
  expect(readinessCardActions(ready, surfaceOwnsInput(unowned))).toEqual(["Type a task · Enter send"]);
  // An ordinary draft hides only the examples: Enter still sends it, so the card keeps saying so.
  for (const draft of ["Fix the clamp", "อธิบาย 🧪", " "]) {
    expect(taskExamplesEligible(ready, { draft, owned: surfaceOwnsInput(unowned), draftNotice: false })).toBe(false);
    expect(readinessCardActions(ready, surfaceOwnsInput(unowned))).toEqual(["Type a task · Enter send"]);
  }
  for (const change of owners) {
    const owned = surfaceOwnsInput({ ...unowned, ...change });
    expect(owned, JSON.stringify(change)).toBe(true);
    expect(taskExamplesEligible(ready, { draft: "", owned, draftNotice: false }), JSON.stringify(change)).toBe(false);
    expect(readinessCardActions(ready, owned), JSON.stringify(change)).toEqual([]);
  }
});

test("each readiness keeps its card action line only while nothing else owns the keys", () => {
  const cases: [Partial<TuiSnapshot>, string[]][] = [
    [{ readiness: "not-connected" }, ["Connect a provider · Alt+L sign in"]],
    [{ readiness: "loading" }, ["Checking connection · Type a task · Esc cancel"]],
    [{ readiness: "ready" }, ["Type a task · Enter send"]],
    [{ readiness: "connect", recovery: { actions: ["connect", "details", "keep-editing"] } as unknown as TuiSnapshot["recovery"] }, ["Connect to continue · Alt+L sign in", "F2 details · Esc keep editing"]],
    [{ readiness: "choose-model" }, ["Choose a model · Alt+M browse models"]],
    [{ readiness: "repair", recovery: { category: "credential-store", actions: ["retry-credentials"] } as unknown as TuiSnapshot["recovery"] }, ["Unlock credential storage · Ctrl+R retry"]],
    [{ readiness: "repair" }, ["Repair connection · Alt+M choose model"]],
  ];
  for (const [change, lines] of cases) {
    expect(readinessCardActions(snapshot(change), false)).toEqual(lines);
    expect(readinessCardActions(snapshot(change), true)).toEqual([]);
  }
});

const outcome = (reason: TurnOutcome["reason"]): TurnOutcome => ({ reason, files: [], elapsedMs: 14000, commands: [],
  commandCounts: { exitZero: 0, nonzero: 0, unknown: 0 }, toolResults: 0, failedTools: 0 });

test("the outcome strip decides review and details separately", () => {
  const conversation = { panel: "", reader: false, details: false, loading: false };
  expect(outcomeStripActions(conversation)).toEqual({ review: true, details: true });
  // Open details ignore F2, but Alt+R still opens review from them.
  expect(outcomeStripActions({ ...conversation, details: true })).toEqual({ review: true, details: false });
  expect(outcomeStripActions({ ...conversation, loading: true })).toEqual({ review: true, details: false });
  for (const panel of PANEL_MODES) expect(outcomeStripActions({ ...conversation, panel })).toEqual({ review: false, details: false });
  expect(outcomeStripActions({ ...conversation, reader: true })).toEqual({ review: false, details: false });
  const failed = outcome("failed");
  expect(formatOutcomeLine(failed, 120, { review: true, details: true })).toBe("✗ Failed · 14s · Alt+R review · F2 details");
  expect(formatOutcomeLine(failed, 120, { review: true, details: false })).toBe("✗ Failed · 14s · Alt+R review");
  expect(formatOutcomeLine(failed, 120, { review: false, details: false })).toBe("✗ Failed · 14s");
  expect(formatOutcomeLine(outcome("completed"), 120, { review: true, details: true })).toBe("✓ Done · 14s · Alt+R review");
});

const variant = { id: "dark-80", theme: "dark" as const, cols: 80, rows: 30, noColor: false };
/** Existing harness fixtures reused as probes: one unconnected and one ready scripted workspace, each in a temporary home. */
const probe = (id: string): Screen => ({ id, title: "Background hints", description: "Hints behind an owning surface.", drive: async () => {}, ready: () => true });
const STATES = {
  "not connected": { probe: "model-picker-unconnected", status: "Not connected", action: "Connect a provider · Alt+L sign in", gap: "\n" },
  ready: { probe: "command-routing", status: "scripted/scripted-model · scripted API key", action: "Type a task · Enter send", gap: "\n\n" },
} as const;
const cardText = (ui: ScreenHarness) => (ui.renderer.root.findDescendantById("empty-conversation") as TextRenderable).chunks.map(chunk => chunk.text).join("");
const frame = (ui: ScreenHarness) => ui.captureCharFrame();
const escape = async (ui: ScreenHarness) => { ui.mockInput.pressEscape(); await ui.settle(); };
const chooseSignIn = async (ui: ScreenHarness, id: string, more = false) => {
  ui.mockInput.pressKey("l", { meta: true }); await ui.waitFor(s => !!s.loginChooser);
  if (more) { ui.mockInput.pressTab(); await ui.waitFor(s => s.loginChooser?.level !== "main"); }
  for (let moves = 0; ui.controller.snapshot().loginChooser?.selectedId !== id; moves++) {
    if (moves > 12) throw new Error(`No sign-in row ${id}`);
    ui.mockInput.pressArrow("down"); await ui.settle();
  }
};

interface Surface {
  name: string;
  open(ui: ScreenHarness): Promise<void>;
  opened(ui: ScreenHarness, snapshot: TuiSnapshot): boolean;
  /** Esc presses that leave the surface and every surface it opened from. */
  escapes: number;
  /** The panel replaces the conversation, so the card is computed but not painted. */
  replacesConversation?: true;
  /** Cancelling records a notice, so the conversation is no longer empty afterwards. */
  leavesNotice?: true;
  /** A probe with settings staging, which custom endpoint entry needs in the ready state. */
  readyProbe?: string;
}
const panel = (mode: string) => (ui: ScreenHarness) => ui.view.panelMode() === mode;
const SURFACES: Surface[] = [
  { name: "sign-in chooser", open: async ui => { ui.mockInput.pressKey("l", { meta: true }); }, opened: panel("login"), escapes: 1 },
  { name: "sign-in more options", open: async ui => { await chooseSignIn(ui, "chatgpt"); ui.mockInput.pressTab(); }, opened: (_ui, s) => s.loginChooser?.level === "chatgpt", escapes: 2 },
  { name: "endpoint entry", open: async ui => { await chooseSignIn(ui, "compatible"); ui.mockInput.pressEnter(); }, opened: panel("endpoint"), escapes: 2, readyProbe: "model-picker" },
  { name: "credential entry", open: async ui => { await chooseSignIn(ui, "openai"); ui.mockInput.pressEnter(); }, opened: panel("credential"), escapes: 2, leavesNotice: true },
  { name: "callback entry", open: async ui => { await chooseSignIn(ui, "chatgpt-callback", true); ui.mockInput.pressEnter(); }, opened: panel("callback"), escapes: 3, leavesNotice: true },
  { name: "sign-in approval", open: async ui => { await chooseSignIn(ui, "grok"); ui.mockInput.pressEnter(); }, opened: (ui, s) => panel("approval")(ui) && !!s.loginApprovalData && !!s.loginWait, escapes: 2, leavesNotice: true },
  { name: "sign-in device wait", open: async ui => { await chooseSignIn(ui, "grok"); ui.mockInput.pressTab(); await ui.waitFor(s => s.loginChooser?.level === "grok"); ui.mockInput.pressEnter(); }, opened: (ui, s) => panel("approval")(ui) && s.loginApprovalData?.kind === "device" && !!s.loginWait, escapes: 3, leavesNotice: true },
  { name: "model picker", open: async ui => { ui.mockInput.pressKey("m", { meta: true }); }, opened: (ui, s) => panel("model")(ui) && !s.modelPicker?.loading, escapes: 1 },
  { name: "session picker", open: async ui => { ui.mockInput.pressKey("s", { meta: true }); }, opened: (ui, s) => panel("sessions")(ui) && !s.sessionPicker?.loading, escapes: 1 },
  { name: "preferences", open: async ui => { ui.mockInput.pressKey("p", { meta: true }); }, opened: panel("preferences"), escapes: 1, replacesConversation: true },
  { name: "history", open: async ui => { await ui.mockInput.typeText("/history"); ui.mockInput.pressEnter(); }, opened: (ui, s) => panel("history")(ui) && s.history?.loading === false, escapes: 1, replacesConversation: true },
  { name: "review", open: async ui => { ui.mockInput.pressKey("r", { meta: true }); }, opened: (ui, s) => panel("review")(ui) && !s.changeReview?.loading, escapes: 1, replacesConversation: true },
  { name: "help palette", open: async ui => { ui.mockInput.pressKey("h", { meta: true }); }, opened: panel("help"), escapes: 1 },
  // No catalog screen shows find over an empty conversation, so Ctrl+F opens it directly.
  { name: "find", open: async ui => { ui.mockInput.pressKey("f", { ctrl: true }); }, opened: panel("search"), escapes: 1 },
  { name: "slash commands", open: ui => ui.mockInput.typeText("/"), opened: ui => !!ui.renderer.root.findDescendantById("picker")?.visible && ui.view.panelMode() === "", escapes: 1 },
];

for (const [state, expected] of Object.entries(STATES)) {
  for (const surface of SURFACES) {
    test(`${state}: ${surface.name} hides the card action line until Esc, then its key acts`, async () => {
      setSystemTime(new Date("2026-01-15T09:30:00.000Z"));
      const ui = await buildScreen(probe(state === "ready" && surface.readyProbe ? surface.readyProbe : expected.probe), variant);
      try {
        const status = state === "ready" && surface.readyProbe ? "openai/gpt-6-astra · ChatGPT subscription" : expected.status;
        await ui.waitFor(s => s.readiness !== "loading");
        expect(cardText(ui)).toBe(`${status}${expected.gap}${expected.action}`);
        await surface.open(ui);
        await ui.waitFor(s => surface.opened(ui, s));
        await ui.settle();
        // Only the status line stays; the panel's own heading and hint row name the live keys.
        expect(cardText(ui)).toBe(status);
        expect(frame(ui)).not.toContain(expected.action);
        expect(frame(ui)).not.toContain("Type a task · Enter send");
        expect(frame(ui)).not.toContain("Connect a provider · Alt+L sign in");
        if (!surface.replacesConversation) expect(frame(ui).split("\n").slice(0, 6).join("\n")).toContain(status);

        for (let press = 0; press < surface.escapes; press++) await escape(ui);
        await ui.waitFor(() => ui.view.panelMode() === "" && !ui.renderer.root.findDescendantById("picker")?.visible);
        await ui.settle();
        if (surface.leavesNotice) {
          expect(ui.controller.snapshot().transcript.length).toBeGreaterThan(0);
          return;
        }
        // The same render restores the original action line unchanged.
        expect(cardText(ui)).toBe(`${status}${expected.gap}${expected.action}`);
        expect(frame(ui)).toContain(expected.action);
        if (ui.editor.plainText) { ui.editor.setText(""); await ui.settle(); }
        if (state === "not connected") {
          ui.mockInput.pressKey("l", { meta: true });
          await ui.waitFor(s => !!s.loginChooser);
          expect(ui.view.panelMode()).toBe("login");
          return;
        }
        ui.mockInput.pressEnter();
        for (let tick = 0; tick < 5; tick++) await ui.settle();
        expect(ui.controller.snapshot().transcript).toHaveLength(0);
        expect(ui.controller.snapshot().status).toBe("idle");
        await ui.mockInput.typeText("Say ready");
        ui.mockInput.pressEnter();
        await ui.waitFor(s => s.status === "idle" && s.transcript.some(entry => entry.kind === "user" && entry.text === "Say ready") && !!s.outcome);
      } finally { await ui.dispose(); }
    }, 30_000);
  }
}

test("the loading card hides Esc cancel while find owns Esc and offers it again afterwards", async () => {
  const terminal = await createTestRenderer({ width: 80, height: 30, kittyKeyboard: true });
  const workspace = { root: "/project", launchCwd: "/project", extraRoots: [] };
  const controller = new TuiController({ session: createSession(), workspace, provider: "openai", modelId: "fixture", sessionId: "loading-session",
    tools: createToolRegistry(), contextManager: createContextManager(workspace), credentials: { store: fakeCredentialStore(), env: {}, reload: async () => ({ model: createScriptedModel() }) },
    configEditor: new ConfigEditor({}, { user: "/home/test/.config/schway/config.json", project: "/project/.schway/config.json" }) });
  const view = createConversationView(terminal.renderer, { controller, workspaceRoot: "/project", home: "/home/test", env: { SCHWAY_THEME: "dark" }, secrets: [], quit() {}, submit: async () => {} });
  const settle = async () => { await Bun.sleep(5); view.refresh(); await terminal.flush(); };
  try {
    const loading = "Checking connection · Type a task · Esc cancel";
    const startup = controller.initializeStartup(signal => new Promise(resolve => signal.addEventListener("abort", () => resolve({ error: "unused" }), { once: true })));
    await settle();
    expect(controller.snapshot().readiness).toBe("loading");
    expect(terminal.captureCharFrame()).toContain(loading);
    terminal.mockInput.pressKey("f", { ctrl: true });
    await settle();
    expect(view.panelMode()).toBe("search");
    expect(terminal.captureCharFrame()).not.toContain(loading);
    expect(terminal.captureCharFrame()).not.toContain("Esc cancel");
    expect(terminal.captureCharFrame()).toContain("openai/fixture");
    terminal.mockInput.pressEscape();
    await settle();
    expect(view.panelMode()).toBe("");
    expect(controller.snapshot().readiness).toBe("loading");
    expect(terminal.captureCharFrame()).toContain(loading);
    // With find closed, Esc reaches the connection check again.
    terminal.mockInput.pressEscape();
    await startup;
    await settle();
    expect(controller.snapshot().readiness).not.toBe("loading");
  } finally { view.destroy(); controller.dispose(); terminal.renderer.destroy(); }
});

test("open details drop F2 details from the outcome strip but keep a working Alt+R review", async () => {
  setSystemTime(new Date("2026-01-15T09:30:00.000Z"));
  const ui = await buildScreen(probe("details-recovery"), variant);
  try {
    const strip = () => frame(ui).split("\n").find(row => row.includes("✗ Failed ·")) ?? "";
    await ui.mockInput.typeText("Summarize the changes"); ui.mockInput.pressEnter();
    await ui.waitFor(s => !!s.recovery && s.outcome?.reason === "failed");
    await ui.settle();
    expect(strip()).toContain("Alt+R review · F2 details");
    const details = async () => {
      ui.mockInput.pressKey("\u001bOQ");
      await ui.waitFor(s => s.transcript.at(-1)?.text.includes("Failure details:") === true);
      await ui.settle();
      expect(frame(ui)).toContain("PgUp/PgDn scroll · Esc back");
      expect(strip()).toContain("Alt+R review");
      expect(strip()).not.toContain("F2 details");
    };
    await details();
    await escape(ui);
    expect(frame(ui)).not.toContain("PgUp/PgDn scroll · Esc back");
    expect(strip()).toContain("Alt+R review · F2 details");
    // F2 reopens details, and Alt+R from open details opens review.
    await details();
    ui.mockInput.pressKey("r", { meta: true });
    await ui.waitFor(s => !!s.changeReview && !s.changeReview.loading);
    expect(ui.view.panelMode()).toBe("review");
  } finally { await ui.dispose(); }
}, 30_000);
