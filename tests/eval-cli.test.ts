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

test.each([
  { name: "missing usage", usage: undefined, totalUsd: 0, caseId: "all", exitCode: 3, stopReason: "usage_unknown" },
  { name: "partial usage", usage: { inputTokens: 10, outputTokens: 5 }, totalUsd: 0.000002, caseId: "all", exitCode: 3, stopReason: "usage_unknown" },
  { name: "last-case partial usage", usage: { inputTokens: 10, outputTokens: 5 }, totalUsd: 0.000002, caseId: "clamp-bounds", exitCode: 1, stopReason: null },
])("timed-out paid $name preserves accounting guards and reports the actual stop reason", async ({ usage, totalUsd, caseId, exitCode, stopReason }) => {
  await withTempDir(async dir => {
    const output = join(dir, "timeout.json");
    let attempts = 0;
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation(text => { lines.push(String(text)); });
    try {
      const code = await runEvalCli([
        "--provider", "openai-compatible", "--model", "fixture", "--base-url", "https://fixture.invalid/v1",
        "--allow-paid", "--case", caseId, "--timeout-ms", "200", "--max-spend", "0.10",
        "--input-price", "0.10", "--output-price", "0.20", "--output", output,
      ], { OPENAI_COMPATIBLE_API_KEY: "fixture-secret" }, { model: () => ({
        provider: "openai-compatible", id: "fixture", async *stream(request) {
          attempts++;
          if (usage) yield { type: "usage", usage };
          await new Promise((_, reject) => {
            request.signal!.throwIfAborted();
            request.signal!.addEventListener("abort", () => reject(request.signal!.reason), { once: true });
          });
        },
      }) });
      const artifact = JSON.parse(await readFile(output, "utf8"));
      expect(code).toBe(exitCode);
      expect(attempts).toBe(1);
      if (caseId === "all") expect(artifact.summary).toMatchObject({ timeout: 1, skipped_spend_cap: 6 });
      else expect(artifact.outcome).toBe("timeout");
      expect(artifact.spend).toMatchObject({ totalUsd, capUsd: 0.10, exact: false, stopReason, stoppedBySpendCap: stopReason !== null });
      expect((artifact.results?.[0] ?? artifact).metrics.incompleteAttempts).toBe(1);
      if (stopReason) expect(lines.join("\n")).toContain("usage incomplete");
      else expect(lines.some(line => line.startsWith("stopped:"))).toBe(false);
      expect(lines.join("\n")).not.toContain("spend cap reached");
      expect(await readFile(output, "utf8")).not.toContain("fixture-secret");
    } finally { log.mockRestore(); }
  });
});


/** Keep fixture credentials entirely in memory, including refreshed writes. */
function subscriptionStore(raw: string | null) {
  return { get: async () => raw, set: async (_identity: unknown, value: string) => { raw = value; }, delete: async () => false };
}

/** Solve the clamp fixture through the real tool loop while reporting deterministic usage. */
function subscriptionFixtureModel(usage = true) {
  const model = createScriptedModel({ responses: [
    { toolCalls: [{ id: "fix", name: "edit", arguments: { path: "src/math.ts", edits: [{ oldText: "return Math.min(value, min);", newText: "return Math.max(min, Math.min(max, value));" }] } }] },
    { text: "Done" },
  ] });
  return { ...model, async *stream(request: Parameters<typeof model.stream>[0]) {
    if (usage) yield { type: "usage" as const, usage: { inputTokens: 100, outputTokens: 50 } };
    yield* model.stream(request);
  } };
}

