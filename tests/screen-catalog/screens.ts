import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TuiSnapshot } from "../../src/tui/controller.ts";
import { CATALOG_API_KEY, CATALOG_CALLBACK, CATALOG_ENDPOINT_URL, type ScreenHarness } from "./harness.ts";
import { displayUrl } from "../../src/tools/web-fetch-display.ts";
import type { TuiRecovery } from "../../src/tui/controller-types.ts";
import type { STARTUP_RECOVERY_CATEGORIES } from "../../src/tui/controller-support.ts";

/** One catalog state reached through input and guarded by observable controller state. */
export interface Screen { id: string; title: string; description: string; noColor?: boolean; noColorWidths?: boolean; rows?: number; elapsed?: number; drive(ui: ScreenHarness): Promise<void>; ready(snapshot: TuiSnapshot, ui: ScreenHarness): boolean }
/** A fresh terminal's final theme, dimensions and color policy. */
export interface Variant { id: string; theme: "dark" | "light"; cols: number; rows: number; noColor: boolean }
const enter = async (ui: ScreenHarness, text: string) => { await ui.mockInput.typeText(text); ui.mockInput.pressEnter(); };
const grokLogin = async (ui: ScreenHarness, device = false) => {
  ui.mockInput.pressKey("l", { meta: true }); await ui.settle();
  while (ui.controller.snapshot().loginChooser?.selectedId !== "grok") ui.mockInput.pressArrow("down");
  if (device) { ui.mockInput.pressTab(); await ui.settle(); }
  ui.mockInput.pressEnter();
};
const failed = (s: TuiSnapshot) => !!s.recovery;
const completed = (s: TuiSnapshot) => s.status === "idle" && !!s.outcome;
const stopped = (s: TuiSnapshot) => s.status === "idle" && s.outcome?.reason === "cancelled" && s.recovery?.actions.includes("continue") === true;
const stopWork = async (ui: ScreenHarness, tool: boolean) => {
  await enter(ui, tool ? "Save the result, then run a command" : "Explain the next step");
  await ui.waitFor(s => s.transcript.some(row => tool
    ? row.toolCallId === "active-shell" && row.text.includes("Ready to stop")
    : row.kind === "assistant" && row.text.includes("The next step is")));
  await ui.mockInput.pasteBracketedText("งานถัดไป 🧪\nยังไม่ส่ง");
  ui.mockInput.pressEscape();
  await ui.waitFor(stopped);
  if (tool && await readFile(join(ui.root, "saved.txt"), "utf8") !== "Completed work ไทย 🧪\n") throw new Error("Stopped tool lost completed file content");
};
const streamingTurn = async (ui: ScreenHarness) => {
  await enter(ui, "Explain the config loader");
  await ui.waitFor(s => s.activity?.phase === "streaming" && s.transcript.some(e => e.text.includes("- Then")));
};
/** The single transcript row each settled manual compaction leaves, keyed by outcome. */
export const COMPACTION_RESULTS = { completed: "Context compacted · /context inspect summary", cancelled: "Compaction cancelled · /compact retry",
  failed: "Compaction failed · F2 repair details", noop: "Context unchanged · /compact retry after more turns" } as const;
const compactionSettled = (result: string) => (s: TuiSnapshot) => s.status === "idle" && !s.activity && s.transcript.at(-1)?.text === result;
/** The screen that records each turn recovery category; `provider` is the generic failed turn (#306). */
export const RECOVERY_SCREENS: Readonly<Record<TuiRecovery["category"], string>> = { auth: "recovery-auth", "credential-store": "recovery-credential-store",
  model: "recovery-model", offline: "recovery-offline", "rate-limit": "recovery-rate-limit", provider: "failed-turn", "session-write": "recovery-session-write" };
/** The screen that records each startup recovery category (#306). */
export const STARTUP_RECOVERY_SCREENS: Readonly<Record<(typeof STARTUP_RECOVERY_CATEGORIES)[number], string>> = { auth: "startup-auth",
  "credential-store": "startup-credential-store", model: "startup-model", provider: "startup-provider" };
/** A turn whose scripted runtime failure (harness `RECOVERY_FIXTURES`) leaves `category`'s recovery offered for the accepted task. */
const recoveryScreen = (category: TuiRecovery["category"], title: string, description: string): Screen => ({ id: RECOVERY_SCREENS[category], title, description, noColorWidths: true,
  drive: ui => enter(ui, "Summarize the changes"), ready: s => s.status === "error" && s.recovery?.category === category && s.recovery.accepted });
/** A saved conversation reopened while its model fails to load (harness `STARTUP_FIXTURES`), offering `category`'s recovery before any task is accepted. */
const startupScreen = (category: keyof typeof STARTUP_RECOVERY_SCREENS, title: string, description: string): Screen => ({ id: STARTUP_RECOVERY_SCREENS[category], title, description, noColorWidths: true,
  drive: async () => {}, ready: s => s.status === "error" && s.recovery?.category === category && !s.recovery.accepted });
/** The model picker is open and its discovery has settled. */
const pickerSettled = (s: TuiSnapshot) => !!s.modelPicker && !s.modelPicker.loading;
/** Open the session picker with Alt+S and wait until discovery finishes. */
const openSessions = async (ui: ScreenHarness) => { ui.mockInput.pressKey("s", { meta: true }); await ui.waitFor(s => !!s.sessionPicker && !s.sessionPicker.loading); };
const thai = "ช่วยอ่านไฟล์ README.md\nแล้วสรุปเป็นภาษาไทย\nสั้น ๆ สามบรรทัด";
const search = async (ui: ScreenHarness, query: string) => {
  ui.controller.notice("Read the project README before making changes.");
  ui.mockInput.pressTab({ shift: true }); ui.mockInput.pressTab({ shift: true });
  ui.mockInput.pressKey("f", { ctrl: true }); await ui.settle();
  if (query) await ui.mockInput.typeText(query);
};
const longFailingCommand = `printf '%s\\n' '${"ตรวจผลลัพธ์ภาษาไทย 🧪 café ".repeat(8)}'; exit 1`;
const shellRow = (ui: ScreenHarness, id: string, command: string, status: "success" | "error" | "cancelled", content: string, details?: unknown) => {
  ui.session.append({ type: "assistant", id: `request-${id}`, content: [{ type: "tool_call", id, name: "bash", arguments: { command } }] });
  ui.controller.applyEvent({ type: "tool.started", toolCallId: id, name: "bash" });
  ui.advance();
  // The scheduler measures run time; these synthetic rows carry the 1.2s each shell screen's clock advances.
  ui.controller.applyEvent({ type: "tool.finished", toolCallId: id, name: "bash", status, content, details, startedAt: "2026-01-15T09:30:00.000Z", durationMs: 1200 });
  ui.session.append({ type: "tool_result", id: `result-${id}`, toolCallId: id, content, isError: status !== "success" });
};
/** Append one web_fetch row; running rows start without finishing. */
const fetchRow = (ui: ScreenHarness, id: string, url: string, finish?: { status: "success" | "error"; content: string; details: unknown }) => {
  ui.session.append({ type: "assistant", id: `request-${id}`, content: [{ type: "tool_call", id, name: "web_fetch", arguments: { url } }] });
  ui.controller.applyEvent({ type: "tool.started", toolCallId: id, name: "web_fetch" });
  if (!finish) return;
  ui.advance();
  // Like the tool, details carry the display-safe first line that the TUI shows instead of the raw echo.
  const statusLine = finish.content.split("\n")[0]!.replace(url, displayUrl(url));
  ui.controller.applyEvent({ type: "tool.finished", toolCallId: id, name: "web_fetch", ...finish, details: { ...(finish.details as object), statusLine } });
  ui.session.append({ type: "tool_result", id: `result-${id}`, toolCallId: id, content: finish.content, isError: finish.status !== "success" });
};
/** Commit one answer through the live controller path; `searches` adds that many kept hosted web search items. */
const searchAnswer = (ui: ScreenHarness, id: string, answer: string, searches: number) => {
  ui.controller.applyEvent({ type: "model.started", provider: "xai", model: "grok-4.7" });
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: answer } });
  const hosted = Array.from({ length: searches }, (_, index) => ({ position: 0, item: { type: "web_search_call", id: `ws-${id}-${index}`, status: "completed", action: { type: "search", query: "bangkok weather" } } }));
  ui.session.append({ type: "assistant", id, content: [{ type: "text", text: answer }], ...(searches ? { providerMetadata: { xai: { response_id: `resp-${id}`, hosted_items: hosted } } } : {}) });
  ui.controller.applyEvent({ type: "model.finished" });
};
const fetchDetails = (url: string, status: number, rawBytes: number, durationMs: number, extra: Record<string, unknown> = {}) =>
  ({ url, finalUrl: url, status, contentType: "text/html", rawBytes, textBytes: Math.round(rawBytes / 4), truncated: false, durationMs, ...extra });
