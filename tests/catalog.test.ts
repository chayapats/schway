import { expect, test } from "bun:test";
import {
  UNKNOWN_MODEL_DEFAULTS,
  listCatalog,
  lookupModel,
} from "../src/model/catalog.ts";

test("known catalog models expose context, output, tool, and thinking metadata", () => {
  const openai = lookupModel("openai", "gpt-6-astra");
  expect(openai.provider).toBe("openai");
  expect(openai.id).toBe("gpt-6-astra");
  expect(openai.contextWindow).toBeGreaterThan(UNKNOWN_MODEL_DEFAULTS.contextWindow);
  expect(openai.maxOutput).toBe(128_000);
  expect(openai.supportsTools).toBe(true);
  expect(openai.supportsThinking).toBe(true);

  const compatible = lookupModel(
    "openai-compatible",
    "gpt-4o",
  );
  expect(compatible.provider).toBe("openai-compatible");
  expect(compatible.id).toBe("gpt-4o");
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
  const known = lookupModel("openai", "gpt-6-astra", {
    contextWindow: 50_000,
    maxOutput: 2_048,
  });
  expect(known.contextWindow).toBe(50_000);
  expect(known.maxOutput).toBe(2_048);
  expect(known.supportsTools).toBe(true);

  const unknown = lookupModel("openai", "secret-lab", {
    contextWindow: 8_000,
    maxOutput: 512,
  });
  expect(unknown.contextWindow).toBe(8_000);
  expect(unknown.maxOutput).toBe(512);
  expect(unknown.supportsThinking).toBe(false);
});

test("the built-in catalog is a small static list of known models", () => {
  const models = listCatalog();
  expect(models.length).toBeGreaterThanOrEqual(2);
  expect(models.length).toBeLessThanOrEqual(12);
  expect(models.some((model) => model.provider === "anthropic")).toBe(false);
  expect(
    models.some(
      (model) => model.provider === "openai" && model.id === "gpt-6-astra",
    ),
  ).toBe(true);
  expect(
    models.some(
      (model) =>
        model.provider === "openai-compatible" &&
        model.id === "gpt-4o",
    ),
  ).toBe(true);
});
