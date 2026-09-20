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
