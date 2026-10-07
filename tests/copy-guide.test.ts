import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BANNED_COPY } from "./helpers/banned-copy.ts";
import { ESC_BANNED_SYNONYMS, ESC_VERBS, escPhraseProblems, type EscPhraseProblem } from "./helpers/esc-verbs.ts";
import { parseScreen } from "./screen-catalog/format.ts";
import { SCREENS, variantsFor } from "./screen-catalog/screens.ts";

// These two explicit Details scenes show the existing diagnostic evidence body.
// All other copy rules (including identifiers/counts) and all primary scenes remain checked.
const diagnosticEvidencePatterns = new Set(["unattributed", "not a (test-suite )?guarantee", String.raw`exit 0 \/`, String.raw`exit 0 \/ \d+ nonzero`]);

test("every catalog golden follows the banned-copy guide", async () => {
  const root = join(import.meta.dir, "screen-catalog/goldens");
  const files = (await readdir(root, { recursive: true })).filter(file => file.endsWith(".golden")).sort();
  const expected = SCREENS.flatMap(screen => variantsFor(screen).map(variant => `${screen.id}/${variant.id}.golden`)).sort();
  expect(files).toEqual(expected);
  const failures: string[] = [];
  for (const file of files) {
    const screen = parseScreen(await readFile(join(root, file), "utf8"));
    screen.text.forEach((line, index) => {
      for (const { pattern, reason } of BANNED_COPY) {
        if ((screen.screen === "details-review" || screen.screen === "details-recovery") && diagnosticEvidencePatterns.has(pattern.source)) continue;
        if (pattern.test(line))
          failures.push(`${file}: screen ${screen.screen}, variant ${screen.variant}, line ${index + 1}: /${pattern.source}/ (${reason})\n${line}`);
      }
    });
  }
  expect(failures, failures.join("\n")).toEqual([]);
});

