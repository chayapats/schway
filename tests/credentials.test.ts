import { expect, test } from "bun:test";
import {
  resolveAnthropicApiKey,
  resolveOpenAIApiKey,
} from "../src/auth/secrets.ts";

test("runtime credentials take precedence over environment credentials", () => {
  const resolved = resolveAnthropicApiKey({
    runtimeApiKey: "sk-runtime",
    env: { ANTHROPIC_API_KEY: "sk-env" },
  });
  expect(resolved).toEqual({ apiKey: "sk-runtime", source: "runtime" });
});

test("environment credentials are used when no runtime override is provided", () => {
  const resolved = resolveAnthropicApiKey({
    env: { ANTHROPIC_API_KEY: "sk-env" },
  });
  expect(resolved).toEqual({ apiKey: "sk-env", source: "env" });
});

test("missing credentials return an actionable error", () => {
  const resolved = resolveAnthropicApiKey({ env: {} });
  expect(resolved).toEqual({
    error:
      "Missing Anthropic API key. Set ANTHROPIC_API_KEY or pass --api-key.",
  });
});

test("blank credentials are treated as missing", () => {
  expect(
    resolveAnthropicApiKey({
      runtimeApiKey: "  ",
      env: { ANTHROPIC_API_KEY: "sk-env" },
    }),
  ).toMatchObject({ error: expect.any(String) });
  expect(
    resolveAnthropicApiKey({ env: { ANTHROPIC_API_KEY: "" } }),
  ).toMatchObject({ error: expect.any(String) });
});

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

import { resolveProviderCredential } from "../src/auth/credentials.ts";
import { credentialIdentity, type CredentialStore } from "../src/auth/store.ts";
import { fakeCredentialStore } from "./helpers/credential-store.ts";

test("provider resolution falls through runtime, environment and secure storage in order", async () => {
  const store = fakeCredentialStore();
  await store.set(credentialIdentity({ provider: "anthropic" }), "stored-sentinel");
  const input = { provider: "anthropic" as const, store, env: { ANTHROPIC_API_KEY: "environment-sentinel" } };
  expect(await resolveProviderCredential({ ...input, runtimeApiKey: "runtime-sentinel" })).toMatchObject({ apiKey: "runtime-sentinel", source: "runtime" });
  expect(await resolveProviderCredential(input)).toMatchObject({ apiKey: "environment-sentinel", source: "env" });
  expect(await resolveProviderCredential({ ...input, env: {} })).toMatchObject({ apiKey: "stored-sentinel", source: "stored" });
  expect(await resolveProviderCredential({ ...input, env: {}, store: fakeCredentialStore() })).toMatchObject({ error: expect.stringContaining("Missing Anthropic API key") });
});

const unavailableStore: CredentialStore = {
  async get() { throw new Error("secret-sentinel locked"); },
  async set() { throw new Error("secret-sentinel denied"); },
  async delete() { throw new Error("secret-sentinel unavailable"); },
};

test("higher priority keys bypass locked storage and an explicit empty override never falls back", async () => {
  for (const provider of ["anthropic", "openai", "openai-compatible"] as const) {
    const input = { provider, baseUrl: "https://example.test/v1", store: unavailableStore, env: { ANTHROPIC_API_KEY: "env", OPENAI_API_KEY: "env", OPENAI_COMPATIBLE_API_KEY: "env" } };
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
