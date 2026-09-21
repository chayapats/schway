import { expect, test } from "bun:test";
import {
  DEFAULT_MODEL_IDS,
  UNKNOWN_MODEL_DEFAULTS,
  listCatalog,
  lookupModel,
} from "../src/model/catalog.ts";

test("known default models expose context, output, tool, and thinking metadata", () => {
  const anthropic = lookupModel("anthropic", DEFAULT_MODEL_IDS.anthropic);
  expect(anthropic).toEqual({
    id: DEFAULT_MODEL_IDS.anthropic,
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutput: 16_384,
    supportsTools: true,
    supportsThinking: true,
  });

  const openai = lookupModel("openai", DEFAULT_MODEL_IDS.openai);
  expect(openai.provider).toBe("openai");
  expect(openai.id).toBe(DEFAULT_MODEL_IDS.openai);
  expect(openai.contextWindow).toBeGreaterThan(UNKNOWN_MODEL_DEFAULTS.contextWindow);
  expect(openai.maxOutput).toBe(16_384);
  expect(openai.supportsTools).toBe(true);
  expect(openai.supportsThinking).toBe(true);

  const compatible = lookupModel(
    "openai-compatible",
    DEFAULT_MODEL_IDS["openai-compatible"],
  );
  expect(compatible.provider).toBe("openai-compatible");
  expect(compatible.id).toBe(DEFAULT_MODEL_IDS["openai-compatible"]);
  expect(compatible.contextWindow).toBeGreaterThan(
    UNKNOWN_MODEL_DEFAULTS.contextWindow,
  );
  expect(compatible.supportsTools).toBe(true);
});

test("unknown model IDs use documented conservative defaults", () => {
  const info = lookupModel("openai", "my-custom-gpt");
  expect(info).toEqual({
    id: "my-custom-gpt",
    provider: "openai",
    ...UNKNOWN_MODEL_DEFAULTS,
  });
});

test("explicit context and output overrides win over catalog and unknown defaults", () => {
  const known = lookupModel("anthropic", DEFAULT_MODEL_IDS.anthropic, {
    contextWindow: 50_000,
    maxOutput: 2_048,
  });
  expect(known.contextWindow).toBe(50_000);
  expect(known.maxOutput).toBe(2_048);
  expect(known.supportsTools).toBe(true);

  const unknown = lookupModel("anthropic", "claude-secret-lab", {
    contextWindow: 8_000,
    maxOutput: 512,
  });
  expect(unknown.contextWindow).toBe(8_000);
  expect(unknown.maxOutput).toBe(512);
  expect(unknown.supportsThinking).toBe(false);
});

test("the built-in catalog is a small static list of known models", () => {
  const models = listCatalog();
  expect(models.length).toBeGreaterThanOrEqual(3);
  expect(models.length).toBeLessThanOrEqual(12);
  expect(
    models.some(
      (model) =>
        model.provider === "anthropic" && model.id === DEFAULT_MODEL_IDS.anthropic,
    ),
  ).toBe(true);
  expect(
    models.some(
      (model) => model.provider === "openai" && model.id === DEFAULT_MODEL_IDS.openai,
    ),
  ).toBe(true);
  expect(
    models.some(
      (model) =>
        model.provider === "openai-compatible" &&
        model.id === DEFAULT_MODEL_IDS["openai-compatible"],
    ),
  ).toBe(true);
});
