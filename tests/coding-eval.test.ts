import { expect, test } from "bun:test";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "./helpers.ts";
import type { AgentClock } from "../src/agent/retry.ts";
import { runCodingEval } from "../src/eval/coding.ts";
import { DAILY_CASES } from "../src/eval/cases.ts";
import type { Model, ModelRequest, ModelStreamEvent } from "../src/model/model.ts";
import { createScriptedModel, type ScriptedTurnFactory } from "./helpers/scripted-model.ts";

const revision = "fixture-revision";
const edit = { path: "src/math.ts", edits: [{ oldText: "return Math.min(value, min);", newText: "return Math.max(min, Math.min(max, value));" }] };

function script(responses: ScriptedTurnFactory[]): Model {
  return createScriptedModel({ responses });
}

test("unchanged code fails the real grader even when the model claims success", async () => {
  const result = await runCodingEval({ model: script([{ text: "Fixed and tests passed" }]), sourceRevision: revision });
  expect(result.outcome).toBe("grader_failure");
  expect(result.grader?.exitCode).not.toBe(0);
  expect(result.metrics.inputTokens).toBeNull();
  expect(result.metrics.unknownInputAttempts).toBe(1);
});

test("real edits pass, source workspace stays isolated and temp repository is removed", async () => {
  let workspace = "";
  const model = script([
    (request) => {
      workspace = request.context.find(section => section.name === "environment")?.content.match(/Workspace root: ([^\n]+)/)?.[1] ?? "";
      return { toolCalls: [{ id: "edit1", name: "edit", arguments: edit }] };
    },
    { toolCalls: [{ id: "test1", name: "bash", arguments: { command: "bun test test/math.test.ts", timeout: 5000 } }] },
    { text: "done" },
  ]);
  const result = await runCodingEval({ model, sourceRevision: revision });
  expect(result.outcome).toBe("success");
  expect(result.grader).toEqual({ passed: true, exitCode: 0 });
  expect(result.metrics.toolCalls).toBe(2);
  expect(result.case).toEqual({ id: "clamp-bounds", version: 1 });
  expect(result.sourceRevision).toBe(revision);
  expect(workspace).toContain("schway-eval-");
  await expect(access(workspace)).rejects.toThrow();
});

test("grader accepts a different correct clamp implementation", async () => {
  const result = await runCodingEval({ model: script([
    { toolCalls: [{ id: "alternate", name: "write", arguments: { path: "src/math.ts", content: "export function clamp(value: number, min: number, max: number): number { if (value < min) return min; if (value > max) return max; return value; }\n" } }] },
    { text: "done" },
  ]), sourceRevision: revision });
  expect(result.outcome).toBe("success");
});

