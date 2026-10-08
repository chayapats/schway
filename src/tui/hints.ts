import { bg, bold, fg, type TextChunk } from "@opentui/core";
import { HINT_KEY } from "./hint-text.ts";

export { APPROVAL_RETURN_HINT, HINT_KEY, fitHintSegments, wrapHintSegments } from "./hint-text.ts";

/** Style "Key action · Key action" hints as tight key chips and muted actions; the plain text is unchanged. */
export function keyHintChunks(text: string, colors: { key: string; chip: string; action: string }): TextChunk[] {
  return text.split(" · ").flatMap((segment, index) => {
    const separator = index ? [fg(colors.action)(" · ")] : [];
    const space = segment.indexOf(" ");
    const key = space < 0 ? segment : segment.slice(0, space);
    if (!HINT_KEY.test(key)) return [...separator, fg(colors.action)(segment)];
    return [...separator, bold(bg(colors.chip)(fg(colors.key)(key))), fg(colors.action)(space < 0 ? "" : segment.slice(space))];
  });
}
