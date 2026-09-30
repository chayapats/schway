import type { TuiSnapshot } from "../../src/tui/controller.ts";
import type { ScreenHarness } from "./harness.ts";

/** One catalog state reached through input and guarded by observable controller state. */
export interface Screen { id: string; title: string; description: string; noColor?: boolean; rows?: number; elapsed?: number; drive(ui: ScreenHarness): Promise<void>; ready(snapshot: TuiSnapshot, ui: ScreenHarness): boolean }
/** A fresh terminal's final theme, dimensions and color policy. */
export interface Variant { id: string; theme: "dark" | "light"; cols: number; rows: number; noColor: boolean }
const enter = async (ui: ScreenHarness, text: string) => { await ui.mockInput.typeText(text); ui.mockInput.pressEnter(); };
const grokLogin = async (ui: ScreenHarness, device = false) => {
  ui.mockInput.pressKey("l", { meta: true }); await ui.settle();
  for (let i = 0; i < (device ? 4 : 3); i++) ui.mockInput.pressArrow("down");
  ui.mockInput.pressEnter();
};
const failed = (s: TuiSnapshot) => !!s.recovery;
const completed = (s: TuiSnapshot) => s.status === "idle" && !!s.outcome;
const thai = "ช่วยอ่านไฟล์ README.md\nแล้วสรุปเป็นภาษาไทย\nสั้น ๆ สามบรรทัด";
/** Ordered design catalog; additions deliberately update the index and its assertion. */
export const SCREENS: readonly Screen[] = [
  { id: "first-run", title: "First run, not connected", description: "A fresh installation waits for a connection.", drive: async () => {}, ready: s => s.modelId === "" && s.readiness !== "loading" },
  { id: "sign-in-chooser", title: "Sign-in chooser", description: "The connection chooser offers available sign-in routes.", drive: async ui => { ui.mockInput.pressKey("l", { meta: true }); }, ready: s => !!s.loginChooser },
  { id: "subscription-sign-in", title: "Subscription sign-in", description: "Browser sign-in is waiting for authorization.", drive: async ui => { ui.mockInput.pressKey("l", { meta: true }); await ui.settle(); ui.mockInput.pressEnter(); }, ready: (s, ui) => s.status === "running" && ui.loginCalled() },
  { id: "grok-browser-approval", title: "Grok browser approval", description: "Grok subscription sign-in waits for browser approval.", drive: ui => grokLogin(ui), ready: s => s.status === "running" && s.loginApprovalData?.kind === "browser" },
  { id: "grok-device-approval", title: "Grok device approval", description: "The ephemeral Grok device code remains in the approval panel.", drive: ui => grokLogin(ui, true), ready: s => s.status === "running" && s.loginApprovalData?.kind === "device" },
  { id: "grok-plan-error", title: "Grok plan restriction", description: "A plan restriction retains the saved login and offers another connection.", drive: ui => grokLogin(ui), ready: s => s.status === "error" && s.transcript.some(entry => entry.text.includes("Your Grok plan doesn't include API access")) },
  { id: "model-picker", title: "Model picker", description: "Connected models show their context and output budgets.", drive: async ui => { ui.mockInput.pressKey("m", { meta: true }); }, ready: s => !!s.modelPicker && !s.modelPicker.loading },
  { id: "thinking-controls", title: "Thinking controls", description: "Provider-advertised reasoning levels and default share one policy.", drive: async ui => { ui.controller.openPreferences(); }, ready: s => !!s.preferences },
  { id: "command-palette", title: "Command palette", description: "Typing a slash opens command suggestions.", drive: async ui => { await ui.mockInput.typeText("/"); }, ready: (s, ui) => s.status === "idle" && ui.editor.plainText === "/" && ui.controller.commandChoices("/").length > 0 && !!ui.renderer.root.findDescendantById("picker")?.visible },
  { id: "thai-composer", title: "Thai composer", description: "A multiline Thai draft remains in the composer.", drive: async ui => { await ui.mockInput.pasteBracketedText(thai); }, ready: (s, ui) => s.status === "idle" && ui.editor.plainText === thai },
  { id: "streaming-answer", title: "Streaming answer", description: "An incomplete Markdown answer streams into the transcript.", elapsed: 4000, drive: ui => enter(ui, "Explain the config loader"), ready: s => s.activity?.phase === "streaming" && s.transcript.some(e => e.text.includes("- Then")) },
  { id: "parallel-tools", title: "Parallel tools", description: "Three independent tool calls are running together.", elapsed: 7000, drive: ui => enter(ui, "Inspect the project"), ready: s => s.activity?.activeTools === 3 },
  { id: "completed-turn", title: "Completed turn", description: "A completed fix records a file edit and successful command.", noColor: true, drive: ui => enter(ui, "Fix the clamp upper bound"), ready: completed },
  { id: "failed-turn", title: "Failed turn", description: "An unavailable service offers recovery after retries.", noColor: true, drive: ui => enter(ui, "Summarize the changes"), ready: failed },
  { id: "retry-countdown", title: "Retry countdown", description: "A transient failure waits before the next attempt.", elapsed: 1200, drive: ui => enter(ui, "Summarize the changes"), ready: s => s.activity?.phase === "retry" },
  // Render the loading panel before yielding to Git so scrollbar initialization has a fixed order.
  { id: "review-panel", title: "Review panel", description: "The change review displays the completed clamp fix.", noColor: true, drive: async ui => { await enter(ui, "Fix the clamp upper bound"); await ui.waitFor(completed); ui.mockInput.pressKey("r", { meta: true }); await ui.renderOnce(); await ui.flush(); }, ready: s => !!s.changeReview && !s.changeReview.loading && s.changeReview.files.length > 0 && s.changeReview.detail.length > 0 },
  { id: "recent-work-resume", title: "Recent work resume", description: "A saved conversation is offered for resumption.", drive: async ui => { await ui.controller.offerRecentSession(ui.sessionDirectory!); }, ready: s => !!s.recentSession },
  { id: "compaction", title: "Compaction", description: "Earlier conversation turns are being summarized.", elapsed: 3000, drive: async ui => { void ui.controller.compact(); }, ready: s => s.activity?.phase === "compacting" },
  { id: "no-color", title: "No color", description: "Failure recovery remains readable without terminal colors.", drive: ui => enter(ui, "Summarize the changes"), ready: failed },
  { id: "narrow-layout", title: "Narrow layout", description: "A table and code block fit the narrow conversation layout.", drive: ui => enter(ui, "Compare the options"), ready: completed },
];
/** Enumerate six standard variants and the screen's explicit color or narrow extras. */
export function variantsFor(screen: Screen): Variant[] {
  const make = (theme: "dark" | "light", cols: number, rows = screen.rows ?? 30, noColor = screen.id === "no-color"): Variant => ({ id: `${noColor ? "nocolor-" : ""}${theme}-${cols}`, theme, cols, rows, noColor });
  const variants = (["dark", "light"] as const).flatMap(theme => [120, 80, 50].map(cols => make(theme, cols)));
  if (screen.id === "first-run") variants.push(...[120, 80, 50].map(cols => make("dark", cols, screen.rows ?? 30, true)));
  if (screen.noColor) variants.push(make("dark", 80, screen.rows ?? 30, true));
  if (screen.id === "narrow-layout") variants.push(make("dark", 40, 20), make("light", 40, 20));
  return variants;
}
