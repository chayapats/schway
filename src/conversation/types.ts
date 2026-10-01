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

/** Assembled assistant output with ordered content blocks and opaque metadata retained for adapter replay. */
export interface AssistantMessage {
  type: "assistant";
  id: string;
  content: AssistantContent[];
  providerMetadata?: ProviderMetadata;
}

/** Model-facing outcome linked to a tool-call id, with errors marked explicitly. */
export interface ToolResult {
  type: "tool_result";
  id: string;
  toolCallId: string;
  content: string;
  isError: boolean;
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
