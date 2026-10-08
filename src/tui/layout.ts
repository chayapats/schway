// Terminal widths at which the view changes layout. Every rule reads its width from here, in terminal columns, so a
// breakpoint sweep can render one column either side of each switch point.

/** Each width, in terminal columns, at which the view changes layout; a rule switches exactly at its value. */
export const LAYOUT_BREAKPOINTS = Object.freeze({
  /** Below this the status bar is compact (mode and one action), the running placeholder is short and the approval panel moves Esc deny out of the status bar. */
  compactStatusBar: 30,
  /** Below this the status pill uses its compact label. */
  compactStatusPill: 34,
  /** From this width the top bar shows the Git branch. */
  topBarBranch: 40,
  /** From this width the approval activity row reads "Approval required" instead of "Approval". */
  approvalRequiredLabel: 42,
  /** Below this the preferences panel shows its compact rows. */
  compactPreferences: 45,
  /** Below this the session picker query uses its short placeholder. */
  shortSessionPlaceholder: 50,
  /** From this width the body has two padding columns on each side instead of one. */
  wideBodyPadding: 60,
  /** From this width each history list row takes one line instead of two. */
  oneLineHistoryRows: 64,
  /** From this width the context meter has 10 cells instead of 5 and the composer hint names tools and commands. */
  fullComposerHint: 70,
  /** From this width the review panel shows files beside the diff instead of above it. */
  reviewSideBySide: 80,
  /** From this width history list columns use their full forms instead of compact ones. */
  fullHistoryColumns: 104,
});

/** Name of one entry in `LAYOUT_BREAKPOINTS`. */
export type LayoutBreakpoint = keyof typeof LAYOUT_BREAKPOINTS;

/** Body padding columns on each side at `columns` terminal columns: 1 below `wideBodyPadding`, otherwise 2. */
export function bodyPadding(columns: number): number {
  return columns < LAYOUT_BREAKPOINTS.wideBodyPadding ? 1 : 2;
}

// Rules that compare the body width compare it with `bodyWidth(breakpoint)`, which keeps their switch at the
// breakpoint's terminal width; no such breakpoint sits where the padding change makes this width step back (60 columns).
/** Content width inside the body padding at `columns` terminal columns, never below 8. */
export function bodyWidth(columns: number): number {
  return Math.max(8, columns - 2 * bodyPadding(columns));
}
