import { STABLE_SYSTEM_PROMPT } from "./prompt.ts";
import type { ConversationItem } from "../conversation/types.ts";
import type { Session } from "../session/session.ts";
import type { Workspace } from "../workspace/workspace.ts";

export interface ContextSection {
  name: string;
  content: string;
}

export interface PreparedContext {
  systemPrompt: string;
  context: ContextSection[];
  items: readonly ConversationItem[];
}

export interface ContextManager {
  prepare(session: Session): PreparedContext;
}

export function createContextManager(workspace: Workspace): ContextManager {
  return {
    prepare(session) {
      return {
        systemPrompt: STABLE_SYSTEM_PROMPT,
        context: [
          {
            name: "environment",
            content: [
              `Workspace root: ${workspace.root}`,
              `Launch directory: ${workspace.launchCwd}`,
            ].join("\n"),
          },
        ],
        items: session.items,
      };
    },
  };
}
