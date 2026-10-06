import { fitLine } from "./presentation.ts";

// Conversation find (Ctrl+F) and reader find share these words. The key handlers in view.ts move ↑/Ctrl+P to the
// previous match and ↓/Ctrl+N to the next, wrapping at both ends; Enter closes find at the selected match; Esc puts
// back the position (and draft) from before find opened.

/** Arrow hint shown only while a match is selected: ↑ goes to the previous match, ↓ to the next. */
export const FIND_ARROWS = "↑↓ previous/next";
/** Enter hint shown only while a match is selected: close find and stay at that match. */
export const FIND_KEEP = "Enter keep";
/** Esc hint for find in every state: discard the find and restore the earlier position. */
export const FIND_RESTORE = "Esc restore";
/** The one scope phrase conversation find uses; it searches the active branch as rendered. */
export const CONVERSATION_FIND_SCOPE = "this branch";
/** Composer placeholder while conversation find has an empty query. */
export const CONVERSATION_FIND_PLACEHOLDER = `Find in ${CONVERSATION_FIND_SCOPE}…`;

/** Conversation find hint row; the arrows and Enter keep appear only while a match is selected, because they do nothing otherwise. */
export function conversationFindHint(selected: boolean, escape = FIND_RESTORE): string {
  return [...selected ? [FIND_ARROWS, FIND_KEEP] : [], escape, "Ctrl+End latest"].join(" · ");
}

/** Reader find hint segments after its leading Esc phrase; empty unless a match is selected. Enter precedes the arrows so narrow rows drop the arrows first. */
export function readerFindKeys(selected: boolean): string[] {
  return selected ? [FIND_KEEP, FIND_ARROWS] : [];
}

/** Conversation find status: at most six words naming the scope (and count) before the next action and its Esc phrase. */
export function conversationFindStatus(state: { query: string; selected: number; count: number; limited: boolean; escape?: string }): string {
  const escape = state.escape ?? FIND_RESTORE;
  const limited = state.limited ? " (limited)" : "";
  if (!state.query) return `Find in ${CONVERSATION_FIND_SCOPE} · Type a query · ${escape}`;
  if (state.count) return `Find ${state.selected + 1}/${state.count}${state.limited ? "+" : ""} in ${CONVERSATION_FIND_SCOPE}${limited} · ${escape}`;
  return `No matches in ${CONVERSATION_FIND_SCOPE}${limited} · Edit query · ${escape}`;
}

/**
 * Fit a find status to `columns` by dropping whole trailing ` · ` segments, so a key never loses its verb and Esc is
 * never clipped; the hint row or status bar still names Esc. Only the leading status may be clipped, as a last resort.
 */
export function fitFindStatus(text: string, columns: number): string {
  const segments = text.split(" · ");
  while (segments.length > 1 && Bun.stringWidth(segments.join(" · ")) > columns) segments.pop();
  return fitLine(segments.join(" · "), columns);
}
