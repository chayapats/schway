import { expect, test } from "bun:test";
import {
  resolveOpenAIApiKey,
} from "../src/auth/secrets.ts";

test("OpenAI runtime credentials take precedence over environment credentials", () => {
  const resolved = resolveOpenAIApiKey({
    runtimeApiKey: "sk-runtime",
    env: { OPENAI_API_KEY: "sk-env" },
  });
  expect(resolved).toEqual({ apiKey: "sk-runtime", source: "runtime" });
});

test("OpenAI environment credentials are used when no runtime override is provided", () => {
  const resolved = resolveOpenAIApiKey({
    env: { OPENAI_API_KEY: "sk-env" },
  });
  expect(resolved).toEqual({ apiKey: "sk-env", source: "env" });
});

test("missing OpenAI credentials fail headlessly without subscription login", () => {
  const resolved = resolveOpenAIApiKey({ env: {} });
  expect(resolved).toEqual({
    error: "Missing OpenAI API key. Set OPENAI_API_KEY or pass --api-key.",
  });
  if (!("error" in resolved)) {
    throw new Error("expected missing credential error");
  }
  expect(resolved.error.toLowerCase().includes("login")).toBe(false);
  expect(resolved.error.toLowerCase().includes("codex")).toBe(false);
  expect(resolved.error.toLowerCase().includes("chatgpt")).toBe(false);
});

test("blank OpenAI credentials are treated as missing", () => {
  expect(
    resolveOpenAIApiKey({
      runtimeApiKey: "  ",
      env: { OPENAI_API_KEY: "sk-env" },
    }),
  ).toMatchObject({ error: expect.any(String) });
  expect(
    resolveOpenAIApiKey({ env: { OPENAI_API_KEY: "" } }),
  ).toMatchObject({ error: expect.any(String) });
});

import { credentialEnvironmentVariable, resolveProviderCredential } from "../src/auth/credentials.ts";
import { XAI_API_KEY_ENV } from "../src/auth/secrets.ts";
import { credentialIdentity, type CredentialStore } from "../src/auth/store.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";

test("provider resolution falls through runtime, environment and secure storage in order", async () => {
  const store = fakeCredentialStore();
  await store.set(credentialIdentity({ provider: "openai" }), "stored-sentinel");
  const input = { provider: "openai" as const, store, env: { OPENAI_API_KEY: "environment-sentinel" } };
  expect(await resolveProviderCredential({ ...input, runtimeApiKey: "runtime-sentinel" })).toMatchObject({ apiKey: "runtime-sentinel", source: "runtime" });
  expect(await resolveProviderCredential(input)).toMatchObject({ apiKey: "environment-sentinel", source: "env" });
  expect(await resolveProviderCredential({ ...input, env: {} })).toMatchObject({ apiKey: "stored-sentinel", source: "stored" });
  expect(await resolveProviderCredential({ ...input, env: {}, store: fakeCredentialStore() })).toMatchObject({ error: expect.stringContaining("Missing OpenAI API key") });
});

const unavailableStore: CredentialStore = {
  async get() { throw new Error("secret-sentinel locked"); },
  async set() { throw new Error("secret-sentinel denied"); },
  async delete() { throw new Error("secret-sentinel unavailable"); },
};

test("higher priority keys bypass locked storage and an explicit empty override never falls back", async () => {
  for (const provider of ["openai", "openai-compatible"] as const) {
    const input = { provider, baseUrl: "https://example.test/v1", store: unavailableStore, env: { OPENAI_API_KEY: "env", OPENAI_COMPATIBLE_API_KEY: "env" } };
    expect(await resolveProviderCredential({ ...input, runtimeApiKey: " runtime " })).toEqual({ apiKey: "runtime", source: "runtime" });
    expect(await resolveProviderCredential(input)).toEqual({ apiKey: "env", source: "env" });
    for (const auth of ["required", "optional", "none"] as const) {
      expect(await resolveProviderCredential({ ...input, auth, runtimeApiKey: " " })).toEqual({ error: expect.stringContaining("Explicit API key is empty") });
    }
    for (const auth of ["required", "optional", "none"] as const) {
      const resolved = await resolveProviderCredential({ ...input, env: {}, auth });
      expect(JSON.stringify(resolved)).not.toContain("secret-sentinel");
      if (provider === "openai-compatible" && auth !== "required") {
        expect(resolved).toEqual({ source: "none" });
      } else {
        expect(resolved).toMatchObject({ error: expect.stringContaining("Unlock or allow access") });
      }
    }
  }
  expect(await resolveProviderCredential({ provider: "openai-compatible", baseUrl: "https://example.test/v1", store: unavailableStore, env: {} })).toEqual({ source: "none" });
});

test("compatible endpoint keys stay separate from native providers and other endpoints", async () => {
  const store = fakeCredentialStore();
  const a = { provider: "openai-compatible" as const, baseUrl: "https://example.test/tenant-a/v1" };
  const b = { ...a, baseUrl: "https://example.test/tenant-b/v1" };
  await store.set(credentialIdentity(a), "tenant-a-key");
  await store.set(credentialIdentity({ provider: "openai" }), "native-key");
  const env = { OPENAI_API_KEY: "native-env-key" };
  expect(await resolveProviderCredential({ ...a, store, env })).toEqual({ apiKey: "tenant-a-key", source: "stored" });
  expect(await resolveProviderCredential({ ...b, store, env })).toEqual({ source: "none" });
  expect(await resolveProviderCredential({ ...b, store, env, auth: "required" })).toMatchObject({ error: expect.stringContaining("Missing API key") });
  expect(await resolveProviderCredential({ ...b, store, env: { OPENAI_COMPATIBLE_API_KEY: "explicit-compatible-env" } })).toEqual({ apiKey: "explicit-compatible-env", source: "env" });
  expect(await resolveProviderCredential({ ...a, store: unavailableStore, env: {}, auth: "none" })).toEqual({ source: "none" });
});

test("xAI keys stay on their own identity and never read OpenAI credentials", async () => {
  expect(credentialEnvironmentVariable("xai")).toBe(XAI_API_KEY_ENV);
  expect(credentialIdentity({ provider: "xai" })).toEqual({ account: "api-key:xai", label: "xai" });
  const store = fakeCredentialStore();
  await store.set(credentialIdentity({ provider: "xai" }), "stored-xai");
  await store.set(credentialIdentity({ provider: "openai" }), "stored-openai");
  expect(await resolveProviderCredential({ provider: "xai", store, env: { XAI_API_KEY: "env-xai", OPENAI_API_KEY: "env-openai" }, runtimeApiKey: "runtime-xai" })).toEqual({ apiKey: "runtime-xai", source: "runtime" });
  expect(await resolveProviderCredential({ provider: "xai", store, env: { XAI_API_KEY: "env-xai", OPENAI_API_KEY: "env-openai" } })).toEqual({ apiKey: "env-xai", source: "env" });
  expect(await resolveProviderCredential({ provider: "xai", store, env: { OPENAI_API_KEY: "env-openai" } })).toEqual({ apiKey: "stored-xai", source: "stored" });
  expect(await resolveProviderCredential({ provider: "openai", store, env: { XAI_API_KEY: "env-xai" } })).toEqual({ apiKey: "stored-openai", source: "stored" });
  expect(await resolveProviderCredential({ provider: "xai", store: fakeCredentialStore(), env: { OPENAI_API_KEY: "env-openai" } })).toEqual({
    error: "Missing xAI API key. Set XAI_API_KEY or pass --api-key.",
  });
});
