import type { AssistantMessage, ConversationItem } from "../conversation/types.ts";
import type { ContextSection } from "../context/manager.ts";

/** Tool description sent to a provider adapter. No execute function. */
export interface ModelTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Provider-independent model request built by the agent loop. */
export interface ModelRequest {
  systemPrompt: string;
  context: readonly ContextSection[];
  items: readonly ConversationItem[];
  tools?: readonly ModelTool[];
  signal?: AbortSignal;
}

/** Incremental stream events plus the assembled assistant message. */
export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "message_complete"; message: AssistantMessage };

/** Schway model surface. Adapters convert to and from provider wire types. */
export interface Model {
  readonly provider: string;
  readonly id: string;
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}
