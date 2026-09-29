import { execFile } from "node:child_process";
import { dirname, relative } from "node:path";
import { resolveToolPath } from "../tools/path.ts";
import { DAILY_CASES, type EvalCase } from "./cases.ts";
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
  version: 2,
  task: "Fix src/math.ts so clamp returns the value inside the inclusive [min, max] range and respects both boundaries. Run exactly bun test test/math.test.ts to verify the change. The eval permits only that exact bash command; omit cwd and timeout arguments.",
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
  outcome: "success" | "grader_failure" | "model_failure" | "harness_error" | "timeout" | "skipped_prerequisites" | "skipped_spend_cap";
  /** Estimated USD spend for this case, set by the eval runner from recorded usage and the route price. */
  spendUsd?: number;
  /** False when some attempts reported no usage, making `spendUsd` a lower bound. */
  spendExact?: boolean;
  durationMs: number;
  grader: { passed: boolean; exitCode: number | null; evidence?: string } | null;
  metrics: EvalMetrics;
  /** Tool-call overlap is diagnostic evidence, not a real-model timing grade. */
  readOverlap?: boolean;
}

/** Execute the real loop and tools in a temporary Git repository, grade files, and clean up on every exit. */
export async function runCodingEval(options: {
  model: Model;
  sourceRevision: string;
  settings?: Partial<EvalSettings>;
  signal?: AbortSignal;
  clock?: AgentClock;
  /** Defaults to the original clamp-bounds case. */
  caseId?: string;
  /** Override the grader executable for embedded runs or deterministic missing-prerequisite checks. */
  graderExecutable?: string;
}): Promise<CodingEvalResult> {
  const settings = resolveEvalSettings(options.settings);
  const selected = options.caseId === undefined || options.caseId === CODING_CASE.id ? undefined : DAILY_CASES.find(item => item.id === options.caseId);
  if (options.caseId !== undefined && options.caseId !== CODING_CASE.id && !selected) throw new Error(`Unknown eval case: ${options.caseId}`);
  const start = performance.now();
  const runId = crypto.randomUUID();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  let directory: string | undefined;
  let outcome: CodingEvalResult["outcome"] = "harness_error";
  let grader: CodingEvalResult["grader"] = null;
  let metrics = createEvalMetricsPlaceholder();
  let readOverlap = false;
  const activeReads = new Set<string>();
  const readPaths = new Map<string, string>();
  const completedReads = new Set<string>();
  const failedReads = new Set<string>();
  let recoveredRead = false;
  try {
    directory = await mkdtemp(join(tmpdir(), "schway-eval-"));
    const project = join(directory, "project");
    await mkdir(join(project, "src"), { recursive: true });
    await mkdir(join(project, "test"), { recursive: true });
    const home = join(directory, "home");
    await mkdir(home);
    const subprocessEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: directory };
    await writeFile(join(project, "package.json"), '{"private":true,"type":"module"}\n');
    for (const [path, content] of Object.entries(selected?.seed ?? { "src/math.ts": INITIAL_SOURCE, "test/math.test.ts": TEST_SOURCE })) {
      await mkdir(dirname(join(project, path)), { recursive: true });
      await writeFile(join(project, path), content);
    }
    await exec("git", ["init", "-q", project], { timeout: 3000, env: subprocessEnv });
    signal.throwIfAborted();
    const workspace = await resolveWorkspace(project);
    const session = await createJsonlSession({ directory: join(directory, "sessions"), workspace });
    for (const fact of selected?.history ?? []) {
      session.append({ type: "user", id: crypto.randomUUID(), content: [{ type: "text", text: fact }] });
      session.append({ type: "assistant", id: crypto.randomUUID(), content: [{ type: "text", text: "Acknowledged; retain this for the final task." }] });
    }
    session.append({ type: "user", id: crypto.randomUUID(), content: [{ type: "text", text: selected?.task ?? CODING_CASE.task }] });
    const tracker = createEvalMetrics(session);
    const tools = createEvalTools(project, selected);
    let reason: string | undefined;
    let errorOrigin: "model" | "harness" | undefined;
    for await (const event of runAgentLoop({
      session, model: options.model, contextManager: createContextManager(workspace, { home, ...(selected?.contextWindow ? { contextWindow: selected.contextWindow } : {}) }),
      workspace, tools, maxTurns: settings.maxTurns, signal, clock: options.clock, toolEnv: subprocessEnv,
    })) {
      tracker.record(event);
      if (event.type === "model.finished" && (selected?.id === "parallel-read" || selected?.id === "tool-error-recovery")) {
        const message = session.items.at(-1);
        if (message?.type === "assistant") for (const block of message.content) {
          if (block.type === "tool_call" && block.name === "read" && block.arguments && typeof block.arguments === "object" && !Array.isArray(block.arguments)) {
            const path = (block.arguments as { path?: unknown }).path;
            if (typeof path === "string") readPaths.set(block.id, relative(workspace.root, resolveToolPath(workspace.root, path)));
          }
        }
      }
      if (event.type === "tool.started" && event.name === "read" && readPaths.has(event.toolCallId)) {
        if (activeReads.size > 0) readOverlap = true;
        activeReads.add(event.toolCallId);
      }
      if (event.type === "tool.finished") {
        activeReads.delete(event.toolCallId);
        const path = readPaths.get(event.toolCallId);
        if (path && event.name === "read") {
          if (event.status === "success") {
            completedReads.add(path);
            if (path === "src/config.ts" && failedReads.has("src/missing-config.ts")) recoveredRead = true;
          } else failedReads.add(path);
        }
      }
      if (event.type === "agent.finished") reason = event.reason;
      if (event.type === "error") errorOrigin = event.origin;
    }
    metrics = tracker.result();
    if (signal.aborted) outcome = controller.signal.aborted ? "timeout" : "model_failure";
    else if (reason !== "completed") outcome = errorOrigin === "harness" ? "harness_error" : "model_failure";
    else {
      grader = selected
        ? await gradeDaily(selected, project, signal, subprocessEnv, options.graderExecutable ?? "bun", completedReads, recoveredRead)
        : await grade(project, join(directory, "grading"), signal, subprocessEnv, options.graderExecutable ?? "bun");
      outcome = signal.aborted ? controller.signal.aborted ? "timeout" : "model_failure" : grader.passed ? "success" : "grader_failure";
    }
  } catch (error) {
    outcome = controller.signal.aborted || error instanceof GraderTimeout ? "timeout" : signal.aborted ? "model_failure" : error instanceof GraderUnavailable ? "skipped_prerequisites" : "harness_error";
  } finally {
    clearTimeout(timer);
    if (directory) await rm(directory, { recursive: true, force: true });
  }
  return {
    runId, case: { id: selected?.id ?? CODING_CASE.id, version: selected?.version ?? CODING_CASE.version },
    sourceRevision: options.sourceRevision, provider: options.model.provider, model: options.model.id,
    settings, outcome, durationMs: Math.round(performance.now() - start), grader, metrics,
    ...(selected?.id === "parallel-read" ? { readOverlap } : {}),
  };
}

