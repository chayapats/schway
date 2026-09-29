import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Model } from "../model/model.ts";
import { loadProviderModel } from "../model/loader.ts";
import { CODING_CASE, failedCodingEval, resolveEvalSettings, runCodingEval, skippedCodingEval, spendCapSkippedEval, type CodingEvalResult, type EvalSettings } from "./coding.ts";
import { DAILY_CASES } from "./cases.ts";
import { estimateSpendUsd, formatUsd, FREE, resolvePrice, roundUsd, type TokenPrice } from "./spend.ts";

const exec = promisify(execFile);
const USAGE = "Usage: bun run eval (--provider scripted | --provider openai|xai|openai-compatible --model ID --allow-paid | --matrix provider:model[,provider:model...] [--allow-paid]) [--case ID|all] [--base-url URL] [--output PATH] [--max-turns N] [--timeout-ms N] [--max-output-tokens N] [--max-spend USD] [--input-price USD_PER_M --output-price USD_PER_M]";

/** Exit code when the spend cap stopped the run before every case started. */
export const SPEND_CAP_EXIT_CODE = 3;

/** Run the selected evals under a spend cap and write a credential-free JSON artifact; `deps.model` is a test seam. */
export async function runEvalCli(argv: string[], env: Record<string, string | undefined> = process.env,
    deps: { model?: (provider: string, model: string, caseId: string) => Model } = {}): Promise<number> {
  if (argv.includes("--help")) { console.log(USAGE); return 0; }
  const values = new Map<string, string>();
  let allowPaid = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--allow-paid") { allowPaid = true; continue; }
    if (!["--provider", "--model", "--matrix", "--case", "--base-url", "--output", "--max-turns", "--timeout-ms", "--max-output-tokens", "--max-spend", "--input-price", "--output-price"].includes(arg) || !argv[i + 1] || argv[i + 1]!.startsWith("--") || values.has(arg)) {
      console.error(USAGE); return 2;
    }
    values.set(arg, argv[++i]!);
  }
  const matrix = values.get("--matrix");
  const entries = matrix ? matrix.split(",").map(value => {
    const split = value.indexOf(":");
    return { provider: value.slice(0, split), model: value.slice(split + 1) };
  }) : [{ provider: values.get("--provider") ?? "", model: values.get("--model") ?? "offline-v1" }];
  const caseId = values.get("--case") ?? CODING_CASE.id;
  const caseIds = caseId === "all" ? [CODING_CASE.id, ...DAILY_CASES.map(item => item.id)] : [caseId];
  if (entries.length < 1 || entries.length > 8 || caseIds.some(id => id !== CODING_CASE.id && !DAILY_CASES.some(item => item.id === id)) ||
      (matrix !== undefined && (values.has("--provider") || values.has("--model"))) ||
      (!matrix && values.get("--provider") !== "scripted" && !values.has("--model")) ||
      entries.some(entry => !["scripted", "openai", "xai", "openai-compatible"].includes(entry.provider) || !entry.model ||
        (entry.provider === "scripted" ? (entry.model !== "offline-v1" || (allowPaid && !matrix)) : !allowPaid)) ||
      (entries.some(entry => entry.provider === "openai-compatible") !== values.has("--base-url")) ||
      (!matrix && !values.has("--provider"))) {
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
  const capUsd = values.has("--max-spend") ? Number(values.get("--max-spend")) : 10;
  const number = (key: string) => values.has(key) ? (values.get(key)!.trim() === "" ? NaN : Number(values.get(key))) : undefined;
  const inputPrice = number("--input-price"), outputPrice = number("--output-price");
  if (!Number.isFinite(capUsd) || capUsd <= 0 || (inputPrice === undefined) !== (outputPrice === undefined) ||
      [inputPrice, outputPrice].some(price => price !== undefined && (!Number.isFinite(price) || price < 0))) {
    console.error("Invalid spend options (--max-spend > 0; --input-price and --output-price together, both >= 0)"); return 2;
  }
  const explicit: TokenPrice | undefined = inputPrice === undefined ? undefined : { inputPerMillion: inputPrice, outputPerMillion: outputPrice! };
  // Paid spend must never go uncounted, so a model that would really be called needs a price first.
  const baseUrl = values.get("--base-url");
  const keyFor = (provider: string) => env[provider === "openai" ? "OPENAI_API_KEY" : provider === "xai" ? "XAI_API_KEY" : "OPENAI_COMPATIBLE_API_KEY"]?.trim();
  const prices = entries.map(entry => resolvePrice(entry.provider, entry.model, explicit));
  const unpriced = entries.find((entry, index) => !prices[index] && !!keyFor(entry.provider) && (entry.provider !== "openai-compatible" || validEndpoint(baseUrl)));
  if (unpriced) {
    console.error(`No known price for ${unpriced.provider}/${unpriced.model}; pass --input-price and --output-price (USD per million tokens).`); return 2;
  }
  // This is the harness revision, never the temporary task repository revision.
  let sourceRevision = "unknown";
  try { sourceRevision = (await exec("git", ["rev-parse", "HEAD"], { cwd: join(import.meta.dir, "../.."), timeout: 3000 })).stdout.trim(); }
  catch { /* Packaged sources need not have a Git checkout. */ }
  const path = values.get("--output") ?? join(tmpdir(), `schway-eval-${crypto.randomUUID()}.json`);
  // Reserve before any paid call; never overwrite an existing artifact or symlink.
  let artifact;
  try { artifact = await open(path, "wx", 0o600); }
  catch { console.error("Cannot reserve eval artifact path (it must be a new file in an existing directory)."); return 2; }
  try {
    const results: CodingEvalResult[] = [];
    let spent = 0, capHit = false, spendUnknown = false;
    const highestCase = entries.map(() => 0);
    const total = entries.length * caseIds.length;
    for (const [entryIndex, entry] of entries.entries()) for (const id of caseIds) {
      const { provider, model: modelId } = entry;
      const price = prices[entryIndex] ?? FREE;
      const paid = price.inputPerMillion > 0 || price.outputPerMillion > 0;
      const apiKey = keyFor(provider);
      const startable = provider === "scripted" || (!!apiKey && (provider !== "openai-compatible" || validEndpoint(baseUrl)));
      // Soft cap: a paid case is assumed to cost as much as that route's costliest case so far (the first runs unless the cap is spent),
      // and unreported usage stops further paid cases. Free routes never spend, so they always run; unstartable routes stay prerequisite skips.
      if (startable && paid && (spendUnknown || spent >= capUsd || spent + highestCase[entryIndex]! > capUsd)) {
        capHit = true;
        results.push({ ...spendCapSkippedEval(provider, modelId, sourceRevision, settings, id), spendUsd: 0, spendExact: true });
        console.log(`${id} ${provider}/${modelId}: skipped/spend_cap`);
        continue;
      }
      let result: CodingEvalResult;
      if (!startable) {
        result = skippedCodingEval(provider, modelId, sourceRevision, settings, id);
      } else {
        try {
          const model: Model = deps.model ? deps.model(provider, modelId, id) : provider === "scripted" ? offlineModel(id)
            : await loadProviderModel({ provider: provider as "openai" | "xai" | "openai-compatible", model: modelId,
              apiKey, baseUrl, auth: "required", maxTokens: settings.maxOutputTokens });
          result = await runCodingEval({ model, sourceRevision, settings, caseId: id });
        } catch {
          result = failedCodingEval(provider, modelId, sourceRevision, settings, id);
        }
      }
      const started = result.outcome !== "skipped_prerequisites";
      const spend = started ? estimateSpendUsd(result.metrics, price) : { usd: 0, exact: true };
      if (started && paid && !spend.exact) spendUnknown = true;
      result.spendUsd = spend.usd;
      result.spendExact = spend.exact;
      spent += spend.usd;
      highestCase[entryIndex] = Math.max(highestCase[entryIndex]!, spend.usd);
      results.push(result);
      console.log(`${result.case.id}@${result.case.version} ${provider}/${modelId}: ${result.outcome} (${result.durationMs}ms); grader=${result.grader?.exitCode ?? "n/a"}; tokens=${result.metrics.inputTokens ?? "unknown"}/${result.metrics.outputTokens ?? "unknown"}${result.metrics.unknownInputAttempts || result.metrics.unknownOutputAttempts ? " (incomplete usage)" : ""}; spend=${spend.exact ? "" : "≥"}${formatUsd(spend.usd)}`);
    }
    const casesRun = results.filter(result => result.outcome !== "skipped_spend_cap" && result.outcome !== "skipped_prerequisites").length;
    const spendSummary = { totalUsd: roundUsd(spent), capUsd, casesRun, casesTotal: total, exact: results.every(result => result.spendExact !== false), stoppedBySpendCap: capHit };
    if (capHit) console.log(`stopped: spend cap reached (${formatUsd(capUsd)})`);
    console.log(`Spent ${formatUsd(spent)} of ${formatUsd(capUsd)} · ${casesRun}/${total} cases run`);
    const multiple = !!matrix || caseIds.length > 1;
    const summary = summarizeEvalResults(results);
    await artifact.writeFile(`${JSON.stringify(multiple ? { sourceRevision, settings, results, summary, spend: spendSummary } : { ...results[0], spend: spendSummary }, null, 2)}\n`);
    console.log(`Artifact: ${path}`);
    if (capHit) return SPEND_CAP_EXIT_CODE;
    return results.every(result => result.outcome === "success") ? 0 : 1;
  } finally {
    await artifact.close();
  }
}

