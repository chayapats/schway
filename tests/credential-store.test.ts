import { expect, test } from "bun:test";
import { credentialIdentity, createNativeCredentialStore } from "../src/auth/store.ts";

test("native store round trips and deletes only the selected credential identity", async () => {
  const values = new Map<string, string>();
  const store = createNativeCredentialStore({
    async get({ service, name }) { return values.get(`${service}/${name}`) ?? null; },
    async set({ service, name, value }) { values.set(`${service}/${name}`, value); },
    async delete({ service, name }) { return values.delete(`${service}/${name}`); },
  });
  const anthropic = credentialIdentity({ provider: "anthropic" });
  const openai = credentialIdentity({ provider: "openai" });
  await store.set(anthropic, "anthropic-sentinel");
  await store.set(openai, "openai-sentinel");
  expect(await store.get(anthropic)).toBe("anthropic-sentinel");
  await store.set(anthropic, "replacement");
  expect(await store.get(anthropic)).toBe("replacement");
  expect(await store.delete(anthropic)).toBe(true);
  expect(await store.get(anthropic)).toBeNull();
  expect(await store.delete(anthropic)).toBe(false);
  expect(await store.get(openai)).toBe("openai-sentinel");
});

test("compatible identity canonicalizes URL spelling without crossing endpoints or native OpenAI", () => {
  const identity = (baseUrl: string) => credentialIdentity({ provider: "openai-compatible", baseUrl });
  expect(identity("HTTPS://Example.test:443/v1/").account).toBe(identity("https://example.test/v1").account);
  const first = identity("https://user:password-sentinel@example.test/a/v1?tenant=query-sentinel");
  expect(first.account).not.toBe(identity("https://user:password-sentinel@example.test/b/v1?tenant=query-sentinel").account);
  expect(first.account).not.toBe(identity("https://user:password-sentinel@example.test/a/v1?tenant=other").account);
  expect(first.account).not.toBe(identity("https://example.test/a/v1?tenant=query-sentinel").account);
  expect(JSON.stringify(first)).not.toContain("password-sentinel");
  expect(JSON.stringify(first)).not.toContain("query-sentinel");
  expect(identity("https://api.openai.com/v1").account).not.toBe(credentialIdentity({ provider: "openai" }).account);
  expect(() => identity("invalid-url-sentinel")).toThrow("valid HTTP(S)");
});

test("native store failures offer recovery without including native error secrets", async () => {
  const fail = async () => { throw new Error("native-error-secret-sentinel"); };
  const store = createNativeCredentialStore({ get: fail, set: fail, delete: fail });
  const identity = credentialIdentity({ provider: "openai" });
  for (const result of [store.get(identity), store.set(identity, "input-secret-sentinel"), store.delete(identity)]) {
    const error = await result.catch((error: Error) => error.message);
    expect(error).toContain("Unlock or allow access");
    expect(error).toContain("No plaintext fallback");
    expect(error).not.toContain("sentinel");
  }
});
