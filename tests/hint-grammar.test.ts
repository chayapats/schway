import { expect, test } from "bun:test";
import { BRANCH_TREE_ARROWS, branchTreeHint, branchTreeModeLine, branchTreePlaceholder } from "../src/tui/branch-tree-hints.ts";
import { credentialEntryPanel } from "../src/tui/credential-entry.ts";
import { APPROVAL_RETURN_HINT, fitDescription, fitHintSegments, HINT_KEY, wrapHintSegments } from "../src/tui/hints.ts";
import { PREFERENCE_SCOPES, type PreferencesSnapshot } from "../src/tui/preferences.ts";
import { preferenceHint, preferenceLines, previewScopeText } from "../src/tui/preferences-view.ts";
import { SIGN_IN_TIMED_OUT, SIGN_IN_WAIT_COMPACT_ACTION, SIGN_IN_WAIT_HINT, signInChooserHint, signInWaitRows } from "../src/tui/sign-in-wait.ts";
import { undoHint } from "../src/tui/undo-view.ts";
import { applyHintExemptions, hintGrammarFailures, type HintExemption, type HintRule } from "./helpers/hint-grammar.ts";
import type { ScreenGolden, StyleRun } from "./screen-catalog/format.ts";

const STATUS_BAR = " ◆ Auto  ● Ready   scripted/scripted-model   Provider default            ctx ~0";
const CHIP = "#293140", BACKGROUND = "#0e1117";

/** Style runs for a hint row: each key that leads a ` · ` segment gets a bold chip run at its cell column. */
function chipRuns(row: number, line: string, options: { bold?: boolean; byIndex?: boolean } = {}): StyleRun[] {
  const runs: StyleRun[] = [];
  let column = 0, index = 0;
  const plain = (end: number) => { if (end > column) runs.push({ row, start: column, end, fg: "#8b95a7", bg: BACKGROUND, attrs: "-" }); column = end; };
  const segments = line.split(" · ");
  segments.forEach((segment, position) => {
    const offset = line.indexOf(segment, index);
    const key = HINT_KEY.exec(segment.trimStart())?.[0];
    if (key) {
      const at = offset + segment.length - segment.trimStart().length;
      // A deliberately wrong renderer would place chips at string indices instead of terminal cells.
      const start = options.byIndex ? at : Bun.stringWidth(line.slice(0, at));
      plain(start);
      runs.push({ row, start, end: start + Bun.stringWidth(key), fg: "#e6eaf0", bg: CHIP, attrs: options.bold === false ? "-" : "b" });
      column = start + Bun.stringWidth(key);
    }
    index = offset + segment.length;
    if (position === segments.length - 1) plain(Bun.stringWidth(line));
  });
  return runs;
}

/** A synthetic golden from text rows; `hint` adds the status bar and a chipped hint row as the last two rows. */
function golden(rows: readonly string[], options: { variant?: string; hint?: string; styles?: StyleRun[]; cols?: number } = {}): ScreenGolden {
  const text = options.hint === undefined ? [...rows] : [...rows, STATUS_BAR, options.hint];
  const styles = options.styles ?? (options.hint === undefined ? [] : chipRuns(text.length - 1, options.hint));
  return { screen: "synthetic", title: "Synthetic", description: "A synthetic frame.", variant: options.variant ?? "dark-80", cols: options.cols ?? 80, rows: text.length,
    cursor: { x: 1, y: 1, visible: false }, text, styles };
}

const rules = (screen: ScreenGolden) => hintGrammarFailures(screen).map(failure => failure.rule);
const fails = (rule: HintRule, screen: ScreenGolden) => expect(rules(screen), screen.text.join("\n")).toContain(rule);
const passes = (screen: ScreenGolden) => expect(hintGrammarFailures(screen).map(failure => failure.message)).toEqual([]);

test("R1 needs an allowed action after each key and names the allowlist in its message", () => {
  passes(golden(["Ready · Enter send · Esc stop", "Undo turn 1 · Enter undo · Esc cancel"]));
  fails("R1", golden(["↑↓ move · R read · C copy · Esc editor"]));
  const [failure] = hintGrammarFailures(golden(["", "Done · Alt+R inspect"]));
  expect(failure).toMatchObject({ rule: "R1", row: 1, text: "Alt+R inspect" });
  expect(failure!.message).toContain("synthetic dark-80 row 2: R1");
  expect(failure!.message).toContain("add the pair to HINT_ACTIONS");
  // A named target after `: ` keeps its allowed verb.
  passes(golden(["New conversation · Alt+B resume: Refactor the session loader"]));
});