for (const provider of ["codex", "grok"]) {
  test(`${provider} requires model and opt-in and rejects base URL`, async () => {
    for (const args of [[], ["--model", "fixture"], ["--allow-paid"], ["--model", "fixture", "--allow-paid", "--base-url", "https://fixture.invalid"]]) {
      expect(await runEvalCli(["--provider", provider, ...args], {}, { createStore: () => { throw Error("must not inspect credentials"); } })).toBe(2);
    }
  });
  test(`${provider} missing or unusable sign-in skips every case without API fallback`, async () => {
    for (const raw of [null, "invalid", JSON.stringify({ accessToken: "fixture-token", obtainedAt: 1, expiresAt: 1 })]) {
      await withTempDir(async dir => {
        const output = join(dir, "skip.json");
        let calls = 0;
        const log = spyOn(console, "log").mockImplementation(() => {});
        try {
          expect(await runEvalCli(["--provider", provider, "--model", "fixture", "--allow-paid", "--case", "all", "--output", output],
            { OPENAI_API_KEY: "never-use", XAI_API_KEY: "never-use" }, { createStore: () => subscriptionStore(raw),
              fetch: async () => { calls++; throw Error("no network"); }, model: () => { calls++; throw Error("no model"); } })).toBe(1);
          const artifact = JSON.parse(await readFile(output, "utf8"));
          expect(artifact.results).toHaveLength(7);
          for (const result of artifact.results) expect(result).toMatchObject({ provider, model: "fixture", billing: "subscription", outcome: "skipped", reason: "not_signed_in", spendUsd: 0, spendExact: true });
          expect(artifact.spend.casesRun).toBe(0);
          expect(artifact.summary.skipped).toBe(7);
          expect(log.mock.calls.some(([line]) => String(line).includes(`${provider}/fixture: skipped/not_signed_in`))).toBe(true);
          expect(calls).toBe(0);
        } finally { log.mockRestore(); }
      });
    }
  });
  test(`${provider} records subscription billing, usage and no credential metadata`, async () => {
    await withTempDir(async dir => {
      const output = join(dir, "success.json");
      const raw = JSON.stringify({ accessToken: "fixture-private-token", accountId: "fixture-private-account", email: "fixture-private@example.test", obtainedAt: 1 });
      const log = spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(await runEvalCli(["--provider", provider, "--model", "fixture", "--allow-paid", "--output", output], {},
          { createStore: () => subscriptionStore(raw), model: () => subscriptionFixtureModel(), fetch: async () => { throw Error("no network"); } })).toBe(0);
        const text = await readFile(output, "utf8");
        expect(JSON.parse(text)).toMatchObject({ provider, model: "fixture", billing: "subscription", outcome: "success", spendUsd: 0, spendExact: true, metrics: { inputTokens: 200, outputTokens: 100 } });
        const consoleText = log.mock.calls.flat().join("\n");
        expect(consoleText).toContain("spend=subscription");
        for (const secret of ["fixture-private-token", "fixture-private-account", "fixture-private@example.test"]) {
          expect(text).not.toContain(secret); expect(consoleText).not.toContain(secret);
        }
      } finally { log.mockRestore(); }
    });
  });
}

test("subscription matrix entries ignore exhausted usage caps and missing token usage", async () => {
  await withTempDir(async dir => {
    const output = join(dir, "matrix.json");
    const started: string[] = [];
    expect(await runEvalCli(["--matrix", "openai:gpt-5,codex:fixture,grok:fixture,openai:gpt-5", "--allow-paid", "--max-spend", "0.000001", "--output", output],
      { OPENAI_API_KEY: "fixture-api-key" }, { createStore: () => subscriptionStore(JSON.stringify({ accessToken: "fixture", obtainedAt: 1 })),
        model: provider => { started.push(provider); return subscriptionFixtureModel(provider === "openai"); } })).toBe(3);
    const artifact = JSON.parse(await readFile(output, "utf8"));
    expect(started).toEqual(["openai", "codex", "grok"]);
    expect(artifact.results.map((r: { outcome: string }) => r.outcome)).toEqual(["success", "success", "success", "skipped_spend_cap"]);
    expect(artifact.results.map((r: { billing: string }) => r.billing)).toEqual(["usage", "subscription", "subscription", "usage"]);
    expect(artifact.spend.totalUsd).toBe(artifact.results[0].spendUsd);
    for (const result of artifact.results.slice(1, 3)) expect(result).toMatchObject({ spendUsd: 0, spendExact: true, metrics: { inputTokens: null } });
  });
});


