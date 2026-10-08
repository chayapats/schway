# Coding eval

## Graded coding eval

Run `bun run eval --provider scripted` for the isolated offline coding case.
Paid runs require an explicit provider, model, and `--allow-paid`.

Run `schway --help` for grouped options and examples, or `schway doctor --help`
for diagnostic options. Both work without configuration or credentials.

## Cases and artifacts

Run the versioned `clamp-bounds@2` task from the Schway source checkout. Version 2 aligns the task with the restricted verification tool: run exactly `bun test test/math.test.ts`, omitting `cwd` and `timeout` arguments. Tool descriptions, schemas and rejection messages advertise the case's exact permitted command, prohibit `cwd`, and bound optional timeouts to 1–5000 ms (default 5000 ms). Cases without a verification command advertise bash as disabled.

```sh
bun run eval --provider scripted
```

This offline scripted fixture (`--model offline-v1` if specified) exercises the real Schway loop, read/edit/bash tools, and an independent environment grader. Its token counts are deterministic fixture values, not paid-model usage. It needs no API key; deterministic tests run all seven cases. A passing fixture is not live-provider evidence.

Select one of seven cases with `--case ID`, or run all cases sequentially in isolated repositories:

```sh
bun run eval --provider scripted --case all --output /tmp/schway-offline-eval.json
bun run eval --matrix scripted:offline-v1,openai:gpt-5 --allow-paid --case all --output /tmp/schway-matrix.json
```

The second command calls OpenAI only if `OPENAI_API_KEY` is present; otherwise each OpenAI row is `skipped_prerequisites`. Never include a key in arguments. The matrix accepts up to eight comma-separated `provider:model` entries and writes `{sourceRevision,settings,results,summary}`. Each result retains case id/version, model, settings, outcome, duration, grader and normalized metrics; skips are counted separately, never as successes. These are observed outcomes, not reliability thresholds. To compare live providers, supply credentials via environment on an explicitly paid run, repeat the same case/settings on the same source revision, retain private artifacts outside Git, and compare per-case outcomes and resource metrics. No live-provider baselines are included in the repository; fixture success is not paid or human dogfood evidence.

Cases: `clamp-bounds`, `multi-file-refactor` (definition + caller), `locate-implementation` (route implementation vs preview/logging), `failing-tests` (cart quantities with unchanged test), `long-context` (release facts from older complete turns and real compaction), `tool-error-recovery` (missing path followed by valid config), and `parallel-read` (three independent inputs). Each case has its own seed, bounded writable paths and machine-checkable grader. The recovery grader requires an observed failed read of the missing target followed by a successful read of the valid config. The parallel-read grader requires successful reads of all three inputs, with `readOverlap` as observational execution evidence collected from tool events; a real model is not graded on timing. Daily-case graders record a bounded evidence code (`checked`, `missing_reads`, `missing_recovery`, `fixture_changed:<path>` or `missing_or_oversized:<path>`) or safe expected-versus-observed probe values for `behavior_mismatch`. Unknown candidate values are redacted rather than storing prompts, arbitrary tool output or secrets. `toolFailures` does not count nonzero bash exits: those are normal shell result data.

The eval `ls` tool lists only the selected case's seeded file names and their parent directories. Omit `path` for the workspace root and use `depth: 2` to include files beneath its immediate subdirectories; a subtree listing still returns workspace-relative paths. The listing is projected from the seed manifest without walking the filesystem, so unseeded files, `.git`, and other directories remain hidden. File operations and verification commands retain their existing restrictions. Deterministic discovery tests run the actual loop, select candidate paths from `ls` results, and derive answers from successful reads; they do not establish that the historical live-provider failures now pass.

To explicitly opt into a paid call, select both provider and model:

```sh
OPENAI_API_KEY=... bun run eval --provider openai --model gpt-5 --allow-paid
# Or: OPENAI_COMPATIBLE_API_KEY=... bun run eval --provider openai-compatible --model local-model --base-url https://example.test/v1 --allow-paid
# xAI has no built-in prices; pass both price flags or the run exits 2 when XAI_API_KEY is set:
# XAI_API_KEY=... bun run eval --provider xai --model grok-4.7 --allow-paid --input-price 1 --output-price 1
```

