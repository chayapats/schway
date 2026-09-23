import type { CredentialStore } from "../../src/auth/store.ts";

/** Isolated in-memory secure store for deterministic tests, never backed by the OS. */
export function fakeCredentialStore(): CredentialStore {
  const values = new Map<string, string>();
  return {
    async get(identity) { return values.get(identity.account) ?? null; },
    async set(identity, value) { values.set(identity.account, value); },
    async delete(identity) { return values.delete(identity.account); },
  };
}
