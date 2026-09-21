import {
  discoverAgentsInstructions,
  formatAgentsInstructions,
} from "./agents.ts";
import { assembleSystemPrompt } from "./prompt.ts";
import type { ConversationItem } from "../conversation/types.ts";
import type { Session } from "../session/session.ts";
import { resolveToolPath } from "../tools/path.ts";
import type { Workspace } from "../workspace/workspace.ts";

/** Named block of volatile context sent with a model request. */
export interface ContextSection {
  name: string;
  content: string;
}

/** Fresh system prompt, dynamic context, and durable conversation items. */
export interface PreparedContext {
  systemPrompt: string;
  context: ContextSection[];
  items: readonly ConversationItem[];
}

/** Builds a model request payload that is not persisted into session history. */
export interface ContextManager {
  /** Assemble system prompt and dynamic context for the current session. */
  prepare(session: Session): Promise<PreparedContext>;
}

/** Create a context manager bound to one workspace and optional user home. */
export function createContextManager(
  workspace: Workspace,
  options: { home?: string } = {},
): ContextManager {
  return {
    async prepare(session) {
      const context: ContextSection[] = [
        {
          name: "environment",
          content: [
            `Workspace root: ${workspace.root}`,
            `Launch directory: ${workspace.launchCwd}`,
          ].join("\n"),
        },
      ];
      const instructions = await discoverAgentsInstructions({
        workspace,
        home: options.home,
        targetPaths: targetPathsFrom(workspace, session.items),
      });
      if (instructions.length > 0) {
        context.push({
          name: "project-instructions",
          content: formatAgentsInstructions(instructions),
        });
      }
      return {
        systemPrompt: await assembleSystemPrompt(options.home),
        context,
        items: session.items,
      };
    },
  };
}

/** Launch directory plus tool `path` / `cwd` arguments from the session. */
function targetPathsFrom(
  workspace: Workspace,
  items: readonly ConversationItem[],
): string[] {
  const paths = [workspace.launchCwd];
  for (const item of items) {
    if (item.type !== "assistant") {
      continue;
    }
    for (const block of item.content) {
      if (block.type !== "tool_call" || !isPlainObject(block.arguments)) {
        continue;
      }
      const args = block.arguments;
      if (typeof args.path === "string" && args.path.length > 0) {
        paths.push(resolveToolPath(workspace.root, args.path));
      }
      if (typeof args.cwd === "string" && args.cwd.length > 0) {
        paths.push(resolveToolPath(workspace.root, args.cwd));
      }
    }
  }
  return paths;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
