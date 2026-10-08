import type { ConversationItem, ToolResult } from "../conversation/types.ts";
import { utf8ByteLength, utf8Prefix } from "../tools/output-budget.ts";
import { splitIntoTurns } from "./compaction.ts";

/** UTF-8 bytes kept from each tool result of an earlier user turn when it is replayed to the model. */
export const REPLAY_TOOL_RESULT_BYTES = 8_000;

/**
 * Copy of `item` whose content keeps its first `maxBytes` UTF-8 bytes (code-point safe) plus a fixed notice.
 * A pure function of the content, so every later request replays the same bytes; results that fit, or would not get smaller, are returned as is.
 */
export function shortenToolResultForReplay(
  item: ToolResult,
  maxBytes: number = REPLAY_TOOL_RESULT_BYTES,
): ToolResult {
  const total = utf8ByteLength(item.content);
  if (total <= maxBytes) return item;
  const content = `${utf8Prefix(item.content, maxBytes)}\n\n[Earlier output shortened from ${total} bytes. Run the call again if you need the full text.]`;
  return utf8ByteLength(content) < total ? { ...item, content } : item;
}

/**
 * Request-only copy of `items` in which tool results before the latest user message are shortened for replay.
 * The turn in progress, every other item and the input array are left unchanged; undo notes do not start a turn.
 */
export function shortenEarlierTurnToolResults(
  items: readonly ConversationItem[],
  maxBytes: number = REPLAY_TOOL_RESULT_BYTES,
): ConversationItem[] {
  const turns = splitIntoTurns(items);
  if (turns.length < 2) return [...items];
  const currentStart = items.length - turns.at(-1)!.items.length;
  return items.map((item, index) =>
    index < currentStart && item.type === "tool_result"
      ? shortenToolResultForReplay(item, maxBytes)
      : item,
  );
}
