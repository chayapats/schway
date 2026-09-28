# Installed v0.2-v0.3 release gate (#58)

## Issue #87 sign-in journey evidence (2026-09-27)

Status: **automated fixture checks implemented; human installed browser check pending**.
Verified implementation candidate `89978dae0ba8b57dbd27e710a0a51ba6a842408d`
on Linux x86-64 with Bun 1.4.2: `bun test` passed 1,014 tests across 74
files and `bun run typecheck` passed. Renderer input used OpenTUI's test
renderer; it is not a human terminal observation.
The controller test sends a real loopback callback through the injected token
endpoint, reads the saved credential with a separate store reader, discovers an
account model and activates it without inference. Other controller and renderer
checks cover denied approval, secure-store save denial, occupied callback port,
device approval, stale callback, cancellation before and after the store commit,
catalog retry, activation failure, masked callback paste, draft/cursor recovery,
resize, and logout with an API-key override. These use isolated user state and
protocol fixtures; they do not establish real OAuth, live provider availability
or native secure-store behavior.
`tests/codex-callback.test.ts` checks that a stale state cannot settle the
current attempt. `tests/codex-subscription.test.ts` checks that explicit Codex
selection never falls back to API-key billing and that headless selection does
not start a browser. Remembered interactive choices belong to later issue #89;
this slice does not consume or persist that memory.

The operator-assisted installed check is **pending**. Record the installed
revision, terminal and runtime, browser approval result, terminal stage messages,
draft recovery, account model activation, and logout result after it is actually
observed. Keep credential payloads and approval codes out of that record. An
unrun check does not make this release gate pass.

Status: **pending**, not release-approved. Checked on 2026-09-25 from the #58 issue worktree based on `15d6bf5` (which includes #57); package identity `schway@0.1.0`, Bun `1.4.2` on macOS arm64. The original gate was a local packed-artifact and offline-fixture check; the later subscription catalog follow-up added one bounded live model-list check. No registry publication, live inference, or human dogfood was performed. Record the final candidate SHA and rerun checks if the PR changes.

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
| #49 subscription feasibility, #50 login/refresh/logout | Passed injected / live pending | `docs/research-codex-subscription.md` records the earlier feasibility handoff and issue #50 records the later positive transport decision; `tests/codex-subscription.test.ts` exercises injected OAuth/refresh/store and no billing fallback. `tests/subscription-models.test.ts` checks account-scoped Codex model discovery and picker selection against protocol fixtures. A real already-stored subscription returned 7 visible model IDs on 2026-09-25; the TUI displayed all seven, and the live controller selected `gpt-6-astra` without an inference call. Login/refresh/logout and live inference are not confirmed here. |
| #51 TUI branch tree | Passed controller / UI pending | Installed controller tree switching after compaction and `tests/tui-branches.test.ts`; no human terminal screenshot/visual check. |
| #52 Git changes, #53 diagnostics, #54 doctor | Passed offline | Installed snapshot distinguishes pre-existing and new files; installed `--debug-file` emits metadata without model/tool text; doctor reports healthy and broken session storage. More failure cases in corresponding deterministic tests. |
| #55 live smoke | Pending | `bun run live-smoke --provider all` returned `incomplete`, all four lanes `skipped/live_disabled`; no `--enable-live`, consent, keys or subscription used. |
| #56 graded eval, #57 daily-driver evals | Passed scripted / live pending | `bun run eval --provider scripted --case all` reported success and grader exit 0 for all seven cases (clamp, refactor, locate, failing tests, long context, tool recovery, parallel read). Artifact `/tmp/schway-58-offline-20260925.json`; fixture usage is not paid-model usage. No live comparison. |
| #58 installed milestone gate | **Pending** | Deterministic and installed-fixture gate passed; required live smoke/eval, native/human terminal evidence and real Schway-development dogfood are outstanding. |

Historical #16 closed with the real Schway-development dogfood check **pending**; closure and scripted/package fixtures do not turn that into a pass. A focused real task still needs an authorized installed Schway session using an actual provider in an isolated Schway checkout: inspect source, make a justified small edit, run relevant tests, resume, then record the actual diff, test output, revision and session outcome. An installed scripted fixture or an agent editing this repository directly is not that evidence.

## Subscription catalog incident (2026-09-25)