test("case test subprocesses cannot inherit unrelated parent credentials", async () => {
  const key = "SCHWAY_EVAL_PRIVATE_TEST";
  const previous = process.env[key];
  process.env[key] = "fixture-secret";
  try {
    const result = await runCodingEval({ model: script([
      { toolCalls: [{ id: "env", name: "edit", arguments: edit }] },
      { toolCalls: [{ id: "verify", name: "bash", arguments: { command: "bun test test/math.test.ts" } }] },
      { text: "done" },
    ]), sourceRevision: revision });
    expect(result.outcome).toBe("success");
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test("missing grader executable is a skipped prerequisite, not a failing candidate", async () => {
  const result = await runCodingEval({ model: script([{ text: "done" }]), sourceRevision: revision,
    graderExecutable: "/nonexistent/schway-eval-bun-fixture" });
  expect(result.outcome).toBe("skipped_prerequisites");
  expect(result.grader).toBeNull();
});

test("wrong edits fail, model and turn failures stay distinct from grader failures", async () => {
  const wrong = await runCodingEval({ model: script([
    { toolCalls: [{ id: "edit1", name: "edit", arguments: { ...edit, edits: [{ oldText: "return Math.min(value, min);", newText: "return Math.min(value, max);" }] } }] },
    { text: "done" },
  ]), sourceRevision: revision });
  expect(wrong.outcome).toBe("grader_failure");
  const failed = await runCodingEval({ model: script([{ error: "provider rejected" }]), sourceRevision: revision });
  expect(failed.outcome).toBe("model_failure");
  const bounded = await runCodingEval({ model: script([{ toolCalls: [{ id: "r", name: "read", arguments: { path: "src/math.ts" } }] }]), sourceRevision: revision, settings: { maxTurns: 1 } });
  expect(bounded.outcome).toBe("model_failure");
});

test("oversized candidate source is rejected before full read or execution", async () => {
  const result = await runCodingEval({ model: script([
    { toolCalls: [{ id: "oversized", name: "write", arguments: { path: "src/math.ts", content: " ".repeat(100_001) } }] },
    { text: "done" },
  ]), sourceRevision: revision });
  expect(result.outcome).toBe("grader_failure");
  expect(result.grader?.exitCode).toBeNull();
});

test("fake test output and an early zero exit cannot bypass trusted assertions", async () => {
  const result = await runCodingEval({ model: script([
    { toolCalls: [{ id: "exit", name: "write", arguments: { path: "src/math.ts", content: 'console.error("3 pass\\n0 fail"); process.exit(0);\nexport function clamp() { return 5; }\n' } }] },
    { text: "fixed" },
  ]), sourceRevision: revision });
  expect(result.outcome).toBe("grader_failure");
  expect(result.grader?.passed).toBe(false);
  expect(result.grader?.exitCode).not.toBe(0);
});

test("editing the grader test is rejected and cannot turn a wrong fix into success", async () => {
  const result = await runCodingEval({ model: script([
    { toolCalls: [{ id: "write1", name: "write", arguments: { path: "test/math.test.ts", content: 'import { test } from "bun:test"; test("fake", () => {});' } }] },
    { text: "done" },
  ]), sourceRevision: revision });
  expect(result.grader?.passed).toBe(false);
  expect(result.metrics.toolFailures).toBe(1);
  expect(result.outcome).toBe("grader_failure");
});

test("eval tool paths and shell commands cannot mutate files outside the case", async () => {
  await withTempDir(async dir => {
    const outside = join(dir, "outside.txt");
    await writeFile(outside, "untouched");
    const result = await runCodingEval({ model: script([
      { toolCalls: [{ id: "external", name: "write", arguments: { path: outside, content: "changed" } }] },
      { toolCalls: [{ id: "shell", name: "bash", arguments: { command: `printf changed > ${outside}` } }] },
      { text: "done" },
    ]), sourceRevision: revision });
    expect(result.outcome).toBe("grader_failure");
    expect(result.metrics.toolFailures).toBe(2);
    expect(await readFile(outside, "utf8")).toBe("untouched");
  });
});

test("timeout and caller cancellation clean up without grading incomplete work", async () => {
  let workspace = "";
  const stalled = (onStart?: () => void): Model => ({ provider: "scripted", id: "waiting", async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    workspace = request.context.find(section => section.name === "environment")?.content.match(/Workspace root: ([^\n]+)/)?.[1] ?? "";
    const aborted = new Promise<void>(resolve => request.signal!.addEventListener("abort", () => resolve(), { once: true }));
    onStart?.();
    await aborted;
    throw new DOMException("aborted", "AbortError");
  } });
  const timeout = await runCodingEval({ model: stalled(), sourceRevision: revision, settings: { timeoutMs: 80 } });
  expect(timeout.outcome).toBe("timeout");
  expect(timeout.grader).toBeNull();
  await expect(access(workspace)).rejects.toThrow();
  const controller = new AbortController();
  const cancelled = await runCodingEval({ model: stalled(() => controller.abort()), signal: controller.signal, sourceRevision: revision });
  expect(cancelled.outcome).toBe("model_failure");
  expect(cancelled.metrics.incompleteAttempts).toBe(1);
  await expect(access(workspace)).rejects.toThrow();
});

test("retries, known partial usage, tool errors and canonical repeat counts are aggregated once", async () => {
  let index = 0;
  const model: Model = { provider: "scripted", id: "metrics-fixture", async *stream(request) {
    request.signal?.throwIfAborted();
    const turn = index++;
    if (turn === 0) {
      yield { type: "usage", usage: { inputTokens: 7, outputTokens: 2 } };
      throw Object.assign(new Error("temporary"), { status: 503 });
    }
    if (turn === 1) {
      yield { type: "usage", usage: { inputTokens: 11, outputTokens: 3 } };
      yield { type: "message_complete", message: { type: "assistant", id: "m1", content: [
        { type: "tool_call", id: "f1", name: "read", arguments: { path: "missing.ts", start: 1 } },
      ] } };
    } else if (turn === 2) {
      yield { type: "message_complete", message: { type: "assistant", id: "m2", content: [
        { type: "tool_call", id: "f2", name: "read", arguments: { start: 1, path: "missing.ts" } },
      ] } };
    } else yield { type: "message_complete", message: { type: "assistant", id: "m3", content: [{ type: "text", text: "done" }] } };
  } };
  const clock: AgentClock = { now: () => 0, sleep: async () => {} };
  const result = await runCodingEval({ model, sourceRevision: revision, clock });
  expect(result.outcome).toBe("grader_failure");
  expect(result.metrics).toEqual({ inputTokens: 18, outputTokens: 5, unknownInputAttempts: 2,
    unknownOutputAttempts: 2, incompleteAttempts: 1, toolCalls: 2, toolFailures: 2,
    providerRetries: 1, compactions: 0, repeatedToolCalls: 1 });
  expect(JSON.stringify(result)).not.toContain("missing.ts");
});

const call = (id: string, name: string, args: unknown) => ({ id, name, arguments: args });
const put = (path: string, content: string) => call(`write-${path}`, "write", { path, content });
const done = { text: "Done" };

const solutions: Record<string, ScriptedTurnFactory[]> = {
  "multi-file-refactor": [
    { toolCalls: [put("src/normalize.ts", 'export function normalizeName(value: string): string { return value.trim().replace(/\\s+/g, " "); }\n'),
      put("src/display.ts", 'import { normalizeName } from "./normalize.ts";\nexport function displayName(value: string): string { return normalizeName(value); }\n')] }, done,
  ],
  "locate-implementation": [
    { toolCalls: [call("server", "read", { path: "src/server.ts" }), call("router", "read", { path: "src/router.ts" }), call("preview", "read", { path: "src/preview.ts" })] },
    { toolCalls: [put("answer.json", JSON.stringify({ path: "src/router.ts", symbol: "resolveRoute" }))] }, done,
  ],
  "failing-tests": [
    { toolCalls: [call("failing", "bash", { command: "bun test test/cart.test.ts" })] },
    { toolCalls: [call("fix", "edit", { path: "src/cart.ts", edits: [{ oldText: "sum + item.price", newText: "sum + item.price * item.quantity" }] })] }, done,
  ],
  "long-context": [{ toolCalls: [put("answer.json", JSON.stringify({ codename: "amber", channel: "stable" }))] }, done],
  "tool-error-recovery": [
    { toolCalls: [call("bad", "read", { path: "src/missing-config.ts" })] },
    { toolCalls: [call("good", "read", { path: "src/config.ts" })] },
    { toolCalls: [put("answer.json", JSON.stringify({ region: "ap-south", revision: 7 }))] }, done,
  ],
  "parallel-read": [
    { toolCalls: [call("one", "read", { path: "input/customer.txt" }), call("two", "read", { path: "input/item.txt" }), call("three", "read", { path: "input/count.txt" })] },
    { toolCalls: [put("answer.json", JSON.stringify({ customer: "mina", sku: "Q42", quantity: 3 }))] }, done,
  ],
};

function caseScript(id: string, responses: ScriptedTurnFactory[]): Model {
  const base = script(responses);
  if (id !== "long-context") return base;
  return { provider: "scripted", id: "summary-fixture", async *stream(request) {
    if (request.systemPrompt.includes("You summarize a long coding session")) {
      yield { type: "message_complete", message: { type: "assistant", id: crypto.randomUUID(), content: [{ type: "text", text: "Codename amber; channel stable" }] } };
    } else yield* base.stream(request);
  } };
}

for (const scenario of DAILY_CASES) {
  test(`${scenario.id} passes with an offline solution and rejects an unmodified self-report`, async () => {
    const passed = await runCodingEval({ caseId: scenario.id, model: caseScript(scenario.id, solutions[scenario.id]!), sourceRevision: revision });
    expect(passed.outcome).toBe("success");
    expect(passed.case).toEqual({ id: scenario.id, version: 1 });
    const wrong = await runCodingEval({ caseId: scenario.id, model: caseScript(scenario.id, [done]), sourceRevision: revision });
    expect(wrong.outcome).toBe("grader_failure");
    if (scenario.id === "parallel-read") expect(wrong.grader?.evidence).toBe("missing_reads:input/customer.txt,input/item.txt,input/count.txt");
    else if (scenario.id === "tool-error-recovery") expect(wrong.grader?.evidence).toBe("missing_recovery");
    else expect(wrong.grader?.evidence).toContain("behavior_mismatch:");
  });
}

test("coupled refactor rejects changing only the caller or only the definition", async () => {
  for (const path of ["src/display.ts", "src/normalize.ts"] as const) {
    const edit = (solutions["multi-file-refactor"]![0] as { toolCalls: ReturnType<typeof call>[] }).toolCalls.find(item => (item.arguments as { path: string }).path === path)!;
    const result = await runCodingEval({ caseId: "multi-file-refactor", model: script([{ toolCalls: [edit] }, done]), sourceRevision: revision });
    expect(result.outcome).toBe("grader_failure");
  }
});

test("a cosmetic normalize edit and caller-only workaround fail the trusted refactor behavior", async () => {
  const result = await runCodingEval({ caseId: "multi-file-refactor", sourceRevision: revision, model: script([
    { toolCalls: [put("src/normalize.ts", 'export function normalizeName(value: string): string { return value.trim(); } // changed\n'),
      put("src/display.ts", 'import { normalizeName } from "./normalize.ts";\nexport function displayName(value: string): string { return normalizeName(value).replace(/\\s+/g, " "); }\n')] }, done,
  ]) });
  expect(result.outcome).toBe("grader_failure");
});

test("locate grader rejects a plausible distractor and test deletion is denied", async () => {
  const wrong = await runCodingEval({ caseId: "locate-implementation", model: script([
    { toolCalls: [put("answer.json", JSON.stringify({ path: "src/preview.ts", symbol: "resolveRoute" }))] }, done,
  ]), sourceRevision: revision });
  expect(wrong.outcome).toBe("grader_failure");
  expect(wrong.grader?.evidence).toContain('"actual":{"path":"src/preview.ts"');
  const tampered = await runCodingEval({ caseId: "failing-tests", model: script([
    { toolCalls: [put("test/cart.test.ts", 'import { test } from "bun:test"; test("fake", () => {});')] }, done,
  ]), sourceRevision: revision });
  expect(tampered.outcome).toBe("grader_failure");
  expect(tampered.metrics.toolFailures).toBe(1);
});

test("failing tests and recoverable missing path record real errors but still grade outcomes", async () => {
  const broken = await runCodingEval({ caseId: "failing-tests", model: script([
    solutions["failing-tests"]![0]!,
    request => {
      expect(request.items.some(item => item.type === "tool_result" && item.content.includes("Exit code: 1"))).toBe(true);
      return solutions["failing-tests"]![1] as { toolCalls: ReturnType<typeof call>[] };
    }, done,
  ]), sourceRevision: revision });
  expect(broken.outcome).toBe("success");
  // A nonzero bash exit is result data; toolFailures counts protocol/tool errors only.
  expect(broken.metrics.toolFailures).toBe(0);
  const recovered = await runCodingEval({ caseId: "tool-error-recovery", model: script(solutions["tool-error-recovery"]!), sourceRevision: revision });
  expect(recovered.outcome).toBe("success");
  expect(recovered.metrics.toolFailures).toBe(1);
  const wrong = await runCodingEval({ caseId: "tool-error-recovery", model: script([{ toolCalls: [put("answer.json", JSON.stringify({ region: "wrong", revision: 7 }))] }, done]), sourceRevision: revision });
  expect(wrong.outcome).toBe("grader_failure");
  const guessed = await runCodingEval({ caseId: "tool-error-recovery", model: script([{ toolCalls: [put("answer.json", JSON.stringify({ region: "ap-south", revision: 7 }))] }, done]), sourceRevision: revision });
  expect(guessed.outcome).toBe("grader_failure");
  expect(guessed.grader?.evidence).toBe("missing_recovery");
});

test("long context compacts older complete turns; retained summary facts determine the graded result", async () => {
  const run = (preserve: boolean) => {
    let summarySeen = false;
    let regularTurn = 0;
    const model: Model = { provider: "scripted", id: "compaction-fixture", async *stream(request) {
      const summarizing = request.systemPrompt.includes("You summarize a long coding session");
      if (summarizing) {
        summarySeen = true;
        const history = JSON.stringify(request.items);
        expect(history).toContain("amber");
        expect(history).toContain("stable");
      } else {
        expect(summarySeen).toBe(true);
        expect(JSON.stringify(request.items)).not.toContain("codename is amber");
      }
      const summary = preserve ? "Codename amber; channel stable" : "Release notes without older facts";
      const content = summarizing ? summary : regularTurn++ === 0 ? undefined : "done";
      const facts = request.context.find(section => section.name === "summary")?.content ?? "";
      yield { type: "message_complete", message: { type: "assistant", id: crypto.randomUUID(), content: content !== undefined ? [{ type: "text", text: content }] : [{ type: "tool_call", ...put("answer.json", JSON.stringify({ codename: facts.includes("amber") ? "amber" : "unknown", channel: facts.includes("stable") ? "stable" : "unknown" })) }] } };
    } };
    return { model, compacted: () => summarySeen };
  };
  const good = run(true);
  const passed = await runCodingEval({ caseId: "long-context", model: good.model, sourceRevision: revision });
  expect(good.compacted()).toBe(true);
  expect(passed.metrics.compactions).toBeGreaterThan(0);
  expect(passed.outcome).toBe("success");
  const bad = run(false);
  const failed = await runCodingEval({ caseId: "long-context", model: bad.model, sourceRevision: revision });
  expect(failed.outcome).toBe("grader_failure");
});

test("parallel reads overlap in the controlled fixture but timing is not the grade", async () => {
  const concurrent = await runCodingEval({ caseId: "parallel-read", model: script(solutions["parallel-read"]!), sourceRevision: revision });
  expect(concurrent.readOverlap).toBe(true);
  expect(concurrent.metrics.toolCalls).toBe(4);
  const serial = await runCodingEval({ caseId: "parallel-read", model: script([
    { toolCalls: [call("one", "read", { path: "input/customer.txt" })] },
    { toolCalls: [call("two", "read", { path: "input/item.txt" })] },
    { toolCalls: [call("three", "read", { path: "input/count.txt" })] },
    { toolCalls: [put("answer.json", JSON.stringify({ customer: "mina", sku: "Q42", quantity: 3 }))] }, done,
  ]), sourceRevision: revision });
  expect(serial.outcome).toBe("success");
  expect(serial.readOverlap).toBe(false);
  const guessed = await runCodingEval({ caseId: "parallel-read", model: script([
    { toolCalls: [put("answer.json", JSON.stringify({ customer: "mina", sku: "Q42", quantity: 3 }))] }, done,
  ]), sourceRevision: revision });
  expect(guessed.outcome).toBe("grader_failure");
  expect(guessed.grader?.evidence).toContain("missing_reads");
});

test("grader evidence bounds candidate observations and redacts arbitrary secrets", async () => {
  const secret = "sk-fixture-sensitive-value";
  const result = await runCodingEval({ caseId: "locate-implementation", model: script([
    { toolCalls: [put("answer.json", JSON.stringify({ path: secret, symbol: secret }))] }, done,
  ]), sourceRevision: revision });
  expect(result.outcome).toBe("grader_failure");
  expect(result.grader?.evidence).toContain('"actual":{"path":"[redacted]","symbol":"[redacted]"}');
  expect(JSON.stringify(result)).not.toContain(secret);
});

test("daily-case timeout and cancellation do not report success", async () => {
  const controller = new AbortController();
  const cancelled = await runCodingEval({ caseId: "parallel-read", model: script([{ waitForAbort: true }]), sourceRevision: revision,
    signal: controller.signal, settings: { timeoutMs: 1000 }, clock: { now: () => 0, sleep: async () => {} } });
  expect(cancelled.outcome).toBe("timeout");
});