test("R1 skips slash-command segments, which R2, R5 and R6 still check", () => {
  passes(golden(["Resume saved work · Alt+B resume · /sessions browse", "/delete-session retry · F2 details", "Shift+Tab change mode · / commands"]));
  fails("R2", golden(["Undo store busy · /"]));
  fails("R2", golden(["/delete-session Delet…"]));
  // A command name alone names no action.
  expect(rules(golden(["Active summary boundary · earlier rows remain history · /context"]))).toEqual(["R2"]);
  passes(golden(["Active summary boundary · earlier rows remain history · /context inspect"]));
  fails("R6", golden(["Cannot delete session: Undo store busy · /", "delete-session retry · F2 details"]));
  fails("R6", golden(["Context unchanged · /compact retry after more", "turns"], { cols: 50 }));
  // A slash segment wider than the row may wrap after its verb.
  passes(golden(["Change tracking is off", "/config set git {\"changeTracking\":\"on-demand\"}", "enable"], { cols: 40 }));
});

test("Alt+L names sign-in on every hint surface", () => {
  passes(golden(["Connect to continue · Alt+L sign in", "Sign-in timed out · Alt+L sign in · F2 details"]));
  for (const action of ["connect", "retry", "reconnect this account"]) fails("R1", golden([`Alt+L ${action}`]));
});

test("R2 rejects bare keys and keys whose action is cut off", () => {
  for (const row of ["↑↓ select · Enter · Tab more options · Esc back", "Connect a provider · Alt+L", "Find: absent · No matches · Esc resto…",
    "Ctrl+C cancel t…", "Nothing running · Enter s…", "Receiving response · Esc …"])
    expect(rules(golden([row])), row).toEqual(["R2"]);
  passes(golden(["↑↓ select · Enter continue · Tab more options · Esc back", "Connect a provider · Alt+L sign in"]));
  // A cut inside the target after `: ` leaves the key's verb whole.
  passes(golden(["Alt+B resume: Refactor the s…"]));
});

test("R3 rejects third-person actions after a key but leaves prose segments alone", () => {
  for (const [row, verb] of [["Ready · Enter sends", "send"], ["◆ Auto  ● Working   ctx ~7    Esc stops  ctx ~7", "stop"], ["Approval pending · Esc cancels", "cancel"],
    ["Enter saves · Esc cancel", "save"], ["Enter exchanges · Esc cancel", "exchange"], ["Enter confirms · Esc cancel", "confirm"],
    ["Aligned columns · C copies Markdown source", "copy"], ["Enter opens", "open"]] as const) {
    const failures = hintGrammarFailures(golden([row]));
    expect(failures.map(failure => failure.rule), row).toEqual(["R3"]);
    expect(failures[0]!.message).toContain(`imperative "${verb}"`);
  }
  // #264's draft guidance is prose: its segment starts with "Wait", not a key.
  passes(golden(["Still working · Wait, then Enter sends · Esc stop"]));
});

test("R4 rejects slashed arrow pairs", () => {
  fails("R4", golden(["↑/↓ select · Tab complete · Esc keep editing · Enter send"]));
  fails("R4", golden(["←/→ change · Enter preview · Esc back"]));
  passes(golden(["↑↓ select · ←→ change · Esc back"]));
});

test("R5 rejects rows that end on a separator, except the composer input row", () => {
  fails("R5", golden(["▌ Sign-in timed out · Alt+L sign in ·", "▌ F2 details"]));
  fails("R5", golden(["No saved undo for these changes · Alt+R review ·   │", "Esc back"]));
  expect(rules(golden(["  ▌ › /", "  ▌ › review ·"]))).toEqual([]);
  passes(golden(["▌ Sign-in timed out · Alt+L sign in", "▌ F2 details"]));
});

test("R6 keeps every key on the row with its action", () => {
  for (const rows of [["Type a task · Enter", "sends"], ["▌ Ctrl+R continue · F2 details · Esc", "▌ keep editing"], ["▌ Ctrl+R continue · Esc keep", "▌ editing"],
    ["No matches · Clear search or Esc", "back"], ["Still working · Wait, then Enter", "sends"], ["Choice used for this session · F2", "details"]]) {
    const failures = hintGrammarFailures(golden(rows, { cols: 40 }));
    expect(failures.map(failure => failure.rule), rows.join(" / ")).toEqual(["R6"]);
    expect(failures[0]!.row).toBe(0);
  }
  passes(golden(["Type a task", "Enter send", "▌ Ctrl+R continue · F2 details", "▌ Esc keep editing"], { cols: 40 }));
  // A complete hint above an unrelated lower-case row is not a wrap.
  passes(golden(["    ts                    Alt+I inspect", "   console.log('hi');"], { cols: 40 }));
});

