import { createHash } from "node:crypto";

/** Stable account identifier and safe display label for one provider credential. */
export interface CredentialIdentity {
  readonly account: string;
  readonly label: string;
}

/** Secure storage boundary; missing reads return null and missing deletions return false. */
export interface CredentialStore {
  /** Read one credential, returning null when its identity is absent. */
  get(identity: CredentialIdentity): Promise<string | null>;
  /** Save or replace the credential at exactly one identity. */
  set(identity: CredentialIdentity, value: string): Promise<void>;
  /** Delete one identity, returning whether a credential existed. */
  delete(identity: CredentialIdentity): Promise<boolean>;
}

/** Provider and endpoint used to select a credential without including its secret. */
export interface CredentialTarget {
  provider: "openai" | "xai" | "openai-compatible";
  baseUrl?: string;
  /** Active compatible profile that scopes the stored identity alongside the endpoint. */
  profile?: string;
  /** Optional non-secret store suffix referenced by the active profile. */
  credentialIdentity?: string;
}

/** Derive an endpoint-isolated account scoped to profile identity and canonical endpoint. */
export function credentialIdentity(target: CredentialTarget): CredentialIdentity {
  if (target.provider !== "openai-compatible") {
    return { account: `api-key:${target.provider}`, label: target.provider };
  }
  let url: URL;
  try {
    url = new URL(target.baseUrl ?? "");
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
  } catch {
    throw new Error("Select a valid HTTP(S) base URL before managing OpenAI-compatible credentials.");
  }
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  const profileSuffix = target.profile?.trim() ? `profile:${target.profile.trim()}:` : "";
  const customSuffix = target.credentialIdentity?.trim() ? `custom:${target.credentialIdentity.trim()}:` : "";
  const digest = createHash("sha256").update(`${profileSuffix}${customSuffix}${url.href}`).digest("hex");
  const profileLabel = target.profile?.trim() ? ` profile "${target.profile.trim()}" ` : " ";
  return {
    account: `api-key:openai-compatible:${digest}`,
    label: `Compatible endpoint${profileLabel}(${url.host})`,
  };
}

/** Secure-store account once used by the removed Anthropic route; only doctor looks for it, to report it as unused. */
export const LEGACY_ANTHROPIC_ACCOUNT = "api-key:anthropic";

/** Command that deletes the leftover Anthropic credential from the OS secure store. */
export const LEGACY_ANTHROPIC_REMOVAL_COMMAND = `bun -e 'await Bun.secrets.delete({ service: "schway", name: "${LEGACY_ANTHROPIC_ACCOUNT}" })'`;

/** Stable secure-store account for the ChatGPT subscription (Codex OAuth) credential, separate from API-key identities. */
export const CODEX_SUBSCRIPTION_ACCOUNT = "codex-subscription:chatgpt";
/** Safe display label for the subscription identity used in login/logout notices. */
export const CODEX_SUBSCRIPTION_LABEL = "ChatGPT subscription (Codex OAuth)";

/** Return the identity-based secure-store address for the selected ChatGPT subscription credential. */
export function codexSubscriptionIdentity(): CredentialIdentity {
  return { account: CODEX_SUBSCRIPTION_ACCOUNT, label: CODEX_SUBSCRIPTION_LABEL };
}

/** Return the secure-store identity dedicated to Grok OAuth tokens. */
export function grokSubscriptionIdentity(): CredentialIdentity {
  return { account: "grok-subscription:xai", label: "Grok subscription (xAI OAuth)" };
}

/** Non-secret recovery guidance for an unavailable, locked or denied secure-store operation. */
export function credentialStoreError(operation: "read" | "save" | "delete"): string {
  return `Cannot ${operation} credential in the OS secure store. Unlock or allow access to your OS credential store; on Linux install libsecret and start a Secret Service. Retry after restoring access. For reads, --api-key or the provider API-key environment variable bypasses the store. No plaintext fallback is used.`;
}

/** Refusal marker for an embedding-application credential-write fence; never carries secret material. */
export function credentialWriteRefusedError(cause?: unknown): Error {
  const error = new Error("Credential store write refused by the embedding-application fence. No credential was changed.",
    cause === undefined ? undefined : { cause });
  (error as { code?: unknown }).code = "credential-write-refused";
  return error;
}

/** True when an error is an embedding-application fence refusal rather than a store failure.
 * Brand-first for direct callers; message fallback survives the agent loop, which
 * rethrows provider failures as sanitized plain messages (see classifyAuthError). */
export function isCredentialWriteRefused(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  if ((error as { code?: unknown }).code === "credential-write-refused") return true;
  return error.message.includes("refused by the embedding-application fence");
}

/** Preserve a fence refusal unchanged; convert any other write failure to a sanitized store error. */
export function preserveRefusal(operation: "save" | "delete", error: unknown): Error {
  if (isCredentialWriteRefused(error)) return error;
  return new Error(credentialStoreError(operation));
}

/** Adapt Bun's OS secure storage without exposing native errors or enabling unrestricted access. */
export function createNativeCredentialStore(native?: typeof Bun.secrets): CredentialStore {
  const address = (identity: CredentialIdentity) => ({ service: "schway", name: identity.account });
  return {
    async get(identity) {
      try { return await (native ?? Bun.secrets).get(address(identity)); }
      catch { throw new Error(credentialStoreError("read")); }
    },
    async set(identity, value) {
      try { await (native ?? Bun.secrets).set({ ...address(identity), value }); }
      catch { throw new Error(credentialStoreError("save")); }
    },
    async delete(identity) {
      try { return await (native ?? Bun.secrets).delete(address(identity)); }
      catch { throw new Error(credentialStoreError("delete")); }
    },
  };
}
