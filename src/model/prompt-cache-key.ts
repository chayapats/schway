import { createHash } from "node:crypto";

/** Versioned prefix every conversation prompt-cache key starts with; a new derivation needs a new version. */
export const PROMPT_CACHE_KEY_PREFIX = "schway-v1-";

/** Exact shape of a conversation prompt-cache key: the prefix plus 32 lowercase hex digits, 42 ASCII characters in all. */
export const PROMPT_CACHE_KEY_PATTERN = /^schway-v1-[0-9a-f]{32}$/;

/** Hash input domain, kept separate from the visible prefix so the digest is bound to this purpose. */
const DOMAIN = "schway.prompt-cache-key.v1";

/** The session and selected branch a conversation request belongs to. */
export interface PromptCacheConversation {
  readonly rootId: string;
  readonly activeBranchId: string;
}

/**
 * Derive the opaque prompt-cache affinity key for one session branch: equal inputs give the same key,
 * and the key never contains the session ID, branch ID or anything else readable.
 */
export function promptCacheKey(conversation: PromptCacheConversation): string {
  const digest = createHash("sha256")
    .update(`${DOMAIN}\0${conversation.rootId}\0${conversation.activeBranchId}`)
    .digest("hex");
  return `${PROMPT_CACHE_KEY_PREFIX}${digest.slice(0, 32)}`;
}

/** True only for a value with the exact derived key shape; adapters send nothing else. */
export function isPromptCacheKey(value: unknown): value is string {
  return typeof value === "string" && PROMPT_CACHE_KEY_PATTERN.test(value);
}
