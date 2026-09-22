import type { SessionRecord } from "../conversation/types.ts";

/** Ordered session records exposed for reading and appending; storage persistence depends on the implementation. */
export interface Session {
  readonly items: readonly SessionRecord[];
  /** Append records in order; persisted implementations may throw on storage or serialization failures. */
  append(...added: SessionRecord[]): void;
}

/** Create an in-memory session with a shallow copy of initial records and no filesystem persistence. */
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