/** Grade the actual source and bounded real Bun test exit, not the assistant's final prose. */
async function grade(project: string, gradingCopy: string, signal: AbortSignal, env: NodeJS.ProcessEnv, executable: string): Promise<{ passed: boolean; exitCode: number | null }> {
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
    await exec(executable, ["--no-env-file", "test", "test/math.test.ts"], {
      cwd: gradingCopy, timeout: 5000, maxBuffer: 8192, signal, env,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    const code = (error as { code?: unknown }).code;
    if (code === "ETIMEDOUT" || (error as { killed?: boolean }).killed) throw new GraderTimeout();
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM") throw new GraderUnavailable();
    if (typeof code === "string" && code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw error;
    exitCode = typeof code === "number" ? code : null;
  }
  // Only trusted tests running candidate code inside a VM determine success.
  // Do not infer completion from candidate-controlled stdout or stderr.
  return { passed: source !== INITIAL_SOURCE && exitCode === 0, exitCode };
}

/** Grade bounded case files and immutable fixtures independently of the model's reported success. */
async function gradeDaily(selected: EvalCase, project: string, signal: AbortSignal, env: NodeJS.ProcessEnv, executable: string, reads: ReadonlySet<string>, recoveredRead: boolean): Promise<{ passed: boolean; exitCode: number | null; evidence: string }> {
  // The same prerequisite as the clamp grader; unavailable Bun is an explicit skip.
  try { await exec(executable, ["--version"], { timeout: 3000, signal, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } }); }
  catch (error) {
    if (["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new GraderUnavailable();
    throw error;
  }
  const files: Record<string, string> = {};
  for (const [path, initial] of Object.entries(selected.seed)) {
    const value = await readBoundedFile(join(project, path), 16_000, signal);
    if (value === null) return { passed: false, exitCode: null, evidence: `missing_or_oversized:${path}` };
    if (!selected.writable.includes(path) && value !== initial) return { passed: false, exitCode: null, evidence: `fixture_changed:${path}` };
    files[path] = value;
  }
  const requiredReads = selected.id === "parallel-read" ? ["input/customer.txt", "input/item.txt", "input/count.txt"] : [];
  const missingReads = requiredReads.filter(path => !reads.has(path));
  const behaviorPassed = await selected.check(files, env, signal);
  signal.throwIfAborted();
  const passed = behaviorPassed && missingReads.length === 0 && (selected.id !== "tool-error-recovery" || recoveredRead);
  const evidence = missingReads.length ? `missing_reads:${missingReads.join(",")}` :
    selected.id === "tool-error-recovery" && !recoveredRead ? "missing_recovery" : passed ? "checked" :
      `behavior_mismatch:${await selected.diagnose(files, env, signal)}`;
  signal.throwIfAborted();
  return { passed, exitCode: passed ? 0 : 1, evidence };
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

/** Missing or unusable grader executable is a skipped prerequisite, not a candidate failure. */
class GraderUnavailable extends Error {}

/** Record a prerequisite skip without constructing or calling a paid model. */
export function skippedCodingEval(provider: string, model: string, sourceRevision: string, settings: EvalSettings, caseId?: string): CodingEvalResult {
  return unstartedEval(provider, model, sourceRevision, settings, "skipped_prerequisites", caseId);
}

/** Mark a case the spend cap kept the runner from starting. */
export function spendCapSkippedEval(provider: string, model: string, sourceRevision: string, settings: EvalSettings, caseId?: string): CodingEvalResult {
  return unstartedEval(provider, model, sourceRevision, settings, "skipped_spend_cap", caseId);
}

/** Record a failed provider setup without leaking construction errors or losing the artifact. */
export function failedCodingEval(provider: string, model: string, sourceRevision: string, settings: EvalSettings, caseId?: string): CodingEvalResult {
  return unstartedEval(provider, model, sourceRevision, settings, "harness_error", caseId);
}

/** Produce safe metadata for a run that never reached the coding workspace. */
function unstartedEval(provider: string, model: string, sourceRevision: string, settings: EvalSettings, outcome: "harness_error" | "skipped_prerequisites" | "skipped_spend_cap", caseId?: string): CodingEvalResult {
  const selected = DAILY_CASES.find(item => item.id === caseId);
  return { runId: crypto.randomUUID(), case: { id: selected?.id ?? CODING_CASE.id, version: selected?.version ?? CODING_CASE.version },
    sourceRevision, provider, model, settings, outcome,
    durationMs: 0, grader: null, metrics: createEvalMetricsPlaceholder() };
}

/** Initialize explicit unknown token totals for early setup failures. */
function createEvalMetricsPlaceholder(): EvalMetrics {
  return { inputTokens: null, outputTokens: null, unknownInputAttempts: 0,
    unknownOutputAttempts: 0, incompleteAttempts: 0, toolCalls: 0,
    toolFailures: 0, providerRetries: 0, compactions: 0, repeatedToolCalls: 0 };
}
