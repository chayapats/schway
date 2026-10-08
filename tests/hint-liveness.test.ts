// Every advertised key chip must act under kitty and legacy key encodings (#305). See docs/screen-catalog.md "Key chip liveness".
import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { RGBA, type CapturedFrame, type TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TuiSnapshot } from "../src/tui/controller.ts";
import { serializeScreen } from "./screen-catalog/format.ts";
import { buildScreen, type ScreenHarness } from "./screen-catalog/harness.ts";
import { SCREENS, variantsFor, type Screen, type Variant } from "./screen-catalog/screens.ts";
import { CHIP_ENCODINGS, chipPresses, discoverChips, FAILURE_NOTICES, legacyCollision, UnknownChipError, type ChipAllowEntry, type ChipEncoding, type DiscoveredChip } from "./helpers/chip-liveness.ts";

const FIXED_TIME = "2026-01-15T09:30:00.000Z";
/** Draft typed before pressing a `send` chip on an empty composer; Thai and emoji prove the whole draft is dispatched. */
const SEND_DRAFT = "ส่งงานนี้ต่อ 🧪";
/** Longest wait for a press to show an effect; a press that changes nothing costs this once. */
const EFFECT_WINDOW_MS = 300;
/** Screens probed at once; each owns its renderer and temporary files. */
const CONCURRENCY = 4;
const update = process.env.SCHWAY_UPDATE_SCREENS === "1";
const inventoryPath = join(import.meta.dir, "screen-catalog/chip-inventory.txt");

/** The themed variant probed for one screen: its dark 80-column color variant, else its first variant (`nocolor-dark-120` for `no-color`). */
function probedVariant(screen: Screen): Variant {
  const variants = variantsFor(screen);
  return variants.find(variant => variant.id === "dark-80") ?? variants[0]!;
}

