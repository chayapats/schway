import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runEvalCli } from "../src/eval/cli.ts";
import { estimateSpendUsd, resolvePrice } from "../src/eval/spend.ts";
import type { Model } from "../src/model/model.ts";
import { withTempDir } from "./helpers.ts";

/** Scripted usage: every attempt reports one million input tokens and no output. */
function usageModel(): Model {
  return { provider: "openai", id: "gpt-5", async *stream() {
    yield { type: "usage", usage: { inputTokens: 1_000_000, outputTokens: 0 } };
    yield { type: "message_complete", message: { type: "assistant", id: crypto.randomUUID(), content: [{ type: "text", text: "Done" }] } };
  } };
}

const ENV = { OPENAI_API_KEY: "fixture-secret" };
const deps = { model: () => usageModel() };

async function run(dir: string, args: string[], env: Record<string, string> = ENV) {
  const output = join(dir, "out.json");
  const logs: string[] = [];
  const original = console.log;
  console.log = (line?: unknown) => { logs.push(String(line)); };
  let code: number;
  try { code = await runEvalCli([...args, "--output", output], env, deps); } finally { console.log = original; }
  const text = await readFile(output, "utf8").catch(() => undefined);
  return { code, logs, artifact: text ? JSON.parse(text) : undefined };
}

test("price table covers known models and explicit prices override it", () => {
  expect(resolvePrice("openai", "gpt-5")).toEqual({ inputPerMillion: 1.25, outputPerMillion: 10 });
  expect(resolvePrice("openai", "unheard-of")).toBeUndefined();
  expect(resolvePrice("openai", "unheard-of", { inputPerMillion: 2, outputPerMillion: 4 })).toEqual({ inputPerMillion: 2, outputPerMillion: 4 });
  expect(resolvePrice("scripted", "offline-v1")).toEqual({ inputPerMillion: 0, outputPerMillion: 0 });
});

test("spend comes from reported usage and flags incomplete usage as a lower bound", () => {
  const price = { inputPerMillion: 1.25, outputPerMillion: 10 };
  const base = { inputTokens: 2_000_000, outputTokens: 100_000, unknownInputAttempts: 0, unknownOutputAttempts: 0 };
  expect(estimateSpendUsd(base, price)).toEqual({ usd: 3.5, exact: true });
  expect(estimateSpendUsd({ ...base, unknownOutputAttempts: 1 }, price)).toEqual({ usd: 3.5, exact: false });
  expect(estimateSpendUsd({ inputTokens: null, outputTokens: null, unknownInputAttempts: 1, unknownOutputAttempts: 1 }, price)).toEqual({ usd: 0, exact: false });
});

test("cap reached stops before the next case, skips the rest and exits 3", async () => {
  await withTempDir(async dir => {
    const { code, logs, artifact } = await run(dir, ["--provider", "openai", "--model", "gpt-5", "--allow-paid", "--case", "all", "--max-spend", "3"]);
    expect(code).toBe(3);
    const outcomes = artifact.results.map((r: { outcome: string }) => r.outcome);
    expect(outcomes.filter((o: string) => o !== "skipped_spend_cap")).toHaveLength(2);
    expect(outcomes.slice(2).every((o: string) => o === "skipped_spend_cap")).toBe(true);
    expect(artifact.results[0].spendUsd).toBe(1.25);
    expect(artifact.spend).toMatchObject({ totalUsd: 2.5, capUsd: 3, casesRun: 2, casesTotal: 7 });
    expect(logs).toContain("stopped: spend cap reached ($3.00)");
    expect(logs).toContain("Spent $2.50 of $3.00 · 2/7 cases run");
    expect(logs.some(line => line.includes("$1.25"))).toBe(true);
  });
});

test("cap not reached runs every case and keeps the usual exit code", async () => {
  await withTempDir(async dir => {
    const { code, logs, artifact } = await run(dir, ["--provider", "openai", "--model", "gpt-5", "--allow-paid", "--case", "all", "--max-spend", "100"]);
    expect(artifact.results.every((r: { outcome: string }) => r.outcome !== "skipped_spend_cap")).toBe(true);
    expect(code).not.toBe(3);
    const total = artifact.results.reduce((sum: number, r: { spendUsd: number }) => sum + r.spendUsd, 0);
    expect(artifact.spend).toMatchObject({ totalUsd: total, capUsd: 100, casesRun: 7, casesTotal: 7 });
    expect(logs).toContain(`Spent $${total.toFixed(2)} of $100.00 · 7/7 cases run`);
    expect(logs.some(line => line.startsWith("stopped:"))).toBe(false);
  });
});

test("default cap is $10", async () => {
  await withTempDir(async dir => {
    const { artifact } = await run(dir, ["--provider", "openai", "--model", "gpt-5", "--allow-paid", "--case", "clamp-bounds"]);
    expect(artifact.spend.capUsd).toBe(10);
  });
});

test("paid model without a known price refuses to start unless explicit prices are given", async () => {
  await withTempDir(async dir => {
    const refused = await run(dir, ["--provider", "openai", "--model", "unheard-of", "--allow-paid"]);
    expect(refused.code).toBe(2);
    expect(refused.artifact).toBeUndefined();
  });
  await withTempDir(async dir => {
    const priced = await run(dir, ["--provider", "openai", "--model", "unheard-of", "--allow-paid", "--input-price", "2", "--output-price", "4", "--case", "clamp-bounds"]);
    expect(priced.artifact.spendUsd).toBe(2);
  });
  await withTempDir(async dir => {
    const half = await run(dir, ["--provider", "openai", "--model", "unheard-of", "--allow-paid", "--input-price", "2"]);
    expect(half.code).toBe(2);
  });
});

test("offline scripted route counts as $0 but still reports usage", async () => {
  await withTempDir(async dir => {
    const output = join(dir, "offline.json");
    expect(await runEvalCli(["--provider", "scripted", "--output", output], {})).toBe(0);
    const result = JSON.parse(await readFile(output, "utf8"));
    expect(result.spendUsd).toBe(0);
    expect(result.metrics.inputTokens).toBeGreaterThan(0);
  });
});

test("invalid max-spend is rejected", async () => {
  for (const value of ["0", "-1", "abc"]) {
    expect(await runEvalCli(["--provider", "scripted", "--max-spend", value], {})).toBe(2);
  }
});
