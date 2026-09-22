import type { ToolDefinition } from "../tools/types.ts";

/** Public JSON Schema and invocation contracts shared with native tools. */
export type {
  JsonSchema, ToolContext, ToolDefinition, ToolExecutionMode,
  ToolExecutionResult, ToolOutputChunk,
} from "../tools/types.ts";
/** Canonical primary workspace and launch paths supplied to tool invocations. */
export type { Workspace } from "../workspace/workspace.ts";

/** Capabilities available only while an explicitly enabled extension initializes. */
export interface ExtensionContext {
  /** Register a custom tool atomically with this module's other tools before initialization finishes. */
  registerTool<TInput = unknown>(tool: ToolDefinition<TInput>): void;
}

/** Default module initializer that registers tools without replacing harness infrastructure. */
export type Extension = (context: ExtensionContext) => void | Promise<void>;

/** Type-check and return an extension initializer without running it. */
export function defineExtension(extension: Extension): Extension {
  return extension;
}
