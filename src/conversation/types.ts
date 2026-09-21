export type ProviderMetadata = Record<string, unknown>;

export interface TextContent {
  type: "text";
  text: string;
}

export interface ThinkingContent {
  type: "thinking";
  text: string;
  providerMetadata?: ProviderMetadata;
}

export interface ToolCallContent {
  type: "tool_call";
  id: string;
  name: string;
  arguments: unknown;
  providerMetadata?: ProviderMetadata;
}

export type UserContent = TextContent;
export type AssistantContent = TextContent | ThinkingContent | ToolCallContent;

export interface UserMessage {
  type: "user";
  id: string;
  content: UserContent[];
}

export interface AssistantMessage {
  type: "assistant";
  id: string;
  content: AssistantContent[];
  providerMetadata?: ProviderMetadata;
}

export interface ToolResult {
  type: "tool_result";
  id: string;
  toolCallId: string;
  content: string;
  isError: boolean;
}

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

/** Any durable session entry: model-facing conversation or compaction marker. */
export type SessionRecord = ConversationItem | CompactionRecord;

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
  return value.type !== "compaction";
}