const longFailure = async (ui: ScreenHarness, expanded = false) => {
  shellRow(ui, "long-failure", longFailingCommand, "success", "Exit code: 1\nตรวจผลลัพธ์ภาษาไทย 🧪\nThe command returned a nonzero exit.", { exitCode: 1 });
  if (expanded) { await ui.settle(); ui.mockInput.pressKey("o", { ctrl: true }); }
};
const inspection = async (ui: ScreenHarness, focus: "none" | "code" | "tool") => {
  let copies = 0;
  ui.renderer.copyToClipboardOSC52 = () => { copies++; return true; };
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: "```txt\nEarlier hidden block\n```\n\n" + "Earlier explanation.\n\n".repeat(24)
    + "```ts\nconsole.log('เป้าหมาย 🧪');\n// บรรทัดสอง\n```\n\n```json\n{\"next\":true}\n```" } });
  ui.controller.applyEvent({ type: "model.finished" });
  ui.controller.applyEvent({ type: "tool.started", toolCallId: "inspection-read", name: "read" });
  ui.controller.applyEvent({ type: "tool.finished", toolCallId: "inspection-read", name: "read", status: "success", content: "ผลลัพธ์ภาษาไทย 🧪\nSecond result line" });
  await ui.mockInput.pasteBracketedText("งานถัดไป 🧪");
  await ui.settle(); ui.mockInput.pressKey("END", { ctrl: true }); await ui.settle();
  if (focus !== "none") {
    ui.mockInput.pressKey("i", { meta: true }); await ui.settle();
    if (focus === "tool") {
      ui.mockInput.pressTab(); await ui.settle();
      ui.mockInput.pressTab(); await ui.settle();
      ui.mockInput.pressEnter(); await ui.settle();
      ui.mockInput.pressKey("\u001b[6~"); await ui.settle();
    }
  }
  if (copies) throw new Error("Inspection opening, navigation and tool expansion must not copy");
};
const readerCode = [
  "export function summarize(rows: readonly Row[], options: { locale: string; currency: string; includeArchived: boolean; precision: number; groupBy: \"region\" | \"owner\"; timezone: string }): Summary {",
  "  const label = 'สรุปยอดขาย 🧪 ' + options.locale; // Thai and emoji stay whole graphemes when the view pans or wraps",
  "  const totals = rows.filter(row => options.includeArchived || !row.archived).map(row => row.amount * row.quantity);",
  "  return { label, total: totals.reduce((sum, value) => sum + value, 0).toFixed(options.precision), currency: options.currency };",
  "}",
].join("\n");
const readerTable = ["| Region | Owner | Q1 revenue | Q2 revenue | Change | Status | Notes | Follow-up |", "| --- | --- | ---: | ---: | ---: | --- | --- | --- |",
  ...Array.from({ length: 36 }, (_, index) => `| ภาค ${index + 1} | ${index % 3 ? "Dana" : ""} | ${(1200 + index * 37).toLocaleString("en-US")} | ${(1300 + index * 41).toLocaleString("en-US")} | +${(index % 9) + 1}% | ${index % 4 ? "On track" : "Review 🧪"} | [details](https://example.test/regions/${index + 1}) | Confirm the quarter-end forecast with finance |`)].join("\n");
const reader = async (ui: ScreenHarness, mode: "code" | "wrapped" | "table" | "search" | "approval") => {
  let copies = 0;
  ui.renderer.copyToClipboardOSC52 = () => { copies++; return true; };
  ui.controller.applyEvent({ type: "model.delta", content: { type: "text", text: mode === "table" ? readerTable : "```ts\n" + readerCode + "\n```" } });
  ui.controller.applyEvent({ type: "model.finished" });
  await ui.mockInput.pasteBracketedText("งานถัดไป 🧪");
  if (mode === "approval") ui.mockInput.pressTab({ shift: true });
  await ui.settle(); ui.mockInput.pressKey("i", { meta: true }); await ui.settle();
  ui.mockInput.pressKey("r"); await ui.settle();
  if (mode === "code") ui.mockInput.pressArrow("right");
  if (mode === "wrapped") ui.mockInput.pressKey("w");
  if (mode === "table") { ui.mockInput.pressKey("\u001b[6~"); await ui.settle(); ui.mockInput.pressArrow("right"); }
  if (mode === "search") { ui.mockInput.pressKey("f", { ctrl: true }); await ui.mockInput.typeText("absent"); }
  if (mode === "approval") void ui.controller.submit("Run the clamp test");
  await ui.settle();
  if (copies) throw new Error("Opening and navigating the reader must not copy");
};
const reading = (ui: ScreenHarness, text: string) => !!ui.renderer.root.findDescendantById("reader-panel")?.visible && ui.captureCharFrame().includes(text);
const openDetails = (ui: ScreenHarness) => ui.mockInput.pressKey("\u001bOQ");
const reviewReady = (s: TuiSnapshot) => !!s.changeReview && !s.changeReview.loading && s.changeReview.files.length > 0 && s.changeReview.detail.length > 0;
const resumedReady = (s: TuiSnapshot) => s.changeReview?.scope?.kind === "workspace" && !s.changeReview.loading && s.changeReview.rows.length > 0 && !s.changeReview.rows.some(row => row.text.startsWith("Loading current"));
const openResumedReview = async (ui: ScreenHarness) => { ui.mockInput.pressKey("r", { meta: true }); await ui.renderOnce(); await ui.flush(); };
const composerReady = (ui: ScreenHarness) => !ui.renderer.isDestroyed && !ui.editor.isDestroyed
  && ui.renderer.root.findDescendantById("prompt") === ui.editor && ui.editor.visible && ui.editor.focused && ui.editor.width > 0 && ui.editor.height > 0;
