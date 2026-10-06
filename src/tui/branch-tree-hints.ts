/** Safety note the branch tree keeps visible at every width: confirming changes conversation ancestry only. */
export const BRANCH_TREE_FILES_NOTE = "Files/Git unchanged";

/** The branch tree's only Esc phrase: closing it restores the draft, cursor and reading position. */
export const BRANCH_TREE_ESC = "Esc back";

/** Arrow keys browse paths or fork points and preview each one without activating it. */
export const BRANCH_TREE_ARROWS = "↑↓ preview";

/** Tab's one label for a mode: from continuing an existing path to a new fork, and back. */
export function branchTreeTabHint(continuing: boolean): string {
  return continuing ? "Tab new fork" : "Tab existing";
}

/** Enter's label for a mode: continue the selected path, or fork at the selected turn. */
export function branchTreeEnterHint(continuing: boolean): string {
  return continuing ? "Enter continue" : "Enter fork";
}

/** The first option that fits `columns` cells, or the last (shortest) option. */
const firstFitting = (options: readonly string[], columns: number) => options.find(option => Bun.stringWidth(option) <= columns) ?? options.at(-1)!;

/** In-panel mode line within `columns`; the mode name shortens or drops before the Tab action is cut. */
export function branchTreeModeLine(continuing: boolean, columns: number): string {
  const tab = branchTreeTabHint(continuing);
  return firstFitting(continuing ? [`Continue existing · ${tab}`, `Continue · ${tab}`, tab] : [`New fork · ${tab}`, tab], columns);
}

/** Composer placeholder within `columns` that always names the mode's Tab action and never wraps. */
export function branchTreePlaceholder(continuing: boolean, columns: number): string {
  const tab = branchTreeTabHint(continuing);
  return firstFitting(continuing ? [`Continue · ${tab}`, tab] : [`Fork name · ${tab}`, `Name · ${tab}`, tab], columns);
}

/** True when a hint row of `columns` cells cannot hold both the Files/Git note and Esc back, so Esc moves to the status bar. */
export function branchTreeEscInStatusBar(columns: number): boolean {
  return Bun.stringWidth(`${BRANCH_TREE_FILES_NOTE} · ${BRANCH_TREE_ESC}`) > columns;
}

/**
 * The branch tree's hint row within `columns` cells. Arrows drop first, then Enter, then Tab. The Files/Git note
 * never drops; Esc back drops last, and only when `escInStatusBar` says the status bar names it instead.
 */
export function branchTreeHint(continuing: boolean, columns: number, escInStatusBar: boolean): string {
  const enter = branchTreeEnterHint(continuing), tab = branchTreeTabHint(continuing);
  const segments = [BRANCH_TREE_FILES_NOTE, BRANCH_TREE_ARROWS, enter, tab, BRANCH_TREE_ESC];
  const fits = () => Bun.stringWidth(segments.join(" · ")) <= columns;
  for (const droppable of [BRANCH_TREE_ARROWS, enter, tab, ...(escInStatusBar ? [BRANCH_TREE_ESC] : [])]) {
    if (fits()) break;
    segments.splice(segments.indexOf(droppable), 1);
  }
  return segments.join(" · ");
}
