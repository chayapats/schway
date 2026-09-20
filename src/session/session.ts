import type { ConversationItem } from "../conversation/types.ts";

export interface Session {
  readonly items: readonly ConversationItem[];
  append(...added: ConversationItem[]): void;
}

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
