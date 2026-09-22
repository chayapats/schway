import type {
  CompactionRecord,
  ConversationItem,
  SessionRecord,
} from "../conversation/types.ts";
import { isCompactionRecord } from "../conversation/types.ts";

/** Reason a compaction runs; surfaced to presentation clients and events. */
export type CompactionReason = "pressure" | "manual" | "overflow";

/** Default number of recent user-delimited turns retained when older turns become summary input. */
export const COMPACTION_KEEP_TURNS = 10;

/** Fraction of the context window that triggers pressure compaction. */
export const COMPACTION_PRESSURE_THRESHOLD = 0.8;

/** Per tool-result cap applied only to summarization input, never to history. */
export const SUMMARY_PRUNE_CHARS = 8_000;

/** Dynamic context section name carrying the durable summary. */
export const SUMMARY_SECTION_NAME = "summary";

/** System prompt requesting a coding-oriented summary with named progress and file sections. */
export const SUMMARY_SYSTEM_PROMPT = [
  "You summarize a long coding session so work can continue from the summary plus recent turns.",
  "Write markdown with exactly these sections:",
  "## Goal",
  "## Constraints",
  "## Progress",
  "## Key Decisions",
  "## Current State",
  "## Next Steps",
  "## Files",
  "### Read",
  "### Modified",
  "Be concrete and coding-oriented. Preserve file paths, decisions, and next steps.",
  "Do not invent work that is not in the history.",
].join("\n");

/** Consecutive conversation items grouped by user-message boundaries, without validating turn completeness. */
export interface CompactionTurn {
  items: ConversationItem[];
}

/** Group conversation items at user messages, retaining any leading or unfinished group. */
export function splitIntoTurns(
  items: readonly ConversationItem[],
): CompactionTurn[] {
  const turns: CompactionTurn[] = [];
  let current: ConversationItem[] = [];
  for (const item of items) {
    if (item.type === "user" && current.length > 0) {
      turns.push({ items: current });
      current = [];
    }
    current.push(item);
  }
  if (current.length > 0) {
    turns.push({ items: current });
  }
  return turns;
}

/** Return the first retained id and older-turn count, or null when the requested retention leaves nothing to compact. */
export function findCompactionBoundary(
  conversation: readonly ConversationItem[],
  keepTurns: number = COMPACTION_KEEP_TURNS,
): { firstKeptId: string; compactedTurns: number } | null {
  if (keepTurns < 1) {
    return null;
  }
  const turns = splitIntoTurns(conversation);
  if (turns.length <= keepTurns) {
    return null;
  }
  const boundary = turns[turns.length - keepTurns];
  const first = boundary?.items[0];
  if (!boundary || !first) {
    return null;
  }
  return { firstKeptId: first.id, compactedTurns: turns.length - keepTurns };
}

/** Copy conversation for summarization, truncating oversized tool output only here. */
export function pruneForSummary(
  items: readonly ConversationItem[],
  maxChars: number = SUMMARY_PRUNE_CHARS,
): ConversationItem[] {
  return items.map((item) => {
    if (item.type !== "tool_result" || item.content.length <= maxChars) {
      return item;
    }
    return {
      ...item,
      content: `${item.content.slice(0, maxChars)}\n... [truncated for summarization]`,
    };
  });
}

/** Latest durable compaction marker, scanning from the tip. */
export function getLatestCompaction(
  records: readonly SessionRecord[],
): CompactionRecord | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record && isCompactionRecord(record)) {
      return record;
    }
  }
  return undefined;
}

/** Latest durable summary, if any compaction has run. */
export function getEffectiveSummary(
  records: readonly SessionRecord[],
): string | undefined {
  return getLatestCompaction(records)?.summary;
}

/**
 * Return conversation from the latest compaction boundary, excluding compaction markers.
 * If the boundary id is missing, retain only conversation records after that marker.
 */
export function getEffectiveConversation(
  records: readonly SessionRecord[],
): ConversationItem[] {
  const conversation: ConversationItem[] = [];
  const positions: number[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (!isCompactionRecord(record)) {
      conversation.push(record);
      positions.push(i);
    }
  }
  const latest = getLatestCompaction(records);
  if (!latest) {
    return conversation;
  }
  const byId = conversation.findIndex((item) => item.id === latest.firstKeptId);
  if (byId >= 0) {
    return conversation.slice(byId);
  }
  // firstKeptId missing (corrupt/hand-edited history): keep records after the marker.
  const markerIndex = records.lastIndexOf(latest);
  const retained: ConversationItem[] = [];
  for (let k = 0; k < conversation.length; k++) {
    if (positions[k]! > markerIndex) {
      retained.push(conversation[k]!);
    }
  }
  return retained;
}

/** Render one conversation item as summarizer-facing text. */
export function formatItemForSummary(item: ConversationItem): string {
  if (item.type === "user") {
    return `User:\n${item.content.map((block) => block.text).join("\n")}`;
  }
  if (item.type === "tool_result") {
    return `Tool result (${item.toolCallId}${item.isError ? ", error" : ""}):\n${item.content}`;
  }
  const parts: string[] = [];
  for (const block of item.content) {
    if (block.type === "text" || block.type === "thinking") {
      parts.push(block.text);
    } else {
      parts.push(
        `Tool call ${block.name} (${block.id}): ${JSON.stringify(block.arguments ?? null)}`,
      );
    }
  }
  return `Assistant:\n${parts.join("\n")}`;
}

/** Build summarizer input from the previous summary plus newly compacted turns. */
export function buildSummaryInputText(input: {
  previousSummary?: string;
  compacted: readonly ConversationItem[];
}): string {
  const sections: string[] = [];
  if (input.previousSummary) {
    sections.push(
      `Previous summary (already covers older history):\n${input.previousSummary}`,
    );
  }
  const body = input.compacted.map(formatItemForSummary).join("\n\n");
  sections.push(`History to summarize:\n${body}`);
  sections.push(
    "Summarize the history above into the required Goal/Constraints/Progress/Key Decisions/Current State/Next Steps/Files structure.",
  );
  return sections.join("\n\n");
}
