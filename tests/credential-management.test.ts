import { expect, test } from "bun:test";
import { MaskedCredentialEntry, removeStoredCredential } from "../src/auth/management.ts";
import { credentialIdentity } from "../src/auth/store.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";

test("masked login saves only after submission and cancellation leaves the selected identity unchanged", async () => {
  const store = fakeCredentialStore();
  const identity = credentialIdentity({ provider: "openai" });
  const entry = new MaskedCredentialEntry({ identity, store });
  entry.insert("entry-secret-sentinel");
  expect(entry.snapshot().masked).toMatch(/^•+$/);
  expect(JSON.stringify(entry.snapshot())).not.toContain("sentinel");
  expect(JSON.stringify(entry)).not.toContain("sentinel");
  expect(await store.get(identity)).toBeNull();
  expect((await entry.submit()).ok).toBe(true);
  expect(await store.get(identity)).toBe("entry-secret-sentinel");
  const cancelled = new MaskedCredentialEntry({ identity, store });
  cancelled.insert("replacement-secret-sentinel");
  expect(cancelled.cancel()).toBe(true);
  expect((await cancelled.submit()).ok).toBe(false);
  expect(await store.get(identity)).toBe("entry-secret-sentinel");
});

test("empty, invalid and failed entry do not replace saved credentials or disclose secrets", async () => {
  const store = fakeCredentialStore();
  const identity = credentialIdentity({ provider: "openai" });
  await store.set(identity, "original");
  for (const value of ["  ", "invalid\nembedded-secret", "🔒".repeat(4_097)]) {
    const entry = new MaskedCredentialEntry({ identity, store });
    entry.insert(value);
    expect((await entry.submit()).ok).toBe(false);
    expect(await store.get(identity)).toBe("original");
  }
  const entry = new MaskedCredentialEntry({ identity, store: { ...store, async set() { throw new Error("write-secret-sentinel"); } } });
  entry.insert("entry-secret-sentinel");
  const result = await entry.submit();
  expect(result.ok).toBe(false);
  expect(result.message).toContain("Cannot save");
  expect(result.message).not.toContain("sentinel");
  expect(entry.snapshot().masked).toBe("");
  expect(await store.get(identity)).toBe("original");
});

test("submitted native writes cannot be reported as cancelled and repeated submit saves once", async () => {
  const store = fakeCredentialStore();
  const identity = credentialIdentity({ provider: "openai" });
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => { finish = resolve; });
  let writes = 0;
  const entry = new MaskedCredentialEntry({ identity, store: { ...store, async set(target, key) { writes++; await wait; await store.set(target, key); } } });
  entry.insert("saved-after-wait");
  const pending = entry.submit();
  expect(entry.snapshot()).toMatchObject({ phase: "saving", masked: "" });
  expect(entry.cancel()).toBe(false);
  expect(entry.submit()).toBe(pending);
  finish();
  expect((await pending).ok).toBe(true);
  expect(writes).toBe(1);
  expect(await store.get(identity)).toBe("saved-after-wait");
});

test("overwrite and logout affect only the explicitly selected identity and explain environment/runtime overrides", async () => {
  const store = fakeCredentialStore();
  const target = { provider: "openai-compatible" as const, baseUrl: "https://example.test/one/v1" };
  const other = credentialIdentity({ ...target, baseUrl: "https://example.test/two/v1" });
  await store.set(other, "other");
  for (const value of ["first", "second"]) {
    const entry = new MaskedCredentialEntry({ identity: credentialIdentity(target), store });
    entry.insert(value + "x"); entry.backspace();
    expect((await entry.submit()).ok).toBe(true);
    expect(await store.get(credentialIdentity(target))).toBe(value);
  }
  const result = await removeStoredCredential({ ...target, store, env: { OPENAI_COMPATIBLE_API_KEY: "environment-secret-sentinel" } });
  expect(result.ok).toBe(true);
  expect(result.message).toContain("OPENAI_COMPATIBLE_API_KEY is still set");
  expect(result.message).not.toContain("sentinel");
  expect(await store.get(credentialIdentity(target))).toBeNull();
  expect(await store.get(other)).toBe("other");
  const missing = await removeStoredCredential({ ...target, store, env: {}, runtimeApiKey: "runtime-secret-sentinel" });
  expect(missing.message).toContain("No stored API key found");
  expect(missing.message).toContain("runtime --api-key override is unchanged");
  expect(missing.message).not.toContain("sentinel");
  const denied = await removeStoredCredential({ ...target, env: {}, store: { ...store, async delete() { throw new Error("delete-secret-sentinel"); } } });
  expect(denied.ok).toBe(false);
  expect(denied.message).toContain("Cannot delete");
  expect(denied.message).not.toContain("sentinel");
});
