import { fitLine } from "./presentation.ts";

/** Rows of preview a short request keeps before the choices it does not select appear. */
const PREVIEW_KEEP_ROWS = 3;

/** The three tool approval choices in selection order; index 0 is the default. */
export function approvalChoices(toolName: string): readonly [string, string, string] {
  return ["Allow once", `Allow ${toolName} for this session`, "Deny with reason…"];
}

/** What Enter does now: the selected choice's verb, or sending the typed reason while one is entered. */
export function approvalEnterVerb(selected: number, enteringReason: boolean): string {
  if (enteringReason) return "deny with reason";
  return selected === 1 ? "allow for session" : selected === 2 ? "add reason" : "allow once";
}

/** The approval's live Enter meaning and its deny key, the action a compact footer keeps. */
export function approvalAction(selected: number, enteringReason: boolean): string {
  return `Enter ${approvalEnterVerb(selected, enteringReason)} · Esc deny`;
}

/** The approval hint row: choice keys, Enter's meaning and Esc deny, plus paging only when the preview overflows. */
export function approvalHint(selected: number, enteringReason: boolean, overflow: boolean): string {
  return `${enteringReason ? "" : "↑↓ choose · "}${approvalAction(selected, enteringReason)}${overflow ? " · PgUp/PgDn scroll" : ""}`;
}

/** Count terminal rows for greedy word wrapping at `columns`, splitting words wider than a row; a leading indent takes cells. */
export function wrappedRows(text: string, columns: number): number {
  const width = Math.max(1, columns);
  return text.split("\n").reduce((total, line) => {
    let rows = 1, column = 0, gap = 0, start = true;
    for (const token of line.split(/( +)/)) {
      if (!token) continue;
      // The renderer keeps a line's leading indent, so it occupies cells before the first word.
      if (token.startsWith(" ")) { if (start) column = Math.min(width, token.length); else gap = token.length; start = false; continue; }
      start = false;
      const cells = Bun.stringWidth(token);
      if (column > 0 && column + gap + cells <= width) { column += gap + cells; gap = 0; continue; }
      if (column > 0) { rows++; column = 0; }
      gap = 0;
      rows += Math.max(0, Math.ceil(cells / width) - 1);
      column = cells % width || width;
    }
    return total + rows;
  }, 0);
}

/** Count terminal rows for character wrapping at `columns`; an empty line still takes a row. */
export function charWrappedRows(text: string, columns: number): number {
  const width = Math.max(1, columns);
  return text.split("\n").reduce((total, line) => total + Math.max(1, Math.ceil(Bun.stringWidth(line) / width)), 0);
}

/** One painted approval choice row. */
export interface ApprovalChoiceRow { text: string; selected: boolean }

/** How the approval panel spends its rows; the heading, one preview row and the selected choice always come first. */
export interface ApprovalPanelLayout {
  /** Heading text, fitted to one row when the full heading would crowd out the request. */
  heading: string;
  headingRows: number;
  /** Blank row under the heading. */
  headingMargin: boolean;
  /** Blank row above the choices. */
  choicesMargin: boolean;
  /** Every choice, or only the selected one with its position when the others are hidden. */
  choices: ApprovalChoiceRow[];
  choiceRows: number;
  /** Rows the scrolling preview receives. */
  previewRows: number;
  /** True when the preview has more rows than it shows. */
  overflow: boolean;
  /** True when the heading, a preview row and the selected choice all fit; Enter must not act otherwise. */
  fits: boolean;
}

/** Spend `rows` on the heading, one preview row and the selected choice first; short panels give up margins, then unselected choices, then preview rows down to one. */
export function approvalPanelLayout(input: { heading: string; choices: readonly string[]; selected: number; previewRows: number; rows: number; columns: number }): ApprovalPanelLayout {
  const columns = Math.max(1, input.columns), rows = Math.max(0, input.rows);
  const selected = Math.max(0, Math.min(input.choices.length - 1, input.selected));
  const row = (choice: string, index: number) => `${index === selected ? "›" : " "} ${choice}`;
  const all = input.choices.map((choice, index) => ({ text: row(choice, index), selected: index === selected }));
  const allRows = all.reduce((sum, choice) => sum + wrappedRows(choice.text, columns), 0);
  const alone = [{ text: `${row(input.choices[selected]!, selected)}  (${selected + 1} of ${input.choices.length})`, selected: true }];
  const aloneRows = wrappedRows(alone[0]!.text, columns);
  let heading = input.heading, headingRows = wrappedRows(heading, columns);
  if (headingRows > 1 && headingRows + aloneRows + 1 > rows) { heading = fitLine(heading, columns); headingRows = 1; }
  const natural = Math.max(1, input.previewRows);
  // Mandatory: heading, one preview row and the selected choice.
  let used = headingRows + 1 + aloneRows;
  const fits = used <= rows;
  // A short preview keeps up to three rows before the unselected choices return, so a one-line edit stays whole.
  const kept = Math.max(0, Math.min(Math.min(natural, PREVIEW_KEEP_ROWS) - 1, rows - used));
  used += kept;
  const showAll = used - aloneRows + allRows <= rows;
  if (showAll) used += allRows - aloneRows;
  // Margins are given up first: they take only rows left once the whole preview is shown, never rows a cut preview or a hidden choice could use.
  const spare = rows - used - (natural - 1 - kept);
  const choicesMargin = spare >= 1, headingMargin = spare >= 2;
  used += (choicesMargin ? 1 : 0) + (headingMargin ? 1 : 0);
  const previewRows = Math.max(1, rows - (used - 1 - kept));
  return { heading, headingRows, headingMargin, choicesMargin, choices: showAll ? all : alone, choiceRows: showAll ? allRows : aloneRows, previewRows, overflow: natural > previewRows, fits };
}
