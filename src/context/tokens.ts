import type {
  ConversationItem,
  SessionRecord,
} from "../conversation/types.ts";
import { isConversationItem } from "../conversation/types.ts";

/** Characters per token for the deterministic estimator. Swap for a real tokenizer later. */
export const CHARS_PER_TOKEN = 4;

/** Estimate tokens for plain text with a stable ceiling division. */
export function estimateTextTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Estimate tokens for one model-facing conversation item. */
export function estimateItemTokens(item: ConversationItem): number {
  if (item.type === "user") {
    return item.content.reduce(
      (sum, block) => sum + (block.type === "text" ? estimateTextTokens(block.text) : 1024 + Math.ceil(block.width * block.height / 256)),
      0,
    );
  }
  if (item.type === "assistant") {
    return item.content.reduce((sum, block) => {
      if (block.type === "text" || block.type === "thinking") {
        return sum + estimateTextTokens(block.text);
      }
      return (
        sum +
        estimateTextTokens(block.name) +
        estimateTextTokens(JSON.stringify(block.arguments ?? null))
      );
    }, 0);
  }
  return estimateTextTokens(item.content);
}

/** Estimate tokens for durable records, skipping compaction markers. */
export function estimateSessionTokens(items: readonly SessionRecord[]): number {
  let total = 0;
  for (const item of items) {
    if (item.type === "turn_undo") { total += estimateTextTokens(item.note); continue; }
    if (!isConversationItem(item)) {
      continue;
    }
    total += estimateItemTokens(item);
  }
  return total;
}

/** Estimate the full model input: system prompt plus context plus conversation. */
export function estimatePreparedTokens(input: {
  systemPrompt: string;
  context: ReadonlyArray<{ name: string; content: string }>;
  items: readonly ConversationItem[];
}): number {
  let total = estimateTextTokens(input.systemPrompt);
  for (const section of input.context) {
    total += estimateTextTokens(section.name);
    total += estimateTextTokens(section.content);
  }
  for (const item of input.items) {
    total += estimateItemTokens(item);
  }
  return total;
}
