import type { AssistantMessage, ConversationItem } from "../conversation/types.ts";
import type { ContextSection } from "../context/manager.ts";

export interface ModelTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  systemPrompt: string;
  context: readonly ContextSection[];
  items: readonly ConversationItem[];
  tools?: readonly ModelTool[];
  signal?: AbortSignal;
}

export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "message_complete"; message: AssistantMessage };

export interface Model {
  readonly provider: string;
  readonly id: string;
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}