test("voice guide and banned-copy patterns cannot drift", async () => {
  const guide = await readFile(join(import.meta.dir, "../docs/voice-and-copy.md"), "utf8");
  const section = guide.split("## Banned patterns\n")[1]?.split("## Reviewer checklist")[0];
  expect(section).toBeDefined();
  const sources = section!.split("\n").filter(line => line.includes("  # ")).map(line => line.split(/\s+# /)[0]!.trim());
  expect(sources.sort()).toEqual(BANNED_COPY.map(({ pattern }) => pattern.source).sort());
});

/** An Esc lint exception for a surface another audit item owns; that item deletes the entry when it lands. */
interface EscException { screen: string; phrase: string; owner: string }

// Each entry must still match a golden, so an owner that fixes its surface has to delete the entry.
// Surfaces those owners also keep but the lint does not flag (valid verbs in the wrong place) need no entry.
const ESC_EXCEPTIONS: readonly EscException[] = [
];

interface ScreenProblem extends EscPhraseProblem { file: string; screen: string; variant: string }

/** Split lint problems into those an exception covers and the rest, and name exceptions that covered nothing. */
function applyEscExceptions(problems: readonly ScreenProblem[], exceptions: readonly EscException[]) {
  const used = new Set<EscException>();
  const unexcused = problems.filter(problem => {
    const exception = exceptions.find(entry => entry.screen === problem.screen && entry.phrase === problem.phrase);
    if (exception) used.add(exception);
    return !exception;
  });
  return { unexcused, stale: exceptions.filter(entry => !used.has(entry)) };
}

test("voice guide and Esc verb table cannot drift", async () => {
  const guide = await readFile(join(import.meta.dir, "../docs/voice-and-copy.md"), "utf8");
  const section = guide.split("## Esc verbs\n")[1]?.split("\n## ")[0];
  expect(section).toBeDefined();
  const rows = section!.split("\n").filter(line => line.startsWith("| `")).map(line => {
    const [verb, use, example] = line.slice(1, -1).split(" | ").map(cell => cell.trim().replace(/^`|`$/g, ""));
    return { verb, use, example };
  });
  const sort = (list: { verb?: string }[]) => [...list].sort((a, b) => a.verb!.localeCompare(b.verb!));
  expect(sort(rows)).toEqual(sort(ESC_VERBS.map(({ verb, use, example }) => ({ verb, use, example }))));
  for (const word of ESC_BANNED_SYNONYMS) expect(section).toContain(`\`${word}\``);
});

test("Esc lint rejects seeded wrong verbs and accepts wrapped table phrases", () => {
  for (const row of ["◆ Auto  ● Working   ctx ~7    Esc stops  ctx ~7", "No matches · Esc dismiss", "Undo turn 1 · Esc close",
    "↑↓ move · Enter toggle · C copy · Esc", "⠋ Receiving response · Esc …", "Find: absent · No matches · Esc resto…",
    "Approval modes · Esc back to change", "Approval waiting · Esc review request"])
    expect(escPhraseProblems([row]).map(problem => problem.row), row).toEqual([0]);
  // A trailing scrollbar or edge glyph is ignored, never taken as the end of a phrase or as its missing verb.
  for (const rows of [["C copy · Esc   █", "Ask Schway…"], ["Esc resto…  █"], ["Esc cance█"], ["Esc stops  ▀"], ["Esc   │"], ["Esc stop it█"], ["Esc back now█"]])
    expect(escPhraseProblems(rows).map(problem => problem.row), rows.join("\n")).toEqual([0]);
  expect(escPhraseProblems(["Undo turn 1 · Esc close", "Esc stops"]).map(problem => problem.problem))
    .toEqual(['banned synonym "close"', 'third-person verb "stops"']);
  for (const rows of [["Ctrl+R continue · Esc keep", " ▌ editing"], ["Ctrl+R continue · Esc", "keep editing"], ["Clear search or Esc", "  back"],
    ["◌ Approval · Esc back to request"], ["Esc or Ctrl+C         Stop running work"], ["Esc cancel sign-in"], ["Esc stop  ctx ~7"], ["Esc back        █"],
    ["↑/↓ preview · Enter confirm · Esc    █", "cancel                               █"]])
    expect(escPhraseProblems(rows), rows.join("\n")).toEqual([]);
  // A wrapped prefix still fails when the next row does not finish a table phrase.
  expect(escPhraseProblems(["C copy · Esc", "Ask Schway…"])).toHaveLength(1);
});

test("Esc lint exceptions fail once they no longer match a golden", () => {
  const problem = { file: "a/dark-80.golden", screen: "a", variant: "dark-80", row: 0, phrase: "Esc cancels", problem: "third-person" };
  const live = { screen: "a", phrase: "Esc cancels", owner: "test" }, stale = { screen: "b", phrase: "Esc cancels", owner: "test" };
  expect(applyEscExceptions([problem], [live, stale])).toEqual({ unexcused: [], stale: [stale] });
  expect(applyEscExceptions([problem], [])).toEqual({ unexcused: [problem], stale: [] });
});

test("every catalog golden uses Esc verbs from the voice guide", async () => {
  const root = join(import.meta.dir, "screen-catalog/goldens");
  const files = (await readdir(root, { recursive: true })).filter(file => file.endsWith(".golden")).sort();
  const problems: ScreenProblem[] = [];
  for (const file of files) {
    const screen = parseScreen(await readFile(join(root, file), "utf8"));
    for (const problem of escPhraseProblems(screen.text)) problems.push({ ...problem, file, screen: screen.screen, variant: screen.variant });
  }
  for (const exception of ESC_EXCEPTIONS) expect(exception.owner).toMatch(/^[A-Z]\d+ #\d+ \S/);
  const { unexcused, stale } = applyEscExceptions(problems, ESC_EXCEPTIONS);
  expect(unexcused.map(problem => `${problem.file}:${problem.row + 1}: ${problem.phrase} (${problem.problem})`)).toEqual([]);
  expect(stale.map(entry => `${entry.screen}: ${entry.phrase} (${entry.owner}) no longer matches a golden; delete it`)).toEqual([]);
});
