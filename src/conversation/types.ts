import type { ModelUsage } from "../model/model.ts";

/** Opaque adapter-owned data preserved alongside Schway's provider-independent conversation records. */
export type ProviderMetadata = Record<string, unknown>;

/** Plain text carried in a user or assistant message. */
export interface TextContent {
  type: "text";
  text: string;
}

/** Assistant reasoning text with optional opaque metadata needed for provider replay. */
export interface ThinkingContent {
  type: "thinking";
  text: string;
  providerMetadata?: ProviderMetadata;
}

/** Requested tool invocation whose id links its result and whose arguments require tool-schema validation. */
export interface ToolCallContent {
  type: "tool_call";
  id: string;
  name: string;
  arguments: unknown;
  providerMetadata?: ProviderMetadata;
}

/** Content accepted in user messages, currently limited to plain text. */
export type UserContent = TextContent;
/** Allowed assistant content block: text, reasoning, or a requested tool invocation. */
export type AssistantContent = TextContent | ThinkingContent | ToolCallContent;

/** Identified user input stored in session history and sent to the model. */
export interface UserMessage {
  type: "user";
  id: string;
  content: UserContent[];
}

/** Harness-measured timing and reported usage of the model call that produced a message; never sent to a provider. Durations are whole milliseconds. */
export interface AssistantTelemetry {
  /** ISO wall-clock start of the first attempt. */
  startedAt: string;
  /** Time from the successful attempt's start to its first text or thinking delta; null when none arrived before completion. */
  firstDeltaMs: number | null;
  /** Time from the successful attempt's start to the end of its stream. */
  attemptMs: number;
  /** Time from the first attempt's start to completion, including failed attempts and backoff. */
  totalMs: number;
  /** One plus the number of transient retries. */
  attempts: number;
  /** Total backoff waited between attempts. */
  retryWaitMs: number;
  /** Final usage the successful attempt reported; null or absent counts were not reported. */
  usage: ModelUsage;
}

/** Assembled assistant output with ordered content blocks and opaque metadata retained for adapter replay. */
export interface AssistantMessage {
  type: "assistant";
  id: string;
  content: AssistantContent[];
  providerMetadata?: ProviderMetadata;
  /** Harness telemetry of the model call; absent on older records and never part of model context. */
  telemetry?: AssistantTelemetry;
}

/** Harness-measured timing of one tool call from scheduler start to settlement, in whole milliseconds; never sent to a provider. */
export interface ToolTelemetry {
  /** ISO wall-clock time the scheduler started the call. */
  startedAt: string;
  /** Wall time from scheduler start to settlement, including any approval wait. */
  durationMs: number;
  /** Part of `durationMs` spent waiting for approval; absent when the call did not wait. */
  approvalWaitMs?: number;
}

/** Model-facing outcome linked to a tool-call id, with errors marked explicitly. */
export interface ToolResult {
  type: "tool_result";
  id: string;
  toolCallId: string;
  content: string;
  isError: boolean;
  /** Harness telemetry of the call; absent on older records and on results that never ran. */
  telemetry?: ToolTelemetry;
}

/** Provider-independent message or tool outcome that may be included in model context. */
export type ConversationItem = UserMessage | AssistantMessage | ToolResult;

/** Durable compaction marker. Never sent to providers; used to rebuild effective context. */
export interface CompactionRecord {
  type: "compaction";
  id: string;
  summary: string;
  firstKeptId: string;
  tokensBefore?: number;
  /** Prior compaction record this summary builds on; absent for the first compaction. */
  parentCompactionId?: string;
}

/** Any durable conversation entry, compaction boundary or file undo outcome. */
export type SessionRecord = ConversationItem | CompactionRecord | TurnUndoRecord;

/** Durable file revert outcome and model-visible note, without rewinding conversation history. */
export interface TurnUndoRecord {
  type: "turn_undo";
  id: string;
  turnId: string;
  turnNumber: number;
  reverted: { path: string; action: "restored" | "deleted" }[];
  skipped: { path: string; reason: "changed" | "failed" }[];
  note: string;
}

/** True for durable turn undo outcomes that become user notes in model context. */
export function isTurnUndoRecord(value: SessionRecord): value is TurnUndoRecord {
  return value.type === "turn_undo";
}

/** True for durable compaction markers. */
export function isCompactionRecord(
  value: SessionRecord,
): value is CompactionRecord {
  return value.type === "compaction";
}

/** True for model-facing conversation items. */
export function isConversationItem(
  value: SessionRecord,
): value is ConversationItem {
  return value.type !== "compaction" && value.type !== "turn_undo";
}
