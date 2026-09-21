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
