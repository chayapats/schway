import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runEvalCli } from "../src/eval/cli.ts";
import { withTempDir } from "./helpers.ts";

test("paid selection requires both model and explicit opt-in, without calling a provider", async () => {
  expect(await runEvalCli(["--provider", "openai", "--model", "gpt-fixture"], {})).toBe(2);
  expect(await runEvalCli(["--provider", "openai", "--allow-paid"], {})).toBe(2);
  expect(await runEvalCli(["--provider", "scripted", "--model", "unknown"], {})).toBe(2);
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