The initial `client_version=0.1.0` (Schway's package version) made the actual Codex `/models` endpoint return HTTP 200 with `{"models":[]}` on two reproducible calls. Omitting `client_version` returned HTTP 400. Using the installed official Codex client version `0.156.1` returned HTTP 200 with 9 entries (7 `list`, 2 `hide`). After pinning this verified protocol compatibility version, `fetchSubscriptionModels` returned the seven visible IDs, and a real pseudo-terminal session displayed all seven **only after** `/model`. A controller backed by the real OS secure store selected `gpt-6-astra` and remained idle; no paid inference was attempted. The TUI tests created new empty sessions in the user's session directory; existing sessions were not edited or removed. This is live **model discovery** evidence only, not proof of successful streaming turns, subscription refresh, or multi-account availability.

## Subscription streaming request regression (2026-09-26)

A user reported HTTP 400 with a streaming-required message after subscription
login and prompt submission. The subscription adapter parsed SSE responses but
omitted `stream: true` from its serialized request body. The body builder now
includes that flag on every subscription Responses request.

`tests/codex-subscription.test.ts` reproduces the failure through the actual adapter
with a fixture endpoint that returns HTTP 400 when the flag is missing, then
verifies text deltas and final completion with the fix. The account-catalog-to-turn
test in `tests/subscription-models.test.ts` enforces the same requirement through
the TUI controller and Schway loop. These are offline protocol checks; a successful
live subscription inference after this fix has not been verified.

## Subscription output-limit request regression (2026-09-27)

The subscription endpoint returned HTTP 400 with `Unsupported parameter:
max_output_tokens`. Schway had sent this public-API parameter unconditionally,
including its default value when no output limit was configured. The subscription
body builder now omits output-token caps while retaining `stream: true`.

Protocol fixtures reproduce the exact rejection and verify text deltas and final
completion with default, small and normal configured budgets. The account-catalog
selection test rejects the parameter through the real controller/agent-loop path
as well. The API-key adapter retains its supported output limit. These are offline
checks; successful live subscription inference after this fix is not verified.

## Scroll and compact-layout checks (2026-09-26)

The scrolling follow-up reproduced wheel input being ignored over the footer,
the transcript losing one column when automatic scrollbar visibility changed,
and a wrapped model-picker heading pushing the composer/status out of a 24×8
viewport. Renderer regressions cover these cases, idle mouse/PageUp scrolling,
and preserving visible text during an active scripted streaming turn.

The full offline suite passed 978 tests. Typecheck passed. A separate real PTY
exercise replayed emitted terminal bytes into xterm/headless and compared 41
frames with OpenTUI's character buffer after wheel/PageUp, appended output and
resize; all matched. This did not reproduce stale/overlapping terminal cells and
does not establish that the user's particular terminal artifact is resolved.
`bun tests/fixtures/tui-demo.ts --scroll` supplies an offline long-stream scenario
for checking that environment. The release gate above remains pending.

Follow-up with Kitty 0.48.2: dedicated real Kitty windows matched all eight checked
frames for Thai text and all eight for mixed Thai/CJK/emoji/combining text. An
isolated tmux 3.7c session inside Kitty reproduced stale characters with mixed
Unicode; a Kitty parser harness without complete capability negotiation also
reproduced Thai spacing and stale-cell errors. These paths must not be conflated
with direct Kitty, where negotiated explicit-width support passed. No global
width override or repaint-on-every-frame workaround was added.

Ctrl+L now uses OpenTUI's suspend/resume lifecycle to reset terminal output while
keeping the conversation widgets. A real Kitty check injected `STALE-FRAGMENT`
directly into the terminal: Ctrl+L left it behind before the change and restored
the expected screen afterwards. Renderer tests also retain the multiline draft,
scroll position and model picker. This is a recovery control, not a fix for all
multiplexer width differences. The user confirmed their report came from a
Schway process that had not yet been restarted after the UI changes.

## Appearance and keyboard slice (#105, 2026-09-28)

The packed executable fixture in `tests/startup-installed.test.ts` passed with
isolated user state: saved dark appearance painted a dark canvas on restart,
and `SCHWAY_THEME=light` painted the light canvas while preferences named the
environment as the effective source. Its Linux OS PTY lane launched the packed
executable through a real pseudo-terminal with a scripted installed model and
fake credential store; no paid API or developer credential store was used.
Renderer keyboard tests exercised
auto/dark/light persistence and reset, `NO_COLOR`, 24×8/32×12 preference focus,
Unicode draft/cursor preservation, and appearance edits while no model was
available. Existing renderer tests cover the panel keyboard and resize
contract listed in `docs/tui.md`; they do not verify future panels.

The additional manual terminal observations used the scripted source demo,
without provider credentials. All lanes name their actual environment:

| Environment and input | Observed result | Limit |
| --- | --- | --- |
| Installed package, Linux OS PTY, `TERM=xterm-256color`, `NO_COLOR=1`, 80×24→32×12, bracketed paste, Enter, Ctrl+L, Ctrl+C | Automated fixture passed: Thai/CJK/emoji/combining draft bytes appeared before Enter; after resize, Ctrl+L redrew `Ready` and `Ask Schway`; process exited 0 with alternate-screen enter/exit. | Raw PTY bytes verify input/output and cleanup, not human visual cell alignment. This lane runs only on Linux with Python 3 available. |
| Linux OS PTY, `TERM=xterm-256color`, no multiplexer, 80×24→32×12, bracketed Thai/CJK/emoji/combining paste, Enter, Ctrl+L, Ctrl+C | Process exited 0 and emitted alternate-screen enter/exit. Captured bytes contained Thai, emoji and the decomposed combining sequence; a second `--scroll` run contained CJK output. | Raw PTY bytes do not prove visual cell alignment in a human terminal. |
| Detached tmux PTY, 80×24→32×12, literal Thai/CJK/emoji/combining input, Enter, Ctrl+L | Captured draft displayed Thai, CJK and emoji; the narrow completed screen retained `Ready` before and after Ctrl+L. | The decomposed combining sequence was absent from `capture-pane`; this run does not establish its tmux rendering. |

No new human-operated direct Kitty check was run for this slice. The earlier
direct Kitty and tmux findings above remain separate historical evidence. A
human terminal pass, multiplexer Unicode judgment, and installed checks for
panels added after #105 remain pending in the final installed-journey gate.

## External evidence to collect

1. With explicit operator consent and credentials, run the bounded installed live-smoke CLI for each selected provider, retain dated JSON with revision and model (see [live providers](live-providers.md)); skipped/pending/failed lanes cannot pass.
2. Run the installed coding eval for selected live models with `--allow-paid`, record private per-case outcomes and grader evidence at the same revision (see [evals](evals.md)). Fixture passes cannot substitute for this.
3. Exercise native OS credential storage and ChatGPT login/refresh/logout on the supported path, plus human terminal model/config, branch tree and Git inspection. Record observed results without tokens or keys.
4. Carry out the real #16/#58 Schway-development dogfood task above. If any required gate remains pending or fails, retain this **pending** verdict; do not publish or claim a fully passed release.