/** Count every measured outcome, including failures and unavailable providers, without inferring missing evidence. */
export function summarizeEvalResults(results: readonly CodingEvalResult[]): Record<CodingEvalResult["outcome"], number> {
  return Object.fromEntries(["success", "grader_failure", "model_failure", "harness_error", "timeout", "skipped_prerequisites", "skipped_spend_cap"].map(outcome =>
    [outcome, results.filter(result => result.outcome === outcome).length])) as Record<CodingEvalResult["outcome"], number>;
}

/** Require a parseable credential-free HTTP(S) compatible endpoint before model construction. */
function validEndpoint(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return (url.protocol === "https:" || (url.protocol === "http:" && loopback)) && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}

/** Offline script drives the real loop through read, edit, and bash verification. */
function offlineModel(caseId: string): Model {
  let turn = 0;
  return { provider: "scripted", id: "offline-v1", async *stream(request) {
    request.signal?.throwIfAborted();
    const steps = [
      { id: "r", name: "read", arguments: { path: "src/math.ts" } },
      { id: "e", name: "edit", arguments: { path: "src/math.ts", edits: [{ oldText: "return Math.min(value, min);", newText: "return Math.max(min, Math.min(max, value));" }] } },
      { id: "b", name: "bash", arguments: { command: "bun test test/math.test.ts", timeout: 5000 } },
    ];
    if (request.systemPrompt.includes("You summarize a long coding session")) {
      yield { type: "message_complete", message: { type: "assistant", id: crypto.randomUUID(), content: [{ type: "text", text: "## Goal\nPrepare release\n## Constraints\nCodename amber; channel stable\n## Progress\nReviewed\n## Key Decisions\nKeep amber and stable\n## Current State\nReady\n## Next Steps\nWrite manifest\n## Files\n### Read\nNone\n### Modified\nNone" }] } };
      return;
    }
    const daily: Record<string, Array<Array<{ id: string; name: string; arguments: unknown }>>> = {
      "multi-file-refactor": [[{ id: "a", name: "write", arguments: { path: "src/normalize.ts", content: 'export function normalizeName(value: string): string { return value.trim().replace(/\\s+/g, " "); }\n' } },
        { id: "b", name: "write", arguments: { path: "src/display.ts", content: 'import { normalizeName } from "./normalize.ts";\nexport function displayName(value: string): string { return normalizeName(value); }\n' } }]],
      "locate-implementation": [[{ id: "a", name: "read", arguments: { path: "src/server.ts" } }, { id: "b", name: "read", arguments: { path: "src/router.ts" } }, { id: "c", name: "read", arguments: { path: "src/preview.ts" } }], [{ id: "d", name: "write", arguments: { path: "answer.json", content: JSON.stringify({ path: "src/router.ts", symbol: "resolveRoute" }) } }]],
      "failing-tests": [[{ id: "a", name: "bash", arguments: { command: "bun test test/cart.test.ts" } }], [{ id: "b", name: "edit", arguments: { path: "src/cart.ts", edits: [{ oldText: "sum + item.price", newText: "sum + item.price * item.quantity" }] } }]],
      "long-context": [[{ id: "a", name: "write", arguments: { path: "answer.json", content: JSON.stringify({ codename: "amber", channel: "stable" }) } }]],
      "tool-error-recovery": [[{ id: "a", name: "read", arguments: { path: "src/missing-config.ts" } }], [{ id: "b", name: "read", arguments: { path: "src/config.ts" } }], [{ id: "c", name: "write", arguments: { path: "answer.json", content: JSON.stringify({ region: "ap-south", revision: 7 }) } }]],
      "parallel-read": [[{ id: "a", name: "read", arguments: { path: "input/customer.txt" } }, { id: "b", name: "read", arguments: { path: "input/item.txt" } }, { id: "c", name: "read", arguments: { path: "input/count.txt" } }], [{ id: "d", name: "write", arguments: { path: "answer.json", content: JSON.stringify({ customer: "mina", sku: "Q42", quantity: 3 }) } }]],
    };
    const calls = caseId === CODING_CASE.id ? (steps[turn] ? [steps[turn]!] : []) : daily[caseId]?.[turn] ?? [];
    turn++;
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: "message_complete", message: { type: "assistant", id: crypto.randomUUID(),
      content: calls.length ? calls.map(call => ({ type: "tool_call" as const, ...call })) : [{ type: "text", text: "Done" }] } };
  } };
}

if (import.meta.main) {
  runEvalCli(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => {
    console.error("Eval runner failed before writing an artifact. Check the output path and selected provider configuration.");
    process.exitCode = 2;
  });
}
