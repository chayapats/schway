import { expect, test } from "bun:test";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "./helpers.ts";
import type { AgentClock } from "../src/agent/retry.ts";
import { runCodingEval } from "../src/eval/coding.ts";
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
