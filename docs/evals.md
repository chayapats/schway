# Coding eval

Run the single versioned `clamp-bounds@1` task from the Schway source checkout:

```sh
bun run eval --provider scripted
```

This offline scripted fixture (`--model offline-v1` if specified) exercises the real Schway loop, read/edit/bash tools, and an independent environment grader. Its token counts are deterministic fixture values, not paid-model usage. It needs no API key and is the only eval mode run by deterministic tests. A passing fixture is not live-provider evidence.

To explicitly opt into a paid call, select both provider and model:

```sh
ANTHROPIC_API_KEY=... bun run eval --provider anthropic --model claude-sonnet-4-5 --allow-paid
# Or: OPENAI_API_KEY=... bun run eval --provider openai --model gpt-5 --allow-paid
# Or: OPENAI_COMPATIBLE_API_KEY=... bun run eval --provider openai-compatible --model local-model --base-url https://example.test/v1 --allow-paid
```

The compatible endpoint must be HTTPS, or HTTP on `localhost`, `127.0.0.1` or `[::1]`, without embedded user credentials; the selected provider key is read from its environment variable, not a command-line flag. Do not put keys in the command or artifact. Only the selected provider adapter is loaded. A missing key or invalid endpoint is recorded as `skipped_prerequisites` without calling a provider. There is no automatic provider fallback or subscription mode.

The command prints a summary and writes a private JSON artifact to the OS temporary directory. Use `--output /safe/path/result.json` to choose a new file (the path is reserved before paid calls; existing files are not overwritten). The coding repository and session live in a separate temporary directory and are removed on completion/cancellation; the grader checks the unchanged case test, copies only the source and trusted test into a fresh grading directory, and requires all three real Bun assertions to finish successfully as well as a zero exit status. Eval subprocesses inherit only `PATH`, a temporary `HOME`, and `TMPDIR`, never provider keys. Eval tool adapters accept reads of `src/math.ts` and the case test, edits/writes only to `src/math.ts`, and only the `bun test test/math.test.ts` shell command. Arbitrary external paths and commands are rejected. Bun tests still execute model-edited code, so this is not an OS sandbox: do not use an untrusted model endpoint on a sensitive machine.

Options: `--max-turns` (1-20, default 8), `--timeout-ms` (1-120000, default 30000), `--max-output-tokens` (1-8192, default 4096, sent as the provider's output cap). The grader additionally has a 5-second command limit and an 8 KiB output limit. Run `bun run eval --help` for the full invocation.

Artifact fields: `runId`, `case` (id/version), `sourceRevision` (harness Git HEAD or `unknown`), `provider`, `model`, `settings`, `outcome`, `durationMs`, `grader` (passed/exitCode) and `metrics`. Outcomes distinguish `success`, `grader_failure`, `model_failure`, `harness_error`, `timeout`, and `skipped_prerequisites`. `inputTokens`/`outputTokens` are sums of **reported** usage, or `null` when none was reported. `unknownInputAttempts`, `unknownOutputAttempts` and `incompleteAttempts` mark unreported or interrupted attempts; a non-null sum alongside unknown attempts is a lower bound, not exact total consumption. Retries and compaction summarization count independently; a completed message is not counted twice. `repeatedToolCalls` counts invocations after the first with equal tool name and recursively key-sorted JSON arguments. Only counts are persisted, never raw arguments or their hash/key. Model prose and tool output are never placed in the artifact.