test("R7 needs one bold chip run per leading key on the hint row, measured in terminal cells", () => {
  passes(golden([""], { hint: "  ↑↓ select · PgUp/PgDn scroll · Alt+R review · Esc cancel" }));
  const plain = "  ↑↓ select · PgUp/PgDn scroll · Alt+R review · Esc cancel";
  const muted = golden([""], { hint: plain, styles: [{ row: 2, start: 0, end: Bun.stringWidth(plain), fg: "#8b95a7", bg: BACKGROUND, attrs: "-" }] });
  expect(hintGrammarFailures(muted).filter(failure => failure.rule === "R7").map(failure => failure.text)).toEqual(["↑↓ select", "PgUp/PgDn scroll", "Alt+R review", "Esc cancel"]);
  // Thai combining marks and emoji are narrower or wider than their string length, so chips sit at cell columns.
  const thai = "  แก้ไข 🧪 ไทย · Enter send · Esc back";
  passes(golden([""], { hint: thai }));
  expect(rules(golden([""], { hint: thai, styles: chipRuns(2, thai, { byIndex: true }) }))).toContain("R7");
  // NO_COLOR frames still mark chips with bold and a chip background.
  passes(golden([""], { variant: "nocolor-dark-80", hint: "  Enter save · Esc cancel" }));
  expect(rules(golden([""], { variant: "nocolor-dark-80", hint: "  Enter save · Esc cancel", styles: chipRuns(2, "  Enter save · Esc cancel", { bold: false }) }))).toEqual(["R7", "R7"]);
});

test("a compact footer that replaced the hint row is unchipped by design but still checked for grammar", () => {
  const compact = (footer: string) => golden(["", " ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀", footer]);
  passes(compact(" Auto · Esc back"));
  expect(rules(compact(" Auto · Esc stops"))).toEqual(["R3"]);
});

test("exemptions apply to one screen and rule, and an exemption that matches nothing is stale", () => {
  const failures = hintGrammarFailures(golden(["Esc or Ctrl+C         Stop running work"]));
  expect(failures.map(failure => failure.rule)).toEqual(["R1"]);
  const live: HintExemption = { screen: "synthetic", pattern: /Esc or Ctrl\+C\s{2,}/, rule: "R1", reason: "Listing row" };
  const otherRule: HintExemption = { ...live, rule: "R3" };
  const otherScreen: HintExemption = { ...live, screen: "elsewhere" };
  expect(applyHintExemptions(failures, [live, otherRule, otherScreen])).toEqual({ unexempt: [], stale: [otherRule, otherScreen] });
  expect(applyHintExemptions(failures, [otherRule]).unexempt).toEqual(failures);
});

test("hint wrapping breaks only at separators and never between a key and its verb", () => {
  expect(wrapHintSegments("Ctrl+R continue · F2 details · Esc keep editing", 34)).toEqual(["Ctrl+R continue · F2 details", "Esc keep editing"]);
  expect(wrapHintSegments("Type a task · Enter send", 20)).toEqual(["Type a task", "Enter send"]);
  expect(wrapHintSegments("Still working · Wait, then Enter sends", 20)).toEqual(["Still working", "Wait,", "then Enter sends"]);
  expect(wrapHintSegments("  Indented · Esc back", 80)).toEqual(["  Indented · Esc back"]);
  // A segment wider than a row may start beside the status, keeping its key with its verb; one that fits starts its own row.
  expect(wrapHintSegments("Still working · Wait, then Enter sends", 21)).toEqual(["Still working · Wait,", "then Enter sends"]);
  expect(wrapHintSegments("Done · Ctrl+R retry credential access now", 21)).toEqual(["Done · Ctrl+R retry", "credential access now"]);
  expect(wrapHintSegments("Ready · Esc keep editing", 20)).toEqual(["Ready", "Esc keep editing"]);
  for (const [text, columns] of [["Cannot delete session: Undo store busy · /delete-session retry · F2 details", 46], ["Connect a provider · Alt+L sign in", 20]] as const)
    passes(golden(wrapHintSegments(text, columns), { cols: columns }));
});

