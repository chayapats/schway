import { expect, test } from "bun:test";
import { resolveAnthropicApiKey } from "../src/auth/secrets.ts";

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
