import type { ConversationItem } from "../conversation/types.ts";

/** Linear conversation items. Persistence belongs to JsonlSession. */
export interface Session {
  readonly items: readonly ConversationItem[];
  append(...added: ConversationItem[]): void;
}

/** Create an in-memory session, optionally seeded with existing items. */
export function createSession(
  initial: readonly ConversationItem[] = [],
): Session {
  const items: ConversationItem[] = [...initial];
  return {
    get items() {
      return items;
    },
    append(...added) {
      items.push(...added);
    },
  };
}
