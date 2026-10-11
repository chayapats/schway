import { expect, test } from "bun:test";
import { listCatalog } from "../src/model/catalog.ts";
import { modelPickerEntries } from "../src/tui/model-picker.ts";

const unavailable = (modelId: string) => modelPickerEntries("", "openai", modelId, {}, { subscriptionMode: true, activeRoute: "codex", subscriptionUnavailable: true })
  .filter(entry => entry.kind === "model" && entry.authRoute === "codex");

test("an unavailable account model list still marks the current subscription model", () => {
  const current = listCatalog().find(entry => entry.provider === "openai")!.id;
  const rows = unavailable(current);
  expect(rows.filter(entry => entry.active).map(entry => entry.modelId)).toEqual([current]);
  expect(rows.every(entry => entry.listUnavailable)).toBe(true);
});

test("an unavailable account model list keeps a current subscription model the fallback catalog lacks", () => {
  const rows = unavailable("gpt-account-only");
  expect(rows.filter(entry => entry.active).map(entry => entry.modelId)).toEqual(["gpt-account-only"]);
  expect(rows.find(entry => entry.active)?.listUnavailable).toBe(true);
});

test("an unavailable account model list marks nothing on another route", () => {
  const current = listCatalog().find(entry => entry.provider === "openai")!.id;
  const rows = modelPickerEntries("", "openai", current, {}, { activeRoute: "api-key", subscriptionUnavailable: true })
    .filter(entry => entry.kind === "model" && entry.authRoute === "codex");
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.some(entry => entry.active)).toBe(false);
});
