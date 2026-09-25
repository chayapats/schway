import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Model } from "../model/model.ts";
import { loadProviderModel } from "../model/loader.ts";
import { failedCodingEval, resolveEvalSettings, runCodingEval, skippedCodingEval, type EvalSettings } from "./coding.ts";

const exec = promisify(execFile);
const USAGE = "Usage: bun run eval --provider scripted | --provider anthropic|openai|openai-compatible --model ID --allow-paid [--base-url URL] [--output PATH] [--max-turns N] [--timeout-ms N] [--max-output-tokens N]";

/** Run one explicitly selected eval and write a credential-free JSON artifact. */
export async function runEvalCli(argv: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  if (argv.includes("--help")) { console.log(USAGE); return 0; }
  const values = new Map<string, string>();
  let allowPaid = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--allow-paid") { allowPaid = true; continue; }
    if (!["--provider", "--model", "--base-url", "--output", "--max-turns", "--timeout-ms", "--max-output-tokens"].includes(arg) || !argv[i + 1] || argv[i + 1]!.startsWith("--") || values.has(arg)) {
      console.error(USAGE); return 2;
    }
    values.set(arg, argv[++i]!);
  }
  const provider = values.get("--provider");
  if (!provider || !["scripted", "anthropic", "openai", "openai-compatible"].includes(provider) ||
      (provider !== "scripted" && (!allowPaid || !values.get("--model"))) ||
      (provider === "scripted" && (allowPaid || (values.has("--model") && values.get("--model") !== "offline-v1"))) ||
      (provider !== "openai-compatible" && values.has("--base-url")) ||
      (provider === "openai-compatible" && !values.has("--base-url"))) {
    console.error(USAGE); return 2;
  }
  const integer = (key: string, fallback: number) => values.has(key) ? Number(values.get(key)) : fallback;
  let settings: EvalSettings;
  try {
    settings = resolveEvalSettings({ maxTurns: integer("--max-turns", 8),
      timeoutMs: integer("--timeout-ms", 30_000), maxOutputTokens: integer("--max-output-tokens", 4096) });
  } catch {
    console.error("Invalid eval bounds"); return 2;
  }
  const modelId = values.get("--model") ?? "offline-v1";
  // This is the harness revision, never the temporary task repository revision.
  let sourceRevision = "unknown";
  try { sourceRevision = (await exec("git", ["rev-parse", "HEAD"], { cwd: join(import.meta.dir, "../.."), timeout: 3000 })).stdout.trim(); }
  catch { /* Packaged sources need not have a Git checkout. */ }
  const keyName = provider === "anthropic" ? "ANTHROPIC_API_KEY" : provider === "openai" ? "OPENAI_API_KEY" : "OPENAI_COMPATIBLE_API_KEY";
  const apiKey = env[keyName]?.trim();
  const baseUrl = values.get("--base-url");
  let result;
  if (provider !== "scripted" && (!apiKey || (provider === "openai-compatible" && !validEndpoint(baseUrl)))) {
    result = skippedCodingEval(provider, modelId, sourceRevision, settings);
  } else {
    try {
      const model: Model = provider === "scripted" ? offlineModel()
        : await loadProviderModel({ provider: provider as "anthropic" | "openai" | "openai-compatible", model: modelId,
          apiKey, baseUrl, auth: "required", maxTokens: settings.maxOutputTokens });
      // Remove the selected credential from tool subprocesses; the adapter retains its own copy.
      const previous = process.env[keyName];
      if (provider !== "scripted") delete process.env[keyName];
      try { result = await runCodingEval({ model, sourceRevision, settings }); }
      finally { if (provider !== "scripted" && previous !== undefined) process.env[keyName] = previous; }
    } catch {
      result = failedCodingEval(provider, modelId, sourceRevision, settings);
    }
  }
  const path = values.get("--output") ?? join(tmpdir(), `schway-eval-${result.runId}.json`);
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(`${result.case.id}@${result.case.version}: ${result.outcome} (${result.durationMs}ms); grader=${result.grader?.exitCode ?? "n/a"}; tokens=${result.metrics.inputTokens ?? "unknown"}/${result.metrics.outputTokens ?? "unknown"}${result.metrics.unknownInputAttempts || result.metrics.unknownOutputAttempts ? " (incomplete usage)" : ""}`);
  console.log(`Artifact: ${path}`);
  return result.outcome === "success" ? 0 : 1;
}

/** Require a parseable credential-free HTTP(S) compatible endpoint before model construction. */
function validEndpoint(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}

/** Offline script drives the real loop through read, edit, and bash verification. */
function offlineModel(): Model {
  let turn = 0;
  return { provider: "scripted", id: "offline-v1", async *stream(request) {
    request.signal?.throwIfAborted();
    const steps = [
      { id: "r", name: "read", arguments: { path: "src/math.ts" } },
      { id: "e", name: "edit", arguments: { path: "src/math.ts", edits: [{ oldText: "return Math.min(value, min);", newText: "return Math.max(min, Math.min(max, value));" }] } },
      { id: "b", name: "bash", arguments: { command: "bun test test/math.test.ts", timeout: 5000 } },
    ];
    const call = steps[turn++];
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: "message_complete", message: { type: "assistant", id: crypto.randomUUID(),
      content: call ? [{ type: "tool_call", ...call }] : [{ type: "text", text: "Done" }] } };
  } };
}

if (import.meta.main) {
  runEvalCli(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => {
    console.error("Eval runner failed before writing an artifact. Check the output path and selected provider configuration.");
    process.exitCode = 2;
  });
}
