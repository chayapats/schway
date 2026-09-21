import type { SessionRecord } from "../conversation/types.ts";

/** Linear durable records. Persistence belongs to JsonlSession. */
export interface Session {
  readonly items: readonly SessionRecord[];
  append(...added: SessionRecord[]): void;
}

/** Create an in-memory session, optionally seeded with existing records. */
export function createSession(
  initial: readonly SessionRecord[] = [],
): Session {
  const items: SessionRecord[] = [...initial];
  return {
    get items() {
      return items;
    },
    append(...added) {
      items.push(...added);
    },
  };
}
