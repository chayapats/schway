import type { SessionRecord } from "../conversation/types.ts";

/** Session-wide contextual root identities, independent of conversation history and future branches. */
export interface SessionMetadata {
  readonly extraRoots: readonly string[];
}

/** Ordered session records exposed for reading and appending; storage persistence depends on the implementation. */
export interface Session {
  readonly items: readonly SessionRecord[];
  readonly metadata: SessionMetadata;
  /** Persist a complete accepted attachment set without appending conversation items. */
  setExtraRoots(roots: readonly string[]): void;
  /** Append records in order; persisted implementations may throw on storage or serialization failures. */
  append(...added: SessionRecord[]): void;
}

/** Create an in-memory session with a shallow copy of initial records and no filesystem persistence. */
export function createSession(
  initial: readonly SessionRecord[] = [],
  extraRoots: readonly string[] = [],
): Session {
  const items: SessionRecord[] = [...initial];
  let metadata: SessionMetadata = { extraRoots: [...extraRoots] };
  return {
    get metadata() { return metadata; },
    setExtraRoots(roots) { metadata = { extraRoots: [...roots] }; },
    get items() {
      return items;
    },
    append(...added) {
      items.push(...added);
    },
  };
}
