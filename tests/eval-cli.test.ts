import { expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runEvalCli, summarizeEvalResults } from "../src/eval/cli.ts";
import { runCodingEval, skippedCodingEval, resolveEvalSettings } from "../src/eval/coding.ts";
import { createScriptedModel } from "./helpers/scripted-model.ts";
import { withTempDir } from "./helpers.ts";

test("paid selection requires both model and explicit opt-in, without calling a provider", async () => {
  expect(await runEvalCli(["--provider", "openai", "--model", "gpt-fixture"], {})).toBe(2);
  expect(await runEvalCli(["--provider", "openai", "--allow-paid"], {})).toBe(2);
  expect(await runEvalCli(["--provider", "scripted", "--model", "unknown"], {})).toBe(2);
});

test("xAI eval skips without a key and refuses an unpriced model when a key is present", async () => {
  await withTempDir(async dir => {
    const output = join(dir, "skip.json");
    const skipped = await runEvalCli(["--provider", "xai", "--model", "grok-4.7", "--allow-paid", "--output", output], {});
    expect(skipped).toBe(1);
    expect((JSON.parse(await readFile(output, "utf8")) as { outcome: string }).outcome).toBe("skipped_prerequisites");
  });
  const priced = await runEvalCli(["--provider", "xai", "--model", "grok-4.7", "--allow-paid"], { XAI_API_KEY: "fixture-not-real" });
  expect(priced).toBe(2);
});

test("missing paid prerequisite emits a structured skip and no model call", async () => {
  await withTempDir(async dir => {
    const output = join(dir, "skip.json");
    const code = await runEvalCli(["--provider", "openai", "--model", "gpt-fixture", "--allow-paid", "--output", output], {});
    expect(code).toBe(1);
    const result = JSON.parse(await readFile(output, "utf8")) as Record<string, unknown>;
    expect(result.outcome).toBe("skipped_prerequisites");
    expect(result.grader).toBeNull();
    expect(JSON.stringify(result)).not.toContain("apiKey");
  });
});

test("malformed compatible endpoint is a skipped prerequisite even with a key", async () => {
  await withTempDir(async dir => {
    const output = join(dir, "skip.json");
    const code = await runEvalCli(["--provider", "openai-compatible", "--model", "fixture", "--base-url", "https://", "--allow-paid", "--output", output], { OPENAI_COMPATIBLE_API_KEY: "fixture-secret" });
    expect(code).toBe(1);
    expect((JSON.parse(await readFile(output, "utf8")) as { outcome: string }).outcome).toBe("skipped_prerequisites");
    expect(await readFile(output, "utf8")).not.toContain("fixture-secret");
  });
});

test("existing output is rejected before any paid attempt and stays unchanged", async () => {
  await withTempDir(async dir => {
    const output = join(dir, "existing.json");
    await Bun.write(output, "leave me alone");
    expect(await runEvalCli(["--provider", "openai", "--model", "fixture", "--allow-paid", "--output", output], { OPENAI_API_KEY: "fixture-secret" })).toBe(2);
    expect(await readFile(output, "utf8")).toBe("leave me alone");
  });
});

test("offline command writes a bounded artifact with the observed grader result", async () => {
  await withTempDir(async dir => {
    const output = join(dir, "run.json");
    expect(await runEvalCli(["--provider", "scripted", "--output", output], {})).toBe(0);
    expect(await runEvalCli(["--provider", "scripted", "--output", output], {})).toBe(2);
    const result = JSON.parse(await readFile(output, "utf8")) as { outcome: string; grader: { passed: boolean }; metrics: { toolCalls: number } };
    expect(result.outcome).toBe("success");
    expect(result.grader.passed).toBe(true);
    expect(result.metrics.toolCalls).toBe(3);
  });
});

test("matrix runs the selected case/config grid, records skips and never treats them as success", async () => {
  await withTempDir(async dir => {
    const output = join(dir, "matrix.json");
    expect(await runEvalCli(["--matrix", "scripted:offline-v1,openai:gpt-fixture", "--allow-paid", "--case", "all", "--output", output], {})).toBe(1);
    const artifact = JSON.parse(await readFile(output, "utf8")) as { results: Array<{ case: { id: string }; settings: unknown; outcome: string; metrics: unknown }>; summary: Record<string, number> };
    expect(artifact.results).toHaveLength(14);
    expect(artifact.summary.success).toBe(7);
    expect(artifact.summary.skipped_prerequisites).toBe(7);
    expect(artifact.summary.grader_failure).toBe(0);
    expect(new Set(artifact.results.map(row => row.case.id)).size).toBe(7);
    expect(artifact.results.every(row => row.settings && row.metrics)).toBe(true);
    expect(JSON.stringify(artifact)).not.toContain("apiKey");
  });
  expect(await runEvalCli(["--matrix", "scripted:offline-v1,openai:gpt-fixture", "--case", "all"], {})).toBe(2);
});

test("mixed pass, fail and skip aggregates only observed outcomes", async () => {
  const failed = await runCodingEval({ caseId: "parallel-read", model: createScriptedModel({ text: "done" }), sourceRevision: "fixture" });
  const skip = skippedCodingEval("openai", "unavailable", "fixture", resolveEvalSettings(), "parallel-read");
  const summary = summarizeEvalResults([{ ...failed, outcome: "success" }, failed, skip]);
  expect(summary).toMatchObject({ success: 1, grader_failure: 1, skipped_prerequisites: 1, model_failure: 0 });
  expect(skip.case.id).toBe("parallel-read");
});

test("timed-out paid usage stops later cases for accounting rather than claiming the money cap was reached", async () => {
  await withTempDir(async dir => {
    const output = join(dir, "timeout.json");
    let attempts = 0;
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation(text => { lines.push(String(text)); });
    try {
      const code = await runEvalCli([
        "--provider", "openai-compatible", "--model", "fixture", "--base-url", "https://fixture.invalid/v1",
        "--allow-paid", "--case", "all", "--timeout-ms", "200", "--max-spend", "0.10",
        "--input-price", "0.10", "--output-price", "0.20", "--output", output,
      ], { OPENAI_COMPATIBLE_API_KEY: "fixture-secret" }, { model: () => ({
        provider: "openai-compatible", id: "fixture", async *stream(request) {
          attempts++;
          await new Promise((_, reject) => {
            request.signal!.throwIfAborted();
            request.signal!.addEventListener("abort", () => reject(request.signal!.reason), { once: true });
          });
        },
      }) });
      const artifact = JSON.parse(await readFile(output, "utf8"));
      expect(code).toBe(3);
      expect(attempts).toBe(1);
      expect(artifact.summary).toMatchObject({ timeout: 1, skipped_spend_cap: 6 });
      expect(artifact.spend).toMatchObject({ totalUsd: 0, capUsd: 0.10, exact: false, stopReason: "usage_unknown" });
      expect(lines.join("\n")).toContain("usage incomplete");
      expect(lines.join("\n")).not.toContain("spend cap reached");
      expect(await readFile(output, "utf8")).not.toContain("fixture-secret");
    } finally { log.mockRestore(); }
  });
});
