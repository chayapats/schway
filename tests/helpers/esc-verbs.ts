/** One Esc meaning from the voice guide's `## Esc verbs` table, plus the short objects a hint may add after the verb. */
export interface EscVerb {
  /** Imperative verb written after `Esc` in a hint or action row. */
  verb: string;
  /** The guide's `Use when Esc…` definition, verbatim. */
  use: string;
  /** The guide's example phrase, verbatim and without backticks. */
  example: string;
  /** Objects allowed after the verb, each naming the target or destination. */
  objects: readonly string[];
}

/** The Esc verb glossary shared by the copy lint and the contributor guide; both must list the same rows. */
export const ESC_VERBS: readonly EscVerb[] = [
  { verb: "stop", use: "interrupts agent work that is running now, such as a turn, tool, retry wait or compaction. Partial results stay.", example: "Esc stop", objects: [] },
  { verb: "cancel", use: "abandons an unfinished flow or pending change before it applies, so nothing is saved, signed in or undone.", example: "Esc cancel sign-in", objects: ["sign-in"] },
  { verb: "deny", use: "rejects the pending tool approval request, so the turn continues without that tool.", example: "Esc deny", objects: [] },
  { verb: "back", use: "leaves a view that changed nothing, one level at a time, until the composer returns with the same draft and reading position.", example: "Esc back", objects: ["to request"] },
  { verb: "restore", use: "discards a provisional find or palette position or query and puts back what was there before. It sits beside an Enter that keeps the result.", example: "Esc restore", objects: [] },
  { verb: "keep editing", use: "closes a notice or suggestion list over the composer. The draft and cursor stay as typed.", example: "Esc keep editing", objects: [] },
];

/** Words that never follow `Esc` in a hint because a table verb already names the meaning. */
export const ESC_BANNED_SYNONYMS = ["close", "dismiss", "exit", "quit", "return", "editor", "basic"] as const;

/** One rendered Esc phrase that does not start with a complete phrase from the glossary. */
export interface EscPhraseProblem {
  /** Zero-based row of the `Esc` token. */
  row: number;
  /** The phrase as read, joined across a word wrap when the row ended mid-phrase. */
  phrase: string;
  /** Why the phrase fails: third person, banned synonym, bare, truncated or unknown. */
  problem: string;
}

const phrases = ESC_VERBS.flatMap(({ verb, objects }) => [verb, ...objects.map(object => `${verb} ${object}`)])
  .sort((a, b) => b.length - a.length);
// A phrase ends at the line end, a ` · ` separator, a column gap, closing punctuation or a panel edge glyph.
const boundary = /^(?:$|\s*$| · | {2}|[.,;:)]|\s*[│┃█▐▌▀▄])/;
// A key list such as the help palette's `Esc or Ctrl+C` shortcut column names keys, not an action.
const keyList = /^ or (?:Ctrl|Alt|Shift)\+\S+(?= {2}|\s*$)/;
const wrapGutter = /^[\s▌]+/;

/** Return the glossary phrase that `rest` (the text after `Esc`) starts with, or undefined. */
function complete(rest: string): string | undefined {
  return phrases.find(phrase => rest.startsWith(` ${phrase}`) && boundary.test(rest.slice(phrase.length + 1)));
}

/** True when `rest` ends the row partway through a glossary phrase, so the next row may continue it. */
function partial(rest: string): boolean {
  const words = rest.trim();
  return words === "" || phrases.some(phrase => phrase.startsWith(`${words} `));
}

/** The reported phrase stops at the next separator or column gap. */
function clip(rest: string): string {
  return rest.split(/ · | {2}/)[0]!.trimEnd();
}

function classify(rest: string): string {
  const word = /^ (\S*)/.exec(rest)?.[1] ?? "";
  if (!word) return "bare Esc with no verb";
  if (word.includes("…")) return "truncated Esc phrase";
  if ((ESC_BANNED_SYNONYMS as readonly string[]).includes(word.toLowerCase())) return `banned synonym "${word}"`;
  const thirdPerson = (base: string) => [`${base}s`, `${base}es`, ...(base.endsWith("y") ? [`${base.slice(0, -1)}ies`] : [])];
  if (ESC_VERBS.some(({ verb }) => thirdPerson(verb.split(" ")[0]!).includes(word))) return `third-person verb "${word}"`;
  return "not a phrase from the Esc verbs table";
}

/**
 * Check every `Esc` token in rendered rows against the glossary. A row that ends on `Esc` or partway through a
 * phrase is joined with the next row (leading spaces and the `▌` gutter removed) before it is judged.
 */
export function escPhraseProblems(rows: readonly string[]): EscPhraseProblem[] {
  const problems: EscPhraseProblem[] = [];
  rows.forEach((line, row) => {
    for (const match of line.matchAll(/(?<![A-Za-z])Esc(?![A-Za-z])/g)) {
      const rest = line.slice(match.index + 3);
      if (keyList.test(rest) || complete(rest)) continue;
      const next = rows[row + 1];
      if (partial(rest) && next !== undefined) {
        const joined = `${rest.trimEnd()} ${next.replace(wrapGutter, "")}`;
        if (complete(joined)) continue;
        problems.push({ row, phrase: `Esc${clip(joined)}`, problem: classify(joined) });
        continue;
      }
      problems.push({ row, phrase: `Esc${clip(rest)}`, problem: classify(rest) });
    }
  });
  return problems;
}