`--provider` and `--matrix` accept `openai`, `xai`, `openai-compatible`, `codex`, and `grok` (plus `scripted` for the offline fixture). The compatible endpoint must be HTTPS, or HTTP on `localhost`, `127.0.0.1` or `[::1]`, without embedded user credentials; the selected provider key is read from its environment variable (`OPENAI_API_KEY`, `XAI_API_KEY`, or `OPENAI_COMPATIBLE_API_KEY`), not a command-line flag. xAI has no built-in price table: with `XAI_API_KEY` set and no `--input-price`/`--output-price`, the command exits 2 and does not call the provider. Without a key it records `skipped_prerequisites`. Do not put keys in the command or artifact. Only the selected provider adapter is loaded. A missing key or invalid endpoint is recorded as `skipped_prerequisites` without calling a provider. There is no automatic provider fallback.

The command prints a summary and writes a private JSON artifact to the OS temporary directory. Use `--output /safe/path/result.json` to choose a new file (the path is reserved before paid calls; existing files are not overwritten). The coding repository and session live in a separate temporary directory and are removed on completion/cancellation. For `clamp-bounds`, the grader bounds candidate reads, copies only the source and trusted test into a fresh grading directory, runs real Bun tests, and checks clamp behavior independently rather than trusting candidate-controlled test output or exit status alone. Daily-case graders bound reads, reject changes to immutable fixtures and run independent behavioral checks. Candidate code probes execute in a separate Bun process with only `PATH`, temporary `HOME` and `TMPDIR`, a 1-second process deadline and a 2 KiB output cap; Bun's VM alone is not a security boundary. The failing-tests and refactor fixtures also offer real Bun tests to the model. Eval subprocesses inherit only `PATH`, a temporary `HOME`, and `TMPDIR`, never provider keys. Eval tool adapters accept only selected seeded case files, edits/writes only to the case's declared writable paths, and only that case's verification command if one exists. Arbitrary external paths and commands are rejected. Bun tests still execute model-edited code, so this is not an OS sandbox: do not use an untrusted model endpoint on a sensitive machine.

Spend cap: `--max-spend <usd>` (default 10) is a soft cap on a live run: the first paid case always starts, so a tiny cap can be exceeded by one case, and a case can cost more than any before it. Spend is estimated from the usage each case records and a per-model price table (`src/eval/spend.ts`). Before starting each case the runner assumes it costs as much as the costliest case so far and stops if that would pass the cap: it prints `stopped: spend cap reached ($10.00)`, marks remaining cases `skipped_spend_cap`, and exits with code 3. Every run ends with `Spent $7.42 of $10.00 · 5/7 cases run`, and each result records `spendUsd` (`spendExact: false` means some attempts reported no usage, so it is a lower bound); the artifact's `spend` object has the total. If a paid case has incomplete usage, spend remains a lower bound and no further paid cases start: the runner prints `stopped: usage incomplete; reconcile provider billing before starting more paid cases` and records `spend.stopReason: "usage_unknown"`. A price-cap stop records `"spend_cap"`; an uninterrupted run records `null`. The existing `stoppedBySpendCap` flag and exit 3 cover both accounting guards for compatibility. Offline and subscription routes cost $0 but still report tokens. A paid model missing from the price table refuses to start (exit 2) when it would actually be called (key present) unless you pass `--input-price` and `--output-price` (USD per million tokens, together). Prices are list prices at the time of writing; verify them before relying on the cap.

