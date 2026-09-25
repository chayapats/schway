import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, mkdir, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runAgentLoop } from "../agent/loop.ts";
import type { AgentClock } from "../agent/retry.ts";
import { createContextManager } from "../context/manager.ts";
import type { Model } from "../model/model.ts";
import { createJsonlSession } from "../session/jsonl.ts";
import { createEvalTools } from "./tools.ts";
import { resolveWorkspace } from "../workspace/workspace.ts";
import { createEvalMetrics, type EvalMetrics } from "./metrics.ts";

const exec = promisify(execFile);
const INITIAL_SOURCE = "export function clamp(value: number, min: number, max: number): number {\n  return Math.min(value, min);\n}\n";
// Trusted tests evaluate the candidate in a VM, so its top-level code cannot
// exit the test process or forge Bun's reporter status before assertions run.
const TEST_SOURCE = [
  'import { expect, test } from "bun:test";',
  'import { readFileSync } from "node:fs";',
  'import { runInNewContext } from "node:vm";',
  'const source = readFileSync(new URL("../src/math.ts", import.meta.url), "utf8");',
  'const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(source)',
  '  .replace(/^\\s*export\\s+(?=(?:function|const|let)\\s+clamp\\b)/m, "");',
  'function clamp(value: number, min: number, max: number): number {',
  '  return runInNewContext(javascript + "\\nclamp(" + [value, min, max].join(", ") + ")", {}, { timeout: 250 }) as number;',
  '}',
  'test("clamp inside range", () => expect(clamp(5, 0, 10)).toBe(5));',
  'test("clamp below range", () => expect(clamp(-2, 0, 10)).toBe(0));',
  'test("clamp above range", () => expect(clamp(12, 0, 10)).toBe(10));',
  'test("eval subprocess hides unrelated credentials", () => expect(process.env.SCHWAY_EVAL_PRIVATE_TEST).toBeUndefined());',
].join("\n") + "\n";

/** One versioned coding task graded against a real isolated repository. */
export const CODING_CASE = {
  id: "clamp-bounds",
  version: 1,
  task: "Fix src/math.ts so clamp returns the value inside the inclusive [min, max] range and respects both boundaries. Run bun test to verify the change.",
} as const;

/** Bounded settings captured without storing any credential or provider request body. */
export interface EvalSettings {
  maxTurns: number;
  timeoutMs: number;
  maxOutputTokens: number;
}

/** Apply and validate bounded settings consistently for the API and CLI. */
export function resolveEvalSettings(overrides: Partial<EvalSettings> = {}): EvalSettings {
  const settings: EvalSettings = {
    maxTurns: overrides.maxTurns ?? 8,
    timeoutMs: overrides.timeoutMs ?? 30_000,
    maxOutputTokens: overrides.maxOutputTokens ?? 4096,
  };
  if (!Number.isSafeInteger(settings.maxTurns) || settings.maxTurns < 1 || settings.maxTurns > 20 ||
      !Number.isSafeInteger(settings.timeoutMs) || settings.timeoutMs < 1 || settings.timeoutMs > 120_000 ||
      !Number.isSafeInteger(settings.maxOutputTokens) || settings.maxOutputTokens < 1 || settings.maxOutputTokens > 8192) {
    throw new Error("Eval bounds exceeded (maxTurns 1-20, timeoutMs 1-120000, maxOutputTokens 1-8192)");
  }
  return settings;
}

/** Safe artifact for one eval, without prompts, tool arguments, outputs, or credentials. */
export interface CodingEvalResult {
  runId: string;
  case: { id: string; version: number };
  sourceRevision: string;
  provider: string;
  model: string;
  settings: EvalSettings;
  outcome: "success" | "grader_failure" | "model_failure" | "harness_error" | "timeout" | "skipped_prerequisites";
  durationMs: number;
  grader: { passed: boolean; exitCode: number | null } | null;
  metrics: EvalMetrics;
}