const helpPalette = async (ui: ScreenHarness, query: string, moves = 0, guide = false) => {
  ui.mockInput.pressKey("h", { meta: true }); await ui.settle();
  if (query) await ui.mockInput.typeText(query);
  await ui.settle();
  for (let move = 0; move < moves; move++) { ui.mockInput.pressArrow("down"); await ui.settle(); }
  if (guide) ui.mockInput.pressEnter();
};
const helpReady = (ui: ScreenHarness, query: string) => ui.controller.commandHelpOpen && ui.editor.plainText === query;
/** Run the three recorded history turns: a fix, a failing check and a stopped command. */
const historyTurns = async (ui: ScreenHarness, turns = 3) => {
  await enter(ui, "Fix the clamp upper bound"); await ui.waitFor(completed);
  if (turns < 2) return;
  await enter(ui, "Run the clamp tests"); await ui.waitFor(s => completed(s) && s.transcript.some(row => row.text.includes("One clamp test still fails.")));
  // Paste keeps the emoji whole; typed input would split its surrogate pair.
  await ui.mockInput.pasteBracketedText("Save clamp notes ไทย 🧪, then wait"); await ui.settle(); ui.mockInput.pressEnter();
  await ui.waitFor(s => s.transcript.some(row => row.toolCallId === "history-wait" && row.text.includes("Ready to stop")));
  ui.mockInput.pressEscape(); await ui.waitFor(stopped);
};
/** Open /history from the composer, move down `downs` rows and optionally open that turn. */
const openHistory = async (ui: ScreenHarness, downs = 0, open = false) => {
  await enter(ui, "/history"); await ui.waitFor(s => s.history?.loading === false);
  for (let index = 0; index < downs; index++) { ui.mockInput.pressArrow("down"); await ui.settle(); }
  if (open) { ui.mockInput.pressEnter(); await ui.settle(); }
};
/** Open the sign-in chooser with /login and move to one row, optionally into its more-options level. */
const loginChoice = async (ui: ScreenHarness, id: string, more = false) => {
  await enter(ui, "/login"); await ui.waitFor(s => !!s.loginChooser);
  if (more) { ui.mockInput.pressTab(); await ui.waitFor(s => s.loginChooser?.level !== "main"); }
  while (ui.controller.snapshot().loginChooser?.selectedId !== id) { ui.mockInput.pressArrow("down"); await ui.settle(); }
  ui.mockInput.pressEnter();
};
/** Open custom endpoint URL entry from the sign-in chooser with Alt+L and the arrow keys. */
const openEndpointEntry = async (ui: ScreenHarness) => {
  ui.mockInput.pressKey("l", { meta: true }); await ui.settle();
  while (ui.controller.snapshot().loginChooser?.selectedId !== "compatible") ui.mockInput.pressArrow("down");
  ui.mockInput.pressEnter(); await ui.waitFor(s => !!s.endpointUrlEntry);
};
/** Load the fixture branch session with /resume, then open its branch tree with /branch tree. */
const openBranchTree = async (ui: ScreenHarness) => {
  await enter(ui, "/resume branch-demo"); await ui.waitFor(s => s.sessionId === "branch-demo" && s.status === "idle");
  await enter(ui, "/branch tree"); await ui.waitFor(s => !!s.branchTree);
};
const historyReady = (view: "list" | "detail", selected = 0) => (s: TuiSnapshot) => s.history?.loading === false && s.history.view === view && s.history.selected === selected;
/** Ordered design catalog; additions deliberately update the index and its assertion. */
export const SCREENS: readonly Screen[] = [
  { id: "first-run", title: "First run, not connected", description: "A fresh installation waits for a connection.", drive: async () => {}, ready: s => s.modelId === "" && s.readiness !== "loading" },
  { id: "disconnected-search", title: "Search before connecting", description: "A disconnected conversation retains its mode and search restore action.", noColorWidths: true, drive: ui => search(ui, "README"), ready: (s, ui) => s.readiness === "not-connected" && s.approvalMode === "read-only" && ui.editor.plainText === "README" },
  { id: "auto-mode", title: "Auto mode", description: "An idle conversation shows the default Auto mode and its change-mode hint.", noColorWidths: true, drive: async () => {}, ready: s => s.approvalMode === "auto" && s.readiness === "ready" },
  { id: "read-only-mode", title: "Read-only mode", description: "An idle conversation shows the read-only approval chip and mode hint.", noColor: true, drive: async ui => { ui.mockInput.pressTab({ shift: true }); ui.mockInput.pressTab({ shift: true }); }, ready: s => s.approvalMode === "read-only" },
  { id: "ask-mode", title: "Ask mode", description: "An idle conversation shows the ask approval chip and mode hint.", noColor: true, drive: async ui => { ui.mockInput.pressTab({ shift: true }); }, ready: s => s.approvalMode === "ask" },
  { id: "approval-modes-help", title: "Approval mode meanings", description: "Preferences explain the three modes without changing the current mode.", noColor: true, drive: async ui => { ui.mockInput.pressKey("p", { meta: true }); await ui.settle(); ui.mockInput.pressKey("pagedown"); }, ready: s => !!s.preferences && s.approvalMode === "auto" },
  { id: "read-only-search-empty", title: "Read-only search, empty query", description: "An empty search retains the mode and Escape action at safety widths.", noColor: true, drive: ui => search(ui, ""), ready: (s, ui) => s.approvalMode === "read-only" && ui.editor.placeholder === "Find in this branch…" },
  { id: "read-only-search-matches", title: "Read-only search, matching query", description: "A matching query retains the mode and Escape action at safety widths.", noColor: true, drive: ui => search(ui, "README"), ready: (s, ui) => s.approvalMode === "read-only" && ui.editor.plainText === "README" },
  { id: "read-only-search-no-matches", title: "Read-only search, no matches", description: "An unmatched query retains the mode and Escape action at safety widths.", noColor: true, drive: ui => search(ui, "absent"), ready: (s, ui) => s.approvalMode === "read-only" && ui.editor.plainText === "absent" },
  { id: "approval-command", title: "Approve a command", description: "A mutating command waits for an interactive approval choice.", noColor: true, drive: ui => enter(ui, "Test the clamp fix"), ready: s => s.toolApproval?.content === "bun test --filter clamp" },
  { id: "approval-edit", title: "Approve an edit", description: "The exact clamp replacement is previewed before approval.", noColor: true, drive: ui => enter(ui, "Fix the clamp upper bound"), ready: s => !!s.toolApproval?.diff },
  { id: "approval-deny-reason", title: "Deny with a reason", description: "Choosing Deny with reason reopens the editor for a reason the agent will see.", noColor: true, drive: async ui => {
    await enter(ui, "Fix the clamp upper bound"); await ui.waitFor(s => !!s.toolApproval?.diff); await ui.settle();
    ui.mockInput.pressArrow("down"); ui.mockInput.pressArrow("down"); await ui.waitFor(s => s.toolApproval?.selected === 2); ui.mockInput.pressEnter();
  }, ready: (s, ui) => !!s.toolApproval?.enteringReason && ui.editor.plainText === "" },
  { id: "approval-diff-overflow", title: "Approve a long edit", description: "An edit diff taller than the approval panel scrolls above the fixed approval choices.", drive: ui => enter(ui, "Bound every clamp step"), ready: s => (s.toolApproval?.diff?.added ?? 0) > 20 },
  { id: "sign-in-chooser", title: "Sign-in chooser", description: "The connection chooser groups subscriptions, API keys and a custom endpoint.", noColorWidths: true, drive: async ui => { ui.mockInput.pressKey("l", { meta: true }); }, ready: s => !!s.loginChooser },
  { id: "chatgpt-more-options", title: "ChatGPT more options", description: "Device approval and a pasted callback are alternate ChatGPT methods.", noColorWidths: true, drive: async ui => { ui.mockInput.pressKey("l", { meta: true }); await ui.settle(); ui.mockInput.pressTab(); }, ready: s => s.loginChooser?.level === "chatgpt" },
  { id: "grok-more-options", title: "Grok more options", description: "Device code is the alternate Grok method.", noColorWidths: true, drive: async ui => { ui.mockInput.pressKey("l", { meta: true }); await ui.settle(); while (ui.controller.snapshot().loginChooser?.selectedId !== "grok") ui.mockInput.pressArrow("down"); ui.mockInput.pressTab(); }, ready: s => s.loginChooser?.level === "grok" },
  { id: "api-key-entry", title: "API key entry", description: "An API key typed after /login shows only masked characters.", noColorWidths: true, drive: async ui => {
    await loginChoice(ui, "openai"); await ui.waitFor(s => !!s.credentialEntry); await ui.mockInput.typeText(CATALOG_API_KEY.slice(0, 14));
  }, ready: s => s.credentialEntry?.masked.length === 14 },
  { id: "api-key-entry-empty", title: "API key entry, empty", description: "An empty API key field names the provider, asks for a paste and puts the caret where the key starts.", noColorWidths: true, drive: async ui => {
    await loginChoice(ui, "openai"); await ui.waitFor(s => !!s.credentialEntry);
  }, ready: s => s.credentialEntry?.masked === "" },
  { id: "callback-entry", title: "Browser callback entry", description: "A pasted ChatGPT browser callback shows only masked characters.", noColorWidths: true, drive: async ui => {
    await loginChoice(ui, "chatgpt-callback", true); await ui.waitFor(s => !!s.loginCallbackEntry); await ui.mockInput.pasteBracketedText(CATALOG_CALLBACK.slice(0, 40));
  }, ready: s => s.loginCallbackEntry?.masked.length === 40 },
  { id: "endpoint-url-empty", title: "Endpoint URL", description: "A custom endpoint starts with an ephemeral, unmasked URL field.", noColorWidths: true, drive: async ui => { ui.mockInput.pressKey("l", { meta: true }); await ui.settle(); while (ui.controller.snapshot().loginChooser?.selectedId !== "compatible") ui.mockInput.pressArrow("down"); ui.mockInput.pressEnter(); }, ready: s => !!s.endpointUrlEntry && !s.endpointUrlEntry.value },
  { id: "endpoint-url-error", title: "Endpoint URL validation", description: "A malformed URL stays in the field with a corrective action.", noColorWidths: true, drive: async ui => { ui.mockInput.pressKey("l", { meta: true }); await ui.settle(); while (ui.controller.snapshot().loginChooser?.selectedId !== "compatible") ui.mockInput.pressArrow("down"); ui.mockInput.pressEnter(); await ui.settle(); await ui.mockInput.typeText("localhost:8787"); ui.mockInput.pressEnter(); }, ready: s => !!s.endpointUrlEntry?.error },
  { id: "endpoint-url-prefilled", title: "Endpoint URL, prefilled", description: "A saved endpoint URL fills the field as a value with the caret after it.", noColorWidths: true, drive: ui => openEndpointEntry(ui), ready: s => s.endpointUrlEntry?.value === CATALOG_ENDPOINT_URL },
  { id: "endpoint-key-entry", title: "Endpoint key entry", description: "After a valid URL the endpoint asks for its key, and Esc goes back to the URL.", noColorWidths: true, drive: async ui => {
    await openEndpointEntry(ui); await ui.mockInput.typeText(CATALOG_ENDPOINT_URL); ui.mockInput.pressEnter();
  }, ready: s => !!s.credentialEntry?.returnsToUrl },
  { id: "subscription-sign-in", title: "Subscription sign-in", description: "Browser sign-in is waiting for authorization.", drive: async ui => { ui.mockInput.pressKey("l", { meta: true }); await ui.settle(); ui.mockInput.pressEnter(); }, ready: (s, ui) => s.status === "running" && ui.loginCalled() },
  { id: "chatgpt-device-approval", title: "ChatGPT device approval", description: "ChatGPT device sign-in lists the address step before the ephemeral code.", drive: async ui => {
    ui.mockInput.pressKey("l", { meta: true }); await ui.settle(); ui.mockInput.pressTab(); await ui.settle(); ui.mockInput.pressEnter();
  }, ready: s => s.status === "running" && s.loginApprovalData?.kind === "device" },
  { id: "grok-browser-approval", title: "Grok browser approval", description: "Grok subscription sign-in waits for browser approval.", drive: ui => grokLogin(ui), ready: s => s.status === "running" && s.loginApprovalData?.kind === "browser" },
  { id: "grok-device-approval", title: "Grok device approval", description: "The ephemeral Grok device code remains in the approval panel.", drive: ui => grokLogin(ui, true), ready: s => s.status === "running" && s.loginApprovalData?.kind === "device" },
  { id: "sign-in-browser-not-opened", title: "Browser not opened", description: "When the browser launcher fails, the link stays above and other methods appear while sign-in still waits.", drive: async ui => {
    ui.mockInput.pressKey("l", { meta: true }); await ui.settle(); ui.mockInput.pressEnter();
  }, ready: s => s.status === "running" && s.loginChooser?.level === "chatgpt" && s.transcript.some(entry => entry.text.startsWith("Browser didn't open")) },
  { id: "sign-in-timeout", title: "Sign-in timed out", description: "A browser callback timeout shows a short status and reopens ChatGPT's other sign-in methods.", drive: async ui => {
    ui.mockInput.pressKey("l", { meta: true }); await ui.settle(); ui.mockInput.pressEnter();
  }, ready: s => s.status === "error" && s.loginChooser?.level === "chatgpt" },
  { id: "grok-plan-error", title: "Grok plan restriction", description: "A plan restriction retains the saved login and offers another connection.", drive: ui => grokLogin(ui), ready: s => s.status === "error" && s.transcript.some(entry => entry.text.includes("Your Grok plan doesn't include API access")) },
  { id: "model-picker", title: "Model picker", description: "A short connected list shows readable model names and access routes.", noColorWidths: true, drive: async ui => { ui.mockInput.pressKey("m", { meta: true }); }, ready: s => !!s.modelPicker && !s.modelPicker.loading },
  { id: "details-model", title: "Model details", description: "F2 reveals the selected model's exact ID and capacity without changing the connection.", noColorWidths: true, drive: async ui => {
    ui.mockInput.pressKey("m", { meta: true }); await ui.waitFor(s => !!s.modelPicker && !s.modelPicker.loading); openDetails(ui);
  }, ready: s => s.modelPicker?.details === true },
  { id: "model-picker-unconnected", title: "Model picker, connect a provider", description: "An empty model list offers one action to connect a provider.", noColorWidths: true, drive: async ui => { ui.mockInput.pressKey("m", { meta: true }); }, ready: s => !!s.modelPicker && !s.modelPicker.loading },
  { id: "model-picker-loading", title: "Model picker, checking models", description: "While the account model list loads, the picker says so and keeps the way back.", noColorWidths: true,
    drive: async ui => { ui.mockInput.pressKey("m", { meta: true }); }, ready: s => !!s.modelPicker?.loading && s.modelPicker.accessLoading === false && s.modelPicker.entries.some(entry => entry.modelId === "fake-coder") },
  { id: "model-picker-offline", title: "Model picker, offline", description: "An offline account model list says so, offers retry and keeps its diagnostic behind F2.", noColorWidths: true,
    drive: async ui => { ui.mockInput.pressKey("m", { meta: true }); }, ready: s => pickerSettled(s) && s.modelPicker!.catalogState === "offline" },
  { id: "model-picker-failed", title: "Model picker, list failed", description: "A failed account model list reads differently from offline and keeps its diagnostic behind F2.", noColorWidths: true,
    drive: async ui => { ui.mockInput.pressKey("m", { meta: true }); }, ready: s => pickerSettled(s) && s.modelPicker!.catalogState === "failed" && !!s.modelPicker!.error?.startsWith("Models unavailable") },
  { id: "model-picker-partial", title: "Model picker, one route missing", description: "When only the endpoint list fails, the picker names it and keeps the loaded models selectable.", noColorWidths: true,
    drive: async ui => { ui.mockInput.pressKey("m", { meta: true }); }, ready: s => pickerSettled(s) && !!s.modelPicker!.error?.startsWith("Endpoint models unavailable") },
  { id: "reasoning-chip-explicit", title: "Reasoning chip, explicit level", description: "After /thinking high the footer chip shows the level Schway sends.", noColor: true,
    drive: ui => enter(ui, "/thinking high"), ready: s => s.thinkingChip === "high" && s.status === "idle" },
  { id: "reasoning-chip-provider-default", title: "Reasoning chip, provider default", description: "With thinking unset the footer chip says the provider default applies.", noColor: true,
    drive: async () => {}, ready: s => s.thinkingChip === "Provider default" && s.readiness === "ready" },
  { id: "reasoning-chip-advertised", title: "Reasoning chip, advertised default", description: "With thinking unset the footer chip names the provider's advertised default without claiming Schway sent it.", noColor: true,
    drive: async () => {}, ready: s => s.thinkingChip === "Provider default (medium)" && s.readiness === "ready" },
  { id: "reasoning-chip-unavailable", title: "Reasoning chip, unavailable level", description: "A requested level the model does not offer shows as unavailable in the footer chip.", noColor: true,
    drive: async () => {}, ready: s => s.thinkingChip === "xhigh unavailable" && s.readiness === "ready" },
  { id: "thinking-controls", title: "Thinking controls", description: "Basic preferences show ordinary settings and supported thinking choices.", noColorWidths: true, drive: async ui => { ui.mockInput.pressKey("p", { meta: true }); await ui.settle(); ui.mockInput.pressArrow("down"); }, ready: s => !!s.preferences?.selectedIndex },
  { id: "command-palette", title: "Command palette", description: "Typing a slash opens the curated built-in order.", noColorWidths: true, drive: async ui => { await ui.controller.refreshCommands(); await ui.mockInput.typeText("/"); }, ready: (s, ui) => s.status === "idle" && ui.editor.plainText === "/" && ui.controller.commandChoices("/").length > 0 && !!ui.renderer.root.findDescendantById("picker")?.visible },
  { id: "command-palette-groups", title: "Command palette groups", description: "Skills and extension owners precede the final destructive command.", noColorWidths: true, drive: async ui => { await ui.controller.refreshCommands(); await ui.mockInput.typeText("/"); await ui.settle(); ui.mockInput.pressArrow("up"); }, ready: (s, ui) => s.status === "idle" && ui.editor.plainText === "/" && ui.captureCharFrame().includes("Extensions") },
  { id: "command-palette-query", title: "Command palette search", description: "A typed query ranks matching names without group headers.", noColorWidths: true, drive: async ui => { await ui.controller.refreshCommands(); await ui.mockInput.typeText("/ses"); }, ready: (s, ui) => s.status === "idle" && ui.editor.plainText === "/ses" && !!ui.renderer.root.findDescendantById("picker")?.visible },
  { id: "command-palette-exact", title: "Command palette exact match", description: "A draft that already matches the highlighted command says Enter sends it.", noColorWidths: true, drive: async ui => {
    await ui.controller.refreshCommands(); await ui.waitFor(s => s.status === "idle" && composerReady(ui)); await ui.mockInput.typeText("/session");
  }, ready: (s, ui) => s.status === "idle" && composerReady(ui) && ui.editor.plainText === "/session" && !!ui.renderer.root.findDescendantById("picker")?.visible && ui.captureCharFrame().includes("/session") && ui.captureCharFrame().includes("Enter send") },
  { id: "command-palette-inserted", title: "Command palette after Enter", description: "Enter inserts the highlighted command and closes the list, so the next Enter sends it.", noColorWidths: true, drive: async ui => { await ui.controller.refreshCommands(); await ui.mockInput.typeText("/ses"); await ui.settle(); ui.mockInput.pressEnter(); }, ready: (s, ui) => s.status === "idle" && ui.editor.plainText === "/sessions " && !ui.renderer.root.findDescendantById("picker")?.visible },
  { id: "login-argument-choices", title: "Sign-in route choices", description: "Typing /login and a space lists the sign-in routes, naming the ChatGPT subscription chatgpt.", noColorWidths: true, drive: async ui => { await ui.mockInput.typeText("/login "); }, ready: (s, ui) => s.status === "idle" && ui.editor.plainText === "/login " && !!ui.renderer.root.findDescendantById("picker")?.visible && ui.captureCharFrame().includes("login chatgpt") },
  { id: "help-palette-actions", title: "Help action results", description: "A help search for review lists keyboard guidance beside matching commands without changing the draft.", noColorWidths: true, drive: ui => helpPalette(ui, "review"), ready: (_s, ui) => helpReady(ui, "review") && ui.captureCharFrame().includes("Enter show keys") },
  { id: "help-palette-disabled", title: "Help disabled actions", description: "Unavailable keyboard actions stay searchable and the selected one names its reason.", noColorWidths: true, drive: ui => helpPalette(ui, "ctrl", 2), ready: (_s, ui) => helpReady(ui, "ctrl") && ui.captureCharFrame().includes("! No details to show · Esc back") },
  { id: "help-palette-guidance", title: "Help keyboard guidance", description: "Enter on a keyboard action shows its exact keys and prerequisites without performing it.", noColorWidths: true, drive: ui => helpPalette(ui, "copy", 0, true), ready: (_s, ui) => helpReady(ui, "copy") && ui.captureCharFrame().includes("Return to the conversation and press") },
  { id: "help-palette-no-matches", title: "Help without matches", description: "An unmatched help search offers restoring the draft it opened from.", noColorWidths: true, drive: ui => helpPalette(ui, "zzqx"), ready: (_s, ui) => helpReady(ui, "zzqx") && ui.captureCharFrame().includes("No matches · Esc restore") },
  { id: "thai-composer", title: "Thai composer", description: "A multiline Thai draft remains in the composer.", drive: async ui => { await ui.mockInput.pasteBracketedText(thai); }, ready: (s, ui) => s.status === "idle" && ui.editor.plainText === thai },
  { id: "draft-restored", title: "Restored draft", description: "A saved Thai draft returns to its session without being sent.", noColorWidths: true, drive: async () => {}, ready: (_s, ui) => ui.editor.plainText === "ร่างภาษาไทย\nยังไม่ส่ง 🧪" && ui.captureCharFrame().includes("Draft restored") },
  { id: "draft-not-saved", title: "Draft not saved", description: "A denied draft write retains the latest Thai text and offers explicit selection and copy.", noColorWidths: true, drive: async ui => {
    await writeFile(`${ui.draftStore!.path}.lock`, "uncertain writer", { mode: 0o600 });
    ui.editor.setText("");
    await ui.mockInput.pasteBracketedText("ข้อความใหม่\nยังไม่ส่ง 🧪");
    if (!ui.view.flushDraft().failed) throw new Error("Draft fixture must observe a real save failure");
  }, ready: (_s, ui) => ui.editor.plainText === "ข้อความใหม่\nยังไม่ส่ง 🧪" && ui.captureCharFrame().includes("Draft not saved") },
  { id: "streaming-answer", title: "Streaming answer", description: "An incomplete Markdown answer streams into the transcript.", elapsed: 4000, drive: ui => enter(ui, "Explain the config loader"), ready: s => s.activity?.phase === "streaming" && s.transcript.some(e => e.text.includes("- Then")) },
  { id: "running-search", title: "Search during active work", description: "Search retains the current mode and offers Escape to restore the draft while the turn keeps running.", elapsed: 4000, noColorWidths: true, drive: async ui => {
    await enter(ui, "Explain the config loader");
    await ui.waitFor(s => s.activity?.phase === "streaming" && s.transcript.some(e => e.text.includes("- Then")));
    await ui.mockInput.pasteBracketedText(thai);
    ui.mockInput.pressKey("f", { ctrl: true }); await ui.settle(); await ui.mockInput.typeText("config");
  }, ready: (s, ui) => s.status === "running" && ui.editor.plainText === "config" && ui.editor.placeholder === "Find in this branch…" },
  { id: "running-empty", title: "Running empty composer", description: "An empty composer during work invites an unsent draft and says Enter sends only after the turn.", elapsed: 4000, noColorWidths: true,
    drive: ui => streamingTurn(ui), ready: (s, ui) => s.activity?.phase === "streaming" && ui.editor.plainText === "" && typeof ui.editor.placeholder === "string" && ui.editor.placeholder.startsWith("Draft") },
  { id: "running-draft", title: "Running draft kept", description: "Enter during work keeps the multiline Thai draft unsent and names waiting and stopping.", elapsed: 4000, noColorWidths: true, drive: async ui => {
    await streamingTurn(ui); await ui.mockInput.pasteBracketedText(thai); ui.mockInput.pressEnter();
  }, ready: (s, ui) => s.status === "running" && ui.editor.plainText === thai && s.transcript.at(-1)?.text.startsWith("Still working") === true },
  { id: "parallel-tools", title: "Parallel tools", description: "Three independent tool calls are running together.", elapsed: 7000, drive: ui => enter(ui, "Inspect the project"), ready: s => s.activity?.activeTools === 3 },
  { id: "completed-turn", title: "Completed turn", description: "A completed fix records a file edit and successful command.", noColor: true, drive: ui => enter(ui, "Fix the clamp upper bound"), ready: completed },
  { id: "shell-long-failure", title: "Long command, nonzero exit", description: "A long Unicode command retains its exit warning before its target is clipped.", noColorWidths: true, elapsed: 1200, drive: ui => longFailure(ui), ready: s => s.transcript.some(entry => entry.shellOutcome?.kind === "exit" && entry.shellOutcome.code === 1) },
  { id: "shell-long-failure-expanded", title: "Long command, expanded output", description: "The same nonzero command retains its outcome while its original bounded output is expanded.", noColorWidths: true, elapsed: 1200, drive: ui => longFailure(ui, true), ready: s => s.transcript.some(entry => entry.shellOutcome?.kind === "exit" && entry.shellOutcome.code === 1) },
  { id: "shell-outcomes", title: "Shell exit evidence", description: "Exit codes, cancellation, timeout, unknown evidence and tool errors retain distinct text and glyphs.", noColorWidths: true, rows: 36, elapsed: 1200, drive: async ui => {
    shellRow(ui, "zero", "exit 0", "success", "Exit code: 0\nCommand completed.", { exitCode: 0 });
    shellRow(ui, "seven", "exit 7", "success", "Exit code: 7", { exitCode: 7 });
    shellRow(ui, "signal", "kill -TERM $$", "success", "Process stopped.", { exitCode: null });
    shellRow(ui, "cancel", "sleep 5", "cancelled", "Command cancelled.", { exitCode: null });
    shellRow(ui, "timeout", "sleep 5", "error", "Command timed out.", { timedOut: true, exitCode: null });
    shellRow(ui, "unknown", "run saved command", "success", "Exit code: 0\nall tests passed");
    shellRow(ui, "malformed", "inspect invalid exit details", "success", "Exit code: 0", { exitCode: "0" });
    shellRow(ui, "error", "run unavailable command", "error", "Command could not start.");
  }, ready: s => s.transcript.filter(entry => entry.kind === "tool").length === 8 },
  { id: "web-fetch-rows", title: "Web fetch results", description: "Fetched pages show status, size and time; an HTTP error stays visible and URL tokens stay masked in targets and result text.", noColorWidths: true, elapsed: 1200, drive: async ui => {
    const weather = "https://weather.example.test/th/bangkok/today";
    fetchRow(ui, "fetch-ok", weather, { status: "success", content: `HTTP 200 OK · text/html · 48,213 bytes · ${weather}\n\n# Today in Bangkok\n\nRain is likely after 3 pm.`, details: fetchDetails(weather, 200, 48_213, 420) });
    const article = "https://reader.example.test/article/42";
    fetchRow(ui, "fetch-long", article, { status: "success", content: `HTTP 200 OK · text/html · 87,940 bytes · ${article}\n\nสภาพอากาศวันนี้ 🌧️\n\n[Showing the first 32,512 of 85,904 bytes of text. Full text: /tmp/schway-web-fetch-1.txt. Use read with offset 214 to continue.]`,
      details: fetchDetails(article, 200, 87_940, 1_350, { truncated: true, outputPath: "/tmp/schway-web-fetch-1.txt" }) });
    const denied = "https://api.example.test/forecast?city=Bangkok&access_token=sk-live-4f9a2b7c1d";
    fetchRow(ui, "fetch-401", denied, { status: "error", content: `HTTP 401 Unauthorized · application/json · 58 bytes · ${denied}\n\nThe server returned HTTP 401 Unauthorized.\n\n{"error":"invalid token","docs":"${denied}"}`, details: { ...fetchDetails(denied, 401, 58, 180, { errorKind: "http-status" }), contentType: "application/json" } });
    fetchRow(ui, "fetch-running", "https://maps.example.test/route?from=Siam&to=Asok&api_key=AIzaSyFixture123");
  }, ready: (s, ui) => s.transcript.filter(entry => entry.kind === "tool").length === 4 && !/sk-live|AIzaSy/.test(ui.captureCharFrame()) },
  { id: "web-search-line", title: "Hosted web search", description: "An answer that used hosted web search shows one compact line with its search count; an answer without search shows none.", noColorWidths: true, drive: async ui => {
    searchAnswer(ui, "search-two", "Rain is likely in Bangkok after 3 pm, so leave before 2:30 pm. ฝนตกช่วงบ่าย 🌧️", 2);
    searchAnswer(ui, "search-none", "The route from Siam to Asok takes about 12 minutes by BTS.", 0);
    searchAnswer(ui, "search-one", "The BTS runs until midnight today.", 1);
  }, ready: s => s.transcript.filter(entry => entry.kind === "system" && entry.text.startsWith("Searched the web")).length === 2 && s.transcript.filter(entry => entry.kind === "assistant").length === 3 },
  { id: "large-edit", title: "Large edit", description: "An edit above the inline limit keeps its summary and disclosure marker.", noColor: true, drive: ui => enter(ui, "Update the clamp implementation"), ready: completed },
  { id: "stopped-streaming", title: "Stopped streaming", description: "A requested stop retains incomplete output and an unsent Thai draft with a neutral continuation notice.", noColorWidths: true, drive: ui => stopWork(ui, false), ready: stopped },
  { id: "stopped-tool", title: "Stopped command", description: "A stopped shell keeps the completed file write and offers explicit continuation without sending the next draft.", noColorWidths: true, drive: ui => stopWork(ui, true), ready: stopped },
  { id: "failed-turn", title: "Failed turn", description: "An unavailable service offers recovery after retries.", noColorWidths: true, drive: ui => enter(ui, "Summarize the changes"), ready: failed },
  { id: "details-notice", title: "Notice details", description: "A retained notice opens local diagnostic evidence while preserving the Thai draft.", noColorWidths: true, drive: async ui => {
    ui.controller.notice("Choice used for this session · F2 details", "The choice could not be saved.\nThe project settings file is read-only.\nตรวจสอบสิทธิ์ของไฟล์ 🧪");
    await ui.mockInput.pasteBracketedText("งานถัดไป 🧪"); await ui.settle(); openDetails(ui);
  }, ready: s => s.noticeDetailsAvailable === false && s.transcript.at(-1)?.text.includes("The choice could not be saved.") === true },
  { id: "details-recovery", title: "Recovery details", description: "F2 opens a failed turn's diagnostic evidence while Escape remains available to return.", noColorWidths: true, drive: async ui => {
    // F2 opens details only once the failed turn has released the controller; recovery is recorded just before that.
    await enter(ui, "Summarize the changes"); await ui.waitFor(s => failed(s) && !ui.controller.running); await ui.mockInput.pasteBracketedText("งานถัดไป 🧪"); openDetails(ui);
  }, ready: s => !!s.recovery && s.transcript.at(-1)?.text.includes("Failure details:") === true },
  { id: "details-unavailable", title: "Details unavailable", description: "F2 leaves a fresh composer unchanged when there is no evidence to show.", noColorWidths: true, drive: async ui => {
    await ui.mockInput.pasteBracketedText("งานถัดไป 🧪"); openDetails(ui);
  }, ready: (s, ui) => s.status === "idle" && !s.noticeDetailsAvailable && !s.recovery && !s.outcome && ui.editor.plainText === "งานถัดไป 🧪" && s.transcript.length === 0 },
  { id: "retry-countdown", title: "Retry countdown", description: "A transient failure waits before the next attempt.", elapsed: 1200, drive: ui => enter(ui, "Summarize the changes"), ready: s => s.activity?.phase === "retry" },
  { id: "retry-rate-limit", title: "Rate-limit retry", description: "A rate limit waits for the provider's requested delay before the next attempt.", noColor: true, elapsed: 1200,
    drive: ui => enter(ui, "Summarize the changes"), ready: s => s.activity?.retry?.cause === "rate-limit" },
  { id: "retry-network", title: "Network retry", description: "A lost connection retries after the default backoff.", noColor: true, elapsed: 400,
    drive: ui => enter(ui, "Summarize the changes"), ready: s => s.activity?.retry?.cause === "offline" },
  recoveryScreen("auth", "Access rejected", "A rejected credential offers sign-in, not continuation, and keeps the draft."),
  recoveryScreen("credential-store", "Credential storage locked", "A locked secure store offers to retry credential access after unlocking."),
  recoveryScreen("model", "Model unavailable", "A model the provider no longer serves offers model choice before continuing."),
  recoveryScreen("offline", "Connection unavailable", "A network failure that outlasts its retries offers continuation from saved progress."),
  recoveryScreen("rate-limit", "Usage limit reached", "A rate limit that outlasts its retries asks to wait, then continue."),
  recoveryScreen("session-write", "Progress not saved", "A refused session write blocks this session and leads with a fresh or saved session."),
  startupScreen("auth", "Startup sign-in needed", "A reopened conversation without credentials offers sign-in before any task is sent."),
  startupScreen("credential-store", "Startup credential storage locked", "A reopened conversation that cannot read the secure store offers to retry credential access."),
  startupScreen("model", "Startup model unavailable", "A reopened conversation whose model is gone offers model choice."),
  startupScreen("provider", "Startup connection unavailable", "A reopened conversation whose provider setup failed offers its details."),
  // Render the loading panel before yielding to Git so scrollbar initialization has a fixed order.
  { id: "review-panel", title: "Review panel", description: "The change review displays the completed clamp fix.", noColor: true, drive: async ui => { await enter(ui, "Fix the clamp upper bound"); await ui.waitFor(completed); ui.mockInput.pressKey("r", { meta: true }); await ui.renderOnce(); await ui.flush(); }, ready: s => !!s.changeReview && !s.changeReview.loading && s.changeReview.files.length > 0 && s.changeReview.detail.length > 0 },
  { id: "details-review", title: "Review details", description: "F2 shows the completed turn's tool evidence from the selected file review.", noColorWidths: true, drive: async ui => {
    await enter(ui, "Fix the clamp upper bound"); await ui.waitFor(completed); ui.mockInput.pressKey("r", { meta: true });
    await ui.renderOnce(); await ui.flush(); await ui.waitFor(reviewReady);
    // Redact per-run snapshot identities through the real view before layout, not in captured cells.
    ui.secrets.push(...ui.controller.snapshot().changeReview!.details.matchAll(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g).map(match => match[0]));
    openDetails(ui);
  }, ready: s => reviewReady(s) && s.changeReview!.showingDetails },
  { id: "review-multi-turn", title: "Multi-turn review", description: "The turn 2 file list keeps that turn's count while the current diff also shows the first turn and a later external edit.", noColor: true, drive: async ui => {
    await enter(ui, "Fix the clamp upper bound"); await ui.waitFor(completed);
    await enter(ui, "Add a return type"); await ui.waitFor(s => completed(s) && s.transcript.some(row => row.text.includes("Added the return type.")));
    await writeFile(join(ui.root, "clamp.ts"), `${await readFile(join(ui.root, "clamp.ts"), "utf8")}export default clamp;\n`);
    ui.mockInput.pressKey("r", { meta: true }); await ui.renderOnce(); await ui.flush();
  }, ready: s => reviewReady(s) && s.changeReview!.detail.includes("export default clamp;") },
  { id: "review-staged-unstaged", title: "Staged and unstaged review", description: "The current diff names its unstaged and staged comparisons for a file the turn edited.", noColor: true, drive: async ui => {
    await enter(ui, "Fix the clamp upper bound"); await ui.waitFor(completed);
    const staged = Bun.spawnSync(["git", "add", "clamp.ts"], { cwd: ui.root });
    if (staged.exitCode) throw new Error(staged.stderr.toString());
    await writeFile(join(ui.root, "clamp.ts"), `${await readFile(join(ui.root, "clamp.ts"), "utf8")}export default clamp;\n`);
    ui.mockInput.pressKey("r", { meta: true }); await ui.renderOnce(); await ui.flush();
  }, ready: s => reviewReady(s) && s.changeReview!.rows.filter(row => row.comparison).length === 2 },
  { id: "resumed-review", title: "Resumed review", description: "After resume there is no live turn record, so review lists current Git changes and the selected file's current diff.", noColor: true, drive: openResumedReview,
    ready: s => resumedReady(s) && s.changeReview!.files.length === 2 && s.changeReview!.rows.some(row => row.comparison) },
  { id: "resumed-review-details", title: "Resumed review details", description: "F2 explains that previous turn details are unavailable and names the current workspace and branch.", noColor: true, drive: async ui => {
    await openResumedReview(ui); await ui.waitFor(s => resumedReady(s) && s.changeReview!.files.length === 2); openDetails(ui);
  }, ready: s => resumedReady(s) && s.changeReview!.showingDetails },
  { id: "resumed-review-clean", title: "Resumed review, clean tree", description: "A clean working tree after resume says there are no current changes without implying earlier turns changed nothing.", noColor: true, drive: openResumedReview,
    ready: s => resumedReady(s) && s.changeReview!.rows[0]!.text.startsWith("No current changes") },
  { id: "resumed-review-no-git", title: "Resumed review outside Git", description: "Outside Git, review names why current changes are unavailable and how to go back.", noColor: true, drive: openResumedReview,
    ready: s => resumedReady(s) && s.changeReview!.rows[0]!.text.startsWith("Not a Git workspace") },
  { id: "resumed-review-off", title: "Resumed review, tracking off", description: "With change tracking off, review reads no Git state and names the setting that enables it.", noColor: true, drive: openResumedReview,
    ready: s => resumedReady(s) && s.changeReview!.rows[0]!.text.startsWith("Change tracking is off") },
  { id: "resumed-review-unavailable", title: "Resumed review, workspace missing", description: "A saved workspace removed after resume names the directory to restore and the reload key.", noColor: true, drive: openResumedReview,
    ready: s => resumedReady(s) && s.changeReview!.rows[0]!.text.startsWith("Workspace unavailable") },
  { id: "resumed-review-git-failed", title: "Resumed review, Git failed", description: "When Git cannot read the repository, review shows Git's reason and the reload key instead of calling it non-Git.", noColor: true, drive: openResumedReview,
    ready: s => resumedReady(s) && s.changeReview!.rows[0]!.text.startsWith("Current changes unavailable") },
  { id: "undo-preview", title: "Undo preview", description: "Undo previews file restores, a deletion and a change without saved undo.", drive: async ui => {
    await enter(ui, "Fix the clamp upper bound"); await ui.waitFor(completed);
    await writeFile(join(ui.root, "README.md"), "Changes made afterwards.\n");
    await enter(ui, "/undo");
  }, ready: s => !!s.undoPreview },
  { id: "undo-preview-no-git", title: "Undo without Git", description: "Undo restores file-tool changes when shell detection is unavailable.", drive: async ui => {
    await enter(ui, "Fix the clamp upper bound"); await ui.waitFor(completed); await enter(ui, "/undo");
  }, ready: s => !!s.undoPreview },
  { id: "undo-shell-only", title: "Undo without saved changes", description: "A change without saved undo lists its path read-only with review and close actions.", drive: async ui => {
    await enter(ui, "Generate the output"); await ui.waitFor(completed); await enter(ui, "/undo");
  }, ready: s => s.undoPreview?.readOnlyStatus === "No saved undo for these changes" },
  { id: "undo-shell-only-review", title: "Review from undo", description: "Alt+R from the undo panel shows current diffs for its paths without source badges.", drive: async ui => {
    await enter(ui, "Generate the output"); await ui.waitFor(completed); await enter(ui, "/undo");
    await ui.waitFor(s => !!s.undoPreview); ui.mockInput.pressKey("r", { meta: true }); await ui.renderOnce(); await ui.flush();
  }, ready: s => reviewReady(s) && !!s.changeReview!.fromUndo && s.changeReview!.rows.some(row => row.text === "generated") },
  { id: "undo-older-target", title: "Undo an older turn", description: "Undo names an older target turn and the newer change that stays.", drive: async ui => {
    await enter(ui, "Fix the clamp upper bound"); await ui.waitFor(completed);
    await enter(ui, "Generate the output"); await ui.waitFor(s => completed(s) && s.transcript.some(row => row.text.includes("Generated the output file.")));
    await enter(ui, "/undo");
  }, ready: s => s.undoPreview?.older === true },
  { id: "undo-detection-unavailable", title: "Undo without change detection", description: "Without change detection, undo names the limit and its details action.", noColor: true, drive: async ui => {
    await enter(ui, "Generate the output"); await ui.waitFor(completed); await enter(ui, "/undo");
  }, ready: s => s.transcript.at(-1)?.text === "Change detection unavailable · F2 details" },
  { id: "history-list", title: "Turn history", description: "History lists recorded turns newest first with outcome, counts, duration and task.", noColor: true, drive: async ui => { await historyTurns(ui); await openHistory(ui); },
    ready: s => historyReady("list")(s) && s.history!.total === 3 },
  { id: "history-detail", title: "Turn history detail", description: "A recorded turn shows its observed files, command exits and which turn undo would preview.", noColor: true, drive: async ui => { await historyTurns(ui); await openHistory(ui, 2, true); },
    ready: historyReady("detail", 2) },
  { id: "history-stopped-turn", title: "Stopped turn in history", description: "A stopped turn keeps its completed file write and shows the stopped command.", noColor: true, drive: async ui => { await historyTurns(ui); await openHistory(ui, 0, true); },
    ready: s => historyReady("detail")(s) && s.history!.turns[0]!.outcome === "stopped" },
  { id: "history-undo-note", title: "Undo note in history", description: "History shows the durable undo outcome for a turn whose file edits were undone.", noColor: true, drive: async ui => {
    await historyTurns(ui, 1); await enter(ui, "/undo"); await ui.waitFor(s => !!s.undoPreview); ui.mockInput.pressEnter();
    await ui.waitFor(s => !s.undoPreview && s.transcript.some(row => row.text.startsWith("✓ Undid turn 1"))); await openHistory(ui, 0, true);
  }, ready: s => historyReady("detail")(s) && s.history!.turns[0]!.undo.length === 1 },
  { id: "history-missing-evidence", title: "History without saved details", description: "Turns saved before history was recorded say details are unavailable instead of inventing evidence.", noColor: true, drive: async ui => { await historyTurns(ui, 1); await openHistory(ui, 1); },
    ready: s => historyReady("list", 1)(s) && s.history!.turns.filter(turn => turn.evidence === "missing").length === 2 },
  { id: "history-truncation", title: "Truncated turn history", description: "A turn with more observations than a record keeps shows how many files and commands are listed.", noColor: true, drive: async ui => { await openHistory(ui, 0, true); },
    ready: s => historyReady("detail")(s) && s.history!.turns[0]!.files.truncated },
  { id: "history-timing", title: "Turn timing in history", description: "A turn that recorded timing shows model time, tool time and the cached share below its duration, and each command's run time.", noColor: true,
    drive: async ui => { await openHistory(ui, 0, true); }, ready: s => historyReady("detail")(s) && !!s.history!.turns[0]!.attempts[0]?.telemetry },
  { id: "history-timing-cache-unreported", title: "Turn timing without cache counts", description: "When the provider reported no cached counts, the timing line says the cache was not reported instead of showing a share.", noColor: true,
    drive: async ui => { await openHistory(ui, 0, true); }, ready: s => historyReady("detail")(s) && !!s.history!.turns[0]!.attempts[0]?.telemetry },
  { id: "history-timing-partial", title: "Partly reported turn timing", description: "When only some model calls reported cached counts, the cached share is shown as a lower bound.", noColor: true,
    drive: async ui => { await openHistory(ui, 0, true); }, ready: s => historyReady("detail")(s) && !!s.history!.turns[0]!.attempts[0]?.telemetry },
  { id: "history-timing-details", title: "Turn timing details", description: "F2 details list model calls, first output, retries, tool wall time and token totals with their caveats.", noColor: true,
    drive: async ui => { await openHistory(ui, 0, true); openDetails(ui); await ui.settle(); }, ready: s => historyReady("detail")(s) && s.history!.showingDetails },
  { id: "history-reasoning", title: "Reasoning effort in history", description: "A turn stopped under the provider default and continued at low shows each attempt's recorded effort.", noColor: true,
    drive: async ui => { await openHistory(ui, 0, true); }, ready: s => historyReady("detail")(s) && s.history!.turns[0]!.attempts.length === 2 },
  { id: "history-reasoning-details", title: "Reasoning effort details", description: "F2 details name the level each attempt sent, who chose it, and the model and route.", noColor: true,
    drive: async ui => { await openHistory(ui, 0, true); openDetails(ui); await ui.settle(); }, ready: s => historyReady("detail")(s) && s.history!.showingDetails },
  { id: "history-reasoning-legacy", title: "Reasoning effort not recorded", description: "A turn recorded before reasoning was saved says the effort was not recorded instead of guessing it.", noColor: true,
    drive: async ui => { await openHistory(ui, 0, true); }, ready: s => historyReady("detail")(s) && !s.history!.turns[0]!.attempts[0]?.reasoning },
  { id: "delete-session-busy", title: "Session deletion retry", description: "A busy session deletion names its reason, retry command and details action.", noColor: true, drive: ui => enter(ui, "/delete-session saved-session"), ready: s => s.status === "error" && s.transcript.some(entry => entry.text.startsWith("Cannot delete session: Undo store busy ·")) },
  { id: "session-picker", title: "Session picker", description: "Alt+S then Ctrl+W lists saved sessions from every workspace with relative activity, the current session and an unavailable folder.", noColorWidths: true,
    drive: async ui => { await openSessions(ui); ui.mockInput.pressKey("w", { ctrl: true }); },
    ready: s => !!s.sessionPicker?.allWorkspaces && !s.sessionPicker.loading && s.sessionPicker.total === 6 },
  { id: "session-picker-resume-failed", title: "Session picker, resume failed", description: "Resuming a session whose folder is gone keeps the picker open and names the reason, details and the way back.", noColorWidths: true,
    drive: async ui => {
      await openSessions(ui); ui.mockInput.pressKey("w", { ctrl: true }); await ui.settle();
      ui.mockInput.pressArrow("down"); ui.mockInput.pressArrow("down"); await ui.settle(); ui.mockInput.pressEnter();
    },
    ready: s => s.sessionPicker?.errorKind === "resume" && !s.sessionPicker.resuming },
  { id: "session-picker-empty", title: "Session picker, no saved sessions", description: "A workspace with no saved sessions says so and offers other workspaces or the way back.", noColorWidths: true,
    drive: openSessions, ready: s => !!s.sessionPicker && !s.sessionPicker.loading && !s.sessionPicker.allWorkspaces && s.sessionPicker.total === 0 },
  { id: "session-picker-no-matches", title: "Session picker, no matches", description: "A search that matches no saved session names both ways forward and the way back.", noColorWidths: true,
    drive: async ui => { await openSessions(ui); await ui.mockInput.typeText("zzz"); },
    ready: s => s.sessionPicker?.query === "zzz" && !s.sessionPicker.loading && s.sessionPicker.total === 0 },
  { id: "branch-tree-continue", title: "Branch tree, continue a branch", description: "The branch tree opens on the active branch, ready to continue it or Tab to a new fork.", drive: openBranchTree,
    ready: s => !!s.branchTree?.selectedBranchId && s.branchTree.branches.length === 3 },
  { id: "branch-tree-fork", title: "Branch tree, new fork", description: "Tab in the branch tree switches from continuing a branch to naming a new fork.", drive: async ui => { await openBranchTree(ui); ui.mockInput.pressTab(); },
    ready: s => !!s.branchTree && !s.branchTree.selectedBranchId },
  { id: "recent-work-resume", title: "Recent work resume", description: "A saved conversation is offered for resumption.", drive: async ui => { await ui.controller.offerRecentSession(ui.sessionDirectory!); }, ready: s => !!s.recentSession },
  { id: "compaction", title: "Compaction", description: "Earlier conversation turns are being summarized.", elapsed: 3000, drive: async ui => { void ui.controller.compact(); }, ready: s => s.activity?.phase === "compacting" },
  { id: "compaction-completed", title: "Compaction completed", description: "A finished /compact leaves one result row and no stop action.", drive: ui => enter(ui, "/compact"), ready: compactionSettled(COMPACTION_RESULTS.completed) },
  { id: "compaction-cancelled", title: "Compaction cancelled", description: "Esc during /compact leaves one cancelled result with its retry command.", noColor: true, drive: async ui => {
    await enter(ui, "/compact"); await ui.waitFor(s => s.activity?.phase === "compacting"); ui.mockInput.pressEscape();
  }, ready: compactionSettled(COMPACTION_RESULTS.cancelled) },
  { id: "compaction-failed", title: "Compaction failed", description: "A failed summary keeps history and offers its repair details once.", drive: ui => enter(ui, "/compact"), ready: compactionSettled(COMPACTION_RESULTS.failed) },
  { id: "compaction-noop", title: "Compaction unchanged", description: "With no older turns to summarize, /compact reports one unchanged result.", drive: ui => enter(ui, "/compact"), ready: compactionSettled(COMPACTION_RESULTS.noop) },
  { id: "compaction-in-turn", title: "Compaction inside a turn", description: "Context pressure compacts older turns, and the running turn names the result while it continues.", drive: ui => enter(ui, "Continue the session loader work"),
    ready: s => s.status === "running" && s.activity?.compactionOutcome === "completed" && s.activity.phase === "streaming" && s.transcript.some(entry => entry.kind === "assistant" && entry.text.startsWith("Continuing")) },
  { id: "no-color", title: "No color", description: "Failure recovery remains readable without terminal colors.", drive: ui => enter(ui, "Summarize the changes"), ready: failed },
  { id: "narrow-layout", title: "Narrow layout", description: "A table and code block fit the narrow conversation layout.", drive: ui => enter(ui, "Compare the options"), ready: completed },
  { id: "table-and-code", title: "Table and code wrapping", description: "Wide table cells and long code lines wrap without losing their text.", rows: 40, noColorWidths: true, drive: ui => enter(ui, "Show wrapping"), ready: completed },
  { id: "inspection-unfocused", title: "Code before inspection", description: "Visible code headers offer inspection while the original draft remains active.", noColorWidths: true, drive: ui => inspection(ui, "none"), ready: (_s, ui) => ui.editor.focused && ui.captureCharFrame().includes("Alt+I inspect") },
  { id: "inspection-code", title: "Inspect a visible code block", description: "Inspection highlights a later visible block before an explicit copy and leaves neighboring headers unchanged.", noColorWidths: true, drive: ui => inspection(ui, "code"), ready: (_s, ui) => !ui.editor.focused && ui.captureCharFrame().includes("› ts") },
  { id: "inspection-tool", title: "Inspect an expanded result", description: "Tab selects a tool result and Enter expands it without copying or changing the draft.", noColorWidths: true, drive: ui => inspection(ui, "tool"), ready: (_s, ui) => !ui.editor.focused && ui.captureCharFrame().includes("Second result line") },
  { id: "reader-code", title: "Read code, horizontal clipping", description: "The reader pans unwrapped code and marks clipped edges without changing the draft.", noColorWidths: true, drive: ui => reader(ui, "code"), ready: (_s, ui) => reading(ui, "Col ") },
  { id: "reader-code-wrapped", title: "Read code, wrapped", description: "W wraps long code lines in the reader while line numbers keep each source line.", noColorWidths: true, drive: ui => reader(ui, "wrapped"), ready: (_s, ui) => reading(ui, "W unwrap") || reading(ui, "Read code") && ui.renderer.width < 60 },
  { id: "reader-table", title: "Read table, pinned headers", description: "A wide table keeps its header and column position visible while scrolled down and right.", noColorWidths: true, drive: ui => reader(ui, "table"), ready: (_s, ui) => reading(ui, "Read table") && reading(ui, "‹") },
  { id: "reader-no-matches", title: "Read code, no matches", description: "Reader search reports no matches and offers to restore the reading position.", noColorWidths: true, drive: ui => reader(ui, "search"), ready: (_s, ui) => reading(ui, "No matches") },
  { id: "reader-approval", title: "Read code, approval waiting", description: "A deferred tool approval stays pending while the reader names the action that reviews it.", noColorWidths: true, drive: ui => reader(ui, "approval"), ready: (s, ui) => !!s.toolApproval && !s.toolApproval.loading && reading(ui, "Esc back to request") },
];
/** Screens that show the subscription sign-in wait panel. */
export const SIGN_IN_WAIT_SCREENS = ["subscription-sign-in", "chatgpt-device-approval", "grok-browser-approval", "grok-device-approval"];
/** Enumerate six standard variants and the screen's explicit color or narrow extras. */
export function variantsFor(screen: Screen): Variant[] {
  const make = (theme: "dark" | "light", cols: number, rows = screen.rows ?? 30, noColor = screen.id === "no-color"): Variant => ({ id: `${noColor ? "nocolor-" : ""}${theme}-${cols}${rows === 8 && cols !== 24 ? "x8" : ""}`, theme, cols, rows, noColor });
  const variants = (["dark", "light"] as const).flatMap(theme => [120, 80, 50].map(cols => make(theme, cols)));
  if (screen.id === "first-run" || screen.noColorWidths) variants.push(...[120, 80, 50].map(cols => make("dark", cols, screen.rows ?? 30, true)));
  if (screen.noColor) variants.push(make("dark", 80, screen.rows ?? 30, true));
  if (screen.id === "narrow-layout") variants.push(make("dark", 40, 20), make("light", 40, 20));
  // Sign-in wait, timeout and browser-launch screens check Esc and the device steps at 40 columns and without color;
  // wait screens add a short terminal where the compact status bar names Esc instead of the hidden hint row.
  if (SIGN_IN_WAIT_SCREENS.includes(screen.id) || ["sign-in-browser-not-opened", "sign-in-timeout"].includes(screen.id)) variants.push(make("dark", 40), make("light", 40), make("dark", 40, 30, true), make("dark", 80, 30, true));
  if (SIGN_IN_WAIT_SCREENS.includes(screen.id)) variants.push(make("dark", 40, 8));
  if (screen.id.startsWith("history-")) variants.push(make("dark", 40, 20), make("light", 40, 20), make("dark", 40, 20, true));
  // Undo panels at 40 columns keep diff continuations under their gutter and the Esc exit the 50-column hint shows (#307).
  if (["undo-preview", "undo-older-target", "undo-shell-only"].includes(screen.id)) variants.push(make("dark", 40), make("light", 40), make("dark", 40, 30, true));
  if (screen.id === "review-multi-turn" || screen.id.startsWith("resumed-review")) variants.push(make("dark", 40, 20), make("light", 40, 20), make("dark", 40, 20, true));
  if (screen.id.startsWith("stopped-") || screen.id === "failed-turn" || screen.id.startsWith("details-")) variants.push(make("dark", 40, 20), make("light", 40, 20), make("dark", 40, 20, true));
  // Turn and startup recovery screens share the failed turn's narrow variants (#306).
  if (screen.id.startsWith("recovery-") || screen.id.startsWith("startup-")) variants.push(make("dark", 40, 20), make("light", 40, 20), make("dark", 40, 20, true));
  if (screen.id.startsWith("draft-") || screen.id.startsWith("shell-") || screen.id.startsWith("inspection-")) variants.push(make("dark", 40), make("light", 40), make("dark", 40, screen.rows ?? 30, true));
  if (screen.id.startsWith("web-fetch-")) variants.push(make("dark", 40), make("light", 40), make("dark", 40, screen.rows ?? 30, true));
  if (screen.id === "web-search-line") variants.push(make("dark", 40), make("light", 40), make("dark", 40, screen.rows ?? 30, true));
  // Palettes and the sign-in chooser need a width where hint rows drop segments, showing what survives the cut.
  if (screen.id.startsWith("command-palette") || screen.id.startsWith("help-palette") || screen.id === "sign-in-chooser") variants.push(make("dark", 40), make("light", 40), make("dark", 40, screen.rows ?? 30, true));
  // Session picker and branch tree panels need 40-column variants so the narrow Esc invariant covers them.
  if (screen.id.startsWith("session-picker") || screen.id.startsWith("branch-tree-")) variants.push(make("dark", 40, 20), make("light", 40, 20), make("dark", 40, 20, true));
  if (screen.id.startsWith("reader-")) variants.push(make("dark", 40), make("light", 40), make("dark", 40, screen.rows ?? 30, true), make("dark", 40, 8), make("light", 40, 8));
  if (["first-run", "disconnected-search", "sign-in-chooser", "auto-mode", "ask-mode", "read-only-mode", "running-search", "running-empty", "running-draft"].includes(screen.id) || screen.id.startsWith("read-only-search-") || screen.id.startsWith("draft-")) variants.push(
    make("dark", 24, 8), make("light", 24, 8), make("dark", 24, 8, true));
  if (["details-notice", "details-recovery", "details-unavailable"].includes(screen.id)) variants.push(make("dark", 24, 8), make("light", 24, 8), make("dark", 24, 8, true));
  const shortWidths = screen.id.startsWith("draft-") || screen.id.startsWith("read-only-search-") || ["disconnected-search", "sign-in-chooser", "running-search"].includes(screen.id) ? [29, 30, 40, 50]
    : ["first-run", "auto-mode", "ask-mode", "read-only-mode", "streaming-answer", "approval-command", "approval-edit", "approval-diff-overflow", "running-empty", "running-draft"].includes(screen.id) ? [40, 50]
    : screen.id === "approval-deny-reason" ? [40] : [];
  // Running drafts also need a narrow width that still shows the key-hint row.
  if (["running-empty", "running-draft"].includes(screen.id)) variants.push(make("dark", 30, 20), make("light", 30, 20), make("dark", 30, 20, true));
  for (const cols of shortWidths) variants.push(make("dark", cols, 8), make("light", cols, 8), make("dark", cols, 8, true));
  return variants;
}