Options: `--case ID|all`, `--matrix provider:model[,provider:model...]`, `--max-turns` (1-20, default 8), `--timeout-ms` (1-120000, default 30000), `--max-output-tokens` (1-8192, default 4096, sent as the provider's output cap). The clamp grader additionally has a 5-second command limit and an 8 KiB output limit; daily-case candidate reads are limited to 16 KiB per file and code probes have a 1-second process limit and 2 KiB output cap. Run `bun run eval --help` for the full invocation.

The case timeout covers all model/tool rounds and compaction in one case. A slow compatible route can complete valid requests while exceeding the default 30-second case budget; select `--timeout-ms 120000` explicitly when that bounded verification window is appropriate, while retaining the spend cap, token bounds and unknown-usage guard. The [compatible deadline investigation](bug-investigations/174.md) records both the failing 30-second run and separate current-revision verification.

Artifact fields: `runId`, `case` (id/version), `sourceRevision` (harness Git HEAD or `unknown`), `provider`, `model`, `billing`, `settings`, `outcome`, `durationMs`, `grader` (passed/exitCode) and `metrics`. Outcomes distinguish `success`, `grader_failure`, `model_failure`, `harness_error`, `timeout`, `skipped_prerequisites`, `skipped_spend_cap`, and `skipped` (with `reason: "not_signed_in"` for unavailable subscriptions). `inputTokens`/`outputTokens` are sums of **reported** usage, or `null` when none was reported. `unknownInputAttempts`, `unknownOutputAttempts` and `incompleteAttempts` mark unreported or interrupted attempts; a non-null sum alongside unknown attempts is a lower bound, not exact total consumption. Retries and compaction summarization count independently; a completed message is not counted twice. `repeatedToolCalls` counts invocations after the first with equal tool name and recursively key-sorted JSON arguments. Only counts are persisted, never raw arguments or their hash/key. Model prose and tool output are never placed in the artifact.


## Subscription routes

Sign in first in interactive Schway with `/login chatgpt` for ChatGPT or `/login grok` for Grok. Evals use only Schway's stored sign-in; they never launch login, read another CLI's credential cache, or fall back to API keys.

```sh
bun run eval --provider codex --model gpt-6-astra --allow-paid --case all
bun run eval --provider grok --model grok-5 --allow-paid --case all
bun run eval --matrix openai:gpt-5,codex:gpt-6-astra,grok:grok-5 --allow-paid --case all
```

Both subscription routes require a model and `--allow-paid`, consume plan quota, and reject `--base-url` unless the matrix includes a compatible entry that uses it. Expired credentials are refreshed and persisted through the same secure-store refreshers as interactive runs. Missing or unusable sign-ins, including failed refreshes, record `outcome: "skipped"` with `reason: "not_signed_in"`; the console prints `skipped/not_signed_in` and other matrix entries continue. Skips exit 1 unless a spend guard requires exit 3.

Every artifact case records the selected route in `provider`, its `model`, and `billing: "subscription"` for `codex`/`grok` or `billing: "usage"` for other routes. Subscription cases record `spendUsd: 0` and `spendExact: true`, display `spend=subscription`, and never consume or stop on `--max-spend`, even when usage is incomplete. Reported token counts remain available for plan-quota analysis. Artifacts and console output exclude stored tokens, account IDs and email addresses.

## Thinking selection

Use `--thinking LEVEL` to request `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `ultra`. These are accepted spellings, not a promise that every model supports each level. Omit the flag to retain provider defaults; omission is distinct from explicit `off`. The scripted fixture has no thinking control and refuses explicit selections.

One `--thinking` value applies to **every entry and case in a matrix**. Use separate runs when entries need different levels or one must keep its default. For the operator-selected RC settings, use `high` for the OpenAI API run and `medium` for ChatGPT subscription, xAI API, and Grok subscription runs. Leave thinking omitted for the OpenRouter entry unless separately selected. Model availability and prices must still be verified before paid runs.

Explicit selections reuse live smoke's selected-route validation: OpenAI API uses documented model support, ChatGPT uses its account catalog, xAI/Grok use their selected auth route's model list, and OpenRouter uses its endpoint-scoped model catalog. Generic compatible endpoints cannot map explicit non-off effort through this flag; omit it to keep defaults. Explicit `off` follows the shared provider policy: it sends a disable control only where supported, and may preserve defaults where no disable control exists.

Discovery and its failures are cached once per matrix entry across cases. Credential refresh still runs inside the adapters when needed. Unsupported selections and unavailable catalogs make zero inference requests and record `skipped_prerequisites` with `reason: "unsupported_thinking"` or `"thinking_capability_unavailable"` and a safe `nextAction`. They exit 1 unless a spend guard requires exit 3. No model, effort, auth route or billing fallback occurs, and raw catalog errors are excluded from artifacts.

Every case retains the requested value in `settings.thinking`, including failed, prerequisite-skipped and spend-cap-skipped cases; matrix artifacts also retain it in their top-level settings. When omitted, the property is absent. Artifact reservation, `--allow-paid`, spend limits and incomplete-usage guards still apply. Capability discovery has the selected `--timeout-ms` deadline separately from each case's model/tool timeout.