/** Execute the real loop and tools in a temporary Git repository, grade files, and clean up on every exit. */
export async function runCodingEval(options: {
  model: Model;
  sourceRevision: string;
  settings?: Partial<EvalSettings>;
  signal?: AbortSignal;
  clock?: AgentClock;
}): Promise<CodingEvalResult> {
  const settings = resolveEvalSettings(options.settings);
  const start = performance.now();
  const runId = crypto.randomUUID();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  let directory: string | undefined;
  let outcome: CodingEvalResult["outcome"] = "harness_error";
  let grader: CodingEvalResult["grader"] = null;
  let metrics = createEvalMetricsPlaceholder();
  try {
    directory = await mkdtemp(join(tmpdir(), "schway-eval-"));
    const project = join(directory, "project");
    await mkdir(join(project, "src"), { recursive: true });
    await mkdir(join(project, "test"), { recursive: true });
    const home = join(directory, "home");
    await mkdir(home);
    const subprocessEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: directory };
    await writeFile(join(project, "package.json"), '{"private":true,"type":"module"}\n');
    await writeFile(join(project, "src/math.ts"), INITIAL_SOURCE);
    await writeFile(join(project, "test/math.test.ts"), TEST_SOURCE);
    await exec("git", ["init", "-q", project], { timeout: 3000, env: subprocessEnv });
    signal.throwIfAborted();
    const workspace = await resolveWorkspace(project);
    const session = await createJsonlSession({ directory: join(directory, "sessions"), workspace });
    session.append({ type: "user", id: crypto.randomUUID(), content: [{ type: "text", text: CODING_CASE.task }] });
    const tracker = createEvalMetrics(session);
    const tools = createEvalTools(project);
    let reason: string | undefined;
    let errorOrigin: "model" | "harness" | undefined;
    for await (const event of runAgentLoop({
      session, model: options.model, contextManager: createContextManager(workspace, { home }),
      workspace, tools, maxTurns: settings.maxTurns, signal, clock: options.clock, toolEnv: subprocessEnv,
    })) {
      tracker.record(event);
      if (event.type === "agent.finished") reason = event.reason;
      if (event.type === "error") errorOrigin = event.origin;
    }
    metrics = tracker.result();
    if (signal.aborted) outcome = controller.signal.aborted ? "timeout" : "model_failure";
    else if (reason !== "completed") outcome = errorOrigin === "harness" ? "harness_error" : "model_failure";
    else {
      grader = await grade(project, join(directory, "grading"), signal, subprocessEnv);
      outcome = signal.aborted ? controller.signal.aborted ? "timeout" : "model_failure" : grader.passed ? "success" : "grader_failure";
    }
  } catch (error) {
    outcome = controller.signal.aborted || error instanceof GraderTimeout ? "timeout" : signal.aborted ? "model_failure" : "harness_error";
  } finally {
    clearTimeout(timer);
    if (directory) await rm(directory, { recursive: true, force: true });
  }
  return {
    runId, case: { id: CODING_CASE.id, version: CODING_CASE.version },
    sourceRevision: options.sourceRevision, provider: options.model.provider, model: options.model.id,
    settings, outcome, durationMs: Math.round(performance.now() - start), grader, metrics,
  };
}

/** Grade the actual source and bounded real Bun test exit, not the assistant's final prose. */
async function grade(project: string, gradingCopy: string, signal: AbortSignal, env: NodeJS.ProcessEnv): Promise<{ passed: boolean; exitCode: number | null }> {
  const source = await readBoundedFile(join(project, "src/math.ts"), 100_000, signal);
  const testSource = await readBoundedFile(join(project, "test/math.test.ts"), 16_000, signal);
  if (source === null || testSource !== TEST_SOURCE) {
    return { passed: false, exitCode: null };
  }
  // The candidate cannot persist bunfig/preload files into the grader's fresh project.
  await mkdir(join(gradingCopy, "src"), { recursive: true });
  await mkdir(join(gradingCopy, "test"), { recursive: true });
  await writeFile(join(gradingCopy, "package.json"), '{"private":true,"type":"module"}\n');
  await writeFile(join(gradingCopy, "src/math.ts"), source);
  await writeFile(join(gradingCopy, "test/math.test.ts"), TEST_SOURCE);
  let exitCode: number | null = 0;
  try {
    await exec("bun", ["--no-env-file", "test", "test/math.test.ts"], {
      cwd: gradingCopy, timeout: 5000, maxBuffer: 8192, signal, env,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    const code = (error as { code?: unknown }).code;
    if (code === "ETIMEDOUT" || (error as { killed?: boolean }).killed) throw new GraderTimeout();
    exitCode = typeof code === "number" ? code : null;
  }
  // Only trusted tests running candidate code inside a VM determine success.
  // Do not infer completion from candidate-controlled stdout or stderr.
  return { passed: source !== INITIAL_SOURCE && exitCode === 0, exitCode };
}

/** Read only a regular, non-symlink candidate with a strict byte cap and abort checks. */
async function readBoundedFile(path: string, maxBytes: number, signal: AbortSignal): Promise<string | null> {
  signal.throwIfAborted();
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (["ENOENT", "ELOOP", "EACCES", "EPERM", "EISDIR", "ENXIO"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) return null;
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer, size, Math.min(8192, buffer.length - size), size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    return size <= maxBytes ? buffer.subarray(0, size).toString("utf8") : null;
  } finally { await file.close(); }
}

/** Distinguish grader command timeout from ordinary failed tests. */
class GraderTimeout extends Error {}

/** Record a prerequisite skip without constructing or calling a paid model. */
export function skippedCodingEval(provider: string, model: string, sourceRevision: string, settings: EvalSettings): CodingEvalResult {
  return unstartedEval(provider, model, sourceRevision, settings, "skipped_prerequisites");
}

/** Record a failed provider setup without leaking construction errors or losing the artifact. */
export function failedCodingEval(provider: string, model: string, sourceRevision: string, settings: EvalSettings): CodingEvalResult {
  return unstartedEval(provider, model, sourceRevision, settings, "harness_error");
}

/** Produce safe metadata for a run that never reached the coding workspace. */
function unstartedEval(provider: string, model: string, sourceRevision: string, settings: EvalSettings, outcome: "harness_error" | "skipped_prerequisites"): CodingEvalResult {
  return { runId: crypto.randomUUID(), case: { id: CODING_CASE.id, version: CODING_CASE.version },
    sourceRevision, provider, model, settings, outcome,
    durationMs: 0, grader: null, metrics: createEvalMetricsPlaceholder() };
}

/** Initialize explicit unknown token totals for early setup failures. */
function createEvalMetricsPlaceholder(): EvalMetrics {
  return { inputTokens: null, outputTokens: null, unknownInputAttempts: 0,
    unknownOutputAttempts: 0, incompleteAttempts: 0, toolCalls: 0,
    toolFailures: 0, providerRetries: 0, compactions: 0, repeatedToolCalls: 0 };
}