let originalFetch: typeof fetch;
const gitEnvironment = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"] as const;
const originalGitEnvironment = new Map<string, string | undefined>();
beforeAll(() => {
  for (const key of gitEnvironment) { originalGitEnvironment.set(key, process.env[key]); process.env[key] = "/dev/null"; }
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(() => { throw new Error("hint liveness must not use the network"); }, { preconnect: originalFetch.preconnect }) as typeof fetch;
  setSystemTime(new Date(FIXED_TIME));
});
afterAll(() => {
  globalThis.fetch = originalFetch; setSystemTime();
  for (const key of gitEnvironment) { const value = originalGitEnvironment.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

/** Calls the liveness test counts as a chip acting even when nothing on screen changes. */
interface Spies { clipboard: number; urls: number; submits: string[]; reloads: number }
interface Reached { ui: ScreenHarness; spies: Spies }

/**
 * Build the screen in one encoding the way the app runs (Ctrl+C reaches the view, offline settings staging), drive it
 * and wait for its ready state. A drive that times out under load gets one more try from a fresh build.
 */
async function reach(screen: Screen, variant: Variant, encoding: ChipEncoding): Promise<Reached> {
  try { return await reachOnce(screen, variant, encoding); }
  catch (error) {
    if (!(error instanceof Error && error.message.startsWith(`Screen ${screen.id} timed out`))) throw error;
    return reachOnce(screen, variant, encoding);
  }
}
async function reachOnce(screen: Screen, variant: Variant, encoding: ChipEncoding): Promise<Reached> {
  const spies: Spies = { clipboard: 0, urls: 0, submits: [], reloads: 0 };
  const ui = await buildScreen(screen, variant, { encoding, exitOnCtrlC: false, exitSignals: [], offlineStageSettings: true,
    onOpenUrl: () => { spies.urls++; }, onSubmit: value => { spies.submits.push(value); } });
  try {
    await screen.drive(ui); await ui.waitFor(snapshot => screen.ready(snapshot, ui)); ui.advance(); await ui.settle();
    // A settled turn may still hold the controller for a moment after its outcome shows; keys pressed then are ignored.
    if (ui.controller.snapshot().status !== "running") { await Promise.race([ui.controller.waitForIdle(), Bun.sleep(1000)]); await ui.settle(); }
    if (!screen.ready(ui.controller.snapshot(), ui)) throw new Error(`Screen ${screen.id} left its ready state before probing`);
    ui.renderer.copyToClipboardOSC52 = () => { spies.clipboard++; return true; };
    // Reload rereads Git; an identical diff shows nothing new, so the request itself is the evidence.
    const reload = ui.controller.refreshChangeReview.bind(ui.controller);
    ui.controller.refreshChangeReview = (...args: Parameters<typeof reload>) => { spies.reloads++; return reload(...args); };
    return { ui, spies };
  } catch (error) { await ui.dispose(); throw error; }
}

const failureNotice = (text: string) => FAILURE_NOTICES.some(notice => notice.test(text));
/**
 * True when the controller snapshot changed for a reason other than failure notices: transcript rows that are failure
 * notices are ignored, and so is the error status when every row added since `before` is one (`fail("Unknown command …")`).
 */
function snapshotChanged(before: TuiSnapshot, after: TuiSnapshot): boolean {
  const known = new Set(before.transcript.map(entry => entry.id));
  const added = after.transcript.filter(entry => !known.has(entry.id));
  const noticeStatus = added.length > 0 && added.every(entry => failureNotice(entry.text)) && after.status === "error";
  const key = (snapshot: TuiSnapshot, status: string) => JSON.stringify({ ...snapshot, transcript: snapshot.transcript.filter(entry => !failureNotice(entry.text)), status });
  return key(before, before.status) !== key(after, noticeStatus ? before.status : after.status);
}
interface Observation { state: TuiSnapshot; status: string; screen: string; text: string[]; editor: string; cursor: number; spies: Spies }
function observe({ ui, spies }: Reached): Observation {
  const frame = ui.captureSpans(), snapshot = ui.controller.snapshot();
  return { state: JSON.parse(JSON.stringify(snapshot)) as TuiSnapshot, status: snapshot.status, screen: serializeScreen(frame, { screen: "", title: "", description: "", variant: "", cursor: ui.renderer.getCursorState() }),
    text: frame.lines.map(line => line.spans.map(span => span.text).join("")),
    editor: ui.editor.plainText, cursor: ui.editor.cursorOffset, spies: { ...spies, submits: [...spies.submits] } };
}
/** A row that leads with a failure notice, after gutter and status glyphs; a palette row that ends with a reason does not. */
const noticeRow = (text: string) => { const body = text.replace(/^[\s▌│┃›!•✗◌]+/, ""); return FAILURE_NOTICES.some(notice => notice.exec(body)?.index === 0); };
/** The first failure notice row the press added, or undefined when it added none. */
function newNotice(before: Observation, after: Observation): string | undefined {
  const old = new Set(before.text.filter(noticeRow).map(text => text.trim()));
  return after.text.filter(noticeRow).map(text => text.trim()).find(text => !old.has(text));
}
/** Same observation twice across a few renders: background work (Git reads, lazy panels) has finished before a press. */
async function quiet(reached: Reached): Promise<Observation> {
  const same = (a: Observation, b: Observation) => a.screen === b.screen && !snapshotChanged(a.state, b.state) && a.editor === b.editor && a.cursor === b.cursor;
  let previous = observe(reached);
  for (const start = performance.now(); performance.now() - start < 2000;) {
    await reached.ui.settle(); await Bun.sleep(5); await reached.ui.settle();
    const current = observe(reached);
    if (same(previous, current)) return current;
    previous = current;
  }
  throw new Error("The state kept changing without a key press; a press cannot be judged");
}

/** Zero-based rows of the visible hint row. */
function hintRows(ui: ScreenHarness): number[] {
  const hints = ui.renderer.root.findDescendantById("hints") as TextRenderable | undefined;
  if (!hints?.visible || !hints.plainText.trim()) return [];
  return Array.from({ length: hints.height }, (_, index) => hints.screenY + index);
}

/** What one chip did after a press in one encoding. */
type Verdict = "live" | "dead" | "notice" | "indistinct" | "unknown";
interface ChipResult { chip: DiscoveredChip; verdict: Verdict; detail: string }
interface ScreenResult { screen: string; variant: string; encoding: ChipEncoding; chips: ChipResult[]; ms: number }

/** Precondition and evidence for one key: `send` needs a draft and a dispatch, `reload` needs the reload request. */
type Expectation = "any" | "send" | "reload";
const expectationFor = (labels: readonly string[]): Expectation =>
  labels.some(label => / send\b/.test(label)) ? "send" : labels.some(label => / reload\b/.test(label)) ? "reload" : "any";

/**
 * Press once and classify the effect, polling until it shows or the effect window closes. Snapshot changes, clipboard
 * writes, `openUrl` calls and reload requests act at once. A submit call or an editor change acts once the frame shows
 * more than a failure notice; a press whose only visible effect is a failure notice does not act.
 */
async function pressOnce(reached: Reached, bytes: string, encoding: ChipEncoding, expectation: Expectation, before: Observation, draft = ""): Promise<{ verdict: "live" | "dead" | "notice"; detail: string }> {
  const { ui } = reached;
  ui.renderer.stdin.emit("data", Buffer.from(bytes));
  // A lone legacy ESC resolves only after the decoder's 20 ms timeout.
  if (encoding === "legacy" && bytes === "\x1b") await Bun.sleep(30);
  const start = performance.now();
  let notice = "", pending: string[] = [];
  // A redraw or snapshot change acts only if it survives settling: re-reading the same diff flickers a loading state and returns.
  const lasting = async () => { const settled = await quiet(reached); return settled.screen !== before.screen || snapshotChanged(before.state, settled.state) || settled.editor !== before.editor || settled.cursor !== before.cursor; };
  while (performance.now() - start < EFFECT_WINDOW_MS) {
    await ui.settle();
    const after = observe(reached);
    if (expectation === "reload") {
      if (after.spies.reloads > before.spies.reloads) return { verdict: "live", detail: "requested a reload" };
      continue;
    }
    const spied = [after.spies.clipboard > before.spies.clipboard && "clipboard write", after.spies.urls > before.spies.urls && "openUrl call", after.spies.reloads > before.spies.reloads && "reload request"].filter(Boolean) as string[];
    if (expectation !== "send" && spied.length) return { verdict: "live", detail: spied.join(", ") };
    const strong = expectation === "send"
      // Sent means a turn started with exactly the draft, or a local command took the whole draft and changed the conversation.
      ? [after.status === "running" && before.status !== "running" && after.state.transcript.some(entry => entry.kind === "user" && entry.text === draft && !before.state.transcript.some(old => old.id === entry.id)) && "started a turn with the draft",
        before.editor === draft && !after.editor && after.spies.submits.length === before.spies.submits.length && snapshotChanged(before.state, after.state) && "accepted the draft"]
      : [snapshotChanged(before.state, after.state) && "controller snapshot"];
    const evidence = strong.filter(Boolean) as string[];
    if (evidence.length) { if (expectation === "send" || await lasting()) return { verdict: "live", detail: evidence.join(", ") }; break; }
    pending = (expectation === "send"
      // Only the exact draft counts: a truncated or re-encoded Thai or emoji draft is not the one the chip sent.
      ? [after.spies.submits.length > before.spies.submits.length && after.spies.submits.at(-1) === draft && `dispatched ${JSON.stringify(draft)}`]
      : [after.editor !== before.editor && "editor text", after.cursor !== before.cursor && "editor cursor", after.spies.submits.length > before.spies.submits.length && "submit call"]
    ).filter(Boolean) as string[];
    if (after.screen !== before.screen) {
      // A new failure notice with no state change is the key being heard but unable to act, whatever else it redraws.
      notice = newNotice(before, after) ?? "";
      const draftKept = after.editor === before.editor && after.cursor === before.cursor;
      if (!(notice && draftKept) && (expectation !== "send" || pending.length)) {
        if (expectation === "send" || pending.includes("submit call") || await lasting()) return { verdict: "live", detail: [...pending, "frame"].join(", ") };
        break;
      }
    }
  }
  if (notice) return { verdict: "notice", detail: `only showed the failure notice "${notice}"` };
  if (pending.length) return { verdict: "live", detail: pending.join(", ") };
  return { verdict: "dead", detail: expectation === "send" ? `the draft ${JSON.stringify(draft)} was not dispatched whole` : expectation === "reload" ? "requested no reload" : "nothing changed" };
}

/**
 * Discover every chip (or only the `only` label) on the screen's ready state in one encoding and press each from a
 * fresh state; `prepare` runs on every fresh state before discovery or a press, such as a resize for a focused proof.
 */
async function probe(screen: Screen, encoding: ChipEncoding, variant = probedVariant(screen), only?: string, prepare?: (ui: ScreenHarness) => Promise<void>): Promise<ScreenResult> {
  const start = performance.now();
  const fresh = async () => { const state = await reach(screen, variant, encoding); try { await prepare?.(state.ui); return state; } catch (error) { await state.ui.dispose(); throw error; } };
  let reached: Reached | undefined = await fresh();
  const found = discoverChips(reached.ui.captureSpans(), hintRows(reached.ui)).filter(chip => only === undefined || chip.label === only);
  const chips = [...new Map(found.map(chip => [chip.label, chip])).values()];
  const results: ChipResult[] = [];
  try {
    const keys = [...new Set(chips.map(chip => chip.key))];
    for (const key of keys) {
      const owned = chips.filter(chip => chip.key === key);
      const record = (verdict: Verdict, detail: string) => { for (const chip of owned) results.push({ chip, verdict, detail }); };
      const collision = encoding === "legacy" ? (() => { try { return legacyCollision(key); } catch { return undefined; } })() : undefined;
      if (collision) { record("indistinct", `sends the same legacy bytes as ${collision}`); continue; }
      let presses;
      try { presses = chipPresses(key, encoding); }
      catch (error) { if (error instanceof UnknownChipError) { record("unknown", error.message); continue; } throw error; }
      const expectation = expectationFor(owned.map(chip => chip.label));
      let verdict: Verdict = "dead", detail = "";
      for (const press of presses) {
        reached ??= await fresh();
        if (expectation === "send" && !reached.ui.editor.plainText) {
          await reached.ui.mockInput.pasteBracketedText(SEND_DRAFT); await reached.ui.settle();
          // The pasted draft must arrive whole, so the send rule below compares against SEND_DRAFT itself.
          expect(reached.ui.editor.plainText).toBe(SEND_DRAFT);
        }
        const before = await quiet(reached);
        const outcome = await pressOnce(reached, press.bytes, encoding, expectation, before, before.editor);
        detail = presses.length > 1 ? `${detail ? `${detail}; ` : ""}${press.direction}: ${outcome.detail}` : outcome.detail;
        // Reuse the state only when the press changed nothing at all.
        const after = observe(reached);
        if (after.screen !== before.screen || snapshotChanged(before.state, after.state) || after.editor !== before.editor || outcome.verdict !== "dead") { await reached.ui.dispose(); reached = undefined; }
        if (outcome.verdict === "live") { verdict = "live"; break; }
        if (outcome.verdict === "notice") verdict = "notice";
      }
      record(verdict, detail);
    }
  } finally { await reached?.ui.dispose(); }
  return { screen: screen.id, variant: variant.id, encoding, chips: results, ms: performance.now() - start };
}

/** Bounded pool: at most `CONCURRENCY` probes run at once, in request order. */
let running = 0;
const queue: (() => void)[] = [];
async function pooled<T>(work: () => Promise<T>): Promise<T> {
  // A finishing probe hands its slot straight to the next waiter, so the bound holds between release and start.
  if (running >= CONCURRENCY) await new Promise<void>(resolve => queue.push(resolve)); else running++;
  try { return await work(); } finally { const next = queue.shift(); if (next) next(); else running--; }
}
const probes = new Map<string, Promise<ScreenResult>>();
const resultFor = (screen: Screen, encoding: ChipEncoding) => {
  const key = `${screen.id}/${encoding}`;
  if (!probes.has(key)) probes.set(key, pooled(() => probe(screen, encoding)));
  return probes.get(key)!;
};

// Unowned dead chips found by #305; each constant names the open issue that fixes the chip.
const FOLLOW_UP_CTRL_O_NO_TOOLS = 355;
const FOLLOW_UP_F2_WHILE_DETAILS_OPEN = 356;
const inspectNothing = (screen: string): ChipAllowEntry => ({ screen, chip: "Alt+I inspect", reason: "notice-by-design",
  note: "Nothing to inspect yet: the notice says so and names the next step (#275)." });
const pagingFits = (screen: string, note: string): ChipAllowEntry => ({ screen, chip: "PgUp/PgDn scroll", reason: "content-fits", note });
/**
 * Chips the liveness test accepts as not acting, each with a typed reason. Prefer a stronger precondition to a new
 * entry; an entry whose chip disappears or starts acting fails the test until it is deleted.
 */
const CHIP_ALLOWLIST: readonly ChipAllowEntry[] = [
  ...["auto-mode", "read-only-mode", "ask-mode", "grok-plan-error", "reasoning-chip-explicit", "reasoning-chip-provider-default", "reasoning-chip-advertised",
    "reasoning-chip-unavailable", "command-palette-inserted", "thai-composer", "draft-restored", "draft-not-saved", "web-search-line", "stopped-streaming",
    "details-unavailable", "delete-session-busy", "recent-work-resume", "compaction-completed", "compaction-cancelled", "compaction-failed", "compaction-noop", "no-color", "startup-provider"].map(inspectNothing),
  { screen: "disconnected-search", chip: "↑↓ previous/next", reason: "single-item", note: "README matches once; `running-search` moves between several matches." },
  { screen: "read-only-search-matches", chip: "↑↓ previous/next", reason: "single-item", note: "README matches once; `running-search` moves between several matches." },
  { screen: "grok-more-options", chip: "↑↓ select", reason: "single-item", note: "Grok has one other method; `chatgpt-more-options` moves between two." },
  { screen: "model-picker-unconnected", chip: "↑↓ select", reason: "single-item", note: "The only row connects a provider; `model-picker` moves between models." },
  { screen: "endpoint-url-error", chip: "Enter continue", reason: "content-fits", note: "Enter rechecks the same malformed URL and shows the same error; `endpoint-url-prefilled` continues to key entry." },
  ...["review-panel", "review-multi-turn", "undo-shell-only-review"].map((screen): ChipAllowEntry => ({ screen, chip: "↑↓ files", reason: "single-item", note: "One file is listed; `review-staged-unstaged` moves between files." })),
  ...["history-detail", "history-stopped-turn", "history-undo-note"].map((screen): ChipAllowEntry => ({ screen, chip: "↑↓ files", reason: "single-item", note: "One file is listed; `history-truncation` moves between files." })),
  ...["undo-preview-no-git", "undo-shell-only"].map((screen): ChipAllowEntry => ({ screen, chip: "↑↓ select", reason: "single-item", note: "One path is listed; `undo-preview` moves between paths." })),
  ...["review-panel", "review-multi-turn", "review-staged-unstaged", "undo-shell-only-review", "resumed-review", "resumed-review-clean", "resumed-review-no-git", "resumed-review-off",
    "resumed-review-unavailable", "resumed-review-git-failed"].map(screen => pagingFits(screen, "The diff fits the panel; `details-review` pages the same review column.")),
  ...["undo-preview", "undo-preview-no-git", "undo-shell-only", "undo-older-target"].map(screen => pagingFits(screen, 'The diff fits the panel; tests/hint-liveness.test.ts "undo preview PgUp/PgDn scroll acts when its diff overflows a short terminal" pages it.')),
  ...["reader-code", "reader-code-wrapped", "reader-approval"].map((screen): ChipAllowEntry => ({ screen, chip: "↑↓ scroll", reason: "content-fits", note: "Five code lines fit the reader; `reader-table` scrolls a long table." })),
  ...["history-timing", "history-timing-cache-unreported", "history-timing-partial", "history-reasoning", "history-reasoning-legacy"].map(screen => pagingFits(screen, "The record fits the panel; `history-timing/dark-40` pages it.")),
  pagingFits("details-notice", "The notice details fit the transcript; `details-recovery/dark-50` pages failure details."),
  { screen: "details-recovery", chip: "PgUp/PgDn scroll", reason: "content-fits", note: "The failure details fit the transcript at 80 columns; `details-recovery/dark-50` pages them." },
  { screen: "details-recovery", chip: "F2 details", reason: "known-defect", issue: FOLLOW_UP_F2_WHILE_DETAILS_OPEN,
    note: "The transcript error row keeps F2 details while those details are open, and F2 does nothing then." },
  { screen: "no-color", chip: "Ctrl+O tools", reason: "known-defect", issue: FOLLOW_UP_CTRL_O_NO_TOOLS, note: "A failed turn without tool rows still offers Ctrl+O tools, which then changes nothing." },
];

/** Verdicts each allowlist reason may cover; `unknown` chips are never allowlisted. */
const COVERS: Readonly<Record<ChipAllowEntry["reason"], readonly Verdict[]>> = {
  "single-item": ["dead"], "content-fits": ["dead"], "notice-by-design": ["notice"], "encoding-limit": ["indistinct"], "known-defect": ["dead", "notice", "indistinct"],
};
const applies = (entry: ChipAllowEntry, screen: string, chip: string, encoding: ChipEncoding) =>
  entry.screen === screen && entry.chip === chip && (entry.encoding === undefined || entry.encoding === encoding);
const explain = (result: ChipResult) => result.verdict === "indistinct" ? `is not distinguishable: ${result.detail}`
  : result.verdict === "unknown" ? `has no key map entry: ${result.detail}` : result.verdict === "notice" ? result.detail : `did not act (${result.detail})`;

/** Expected chip labels per screen, in discovery order, read from the committed inventory. */
async function readInventory(): Promise<Map<string, string[]>> {
  const text = await readFile(inventoryPath, "utf8").catch(() => "");
  return new Map(text.split("\n").filter(Boolean).map(line => {
    const [id, ...labels] = line.split(" | ");
    return [id!, labels.filter(label => label !== "(none)")];
  }));
}
const inventoryLine = (screen: string, labels: readonly string[]) => [screen, ...(labels.length ? labels : ["(none)"])].join(" | ");
const inventory = readInventory();

for (const screen of SCREENS) for (const encoding of CHIP_ENCODINGS) test.concurrent(`chips ${screen.id} [${encoding}]`, async () => {
  const result = await resultFor(screen, encoding);
  const labels = result.chips.map(entry => entry.chip.label);
  const failures: string[] = [];
  if (!update) {
    const expected = (await inventory).get(screen.id);
    if (expected === undefined || expected.join(" | ") !== labels.join(" | ")) failures.push(`advertises [${labels.join(", ")}] but tests/screen-catalog/chip-inventory.txt lists [${expected?.join(", ") ?? "nothing"}]. ` +
      "If the change is intended, run: SCHWAY_UPDATE_SCREENS=1 bun test tests/hint-liveness.test.ts");
  }
  for (const entry of result.chips) {
    if (entry.verdict === "live") continue;
    if (CHIP_ALLOWLIST.some(allowed => applies(allowed, screen.id, entry.chip.label, encoding) && COVERS[allowed.reason].includes(entry.verdict))) continue;
    failures.push(`"${entry.chip.label}" ${explain(entry)}`);
  }
  if (failures.length) throw new Error(`Screen ${screen.id} ${result.variant} [${encoding}]:\n${failures.map(failure => `- ${failure}`).join("\n")}`);
}, 600_000);

/** A catalog place (`screen` or `screen/variant`) or a focused test (`tests/x.test.ts "name"`) a note names as proof. */
function proofOf(note: string): { screen: string; variant?: string } | { file: string; name: string } | undefined {
  const focused = /(tests\/[\w./-]+\.test\.ts) "([^"]+)"/.exec(note);
  if (focused) return { file: focused[1]!, name: focused[2]! };
  const place = /`([a-z0-9-]+)(?:\/([a-z0-9-]+))?`/.exec(note);
  return place ? { screen: place[1]!, ...(place[2] ? { variant: place[2] } : {}) } : undefined;
}

test("allowlist entries are typed, explained and still needed", async () => {
  const results = await Promise.all(SCREENS.flatMap(screen => CHIP_ENCODINGS.map(encoding => resultFor(screen, encoding))));
  const find = (screen: string, encoding: ChipEncoding) => results.find(result => result.screen === screen && result.encoding === encoding);
  const problems: string[] = [];
  for (const entry of CHIP_ALLOWLIST) {
    const name = `${entry.screen} "${entry.chip}"${entry.encoding ? ` [${entry.encoding}]` : ""} (${entry.reason})`;
    if (!entry.note.trim()) problems.push(`${name} has no note`);
    if (entry.reason === "known-defect" && !(Number.isInteger(entry.issue) && entry.issue! > 0)) problems.push(`${name} must link the open issue that fixes it`);
    if (!SCREENS.some(screen => screen.id === entry.screen)) { problems.push(`${name} names no catalog screen; delete the entry`); continue; }
    const encodings = entry.encoding ? [entry.encoding] : CHIP_ENCODINGS;
    const seen = encodings.map(encoding => find(entry.screen, encoding)!.chips.find(result => result.chip.label === entry.chip));
    if (seen.every(result => !result)) { problems.push(`Stale allowlist entry ${name}: the chip no longer appears. Delete the entry.`); continue; }
    if (seen.every(result => !result || !COVERS[entry.reason].includes(result.verdict))) problems.push(`Stale allowlist entry ${name}: the chip now acts. Delete the entry.`);
    else if (!entry.encoding && seen.some(result => result?.verdict === "live")) problems.push(`Allowlist entry ${name} covers an encoding where the chip acts; set encoding to the one where it does not.`);
    if (entry.reason === "encoding-limit") {
      // Legacy terminals still reach the action through another advertised key on the same screen.
      const action = entry.chip.slice(entry.chip.indexOf(" ") + 1);
      if (entry.encoding !== "legacy") problems.push(`${name} must set encoding: "legacy"`);
      else if (!find(entry.screen, "legacy")!.chips.some(result => result.verdict === "live" && result.chip.label !== entry.chip && result.chip.label.endsWith(` ${action}`)))
        problems.push(`${name}: no other advertised key reaches "${action}" under legacy`);
    }
    if (entry.reason === "single-item" || entry.reason === "content-fits") {
      const proof = proofOf(entry.note);
      if (!proof) { problems.push(`${name}: the note must name a catalog screen in backticks or a tests/*.test.ts file and quoted test name that prove the chip live`); continue; }
      if ("file" in proof) {
        const source = await readFile(join(import.meta.dir, "..", proof.file), "utf8").catch(() => "");
        if (!source.includes(`test("${proof.name}"`) && !source.includes(`test.concurrent("${proof.name}"`)) problems.push(`${name}: ${proof.file} has no test "${proof.name}"`);
        continue;
      }
      const screen = SCREENS.find(candidate => candidate.id === proof.screen);
      const variant = screen && (proof.variant ? variantsFor(screen).find(candidate => candidate.id === proof.variant) : probedVariant(screen));
      if (!screen || !variant) { problems.push(`${name}: the proof ${proof.screen}${proof.variant ? `/${proof.variant}` : ""} is not a catalog screen and variant`); continue; }
      for (const encoding of encodings) {
        const proven = proof.variant ? (await pooled(() => probe(screen, encoding, variant, entry.chip))).chips[0] : find(screen.id, encoding)!.chips.find(result => result.chip.label === entry.chip);
        if (proven?.verdict !== "live") problems.push(`${name}: "${entry.chip}" is not live on ${screen.id}/${variant.id} [${encoding}], the place its note names`);
      }
    }
  }
  if (problems.length) throw new Error(problems.join("\n"));
}, 600_000);

test("chip inventory covers every screen; counts per screen and encoding", async () => {
  const results = await Promise.all(SCREENS.flatMap(screen => CHIP_ENCODINGS.map(encoding => resultFor(screen, encoding))));
  const kitty = results.filter(result => result.encoding === "kitty"), legacy = results.filter(result => result.encoding === "legacy");
  console.log(["Chips per screen (kitty / legacy):", ...kitty.map((result, index) => `  ${result.screen} ${result.variant}: ${result.chips.length} / ${legacy[index]!.chips.length}`),
    `  total: ${kitty.reduce((sum, result) => sum + result.chips.length, 0)} / ${legacy.reduce((sum, result) => sum + result.chips.length, 0)}`].join("\n"));
  // Both encodings render the same frame, so they must discover the same chips.
  for (const [index, result] of kitty.entries()) expect(legacy[index]!.chips.map(entry => entry.chip.label), result.screen).toEqual(result.chips.map(entry => entry.chip.label));
  const text = kitty.map(result => inventoryLine(result.screen, result.chips.map(entry => entry.chip.label))).join("\n") + "\n";
  if (update) { await writeFile(inventoryPath, text); return; }
  const listed = [...(await inventory).keys()];
  expect(listed, "tests/screen-catalog/chip-inventory.txt lists exactly the catalog screens in order; run SCHWAY_UPDATE_SCREENS=1 bun test tests/hint-liveness.test.ts").toEqual(SCREENS.map(screen => screen.id));
}, 600_000);

test("undo preview PgUp/PgDn scroll acts when its diff overflows a short terminal", async () => {
  const screen = SCREENS.find(candidate => candidate.id === "undo-preview")!;
  for (const encoding of CHIP_ENCODINGS) {
    const result = await pooled(() => probe(screen, encoding, probedVariant(screen), "PgUp/PgDn scroll", async ui => { ui.resize(80, 14); await ui.settle(); await ui.settle(); }));
    expect(result.chips.map(entry => `${entry.chip.label}=${entry.verdict}`), encoding).toEqual(["PgUp/PgDn scroll=live"]);
  }
}, 120_000);

test("key map sends the documented kitty and legacy bytes for each chip key", () => {
  const bytes = (token: string, encoding: ChipEncoding) => chipPresses(token, encoding).map(press => press.bytes);
  expect(bytes("F2", "kitty")).toEqual(["\x1b[57365;1u\x1b[57365;1:3u"]);
  expect(bytes("F2", "legacy")).toEqual(["\x1bOQ"]);
  expect(bytes("Alt+L", "kitty")).toEqual(["\x1b[108;3u"]); expect(bytes("Alt+L", "legacy")).toEqual(["\x1bl"]);
  expect(bytes("Alt+R", "kitty")).toEqual(["\x1b[114;3u"]); expect(bytes("Alt+R", "legacy")).toEqual(["\x1br"]);
  expect(bytes("Shift+Tab", "kitty")).toEqual(["\x1b[9;2u"]); expect(bytes("Shift+Tab", "legacy")).toEqual(["\x1b[Z"]);
  expect(bytes("Esc", "kitty")).toEqual(["\x1b[27u"]); expect(bytes("Esc", "legacy")).toEqual(["\x1b"]);
  expect(bytes("Enter", "kitty")).toEqual(["\x1b[13u"]); expect(bytes("Enter", "legacy")).toEqual(["\r"]);
  expect(bytes("Tab", "kitty")).toEqual(["\x1b[9u"]); expect(bytes("Tab", "legacy")).toEqual(["\t"]);
  expect(bytes("Ctrl+R", "kitty")).toEqual(["\x1b[114;5u"]); expect(bytes("Ctrl+R", "legacy")).toEqual(["\x12"]);
  expect(bytes("Ctrl+End", "kitty")).toEqual(["\x1b[57357;5u"]); expect(bytes("Ctrl+End", "legacy")).toEqual(["\x1b[1;5F"]);
  expect(bytes("C", "kitty")).toEqual(["\x1b[99u"]); expect(bytes("C", "legacy")).toEqual(["c"]);
  expect(bytes("/", "legacy")).toEqual(["/"]); expect(bytes("/compact", "kitty")).toEqual(["/compact\x1b[13u"]);
  // Two-way chips try each direction.
  expect(chipPresses("↑↓", "legacy")).toEqual([{ direction: "Up", bytes: "\x1b[A" }, { direction: "Down", bytes: "\x1b[B" }]);
  expect(chipPresses("←→", "kitty").map(press => press.direction)).toEqual(["Left", "Right"]);
  expect(bytes("PgUp/PgDn", "legacy")).toEqual(["\x1b[5~", "\x1b[6~"]);
  // Legacy control bytes that equal another key's.
  expect(bytes("Ctrl+I", "legacy")).toEqual(["\t"]); expect(bytes("Ctrl+M", "legacy")).toEqual(["\r"]);
  expect(bytes("Ctrl+H", "legacy")).toEqual(["\b"]); expect(bytes("Ctrl+[", "legacy")).toEqual(["\x1b"]);
  expect(bytes("Ctrl+I", "kitty")).toEqual(["\x1b[105;5u"]);
});

test("legacy collisions name the key that shares the bytes", () => {
  expect(legacyCollision("Ctrl+I")).toBe("Tab");
  expect(legacyCollision("Ctrl+M")).toBe("Enter");
  expect(legacyCollision("Ctrl+H")).toBe("Backspace");
  expect(legacyCollision("Ctrl+[")).toBe("Esc");
  expect(legacyCollision("Shift+Enter")).toBe("Enter");
  for (const token of ["F2", "Alt+I", "Ctrl+R", "Ctrl+C", "Shift+Tab", "Esc", "Tab", "Enter", "↑↓", "C"]) expect(legacyCollision(token), token).toBeUndefined();
});

test("unknown chip text fails with a message that names the chip", () => {
  expect(() => chipPresses("Ctrl+Shift+X", "kitty")).toThrow(UnknownChipError);
  expect(() => chipPresses("Ctrl+Shift+X", "legacy")).toThrow('No key map entry for chip key "Ctrl+Shift+X"');
  expect(() => chipPresses("F5", "kitty")).toThrow('"F5"');
});

test("the test decoder reads every mapped press as its key in each encoding", async () => {
  const expected: Record<string, string> = { Esc: "escape", Enter: "return", Tab: "tab", "Shift+Tab": "tab+shift", F2: "f2", "Alt+L": "l+meta", "Ctrl+R": "r+ctrl", "Ctrl+End": "end+ctrl", C: "c", Up: "up", Down: "down", Left: "left", Right: "right", PgUp: "pageup", PgDn: "pagedown" };
  for (const encoding of CHIP_ENCODINGS) {
    const terminal = await createTestRenderer({ width: 20, height: 4, kittyKeyboard: encoding === "kitty", exitOnCtrlC: false });
    try {
      const seen: string[] = [];
      terminal.renderer.keyInput.on("keypress", key => { if (key.eventType !== "release") seen.push(`${key.name}${key.ctrl ? "+ctrl" : ""}${key.meta ? "+meta" : ""}${key.shift ? "+shift" : ""}`); });
      for (const token of ["Esc", "Enter", "Tab", "Shift+Tab", "F2", "Alt+L", "Ctrl+R", "Ctrl+End", "C", "↑↓", "←→", "PgUp/PgDn"]) for (const press of chipPresses(token, encoding)) {
        seen.length = 0;
        terminal.renderer.stdin.emit("data", Buffer.from(press.bytes));
        await Bun.sleep(press.bytes === "\x1b" ? 30 : 1);
        expect(seen, `${encoding} ${token} ${press.direction}`).toEqual([expected[press.direction] ?? expected[token]!]);
      }
    } finally { terminal.renderer.destroy(); }
  }
});

/** A synthetic one-row-per-entry frame from `[text, background, bold?]` runs; foreground is fixed. */
function syntheticFrame(rows: readonly (readonly [string, string, boolean?])[][]): CapturedFrame {
  const cols = Math.max(...rows.map(row => row.reduce((width, [text]) => width + Bun.stringWidth(text), 0)));
  return { cols, rows: rows.length, cursor: [0, 0], lines: rows.map(row => ({ spans: row.map(([text, background, strong]) => ({
    text, width: Bun.stringWidth(text), fg: RGBA.fromHex("#e6eaf0"), bg: RGBA.fromHex(background), attributes: strong ? 1 : 0 })) })) };
}
const BG = "#0e1117", CHIP = "#293140", SURFACE = "#161b24";
const labels = (chips: readonly DiscoveredChip[]) => chips.map(chip => `${chip.row}:${chip.label}:${chip.source}`);

test("chip discovery finds hint-row, status-bar, outcome-strip, readiness-card and transcript error-row chips", () => {
  const frame = syntheticFrame([
    [["  ", BG], ["Esc", CHIP, true], [" back · ", BG], ["Enter", CHIP, true], [" send", BG]],
    [[" ◆ Auto ", SURFACE], ["● Ready", "#31433f", true], ["  ", SURFACE], ["Ctrl+C", "#2a3040", true], [" cancel turn", SURFACE]],
    [["  ", BG], ["✗ Failed", BG, true], [" · 0.0s · ", BG], ["Alt+R", CHIP, true], [" review", BG]],
    [["  Connect a provider · ", BG], ["Alt+L", CHIP, true], [" sign in", BG]],
    [["  ▌ ", "#2a2227"], ["Ctrl+R", "#2c3241", true], [" continue · ", "#2a2227"], ["F2", "#2c3241", true], [" details", "#2a2227"]],
  ]);
  expect(labels(discoverChips(frame, [0]))).toEqual([
    "0:Esc back:chip", "0:Enter send:chip", "0:Esc back:hint-row", "0:Enter send:hint-row", "1:Ctrl+C cancel turn:chip", "2:Alt+R review:chip",
    "3:Alt+L sign in:chip", "4:Ctrl+R continue:chip", "4:F2 details:chip",
  ]);
});

test("chip discovery reads a NO_COLOR frame, where chips keep a gray cell background", () => {
  const frame = syntheticFrame([[["  ", BG], ["Ctrl+R", CHIP, true], [" continue · ", BG], ["/", CHIP, true], [" commands", BG]]]);
  expect(labels(discoverChips(frame))).toEqual(["0:Ctrl+R continue:chip", "0:/ commands:chip"]);
  // A hint row whose chips lost their style still counts by its key-led segments.
  expect(labels(discoverChips(syntheticFrame([[["  Ctrl+O tools · Alt+I inspect · Ready", BG]]]), [0]))).toEqual(["0:Ctrl+O tools:hint-row", "0:Alt+I inspect:hint-row"]);
});

test("chip discovery excludes palette rows that only document keys", () => {
  const selected = "#2a3344";
  const frame = syntheticFrame([
    // Selected help row: the key shares the row highlight and documents itself before a column gap.
    [["   › ! ", selected], ["F2", CHIP, true], [" or ", selected], ["Ctrl+I", CHIP, true], ["          Inspect details", selected]],
    [["       ", BG], ["Shift+Tab", BG, true], ["             Change approval mode", BG]],
    [["       ", selected], ["Ctrl+C", selected, true], [" cancel turn", selected]],
  ]);
  expect(discoverChips(frame)).toEqual([]);
});

test("a press that only adds failure notices leaves the snapshot unchanged, even when it sets or keeps error status", () => {
  const snapshot = (status: string, rows: [string, TuiSnapshot["transcript"][number]["kind"], string][]) =>
    ({ status, transcript: rows.map(([id, kind, text]) => ({ id, kind, text })) }) as unknown as TuiSnapshot;
  const failed = snapshot("error", [["u1", "user", "Summarize the changes"], ["e1", "error", "Request failed · Inspect details before continuing"]]);
  // Already in error: an appended notice keeps the key, though the last row is now a notice.
  expect(snapshotChanged(failed, snapshot("error", [...failed.transcript.map(entry => [entry.id, entry.kind, entry.text] as [string, "user", string]), ["s1", "system", "Wait for this turn · Esc stop"]]))).toBe(false);
  // Idle to error only because fail("Unknown command …") added its row.
  const idle = snapshot("idle", [["u1", "user", "Summarize the changes"]]);
  expect(snapshotChanged(idle, snapshot("error", [["u1", "user", "Summarize the changes"], ["e2", "error", "Unknown command · /help browse commands"]]))).toBe(false);
  // A real effect still counts: an ordinary row, or a status change without a notice row.
  expect(snapshotChanged(idle, snapshot("idle", [["u1", "user", "Summarize the changes"], ["s2", "system", "Session: catalog-session"]]))).toBe(true);
  expect(snapshotChanged(idle, snapshot("running", [["u1", "user", "Summarize the changes"]]))).toBe(true);
  expect(snapshotChanged(idle, snapshot("error", [["u1", "user", "Summarize the changes"], ["e3", "error", "Request failed"]]))).toBe(true);
});