test("failed subscription refresh skips safely and continues the matrix", async () => {
  await withTempDir(async dir => {
    const output = join(dir, "refresh-failed.json");
    let fetches = 0;
    expect(await runEvalCli(["--matrix", "codex:fixture,grok:fixture,scripted:offline-v1", "--allow-paid", "--output", output], {}, {
      createStore: () => subscriptionStore(JSON.stringify({ accessToken: "old", refreshToken: "fixture-refresh", expiresAt: 1, obtainedAt: 1 })),
      fetch: async () => { fetches++; return Response.json({ error: "invalid_grant" }, { status: 401 }); },
      model: provider => { expect(provider).toBe("scripted"); return subscriptionFixtureModel(); },
    })).toBe(1);
    const artifact = JSON.parse(await readFile(output, "utf8"));
    expect(fetches).toBe(2);
    expect(artifact.results.map((r: { outcome: string }) => r.outcome)).toEqual(["skipped", "skipped", "success"]);
    expect(artifact.results.slice(0, 2).every((r: { reason: string }) => r.reason === "not_signed_in")).toBe(true);
  });
});


for (const provider of ["codex", "grok"]) {
  test(`${provider} failed preflight runs once per matrix entry across all seven cases`, async () => {
    await withTempDir(async dir => {
      const output = join(dir, "bounded-refresh.json");
      let fetches = 0;
      const log = spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(await runEvalCli(["--matrix", `${provider}:first,${provider}:second,scripted:offline-v1`, "--allow-paid", "--case", "all", "--output", output], {}, {
          createStore: () => subscriptionStore(JSON.stringify({ accessToken: "old", refreshToken: "fixture-refresh", expiresAt: 1, obtainedAt: 1 })),
          fetch: async () => { fetches++; return Response.json({ error: "invalid_grant" }, { status: 401 }); },
        })).toBe(1);
        const artifact = JSON.parse(await readFile(output, "utf8"));
        expect(fetches).toBe(2);
        expect(artifact.results).toHaveLength(21);
        for (const [index, model] of ["first", "second"].entries()) {
          const results = artifact.results.slice(index * 7, (index + 1) * 7);
          expect(new Set(results.map((result: { case: { id: string } }) => result.case.id)).size).toBe(7);
          for (const result of results) expect(result).toMatchObject({ provider, model, outcome: "skipped", reason: "not_signed_in" });
          expect(log.mock.calls.filter(([line]) => String(line).includes(`${provider}/${model}: skipped/not_signed_in`))).toHaveLength(7);
        }
        expect(artifact.summary).toMatchObject({ skipped: 14, success: 7 });
      } finally { log.mockRestore(); }
    });
  });

  test(`${provider} successful preflight persists refresh and caches readiness separately per entry`, async () => {
    await withTempDir(async dir => {
      const output = join(dir, "cached-refresh.json");
      let raw = JSON.stringify({ accessToken: "old", refreshToken: "fixture-refresh", expiresAt: 1, obtainedAt: 1 });
      let reads = 0, writes = 0, fetches = 0;
      const observations: Array<{ model: string; reads: number }> = [];
      expect(await runEvalCli(["--matrix", `${provider}:first,${provider}:second`, "--allow-paid", "--case", "all", "--output", output], {}, {
        createStore: () => ({ get: async () => { reads++; return raw; }, set: async (_identity, value) => { writes++; raw = value; }, delete: async () => false }),
        fetch: async () => { fetches++; return Response.json({ access_token: "renewed-fixture", expires_in: 3600, token_type: "Bearer" }); },
        model: (_provider, model) => {
          expect(JSON.parse(raw).accessToken).toBe("renewed-fixture");
          observations.push({ model, reads });
          // Deliberately leave tasks unsolved: this test measures readiness, not coding grades.
          return createScriptedModel({ text: "Done" });
        },
      })).toBe(1);
      expect(fetches).toBe(1); expect(writes).toBe(1);
      expect(JSON.parse(raw)).toMatchObject({ accessToken: "renewed-fixture", refreshToken: "fixture-refresh" });
      expect(observations).toHaveLength(14);
      const firstReads = observations[0]!.reads, secondReads = observations[7]!.reads;
      expect(secondReads).toBeGreaterThan(firstReads);
      expect(observations.slice(0, 7)).toEqual(Array(7).fill({ model: "first", reads: firstReads }));
      expect(observations.slice(7)).toEqual(Array(7).fill({ model: "second", reads: secondReads }));
      const artifact = JSON.parse(await readFile(output, "utf8"));
      expect(artifact.spend.casesRun).toBe(14);
      expect(artifact.summary.skipped).toBe(0);
    });
  });
}