test("hint fitting drops whole segments, keeps Esc over status and never cuts a key's action", () => {
  expect(fitHintSegments("Nothing running · Enter send a task", 26)).toBe("Nothing running");
  expect(fitHintSegments("Done · 4 files +44 −1 · 1 command ok · 7.8s · Alt+R review", 30)).toBe("Done · Alt+R review");
  expect(fitHintSegments("◌ Approval waiting · Esc back to request", 22)).toBe("Esc back to request");
  expect(fitHintSegments("Delete a saved session", 16)).toBe("Delete a saved…");
  expect(fitHintSegments("Delete a saved session", 6)).toBe("");
  expect(fitHintSegments("Ctrl+C cancel turn", 12)).toBe("");
  // A key-led segment stays whole or goes; it never gains `…` between its key+verb and the full action.
  for (const [text, columns] of [["Esc keep editing", 12], ["Ctrl+C cancel turn", 15], ["Alt+M browse models", 17]] as const) {
    expect(fitHintSegments(text, columns), text).toBe("");
    expect(fitHintSegments(text, Bun.stringWidth(text)), text).toBe(text);
  }
  // The stop action outranks status decoration, as Esc does.
  expect(fitHintSegments("Approval · Ctrl+C cancel turn", 26)).toBe("Ctrl+C cancel turn");
  expect(fitHintSegments("Approval · Ctrl+C cancel turn", 17)).toBe("Approval");
  for (const columns of [8, 12, 20, 30, 40]) passes(golden([fitHintSegments("Aligned columns · C copy Markdown source", columns)]));
});

test("palette descriptions shorten prose at a word even when it starts with a key-like word", () => {
  // Extension command descriptions are prose: `End`, `Tab` or `Enter` here is a word, not a key hint.
  expect(fitDescription("End the current sprint and archive it", 20)).toBe("End the current…");
  expect(fitDescription("Tab completion for branch names", 18)).toBe("Tab completion…");
  expect(fitDescription("End the current sprint", 22)).toBe("End the current sprint");
  // Text with ` · ` segments still fits like a hint, so a key-led segment never gains `…`.
  expect(fitDescription("Busy · Esc keep editing", 12)).toBe("Busy");
});

test("every hint producer outside the catalog passes the checker", () => {
  const rows: string[] = [];
  // Sign-in typing surfaces: endpoint URL, API key (from the chooser and from the endpoint step) and the browser callback.
  for (const snapshot of [{ endpointUrlEntry: { value: "" } }, { credentialEntry: { label: "OpenAI", masked: "", returnsToUrl: false } },
    { credentialEntry: { label: "Endpoint", masked: "", returnsToUrl: true } }, { loginCallbackEntry: { masked: "" } }])
    rows.push(credentialEntryPanel(snapshot as never)!.hint);
  // Subscription sign-in waits, including the ChatGPT approval rows and the chooser behind a wait.
  for (const provider of ["ChatGPT", "Grok"] as const) {
    rows.push(...signInWaitRows({ provider }, "Approve in your browser").map(row => row.text));
    rows.push(...signInWaitRows({ provider }, "Waiting", { kind: "device", verificationUri: "https://example.test/device", userCode: "ABCD-1234" }).map(row => row.text));
  }
  rows.push(SIGN_IN_WAIT_HINT, SIGN_IN_WAIT_COMPACT_ACTION, SIGN_IN_TIMED_OUT, APPROVAL_RETURN_HINT,
    signInChooserHint(undefined, "↑↓ select · Enter continue · Tab more options"), signInChooserHint({}, "↑↓ select · Enter continue"));
  // Branch tree hint rows, mode lines and placeholders at every width.
  for (const continuing of [true, false]) for (const columns of [24, 40, 50, 80, 120]) for (const esc of [true, false])
    rows.push(branchTreeHint(continuing, columns, esc), branchTreeModeLine(continuing, columns), branchTreePlaceholder(continuing, columns));
  expect(BRANCH_TREE_ARROWS).toBe("↑↓ preview");
  // Undo hint rows at every width, for an offered undo and a result.
  const undo = { turnNumber: 1, files: [], selected: 0 } as never;
  for (const columns of [20, 40, 60, 80]) rows.push(undoHint(undo, columns), undoHint({ ...(undo as object), result: "Undone" } as never, columns));
  // The preference state line and the staged preview for every scope, as the controller words it.
  for (const scope of Object.keys(PREFERENCE_SCOPES) as PreferencesSnapshot["scope"][]) {
    const preview = `${previewScopeText(scope)} Appearance: light. Effective after save: light.`;
    const panel = { page: "basic", scope, selectedIndex: 0, choiceIndex: 0, preview,
      rows: [{ key: "appearance", label: "Appearance", value: "auto", choices: ["light"], saved: "auto", origin: "default", reset: "" }] } as unknown as PreferencesSnapshot;
    expect(preview).not.toMatch(/Enter|Esc/);
    rows.push(...preferenceLines(panel, false), ...preferenceLines(panel, true), preferenceHint(panel));
    expect(preferenceLines(panel, false)).toContain("Enter save · light");
  }
  const failures = rows.flatMap(row => hintGrammarFailures(golden([row])).map(failure => failure.message));
  expect(failures).toEqual([]);
});
