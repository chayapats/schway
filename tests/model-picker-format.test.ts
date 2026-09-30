import { describe, expect, test } from "bun:test";
import { formatContextWindow, MODEL_PICKER_ROUTE_GROUPS } from "../src/tui/model-picker.ts";

describe("compact model picker context windows", () => {
  test.each([
    [0, "0"],
    [999, "999"],
    [1_000, "1k"],
    [1_999, "1k"],
    [32_768, "32k"],
    [128_000, "128k"],
    [256_000, "256k"],
    [999_999, "999k"],
    [1_000_000, "1M"],
    [1_009_999, "1M"],
    [1_010_000, "1.01M"],
    [1_047_576, "1.04M"],
    [1_050_000, "1.05M"],
    [1_099_999, "1.09M"],
    [1_100_000, "1.1M"],
    [1_999_999, "1.99M"],
    [2_000_000, "2M"],
  ])("formats %i tokens as %s", (tokens, expected) => {
    expect(formatContextWindow(tokens)).toBe(expected);
  });
});

test("real auth routes have one fixed group order", () => {
  expect(MODEL_PICKER_ROUTE_GROUPS).toEqual([
    { provider: "openai", authRoute: "codex", label: "ChatGPT subscription" },
    { provider: "xai", authRoute: "grok", label: "Grok subscription" },
    { provider: "openai", authRoute: "api-key", label: "OpenAI API key" },
    { provider: "xai", authRoute: "api-key", label: "xAI API key" },
    { provider: "openai-compatible", authRoute: "provider", label: "OpenAI-compatible" },
  ]);
});
