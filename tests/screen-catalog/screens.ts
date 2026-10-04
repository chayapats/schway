import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TuiSnapshot } from "../../src/tui/controller.ts";
import type { ScreenHarness } from "./harness.ts";

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
  ui.controller.applyEvent({ type: "tool.finished", toolCallId: id, name: "bash", status, content, details });
  ui.session.append({ type: "tool_result", id: `result-${id}`, toolCallId: id, content, isError: status !== "success" });
};
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
const openDetails = (ui: ScreenHarness) => ui.mockInput.pressKey("\u001bOQ");
const reviewReady = (s: TuiSnapshot) => !!s.changeReview && !s.changeReview.loading && s.changeReview.files.length > 0 && s.changeReview.detail.length > 0;
const resumedReady = (s: TuiSnapshot) => s.changeReview?.scope?.kind === "workspace" && !s.changeReview.loading && s.changeReview.rows.length > 0 && !s.changeReview.rows.some(row => row.text.startsWith("Loading current"));
const openResumedReview = async (ui: ScreenHarness) => { ui.mockInput.pressKey("r", { meta: true }); await ui.renderOnce(); await ui.flush(); };
const helpPalette = async (ui: ScreenHarness, query: string, moves = 0, guide = false) => {
  ui.mockInput.pressKey("h", { meta: true }); await ui.settle();
  if (query) await ui.mockInput.typeText(query);
  await ui.settle();
  for (let move = 0; move < moves; move++) { ui.mockInput.pressArrow("down"); await ui.settle(); }
  if (guide) ui.mockInput.pressEnter();
};
const helpReady = (ui: ScreenHarness, query: string) => ui.controller.commandHelpOpen && ui.editor.plainText === query;
/** Ordered design catalog; additions deliberately update the index and its assertion. */
export const SCREENS: readonly Screen[] = [
  { id: "first-run", title: "First run, not connected", description: "A fresh installation waits for a connection.", drive: async () => {}, ready: s => s.modelId === "" && s.readiness !== "loading" },
  { id: "disconnected-search", title: "Search before connecting", description: "A disconnected conversation retains its mode and search restore action.", noColorWidths: true, drive: ui => search(ui, "README"), ready: (s, ui) => s.readiness === "not-connected" && s.approvalMode === "read-only" && ui.editor.plainText === "README" },
  { id: "auto-mode", title: "Auto mode", description: "An idle conversation shows the default Auto mode and its change-mode hint.", noColorWidths: true, drive: async () => {}, ready: s => s.approvalMode === "auto" && s.readiness === "ready" },
  { id: "read-only-mode", title: "Read-only mode", description: "An idle conversation shows the read-only approval chip and mode hint.", noColor: true, drive: async ui => { ui.mockInput.pressTab({ shift: true }); ui.mockInput.pressTab({ shift: true }); }, ready: s => s.approvalMode === "read-only" },
  { id: "ask-mode", title: "Ask mode", description: "An idle conversation shows the ask approval chip and mode hint.", noColor: true, drive: async ui => { ui.mockInput.pressTab({ shift: true }); }, ready: s => s.approvalMode === "ask" },
  { id: "approval-modes-help", title: "Approval mode meanings", description: "Preferences explain the three modes without changing the current mode.", noColor: true, drive: async ui => { ui.mockInput.pressKey("p", { meta: true }); await ui.settle(); ui.mockInput.pressKey("pagedown"); }, ready: s => !!s.preferences && s.approvalMode === "auto" },
  { id: "read-only-search-empty", title: "Read-only search, empty query", description: "An empty search retains the mode and Escape action at safety widths.", noColor: true, drive: ui => search(ui, ""), ready: (s, ui) => s.approvalMode === "read-only" && ui.editor.placeholder === "Find in this conversation…" },
  { id: "read-only-search-matches", title: "Read-only search, matching query", description: "A matching query retains the mode and Escape action at safety widths.", noColor: true, drive: ui => search(ui, "README"), ready: (s, ui) => s.approvalMode === "read-only" && ui.editor.plainText === "README" },
  { id: "read-only-search-no-matches", title: "Read-only search, no matches", description: "An unmatched query retains the mode and Escape action at safety widths.", noColor: true, drive: ui => search(ui, "absent"), ready: (s, ui) => s.approvalMode === "read-only" && ui.editor.plainText === "absent" },
  { id: "approval-command", title: "Approve a command", description: "A mutating command waits for an interactive approval choice.", noColor: true, drive: ui => enter(ui, "Test the clamp fix"), ready: s => s.toolApproval?.content === "bun test --filter clamp" },
  { id: "approval-edit", title: "Approve an edit", description: "The exact clamp replacement is previewed before approval.", noColor: true, drive: ui => enter(ui, "Fix the clamp upper bound"), ready: s => !!s.toolApproval?.diff },
  { id: "sign-in-chooser", title: "Sign-in chooser", description: "The connection chooser groups subscriptions, API keys and a custom endpoint.", noColorWidths: true, drive: async ui => { ui.mockInput.pressKey("l", { meta: true }); }, ready: s => !!s.loginChooser },
  { id: "chatgpt-more-options", title: "ChatGPT more options", description: "Device approval and a pasted callback are alternate ChatGPT methods.", noColorWidths: true, drive: async ui => { ui.mockInput.pressKey("l", { meta: true }); await ui.settle(); ui.mockInput.pressTab(); }, ready: s => s.loginChooser?.level === "chatgpt" },
  { id: "grok-more-options", title: "Grok more options", description: "Device code is the alternate Grok method.", noColorWidths: true, drive: async ui => { ui.mockInput.pressKey("l", { meta: true }); await ui.settle(); while (ui.controller.snapshot().loginChooser?.selectedId !== "grok") ui.mockInput.pressArrow("down"); ui.mockInput.pressTab(); }, ready: s => s.loginChooser?.level === "grok" },
  { id: "endpoint-url-empty", title: "Endpoint URL", description: "A custom endpoint starts with an ephemeral, unmasked URL field.", noColorWidths: true, drive: async ui => { ui.mockInput.pressKey("l", { meta: true }); await ui.settle(); while (ui.controller.snapshot().loginChooser?.selectedId !== "compatible") ui.mockInput.pressArrow("down"); ui.mockInput.pressEnter(); }, ready: s => !!s.endpointUrlEntry && !s.endpointUrlEntry.value },
  { id: "endpoint-url-error", title: "Endpoint URL validation", description: "A malformed URL stays in the field with a corrective action.", noColorWidths: true, drive: async ui => { ui.mockInput.pressKey("l", { meta: true }); await ui.settle(); while (ui.controller.snapshot().loginChooser?.selectedId !== "compatible") ui.mockInput.pressArrow("down"); ui.mockInput.pressEnter(); await ui.settle(); await ui.mockInput.typeText("localhost:8787"); ui.mockInput.pressEnter(); }, ready: s => !!s.endpointUrlEntry?.error },
  { id: "subscription-sign-in", title: "Subscription sign-in", description: "Browser sign-in is waiting for authorization.", drive: async ui => { ui.mockInput.pressKey("l", { meta: true }); await ui.settle(); ui.mockInput.pressEnter(); }, ready: (s, ui) => s.status === "running" && ui.loginCalled() },
  { id: "grok-browser-approval", title: "Grok browser approval", description: "Grok subscription sign-in waits for browser approval.", drive: ui => grokLogin(ui), ready: s => s.status === "running" && s.loginApprovalData?.kind === "browser" },
  { id: "grok-device-approval", title: "Grok device approval", description: "The ephemeral Grok device code remains in the approval panel.", drive: ui => grokLogin(ui, true), ready: s => s.status === "running" && s.loginApprovalData?.kind === "device" },
  { id: "grok-plan-error", title: "Grok plan restriction", description: "A plan restriction retains the saved login and offers another connection.", drive: ui => grokLogin(ui), ready: s => s.status === "error" && s.transcript.some(entry => entry.text.includes("Your Grok plan doesn't include API access")) },
  { id: "model-picker", title: "Model picker", description: "A short connected list shows readable model names and access routes.", noColorWidths: true, drive: async ui => { ui.mockInput.pressKey("m", { meta: true }); }, ready: s => !!s.modelPicker && !s.modelPicker.loading },
  { id: "details-model", title: "Model details", description: "F2 reveals the selected model's exact ID and capacity without changing the connection.", noColorWidths: true, drive: async ui => {
    ui.mockInput.pressKey("m", { meta: true }); await ui.waitFor(s => !!s.modelPicker && !s.modelPicker.loading); openDetails(ui);
  }, ready: s => s.modelPicker?.details === true },
  { id: "model-picker-unconnected", title: "Model picker, connect a provider", description: "An empty model list offers one action to connect a provider.", noColorWidths: true, drive: async ui => { ui.mockInput.pressKey("m", { meta: true }); }, ready: s => !!s.modelPicker && !s.modelPicker.loading },
  { id: "thinking-controls", title: "Thinking controls", description: "Basic preferences show ordinary settings and supported thinking choices.", noColorWidths: true, drive: async ui => { ui.controller.openPreferences(); ui.controller.movePreference(1); }, ready: s => !!s.preferences },
  { id: "command-palette", title: "Command palette", description: "Typing a slash opens the curated built-in order.", noColorWidths: true, drive: async ui => { await ui.controller.refreshCommands(); await ui.mockInput.typeText("/"); }, ready: (s, ui) => s.status === "idle" && ui.editor.plainText === "/" && ui.controller.commandChoices("/").length > 0 && !!ui.renderer.root.findDescendantById("picker")?.visible },
  { id: "command-palette-groups", title: "Command palette groups", description: "Skills and extension owners precede the final destructive command.", noColorWidths: true, drive: async ui => { await ui.controller.refreshCommands(); await ui.mockInput.typeText("/"); await ui.settle(); ui.mockInput.pressArrow("up"); }, ready: (s, ui) => s.status === "idle" && ui.editor.plainText === "/" && ui.captureCharFrame().includes("Extensions") },
  { id: "command-palette-query", title: "Command palette search", description: "A typed query ranks matching names without group headers.", noColorWidths: true, drive: async ui => { await ui.controller.refreshCommands(); await ui.mockInput.typeText("/ses"); }, ready: (s, ui) => s.status === "idle" && ui.editor.plainText === "/ses" && !!ui.renderer.root.findDescendantById("picker")?.visible },
  { id: "help-palette-actions", title: "Help action results", description: "A help search for review lists keyboard guidance beside matching commands without changing the draft.", noColorWidths: true, drive: ui => helpPalette(ui, "review"), ready: (_s, ui) => helpReady(ui, "review") && ui.captureCharFrame().includes("Enter show keys") },
  { id: "help-palette-disabled", title: "Help disabled actions", description: "Unavailable keyboard actions stay searchable and the selected one names its reason.", noColorWidths: true, drive: ui => helpPalette(ui, "ctrl", 2), ready: (_s, ui) => helpReady(ui, "ctrl") && ui.captureCharFrame().includes("! No details to show · Esc back") },
  { id: "help-palette-guidance", title: "Help keyboard guidance", description: "Enter on a keyboard action shows its exact keys and prerequisites without performing it.", noColorWidths: true, drive: ui => helpPalette(ui, "copy", 0, true), ready: (_s, ui) => helpReady(ui, "copy") && ui.captureCharFrame().includes("Copy code or a result · Alt+I, then C") },
  { id: "help-palette-no-matches", title: "Help without matches", description: "An unmatched help search offers clearing the search or returning to the draft.", noColorWidths: true, drive: ui => helpPalette(ui, "zzqx"), ready: (_s, ui) => helpReady(ui, "zzqx") && ui.captureCharFrame().includes("No matches · Clear search or Esc back") },
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
  }, ready: (s, ui) => s.status === "running" && ui.editor.plainText === "config" && ui.editor.placeholder === "Find in this conversation…" },
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
  { id: "large-edit", title: "Large edit", description: "An edit above the inline limit keeps its summary and disclosure marker.", noColor: true, drive: ui => enter(ui, "Update the clamp implementation"), ready: completed },
  { id: "stopped-streaming", title: "Stopped streaming", description: "A requested stop retains incomplete output and an unsent Thai draft with a neutral continuation notice.", noColorWidths: true, drive: ui => stopWork(ui, false), ready: stopped },
  { id: "stopped-tool", title: "Stopped command", description: "A stopped shell keeps the completed file write and offers explicit continuation without sending the next draft.", noColorWidths: true, drive: ui => stopWork(ui, true), ready: stopped },
  { id: "failed-turn", title: "Failed turn", description: "An unavailable service offers recovery after retries.", noColorWidths: true, drive: ui => enter(ui, "Summarize the changes"), ready: failed },
  { id: "details-notice", title: "Notice details", description: "A retained notice opens local diagnostic evidence while preserving the Thai draft.", noColorWidths: true, drive: async ui => {
    ui.controller.notice("Choice used for this session · F2 details", "The choice could not be saved.\nThe project settings file is read-only.\nตรวจสอบสิทธิ์ของไฟล์ 🧪");
    await ui.mockInput.pasteBracketedText("งานถัดไป 🧪"); await ui.settle(); openDetails(ui);
  }, ready: s => s.noticeDetailsAvailable === false && s.transcript.at(-1)?.text.includes("The choice could not be saved.") === true },
  { id: "details-recovery", title: "Recovery details", description: "F2 opens a failed turn's diagnostic evidence while Escape remains available to return.", noColorWidths: true, drive: async ui => {
    await enter(ui, "Summarize the changes"); await ui.waitFor(failed); await ui.mockInput.pasteBracketedText("งานถัดไป 🧪"); openDetails(ui);
  }, ready: s => !!s.recovery && s.transcript.at(-1)?.text.includes("Failure details:") === true },
  { id: "details-unavailable", title: "Details unavailable", description: "F2 leaves a fresh composer unchanged when there is no evidence to show.", noColorWidths: true, drive: async ui => {
    await ui.mockInput.pasteBracketedText("งานถัดไป 🧪"); openDetails(ui);
  }, ready: (s, ui) => s.status === "idle" && !s.noticeDetailsAvailable && !s.recovery && !s.outcome && ui.editor.plainText === "งานถัดไป 🧪" && s.transcript.length === 0 },
  { id: "retry-countdown", title: "Retry countdown", description: "A transient failure waits before the next attempt.", elapsed: 1200, drive: ui => enter(ui, "Summarize the changes"), ready: s => s.activity?.phase === "retry" },
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
  { id: "delete-session-busy", title: "Session deletion retry", description: "A busy session deletion names its reason, retry command and details action.", noColor: true, drive: ui => enter(ui, "/delete-session saved-session"), ready: s => s.status === "error" && s.transcript.some(entry => entry.text.startsWith("Cannot delete session: Undo store busy ·")) },
  { id: "recent-work-resume", title: "Recent work resume", description: "A saved conversation is offered for resumption.", drive: async ui => { await ui.controller.offerRecentSession(ui.sessionDirectory!); }, ready: s => !!s.recentSession },
  { id: "compaction", title: "Compaction", description: "Earlier conversation turns are being summarized.", elapsed: 3000, drive: async ui => { void ui.controller.compact(); }, ready: s => s.activity?.phase === "compacting" },
  { id: "no-color", title: "No color", description: "Failure recovery remains readable without terminal colors.", drive: ui => enter(ui, "Summarize the changes"), ready: failed },
  { id: "narrow-layout", title: "Narrow layout", description: "A table and code block fit the narrow conversation layout.", drive: ui => enter(ui, "Compare the options"), ready: completed },
  { id: "table-and-code", title: "Table and code wrapping", description: "Wide table cells and long code lines wrap without losing their text.", rows: 40, noColorWidths: true, drive: ui => enter(ui, "Show wrapping"), ready: completed },
  { id: "inspection-unfocused", title: "Code before inspection", description: "Visible code headers offer inspection while the original draft remains active.", noColorWidths: true, drive: ui => inspection(ui, "none"), ready: (_s, ui) => ui.editor.focused && ui.captureCharFrame().includes("Alt+I inspect") },
  { id: "inspection-code", title: "Inspect a visible code block", description: "Inspection highlights a later visible block before an explicit copy and leaves neighboring headers unchanged.", noColorWidths: true, drive: ui => inspection(ui, "code"), ready: (_s, ui) => !ui.editor.focused && ui.captureCharFrame().includes("› ts") },
  { id: "inspection-tool", title: "Inspect an expanded result", description: "Tab selects a tool result and Enter expands it without copying or changing the draft.", noColorWidths: true, drive: ui => inspection(ui, "tool"), ready: (_s, ui) => !ui.editor.focused && ui.captureCharFrame().includes("Second result line") },
];
/** Enumerate six standard variants and the screen's explicit color or narrow extras. */
export function variantsFor(screen: Screen): Variant[] {
  const make = (theme: "dark" | "light", cols: number, rows = screen.rows ?? 30, noColor = screen.id === "no-color"): Variant => ({ id: `${noColor ? "nocolor-" : ""}${theme}-${cols}${rows === 8 && cols !== 24 ? "x8" : ""}`, theme, cols, rows, noColor });
  const variants = (["dark", "light"] as const).flatMap(theme => [120, 80, 50].map(cols => make(theme, cols)));
  if (screen.id === "first-run" || screen.noColorWidths) variants.push(...[120, 80, 50].map(cols => make("dark", cols, screen.rows ?? 30, true)));
  if (screen.noColor) variants.push(make("dark", 80, screen.rows ?? 30, true));
  if (screen.id === "narrow-layout") variants.push(make("dark", 40, 20), make("light", 40, 20));
  if (screen.id === "review-multi-turn" || screen.id.startsWith("resumed-review")) variants.push(make("dark", 40, 20), make("light", 40, 20), make("dark", 40, 20, true));
  if (screen.id.startsWith("stopped-") || screen.id === "failed-turn" || screen.id.startsWith("details-")) variants.push(make("dark", 40, 20), make("light", 40, 20), make("dark", 40, 20, true));
  if (screen.id.startsWith("draft-") || screen.id.startsWith("shell-") || screen.id.startsWith("inspection-")) variants.push(make("dark", 40), make("light", 40), make("dark", 40, screen.rows ?? 30, true));
  if (["first-run", "disconnected-search", "sign-in-chooser", "auto-mode", "ask-mode", "read-only-mode", "running-search"].includes(screen.id) || screen.id.startsWith("read-only-search-") || screen.id.startsWith("draft-")) variants.push(
    make("dark", 24, 8), make("light", 24, 8), make("dark", 24, 8, true));
  if (["details-notice", "details-recovery", "details-unavailable"].includes(screen.id)) variants.push(make("dark", 24, 8), make("light", 24, 8), make("dark", 24, 8, true));
  const shortWidths = screen.id.startsWith("draft-") || screen.id.startsWith("read-only-search-") || ["disconnected-search", "sign-in-chooser", "running-search"].includes(screen.id) ? [29, 30, 40, 50]
    : ["first-run", "auto-mode", "ask-mode", "read-only-mode", "streaming-answer", "approval-command"].includes(screen.id) ? [40, 50] : [];
  for (const cols of shortWidths) variants.push(make("dark", cols, 8), make("light", cols, 8), make("dark", cols, 8, true));
  return variants;
}
