# Installed v0.2-v0.3 release gate (#58)

Status: **pending**, not release-approved. Checked on 2026-09-25 from the #58 issue worktree based on `15d6bf5` (which includes #57); package identity `schway@0.1.0`, Bun `1.4.2` on macOS arm64. This is a local packed-artifact and offline-fixture check, not a registry publication, a live-provider call or human dogfood. Record the final candidate SHA and rerun checks if the PR changes.

## Reproduce the installed path

```sh
bun install --frozen-lockfile
bun test tests/packaging.test.ts
bun run typecheck
bun test
bun run eval --provider scripted --case all --output /tmp/schway-offline-eval.json
bun run live-smoke --provider all # no --enable-live: records skips, exits 2
```

`tests/packaging.test.ts` packs with `npm pack`, installs the tarball and greeting package into a temporary consumer with isolated `HOME`, then executes that consumer's binary and copied fixtures. The fixture imports are rewritten from source-relative paths to **the installed package** before execution. It runs installed `--help`, headless JSONL and text, the interactive controller and packaged skill/custom tool, ordered prompt and tool hooks, an observer that fails without aborting the turn, an attached project skill and primary-root write, persisted branch/tree/compaction resume without replay, two endpoint profiles with distinct fixture credentials and actual wire model/reasoning bodies, healthy/broken doctor, redacted debug metadata, and a Git snapshot separating pre-existing and new changes. It removes unused OpenTUI and provider SDK modules before the headless checks to verify lazy loading. The package also includes every `docs/` guide linked from its README; the tarball inventory verifies their presence. The local compatible HTTP server and scripted controller are fixtures; they do not prove remote provider behavior or human terminal rendering.

| Target | Status | Observable evidence or limit |
| --- | --- | --- |
| v0.1 base path | Passed offline | `tests/v01-coding-workflow.test.ts` checks all seven tools, mutation barriers, bounded results, bash exit, cancellation/retry tests, saved JSONL and compaction; package test runs installed text/JSON and controller. Provider protocol fixtures cover Anthropic, OpenAI and compatible, not live availability. |
| #33 process isolation, #34 exported contracts | Passed offline | CLI process tests use isolated user state; `bun run typecheck` plus `tests/architecture.test.ts` and public extension example typecheck in installed consumer. |
| #35 skills, #36 activation | Passed offline | Installed packaged and attached skill activation; `tests/skills.test.ts` and `tests/skill-activation.test.ts` cover lifecycle. |
| #37 extensions, #38 commands/observers, #39 request hooks, #40 tool hooks | Passed offline | Installed greeting tool/command, prompt changes in HTTP request, tool result rewrite and isolated failing observer; extension hook/observer tests cover cancellation and errors. |
| #41 npm manifests, #42 contextual roots, #43 session branches | Passed offline | Installed package configuration; attached skill with primary write; versioned persisted fork, TUI tree, branch-local compaction and resume; older formats covered by `tests/session-branches.test.ts`. |
| #44 interactive model/config editing | Passed offline | `tests/model-picker.test.ts`, `tests/config-editing.test.ts`; installed controller only, not terminal UI dogfood. |
| #45 external Matt-style package | Passed offline / human pending | `tests/matt-workflow.test.ts` verifies configured external package contract; no human workflow recorded here. |
| #46 secure key storage | Passed injected / native pending | `tests/credential-store.test.ts`, `tests/credential-management.test.ts` inject a store; native OS secure-store smoke not run. |
| #47 profiles, #48 reasoning | Passed fixtures / live pending | Installed two profiles produce distinct HTTP Authorization, model and `reasoning_effort`; `tests/reasoning.test.ts` covers provider-specific controls. No remote reasoning response checked. |
| #49 subscription feasibility, #50 login/refresh/logout | Passed injected / live pending | `docs/research-codex-subscription.md` records the earlier feasibility handoff and issue #50 records the later positive transport decision; `tests/codex-subscription.test.ts` exercises injected OAuth/refresh/store and no billing fallback. `tests/subscription-models.test.ts` checks account-scoped Codex model discovery and picker selection against protocol fixtures. No real subscription sign-in, model list or live confirmation. |
| #51 TUI branch tree | Passed controller / UI pending | Installed controller tree switching after compaction and `tests/tui-branches.test.ts`; no human terminal screenshot/visual check. |
| #52 Git changes, #53 diagnostics, #54 doctor | Passed offline | Installed snapshot distinguishes pre-existing and new files; installed `--debug-file` emits metadata without model/tool text; doctor reports healthy and broken session storage. More failure cases in corresponding deterministic tests. |
| #55 live smoke | Pending | `bun run live-smoke --provider all` returned `incomplete`, all four lanes `skipped/live_disabled`; no `--enable-live`, consent, keys or subscription used. |
| #56 graded eval, #57 daily-driver evals | Passed scripted / live pending | `bun run eval --provider scripted --case all` reported success and grader exit 0 for all seven cases (clamp, refactor, locate, failing tests, long context, tool recovery, parallel read). Artifact `/tmp/schway-58-offline-20260925.json`; fixture usage is not paid-model usage. No live comparison. |
| #58 installed milestone gate | **Pending** | Deterministic and installed-fixture gate passed; required live smoke/eval, native/human terminal evidence and real Schway-development dogfood are outstanding. |

Historical #16 closed with the real Schway-development dogfood check **pending**; closure and scripted/package fixtures do not turn that into a pass. A focused real task still needs an authorized installed Schway session using an actual provider in an isolated Schway checkout: inspect source, make a justified small edit, run relevant tests, resume, then record the actual diff, test output, revision and session outcome. An installed scripted fixture or an agent editing this repository directly is not that evidence.

## External evidence to collect

1. With explicit operator consent and credentials, run the bounded installed live-smoke CLI for each selected provider, retain dated JSON with revision and model (see [live providers](live-providers.md)); skipped/pending/failed lanes cannot pass.
2. Run the installed coding eval for selected live models with `--allow-paid`, record private per-case outcomes and grader evidence at the same revision (see [evals](evals.md)). Fixture passes cannot substitute for this.
3. Exercise native OS credential storage and ChatGPT login/refresh/logout on the supported path, plus human terminal model/config, branch tree and Git inspection. Record observed results without tokens or keys.
4. Carry out the real #16/#58 Schway-development dogfood task above. If any required gate remains pending or fails, retain this **pending** verdict; do not publish or claim a fully passed release.
