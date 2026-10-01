# Installed v0.2-v0.3 release gate (#58)

## 0.6.0 release (2026-10-02)

**Verdict: release preparation pending.**

This section tracks offline preparation for
[#157](https://github.com/chayapats/schway/issues/157). It does not establish
publication or actual-merge-commit verification. `R` is pending the release PR's
merge to `main`; tag `v0.6.0`, npm publication and the stable dist-tag check are
pending. Raw reports remain private, outside Git, in
`~/schway-release-evidence/0.6.0/v06-20261001T143347Z-issue-157/`.

### Preconditions and candidate contents

On 2026-10-02 (Asia/Bangkok), #152, #153, #154, #155 and #156 were closed.
Their integrated contracts were inspected at pinned base
`50c9eccda0a032731e1696d888d0cc53a220c67b`.
`gh issue list --milestone 0.6 --state open` listed only #157; open P0 and P1
queries were both empty. Round 1 in [the dogfood log](dogfood-log.md#friction)
reported P0 0 / P1 0, so no round-1 P0/P1 fixes or Fixed changelog entries were
required. Recheck these queries before publication.

The candidate sets `package.json` to `0.6.0` and both the greeting-package peer
range and the maintained extension-guide example to `^0.6.0`. The README peer
example moved to `docs/extensions.md` in #150. The changelog describes file undo,
shell changes, non-Git workspaces, retention defaults, approval modes and the
extension tool effect declaration.

The session policy follows the persisted implementation: new sessions use
format 4; formats 1–4 remain readable. Ordinary format-3 writes do not upgrade
the file. The first operation containing `turn_undo` appends a format-4 marker
before that operation, preserving prior bytes. Schway 0.5 and earlier reject
format-4 files, including upgraded sessions. Downgrade is not supported.
Reading a 0.5 session does not create undo pre-images for its old turns.

#158 remained open at preparation time. As #157 permits, #158 must backfill the
0.6.0 session fixture from npm after publication; no fixture-generation claim
is made here.

### Offline candidate verification

These are pre-merge checks, not actual-`R` evidence. The managed worker's handoff
records the exact checked candidate revision and final documentation revision.

| Check | Exit | Result |
| --- | --- | --- |
| `bun install --frozen-lockfile` | 0 | 27 installs / 53 packages checked; no changes |
| `bun run typecheck` | 0 | Candidate typecheck passed |
| Focused package, session and demo tests | 0 | 98 tests across 5 files; 0 failures |
| Candidate full `bun test` | Pending | Record full-suite count and revision after the clean candidate run |
| `bun run demo:record` | 0 | Scripted offline model; GIF 212,814 bytes, below 2,097,152 bytes |
| Candidate `npm pack --dry-run --json` | 0 | 160 files; CLI, source, examples, declared user docs and changelog present; tests, scratch and release evidence absent |

The demo was recorded with task-local VHS 0.10.0, ttyd 1.7.7 and DejaVu Sans
Mono through a temporary fontconfig file. Frame review confirmed the ready
screen, inline diff, outcome and two-column review, with no splash, private
paths or real provider names. The coordinator independently inspected the
final GIF at 0, 4, 8 and 10.5 seconds and confirmed visual QA passed. Its SHA256
is `bdd51b4838fe227c84492016687ffd41f29511fcd4dcbce3cef260378fbe6474`.
No TUI source or screen-catalog goldens changed.

After merge, rerun frozen install, typecheck and the full suite on clean `R`,
record its SHA and test count, and inspect `npm pack --dry-run` again on `R`.
Pre-merge checks do not replace those release gates.

### Five-lane live smoke — pending

Operator model/reasoning selections, compatible endpoint and paid-smoke consent
remain pending. No live smoke ran for 0.6.0. The following rows are checklist
placeholders, not runner output; no model, auth source, timestamp or revision
has been observed. Run the all-provider smoke from [the release checklist](releasing.md#3-live-verification-on-the-release-commit)
on `R`, with the operator's explicit selections, and replace these rows with
actual evidence. Every lane must pass; repair access and rerun pending/skipped
lanes, and file any failed lane as P1 before release. Full live evals are outside
#157's scope.

| Route | Provider (smoke lane) | Model | Thinking | Auth source | Status | Reason | Tested at (UTC) | Revision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ChatGPT subscription | `codex` | Pending selection | Pending selection | Not observed | Pending | Not run; selections and consent pending | — | — |
| Grok subscription | `grok` | Pending selection | Pending selection | Not observed | Pending | Not run; selections and consent pending | — | — |
| OpenAI key | `openai-api-key` | Pending selection | Pending selection | Not observed | Pending | Not run; selections and consent pending | — | — |
| xAI key | `xai-api-key` | Pending selection | Pending selection | Not observed | Pending | Not run; selections and consent pending | — | — |
| Compatible endpoint | `compatible` | Pending selection | Pending selection | Not observed | Pending | Not run; endpoint, selections and consent pending | — | — |

### Publication and clean-HOME upgrade — pending

Maintainer publish identity/rights, unused version, and any required npm 2FA
must be checked when publication is authorized. No publish, tag or production
auth/config change was performed by this preparation. Follow
[the release checklist](releasing.md#4-publish-and-tag) on clean `R`, then the
specific 0.5-to-0.6 upgrade procedure in #157. A temporary HOME does not isolate
the OS secure store; keep production accounts unchanged.

| Upgrade step from #157 | Exit | Result still required |
| --- | --- | --- |
| Set up isolated Git workspace; install registry `schway@0.5.0`; run doctor | Not run | Version `0.5.0` |
| Create session A through the selected compatible endpoint; copy `A.before` | Not run | Exit 0; exactly one saved session |
| Create interactive draft session B; wait 2 seconds and exit | Not run | Record B's ID; `draft survives upgrade` remains unsent |
| Install registry `schway@0.6.0`; run doctor | Not run | Version `0.6.0` |
| Resume A through the selected endpoint; compare prior byte prefix | Not run | Exit 0; answer refers to `a.ts`; `cmp` exit 0 |
| Resume B interactively | Not run | Composer restores `draft survives upgrade` without sending |
| Open `/undo` in A; inspect default approval status | Not run | `Nothing to undo`; no approval chip in default `auto` |

Record every actual step's result and exit code after publication. Deterministic
candidate tests do not replace this published-version live upgrade check.

### Remaining release gates

The coordinator owns the release PR, current-HEAD CodeRabbit review and merge.
After actual-`R` offline checks, five passing live lanes, publish/tag verification
and the complete clean-HOME upgrade, replace the pending verdict with the
published verdict required by #157. Commit the completed evidence section to
`main`, link it on #157 and close the issue. Until then, #157 remains open.

## 0.5.0 release (2026-10-01)

**Verdict: 0.5.0 published.**

Published release commit **`R = f6def34943ce0210d8aa84f87ac6f21ab4b96cf2`**,
annotated tag **`v0.5.0`**, npm version **`schway@0.5.0`**, and stable dist-tag
**`latest: 0.5.0`**. Release preparation merged through
[PR #206](https://github.com/chayapats/schway/pull/206).
This section records the actual release checks for
[#151](https://github.com/chayapats/schway/issues/151).
Raw reports remain private, outside Git, in
`~/schway-release-evidence/0.5.0/local-20261001/`.

### Preconditions and offline verification

On 2026-10-01, all thirteen blockers #138–#150 were closed and present in `R`.
The 0.5 milestone had only #151 and #152 open. Open P0 and P1 queries were empty
before verification, immediately before publication, and after installation.
Severity labels P0, P1 and P2 exist.

On a clean local worktree at actual `R`, `bun install --frozen-lockfile`,
`bun run typecheck` and `bun test` each exited 0. The full suite, including
screen-catalog goldens, passed **1,845 tests across 117 files; 0 failures**,
in **160.97 seconds**. This is local actual-R evidence, separate from the
successful post-merge CI and earlier candidate checks.

Test fixtures used `TMPDIR=/dev/shm`. The first default-temp attempt was stopped
after failures because an existing `/tmp/.git` redirected fixture workspace
discovery to `/tmp`. Changing only the temp location made the isolated
reproduction pass; the full rerun passed without source changes. The existing
`/tmp/.git` was preserved. Toolchain: Linux 7.2.5-3-omarchy, Bun 1.4.2,
Node 26.8.2 and npm 11.19.1.

### Gallery and design sign-off

The initial approved gallery commit was
`9aee12438ce25d152b77273f5f83d503dda5c36b`. Its golden tree was
`34207f099aa1bcc5d4340cf6390816df5509e028`.
`git diff --stat 9aee12438ce25d152b77273f5f83d503dda5c36b R -- tests/screen-catalog/goldens`
printed nothing. `bun run screens:gallery` regenerated **29 screens / 216
variants** at `R`: dark/light at 120, 80 and 50 columns, declared no-color
variants and additional narrow widths. After the browser connector could not
open the HTML, the maintainer opened it locally and confirmed complete review,
with no requested changes. The final reviewed commit is **`G = R`**; the final
`git diff --stat G R -- tests/screen-catalog/goldens` is also empty.

Design sign-off #1: approved by chayapats on 2026-10-01 at f6def34943ce0210d8aa84f87ac6f21ab4b96cf2

The empty request table records that no changes were requested in either review.

| Screen | Variant | Request | Merged PR (fixed) or issue (filed) |
| --- | --- | --- | --- |

### Release contents and publication

`package.json` is `0.5.0`; the greeting-package peer range and the maintained
extension-guide example are `^0.5.0`. The README peer example moved to
`docs/extensions.md` during #150. The changelog covers the user-visible work
from #139–#150, including `ui.inlineDiffLines` and `ui.splash`.
The regenerated and visually checked demo GIF is **241,206 bytes**, below
2,097,152 bytes. #158 remained open, so its published-version fixture backfill
is deferred as #151 permits.

On clean `R`, `npm pack --dry-run` exited 0 and listed **154 files**, including
CHANGELOG, the CLI, source, examples and declared user docs. Tests, scratch files
and release-verification evidence are absent. npm identified `chayapats` with
`schway: read-write`; the version and tag were unused before publication.

After maintainer browser 2FA, `npm publish --access public` exited 0.
The registry accepted the upload with HTTP 202; its authenticated lifecycle
status subsequently reported `published`, and public version/latest queries
then returned `0.5.0`. The registry did not supply `gitHead`.
The annotated tag was created at `R`, pushed, and its resolved commit verified
as `f6def34943ce0210d8aa84f87ac6f21ab4b96cf2`.

npm's warning that the bin script name was "invalid and removed" was checked
before publication: normalization strips `./` from `./bin/schway`, retaining
`schway → bin/schway`. The source and packed tarball mappings remained intact;
the published mapping and executable installation were verified below.

### Five-lane live smoke

The actual-R command selected all five lanes, OpenRouter at
`https://openrouter.ai/api/v1`, explicit models and `medium` thinking, with a
120,000 ms per-lane deadline. It exited **0**, aggregate **`passed`**.
Every lane completed two model rounds and one read-tool result with **zero
provider retries**. The table's `R` denotes the full release SHA above; the
shared report timestamp and revision apply to every row.

| Route | Provider | Model | Thinking | Auth source | Status | Reason | Tested at (UTC) | Revision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAI key | `openai-api-key` | `gpt-6-luna` | `medium` | `stored` | `passed` | `verified` | `2026-10-01T09:21:47.379Z` | `R` |
| xAI key | `xai-api-key` | `grok-4.7` | `medium` | `stored` | `passed` | `verified` | `2026-10-01T09:21:47.379Z` | `R` |
| OpenRouter | `compatible` | `meta/muse-spark-1.3-contributor` | `medium` | `stored` | `passed` | `verified` | `2026-10-01T09:21:47.379Z` | `R` |
| ChatGPT subscription | `codex` | `gpt-6-sol` | `medium` | `stored-subscription` | `passed` | `verified` | `2026-10-01T09:21:47.379Z` | `R` |
| Grok subscription | `grok` | `grok-4.7` | `medium` | `stored-subscription` | `passed` | `verified` | `2026-10-01T09:21:47.379Z` | `R` |

These are the maintainer's explicit selections. The initially requested
`gpt-6.1-sol` was absent from this ChatGPT account catalog; after being shown
that result, the maintainer explicitly chose `gpt-6-sol medium`.
No auth route or billing source was substituted.

The approved ceiling remained **USD 1 per route**, up to USD 5 total, without
pooling or a subscription purchase. API smoke requests cap requested output at
256 tokens per response and constrain retries, messages and response bytes.
The initial context was under 1 KiB. A conservative per-run API exposure estimate
was below USD 0.20 per route, using these limits and current prices, leaving
compatible-route headroom for the installed turn. This is an estimate, not an exact bill:
the smoke report does not report token usage or dollar spend.
No full live eval or subscription purchase ran.

Current public standard input/output prices per million tokens were checked on
2026-10-01: [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
USD 0.10/0.50; [Grok 4.7](https://docs.x.ai/developers/models/grok-4.7)
USD 2/6 below its long-context threshold; and
[Muse Spark 1.3 Contributor](https://openrouter.ai/meta/muse-spark-1.3-contributor)
USD 0.10/0.20. These API prices do not establish subscription plan charges.

### Registry installation and daily-use setup

The exact registry version was installed with a separate prefix, empty HOME
and separate Git workspace. No production login/logout or secure-store mutation
was performed. The temporary HOME shares the OS secure store, so the compatible
turn used the existing endpoint-scoped OpenRouter identity.

| Check | Exit | Verified result |
| --- | --- | --- |
| Exact registry install | 0 | `schway@0.5.0`; executable exists |
| Grouped `--help` | 0 | Common, model/auth, sessions, workspace, output/diagnostics, advanced and examples |
| `doctor --json` | 0 | Version `0.5.0` |
| No configured model | 1 | Exact no-model guidance from the release checklist; no session created |
| Compatible headless turn | 0 | `agent.finished.reason=completed`; exactly one session JSONL |
| Removed Anthropic configuration | 1 | Exact removal message from the release checklist |

The installed turn used the same approved Muse model with `medium` thinking,
`--max-output 1024` and `--max-turns 1`, within the reserved compatible allowance.
`npm install -g schway@0.5.0` then exited 0 for daily use, and the installed
`schway doctor --json` exited 0 with version **`0.5.0`**.

Open P0/P1 check date: **2026-10-01**; both queries returned no issues.
The install/smoke checks do not count as dogfood sessions. No #152 day or session
has been counted by this release verification.

## Dogfood round 1 (2026-10-01)

Evidence mode: accelerated agent-operated validation; no three-day observation claim.

Round 1: 2026-10-01–2026-10-01 · 8 sessions · routes: ChatGPT, Grok · P0 0 · P1 0 · P2 4

**Validation verdict: passed against the amended #152 criteria.**
See the [session, friction and operator log](dogfood-log.md#round-1-050).
Registry-installed 0.5.0 completed file/search/edit/write/test workflows with
Thai text and primary-root/attached isolation. Three same-ID resumes preserved
prior JSONL bytes, including Grok → ChatGPT, without replaying writes.
Typecheck exited 0; the full offline suite passed 1,845 tests across 117 files,
0 failures (195.92 s, `TMPDIR=/dev/shm`), including deterministic installed
branch/compaction/resume fixtures. These fixtures are supporting checks, not
extra live sessions. Installed CLI/loop/session source bytes matched the unchanged
worktree. No source changes or new API-key spending were needed.

P0/P1 closing check date: **2026-10-01**; both open-label queries were empty.
No P0/P1 fixes or restart were required. The P2 discoverability follow-up
[#209](https://github.com/chayapats/schway/issues/209) remains open; the log records
all four observations. This headless agent validation does not establish
multi-day reliability or human TUI usability.

## 0.4.0 release (2026-09-30)

**Verdict: 0.4.0 published.**

Published release commit **`R = bcb437781398ddf4ec98e0541042ab353a46029c`**,
annotated tag **`v0.4.0`**, npm version **`schway@0.4.0`**, and stable dist-tag
**`latest: 0.4.0`**. Release preparation was merged through
[PR #186](https://github.com/chayapats/schway/pull/186); the release includes the
subsequent smoke fixes in [PR #191](https://github.com/chayapats/schway/pull/191)
and [PR #192](https://github.com/chayapats/schway/pull/192). `R` is the actual
main merge commit of #192, after both original release blockers were resolved.

The earlier stopped attempt is retained below. Raw evidence for this successful
attempt is private, outside Git, in
`~/schway-release-evidence/0.4.0/release-resumed-1/`.

### Preconditions and offline verification

On 2026-09-30, all native blockers of #138 were closed, including #129–#137,
#166, #185, #188 and #189; their required changes were present in `R`.
The milestone query listed only #138. Severity labels were updated idempotently
with the checklist descriptions, and the truth-pass defects #173, #174, #176
and #179 each carried P2. Open P0/P1 queries returned empty lists at
**07:29:19 UTC** and again at **07:39:47 UTC**.

`npm whoami` exited 0 as the maintainer account. Publish 2FA was confirmed as
`pending: null`, `mode: "auth-and-writes"`. Registry preflight confirmed that
0.4.0 was unused. The existing 0.4.0 version, example/README `^0.4.0` peer
ranges, dynamic version tests, shipped changelog and generic
[release checklist](releasing.md) were retained.

On the clean `R` checkout, **`bun install --frozen-lockfile`,
`bun run typecheck` and `bun test` all exited 0**.
**1,466 tests passed across 100 files; 0 failures**, in 110.25 seconds.
Both #192 Travis checks and its CodeRabbit review passed.
No full live evals were required for this ordinary minor release.

Machine: **Linux 7.2.5-3-omarchy; Bun 1.4.2; npm 11.19.1**.

### Live smoke on the published commit

After the offline checks, the actual CLI ran all five lanes on clean `R`,
using the maintainer-selected models and thinking levels, a 120,000 ms
per-lane timeout, and the compatible endpoint host `openrouter.ai`.
**Exit 0; aggregate `passed`.** Every lane verified the actual sentinel tool
round trip, completed two model rounds and one tool result, and recorded zero
provider retries. No lane was skipped or pending.

API keys were read from the OS secure store into a temporary child environment;
keys were not written to files or command arguments. Dates below are UTC and
come from this attempt's `live-smoke.json`; every revision equals `R`.

| Route | Provider | Model | Thinking | Auth source | Status | Reason | Tested at (UTC) | Revision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAI API key | `openai-api-key` | `gpt-6-luna` | high | env | passed | verified | 2026-09-30T07:28:45.445Z | `bcb437781398ddf4ec98e0541042ab353a46029c` |
| xAI API key | `xai-api-key` | `grok-4.7` | medium | env | passed | verified | 2026-09-30T07:28:45.445Z | `bcb437781398ddf4ec98e0541042ab353a46029c` |
| Compatible (OpenRouter) | `compatible` | `meta/muse-spark-1.3-contributor` | medium | env | passed | verified | 2026-09-30T07:28:45.445Z | `bcb437781398ddf4ec98e0541042ab353a46029c` |
| ChatGPT subscription | `codex` | `gpt-6-sol` | medium | stored-subscription | passed | verified | 2026-09-30T07:28:45.445Z | `bcb437781398ddf4ec98e0541042ab353a46029c` |
| Grok subscription | `grok` | `grok-4.7` | medium | stored-subscription | passed | verified | 2026-09-30T07:28:45.445Z | `bcb437781398ddf4ec98e0541042ab353a46029c` |

The **USD 1.50 cumulative limit per API key** was retained across prior calls
and this attempt; no fresh allowance was assumed. The private spend plan
records current published prices and conservative planning estimates.
This attempt made one all-lane smoke run and one bounded compatible install
turn, with no further paid probes or full evals. Smoke reports do not establish
exact billed cost; no exact spend is claimed.

### Publish, registry and tag

From clean `R`, `npm pack --dry-run` exited 0 and listed 144 files, including
`bin/schway`, `src/`, examples, declared docs, README, LICENSE and CHANGELOG.
It excluded `tests/`, `.scratch/`, `docs/releasing.md` and this report.

`npm publish --access public` exited **0** after the maintainer completed npm's
web 2FA. npm normalized the metadata's `./bin/schway` to `bin/schway`;
the executable mapping remained present and the installed CLI worked.
The publish request returned HTTP 202; initial registry reads returned E404
and showed a temporary `0.0.0-stage` placeholder. The registry subsequently
exposed 0.4.0 (publication timestamp **2026-09-30T07:33:26.145Z**);
repeated `npm view` checks then exited 0 and confirmed version 0.4.0 and
`latest: 0.4.0`.

**Process deviation:** the annotated tag was created and pushed before the
registry availability check completed. The tag was retained, then verified
locally and on the remote to point to `R`. Registry installation was held
until version/latest verification succeeded.

The registry did not supply `gitHead`. Instead, every one of the **144 published
files matched the clean release tree byte for byte**, and the registry tarball
integrity matched `npm pack --dry-run`. This confirms the installed artifact
matches `R` without asserting an unavailable registry SHA.

### Registry installation with a clean HOME

The exact public registry version was installed outside the checkout using
`npm install -g --prefix <temporary-prefix> --no-audit --no-fund schway@0.4.0`.
Checks used an empty temporary HOME and a separate initialized Git workspace.
No production login/logout or credential changes were made.

| Check | Exit | Verified result |
| --- | --- | --- |
| Registry install | 0 | `schway@0.4.0` installed |
| `--help` | 0 | Installed executable works |
| `doctor --json` | 0 | `.version` is `0.4.0` |
| `-p "hello"`, no configured model | 1 | Exact `No model configured · Pass --provider and --model, or set them in config` message |
| Compatible `Reply with the word OK.` turn | 0 | `agent.finished.reason: completed`; exactly one session JSONL |
| Removed Anthropic configuration | 1 | Exact `ANTHROPIC_REMOVED_MESSAGE` |

The compatible turn used the selected OpenRouter model with medium thinking,
`--max-output 256` and `--max-turns 1`. The initial verification helper
unnecessarily required doctor exit 0 while stripping the DBus environment;
it reported the correct version but an unavailable secure store. That helper
result was preserved, and the doctor check was repeated with the inherited
environment and temporary HOME specified by the checklist, before any paid
install turn. The final results above passed.

Private artifacts include `preconditions.json`, `offline-results.json`,
`install.log`, `typecheck.log`, `test.log`, `live-smoke.json`,
`live-smoke-command.json`, `spend-plan.json`, `npm-pack-dry-run.json`,
`npm-registry.json`, `registry-install-results.json`,
`registry-install-initial-runner.json`, `registry-source-comparison.json`,
`final-severity-check.json` and the installed CLI stdout/stderr records.


## 0.4.0 stopped release attempt (2026-09-30)

**Verdict: 0.4.0 not published; release stopped at live smoke.**

Release commit `R = 273dfd9526d057f557d3788f198d17e1e83b20e6` was merged to
`main` through [PR #186](https://github.com/chayapats/schway/pull/186).
Version and example peer ranges are 0.4.0, the changelog is shipped, and the
generic checklist is in [releasing.md](releasing.md). Raw JSON and logs remain
private at `~/schway-release-evidence/0.4.0`, outside Git.

### Preconditions and offline verification

On 2026-09-30, #129–#137 and #166 were closed. The initial milestone query listed
only #138. P0/P1/P2 labels were updated idempotently; all truth-pass defects
(#173, #174, #176 and #179) carried P2. Immediately before smoke, the milestone
again listed only #138 and both open P0/P1 queries returned empty lists.

An initial `npm whoami` failed with `ENEEDAUTH`; after maintainer login it exited
0 as `chayapats`. The operator enabled npm 2FA, and a repeated profile read
confirmed `pending: null`, `mode: "auth-and-writes"`. The registry preflight
reported E404 for the unpublished package; publish permission was not exercised.

The operator required explicit smoke thinking support. It was implemented in
#185 and merged through [PR #187](https://github.com/chayapats/schway/pull/187)
as `9b488d1900622df0f87be5affdc4b9493bbdb404`. Protocol fixtures and both CI checks
passed; they did not establish successful discovery with the real production
catalog sizes measured below.

On a clean checkout of `R`, `bun install --frozen-lockfile`, `bun run typecheck`
and `bun test` all exited 0. **1,461 tests passed across 100 files, 0 failures.**
The suite includes installation of the packed harness/example package and their
tool round trips. Preparation's focused package suite passed 57 tests.
Both PRs received Standards/Spec review; CodeRabbit completed without actionable
comments. At this report, release PR #186's Travis checks were still pending;
the local merge-commit checks above passed.

Machine: Linux; Bun 1.4.2; npm 11.19.1.
Private offline log: `R-bun-test.log`.

### Live smoke

The maintainer authorized these exact models/thinking and a **USD 1.50 maximum
per API key for all release calls**. All five credentials were ready. API keys
were read from the OS store into a temporary child environment, never written
to files or command arguments. No model, thinking, auth or billing fallback
was used. The compatible endpoint host is `openrouter.ai`.

The clean `R` invocation selected `--provider all`, a 120,000 ms per-lane
timeout, and explicit model/thinking overrides for all five lanes.
**Exit 1; aggregate `failed`.** Dates below are UTC and are copied from
`live-smoke.json`; each revision equals `R`.

| Route | Provider | Model | Thinking | Auth source | Status | Reason | Tested at (UTC) | Revision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAI API key | `openai-api-key` | `gpt-6-luna` | high | env | passed | verified | 2026-09-30T06:14:34.965Z | `273dfd9526d057f557d3788f198d17e1e83b20e6` |
| xAI API key | `xai-api-key` | `grok-4.7` | medium | env | failed_provider | missing_tool_evidence | 2026-09-30T06:14:34.965Z | `273dfd9526d057f557d3788f198d17e1e83b20e6` |
| Compatible (OpenRouter) | `compatible` | `meta/muse-spark-1.3-contributor` | medium | env | failed_provider | output_limit | 2026-09-30T06:14:34.965Z | `273dfd9526d057f557d3788f198d17e1e83b20e6` |
| ChatGPT subscription | `codex` | `gpt-6-sol` | medium | stored-subscription | failed_provider | output_limit | 2026-09-30T06:14:34.965Z | `273dfd9526d057f557d3788f198d17e1e83b20e6` |
| Grok subscription | `grok` | `grok-4.7` | medium | stored-subscription | passed | verified | 2026-09-30T06:14:34.965Z | `273dfd9526d057f557d3788f198d17e1e83b20e6` |

OpenAI API key and Grok subscription verified the actual sentinel tool round
trip. OpenRouter and Codex failed before inference: each recorded
`modelAttemptsStarted: 0`, one HTTP request/response and HTTP 200.
Read-only probes measured catalogs of **762,009 bytes** (OpenRouter) and
**522,290 bytes** (Codex), above the shared **262,144-byte** smoke response
budget. Explicit thinking discovery exhausts that budget on metadata alone.

The xAI API-key lane completed two model rounds and one tool-result event, with
no retries, three HTTP requests/responses and HTTP 200, but did not verify the
permitted sentinel read. One tool-result event is not proof of successful
sentinel access; its exact missing-evidence cause remains unconfirmed.

| Defect | Severity | Affected routes | Status |
| --- | --- | --- | --- |
| [#188](https://github.com/chayapats/schway/issues/188): real reasoning catalogs exceed smoke byte budget | P1 | OpenRouter, Codex | open; native blocker of #138 |
| [#189](https://github.com/chayapats/schway/issues/189): xAI sentinel verification failure | P1 | xAI API key | open; native blocker of #138; root cause needs triage |

After filing these defects, the open P0 query remained empty; the open P1 query
listed #188 and #189. No further paid smoke or full eval was run. Smoke reports
do not contain token usage or a spend total, so no exact billing amount is
claimed. The private spend plan records the operator's per-key ceiling and
current model prices.

Private artifacts: `live-smoke.json`, `live-smoke-command.json`,
`compatible-catalog-size.json`, `codex-catalog-size.json`, `spend-plan.json`
and the precondition/profile records. None of their raw contents is committed.

### Publish and clean-HOME install

The failed smoke stopped the ordered release checklist. `npm publish`, the
`v0.4.0` tag/push and registry clean-HOME installation were **not run**.
Help/doctor/no-model/compatible-turn/Anthropic-removal registry-install checks
therefore have no results or exit codes. Issue #138 remains open; fixes are
tracked separately and are outside this release attempt.

## 0.4 truth pass (#137, 2026-09-29)

**Verdict: live verification recorded with failures; release approval remains pending.**
The maintainer authorized these models and reduced the original $10 eval ceiling
to $2 per API service ($4 combined). Smoke and eval used the runner's default
thinking, with explicit consent because those commands expose no thinking option.
The installed coding tasks used Codex `gpt-6-sol` with `medium`, OpenRouter
`meta/muse-spark-1.3-contributor` with `reasoning.effort=medium` in its compatible
request body, and OpenAI `gpt-6-luna` with provider-default thinking. Luna medium
was unavailable through the thinking selector at this tested revision.
No provider/model fallback was used and no defects were fixed in this pass.

Tested revision: `d72f94a234a648dbfe63cf6162643e56418f8656`, clean `main`.
`bun install --frozen-lockfile`, `bun run typecheck`, and `bun test` all exited 0;
1,414 tests passed across 99 files, with 0 failures. Raw JSON, session records,
logs and the reviewed task diffs remain in private directory
`~/schway-evidence/0.4/137-20260929T154041Z`, outside Git.

### Live smoke

Dates are UTC. Each run used the tested revision above; it is repeated below so
individual rows retain their provenance. The compatible endpoint host is
`openrouter.ai`. No endpoint path or credential is published.

| Date (UTC) | Revision | Route | Model | Auth source | Status / reason | Tool round trip | Exit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-09-29T15:41:48.402Z | `d72f94a234a648dbfe63cf6162643e56418f8656` | codex | `gpt-6-sol` | stored-subscription | passed / verified | true | 0 |
| 2026-09-29T15:44:26.689Z | `d72f94a234a648dbfe63cf6162643e56418f8656` | openai-api-key | `gpt-6-luna` | stored | passed / verified | true | 0 |
| 2026-09-29T15:45:41.898Z | `d72f94a234a648dbfe63cf6162643e56418f8656` | compatible | `meta/muse-spark-1.3-contributor` | unavailable | failed_provider / timeout | false | 1 |
| 2026-09-29T15:47:58.062Z | `d72f94a234a648dbfe63cf6162643e56418f8656` | compatible (120 s retry) | `meta/muse-spark-1.3-contributor` | unavailable | failed_provider / timeout | false | 1 |
| 2026-09-29T16:04:57.438Z | `d72f94a234a648dbfe63cf6162643e56418f8656` | compatible (diagnostic serial 1, 120 s) | `meta/muse-spark-1.3-contributor` | stored | passed / verified | true | 0 |
| 2026-09-29T16:06:30.426Z | `d72f94a234a648dbfe63cf6162643e56418f8656` | compatible (diagnostic serial 2, 120 s) | `meta/muse-spark-1.3-contributor` | stored | passed / verified | true | 0 |
| 2026-09-29T16:07:52.662Z | `d72f94a234a648dbfe63cf6162643e56418f8656` | compatible (diagnostic serial 3, 120 s) | `meta/muse-spark-1.3-contributor` | stored | passed / verified | true | 0 |
| 2026-09-29T16:09:02.935Z | `d72f94a234a648dbfe63cf6162643e56418f8656` | compatible (diagnostic parallel A, 120 s) | `meta/muse-spark-1.3-contributor` | stored | passed / verified | true | 0 |
| 2026-09-29T16:08:56.919Z | `d72f94a234a648dbfe63cf6162643e56418f8656` | compatible (diagnostic parallel B, 120 s) | `meta/muse-spark-1.3-contributor` | stored | passed / verified | true | 0 |

Both original compatible attempts timed out (30,004 ms and 120,022 ms). Its credential
could separately be read from the secure store in 10 ms; the smoke parent's
`unavailable` auth source does not by itself diagnose an authentication failure.
These failures are tracked in [#174](https://github.com/chayapats/schway/issues/174).

Maintainer-requested diagnostics confirmed authenticated account/model requests
returned HTTP 200, a direct adapter tool call completed in 5.4 s, and an
in-process smoke completed in 23.3 s without the bounded fetch wrapper. One
bounded probe received HTTP 503; another reached the shared 30 s deadline
during its second request. A closed synthetic HTTP 503 body produced the
correct adapter error in 2 ms.

The five subsequent instrumented OS-supervised workers in the table passed
with a 120 s limit: 33.761, 43.464, 29.400, 17.769 and 11.757 seconds respectively.
Their parent smoke reports include startup/IPC overhead and record 33.836,
43.586, 29.525, 17.848 and 11.836 seconds. For the first run, OpenRouter generation
metadata names Meta and reports provider-response latencies of 12.433 and
19.967 seconds for its two HTTP 200 calls; the worker consumed SSE throughout.
An offline replay through the production adapter, bounded transport and smoke
runner scaled the request delays to 130/203 ms: a shared 300 ms deadline timed
out, while changing only the deadline to 600 ms passed. Both outcomes repeated
twice. This confirms a whole-lane deadline/latency interaction; successful
parallel runs do not establish concurrency as a cause.

These diagnostics do not erase the original failures. The original 120 s
timeout lacks its request/generation ID, so its root cause remains unknown in
[#174](https://github.com/chayapats/schway/issues/174). Neither a contributor
queue nor a particular local bug is established for that historical failure.
No production fix or model fallback was applied in the truth pass.

### Evals

Prices in USD per million input/output tokens, checked 2026-09-29:
[OpenAI Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) $0.10/$0.50;
[OpenRouter Muse Spark](https://openrouter.ai/meta/muse-spark-1.3-contributor)
$0.10/$0.20 (also checked against its public model catalog).
The stock eval runner received the selected secure-store key through an in-memory
environment mapping; keys were never written to files or command arguments.
Each original suite run had `maxTurns=8`, `timeoutMs=30000`, `maxOutputTokens=4096` and
`--max-spend 1.99`, reserving $0.01 of each $2 service allowance for smoke.
The runner's cap is a soft, between-case gate, not a provider billing hard limit.

| Route | Model | Input/output price | Case / outcome | Cases passed/total | Spend USD | Grader exit | Run exit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAI API key | `gpt-6-luna` | 0.10 / 0.50 | `clamp-bounds` / success | 1/1 | 0.000564 | 0 | 1 |
| OpenAI API key | `gpt-6-luna` | 0.10 / 0.50 | `multi-file-refactor` / success | 1/1 | 0.001148 | 0 | 1 |
| OpenAI API key | `gpt-6-luna` | 0.10 / 0.50 | `locate-implementation` / model_failure | 0/1 | 0.001188 | not run | 1 |
| OpenAI API key | `gpt-6-luna` | 0.10 / 0.50 | `failing-tests` / success | 1/1 | 0.000839 | 0 | 1 |
| OpenAI API key | `gpt-6-luna` | 0.10 / 0.50 | `long-context` / success | 1/1 | 0.001229 | 0 | 1 |
| OpenAI API key | `gpt-6-luna` | 0.10 / 0.50 | `tool-error-recovery` / success | 1/1 | 0.000458 | 0 | 1 |
| OpenAI API key | `gpt-6-luna` | 0.10 / 0.50 | `parallel-read` / model_failure | 0/1 | 0.001674 | not run | 1 |
| OpenAI API key total | `gpt-6-luna` | 0.10 / 0.50 | 7/7 cases run | 5/7 | 0.0071 reported | 0 for five successes | 1 |
| OpenAI-compatible | `meta/muse-spark-1.3-contributor` | 0.10 / 0.20 | `clamp-bounds` / timeout | 0/1 | ≥0; usage missing | not run | 3 |
| OpenAI-compatible | `meta/muse-spark-1.3-contributor` | 0.10 / 0.20 | `multi-file-refactor`, `locate-implementation`, `failing-tests`, `long-context`, `tool-error-recovery`, `parallel-read` / skipped_spend_cap | 0/6; unrun | 0 additional calls | not run | 3 |
| OpenAI-compatible total | `meta/muse-spark-1.3-contributor` | 0.10 / 0.20 | 1/7 cases run | 0/7 | ≥0; lower bound | not run | 3 |
| OpenAI-compatible diagnostic, original prompt | `meta/muse-spark-1.3-contributor` | 0.10 / 0.20 | `clamp-bounds` / model_failure, 120 s limit | 0/1 | 0.002096 | not run | 1 |
| OpenAI-compatible diagnostic, corrected prompt only | `meta/muse-spark-1.3-contributor` | 0.10 / 0.20 | `clamp-bounds` / success, 120 s limit | 1/1 | 0.000872 | 0 | 0 |
| ChatGPT subscription | `gpt-6-sol` | subscription | not runnable (tracked in #167) | — | — | — | — |

Original runner summaries: `Spent $0.0071 of $1.99 · 7/7 cases run` (OpenAI)
and `Spent $0.00 of $1.99 · 1/7 cases run` (compatible). The two diagnostic
summaries are `Spent $0.0021 of $0.10 · 1/1 cases run` and
`Spent $0.00087 of $0.10 · 1/1 cases run`; the table uses their unrounded JSON
amounts. Summing `spend.totalUsd` in the four retained live eval artifacts gives
**$0.010068, a lower bound** ($0.0071 + $0 + $0.002096 + $0.000872), below the
$4 authorized combined allowance and original $10 eval ceiling as a reported
lower bound, not proof of an exact bill. The original compatible run has
`spendExact=false`; its six skips reflect missing usage, not measured exhaustion
of $1.99. Exit 3 is not a pass. Smoke and coding-task costs are not included in
this eval sum, and other release runs outside this evidence set are not audited.

The latest read-only provider key check at 2026-09-29T19:22:33.743Z reported a
$2 limit, $0.007219806 cumulative usage and $1.992780194 remaining. The earlier
post-Muse-task measurement was $0.006495026. These are key-level measurements
including calls outside the eval artifacts; reporting delay or other calls can
explain a later change. They are not per-run attribution and must not be added
to the eval sum. The latest OpenRouter measurement is below its configured $2
limit; exact OpenAI smoke/coding charges and release-wide billing remain
unverified. Issue #137 permits a lower-bound report when usage is incomplete;
this qualifier does not certify exact billing or release approval.

The diagnostic original-prompt clamp run ended at 87.878 s with 8 tool calls,
5 failures and 3 repeated calls; no grader ran. Its task prescribed `bun test`,
but the restricted tool accepts only `bun test test/math.test.ts` without extra
arguments. The same command mismatch reproduces offline. Changing only the
diagnostic prompt to name the permitted command completed at 20.768 s with
4 calls, zero tool failures and grader exit 0. Model nondeterminism prevents
attributing the whole duration difference to that edit. Both diagnostics used
8 turns and a 4,096-token output cap; neither replaces the official 30 s suite
results. [#176](https://github.com/chayapats/schway/issues/176) tracks this
confirmed harness defect; [#173](https://github.com/chayapats/schway/issues/173)
tracks Luna's two discovery failures, and #174 retains the compatible failures
and six unrun official cases. The official totals remain Luna **5/7** and
compatible **0/7**, despite successful later coding tasks and diagnostics.

### Installed coding tasks

`npm pack` at the tested revision and `npm install --ignore-scripts` into a
separate temporary prefix both exited 0. Only the installed executable was
launched for the original task. The three real live-model tasks used disposable
clones of the same repository and an agent-operated Linux PTY;
this is not a human visual review of terminal layout. The Muse task plan pins
the tested revision. The Luna follow-up was reported as using the retained
installed build, but its saved outcome/session do not independently identify
the executable revision and no separate launch artifact was retained; its
revision attribution has that provenance limit.

| Field | Recorded result |
| --- | --- |
| Schway revision | `d72f94a234a648dbfe63cf6162643e56418f8656` |
| Route / model / thinking | ChatGPT subscription / `gpt-6-sol` / `medium` |
| Repository | [sindresorhus/escape-string-regexp](https://github.com/sindresorhus/escape-string-regexp), MIT, commit `a7f7dabaf336bda98d2166848af15d9168b10bcf`; clean disposable clone before the task |
| Task | Add dependency-free `node:test` edge-case tests, a `test:edge` package script and README usage, preserving the existing API and test script |
| Execution limits | Tested agent instructed to stay in the disposable repo; no dependency installation, network use, credential reads, commits or pushes |
| Changes | New `edge-cases.test.js`; modified `package.json` and `readme.md`. `git diff --stat`: 2 tracked files, 6 insertions, 1 deletion; new untracked test file is captured separately in the private diff |
| Checks through Schway bash | `npm run test:edge`: 11 passed, exit 0, both before exit and after resume; original `npm test` not run because its dev dependencies were not installed |
| Session / exit | `/session` returned `8e7e2b5a-a0a0-4798-b32f-ee6f9e396a56`; `/quit` exited 0 |
| Resume | Installed executable with `--resume` restored 20 saved records and displayed earlier turns; one further user turn completed and reran the tests successfully; second `/quit` exited 0 |
| Outcome | completed in Schway |
| Recovered friction | Model initially read `README.md` instead of `readme.md`; it discovered the correct file and recovered without intervention. No incorrect file was edited |
| Evidence hygiene | Task diff checked for credential patterns before private storage; raw session retained outside Git |
| OpenAI follow-up, 2026-09-29 | Installed OpenAI API-key / `gpt-6-luna` / provider default; same repository and base commit, separate disposable clone; add dependency-free edge tests, `test:edge` and README instructions |
| OpenAI changes | Raw `git diff --stat`: 2 tracked files, 6 insertions, 1 deletion (`package.json`, `readme.md`); new untracked `edge-cases.test.js`, 28 lines, included in retained diff; full captured diff: 3 files, 34 insertions, 1 deletion |
| OpenAI checks / outcome | `npm run test:edge`: 2 passed, 0 failed before and after resume; both exits 0; completed in Schway. Initial turn 34.411 s, resumed turn 4.236 s, no tool errors |
| OpenAI session / resume | `2dad1603-9485-4738-8096-cd7e4eb501c0`; earlier session restored, further test turn completed; both `/quit` exits 0 |
| OpenAI limits / friction | Exact task cost unknown because the TUI does not persist complete billable usage. Existing dependency-requiring `npm test` not run; tests cover installed Node only. README test section interrupts existing usage prose, tracked as documentation quality in [#179](https://github.com/chayapats/schway/issues/179); no functional failure or escape from Schway |
| OpenRouter follow-up, 2026-09-29 | Installed compatible / `meta/muse-spark-1.3-contributor` / explicit medium request body; same repository and base commit, separate disposable clone; same bounded edge-test task |
| OpenRouter changes | Raw `git diff --stat`: 2 tracked files, 12 insertions, 1 deletion (`package.json`, `readme.md`); new untracked `edge-cases.test.js`, 64 lines, included in retained diff; full captured diff: 3 files, 76 insertions, 1 deletion |
| OpenRouter checks / outcome | `npm run test:edge`: 6 passed, 0 failed before and after resume; both exits 0; completed in Schway. Initial turn 61.803 s, resumed turn 11.951 s, no tool errors |
| OpenRouter session / resume | `34daada1-3239-47bf-859c-5b1a8c6149e4`; earlier session restored, further test turn completed; both `/quit` exits 0 |
| OpenRouter accounting / limits | Key usage rose from $0.00334299 to $0.006495026 around the task (observed delta $0.003152036); accounting can lag, so this is not an exact task bill. Existing dependency-requiring `npm test` not run; tests cover installed Node only |

### Defects

| Issue | Severity | Title |
| --- | --- | --- |
| [#173](https://github.com/chayapats/schway/issues/173) | P2 | Eval discovery cases fail with gpt-6-luna when seed paths cannot be listed |
| [#174](https://github.com/chayapats/schway/issues/174) | P2 | OpenRouter Muse Spark smoke and eval time out without usage |
| [#176](https://github.com/chayapats/schway/issues/176) | P2 | Clamp eval instructs a bash command its own restricted tool rejects |
| [#179](https://github.com/chayapats/schway/issues/179) | P2 | Luna coding task inserts README Tests heading inside Usage prose |

The OpenAI artifact reports 12/13 failed tool calls for `locate-implementation`
and 24/24 for `parallel-read`. A shared fixture-discovery gap is visible in the
harness, but the exact failed arguments were not retained; #173 distinguishes
that observation from a confirmed explanation of every tool failure. The
original 120 s compatible timeout root cause remains unconfirmed, distinct from
the reproduced deadline interaction and confirmed #176 command mismatch. These
P2 defects have no release milestone. No P0/P1 condition was observed in this pass.

The thinking-control follow-up [#177](https://github.com/chayapats/schway/issues/177)
was subsequently closed by [PR #178](https://github.com/chayapats/schway/pull/178);
that implementation is separate from the unchanged historical tested revision
and does not retroactively validate medium selection or rerun these evals.
This evidence completes the #137 truth-pass record once the report PR is merged,
with unresolved accounting explicitly reported as a lower bound. Release
approval remains pending under [#138](https://github.com/chayapats/schway/issues/138);
closing the truth pass does not mean all evals passed or approve publication.


## Complete installed daily-use gate (#106, 2026-09-28)

**Verdict: pending.** The implementation is present and the offline checks below
passed, but an operator has not completed the required installed, live coding
journey or judged the assembled interface in a human terminal. Issue #106 must
remain open; no package was published and historical issue #58 was not changed.
Closed prerequisite issues are implementation history, not a passed journey.

The packed **runtime revision** was
`a49f1e51d080446ddd436c499fe3dd3ea80065a5` (`origin/main` after #105):
the issue changes tests and this report, with no packaged file or runtime
behavior change. The first repaired verification tree was commit
`7433ba0794111984b2877b1564bac5ff52989073`; the final test/report
revision is recorded as the linked PR head and issue comment after the last
full run. These are separate revisions because the test harness changed after
packing the unchanged runtime. Tests ran on Linux
x86_64 with Bun 1.4.2 and npm 11.19.1. `tests/startup-installed.test.ts` and
`tests/packaging.test.ts` packed this candidate with `npm pack`, installed it
outside the checkout, and ran its installed entrypoints with isolated HOME,
fixture credentials and a scripted model. The installed Linux PTY lane used
`TERM=xterm-256color` and `NO_COLOR=1`; renderer tests used OpenTUI's test
renderer. Neither fixture is a human terminal or a live provider.

### Evidence by category

| Category | Result for this candidate | Boundary and limit |
| --- | --- | --- |
| Implementation completeness | Present for the listed journeys | The merged #93, #96-#100 and #102-#105 contracts are in the candidate; this says what can be exercised, not what a user observed. |
| Offline renderer and protocol | **Passed**: 133 focused tests across 13 files, 0 failures; one assembled working-journey renderer/loop/tool test; scripted eval 7/7 cases, grader exit 0 | Renderer keyboard, paste and resize; controller/loop, auth-route and retry fixtures. The assembled scripted working journey does not prove human terminal or live-provider behavior. |
| Installed package and public consumer | **Passed** in focused run | Packed binary outside the checkout: fresh connection, remembered choice, explicit unavailable subscription model, headless tool round trip, extension typecheck, branch/compaction resume, and isolated profiles. `tests/startup-installed.test.ts` also launched the binary in a Linux OS PTY. |
| Full repository checks | **Passed:** `bun test` 1,209/1,209 across 92 files, 0 failures; `bun run typecheck` passed | Two earlier full runs exposed fixture timing failures, repaired as described below. The final run includes the assembled working-journey test. |
| Human terminal, browser and live provider | **Pending** | No operator approval, real browser OAuth, native credential-store check, paid inference, or human visual judgment was performed for this candidate. `bun run live-smoke --provider all` exited 2 with all four routes `skipped/live_disabled`. |

### Journey ledger

“Passed offline” applies only to the named fixture boundary. A journey stays
pending when its required installed, human or live lane has not been observed.

| Journey | Implementation | Offline observation | Human/live verdict and remaining friction |
| --- | --- | --- | --- |
| T1: clean installed start, connect, choose model/auth, send Thai multiline task | Present | **Passed offline:** installed executable, injected secure store and model, real renderer paste/keyboard/resize, one explicit send and one durable user turn (`tests/startup-installed.test.ts`). | **Pending:** native store, real browser approval/account discovery, live task and human screen reading. |
| T2: read/edit/check, inspect/copy/search, compact, review, finish | Present | **Passed at the renderer/loop/tool boundary:** `tests/daily-use-journey.test.ts` sends one Thai multiline task through real keyboard input and tools, checks the file and command exit, copies a result, searches, reviews, compacts and reloads durable history. Installed package headless tools and controller branch/compact paths also passed. | **Pending:** human judgment of the assembled installed TUI path and live model output. The scripted source renderer is not a human installed terminal. |
| T3: auth expiry, bad model, partial retry, disk failure, cancellation, interrupted exit | Present | **Passed across the required separate offline checkpoints:** expired token transport, unavailable model, partial retry, failed persistence, cancellation and interrupted exit use protocol/controller/renderer/app subprocess boundaries. Wrong subscription model and denied credential read also reached installed startup. | **Pending:** actual auth expiry/repair with an authorized live route and human installed recovery observations. No paid retry or effect replay was attempted. |
| T4: returning user, explicit overrides, two workspaces, branches and draft policy | Present | **Passed at fresh-process/controller boundaries:** installed remembered/explicit model paths and packaged branch/compaction resume; fresh-process tests cover precedence, two workspace scopes, recent resume, branch navigation and ordinary/sensitive drafts. | **Pending:** human installed restart across both workspaces and real auth routes. Current effective settings must be rechecked at resume before any paid turn. |
| T5: normal/narrow/light/dark/no-color, Unicode and terminal controls | Present | **Partial:** installed xterm PTY passed 80×24 to 32×12, Thai/CJK/emoji/combining paste, Ctrl+L and exit; renderer tests passed appearance, keyboard/focus and narrow layouts. | **Pending:** human direct-terminal and multiplexer visual judgment across the assembled panels. Raw PTY bytes cannot certify cell alignment. |
| T6: actual Schway coding task, exit and resume | Present as an intended workflow | **Pending:** scripted eval is a fixture, not this task. | **Pending:** explicit authorization for live/provider use and an operator with an installed terminal session. Record actual revision, model/auth route, diff, checks and resumed session without secrets. |
| T7: release verdict | Gate and report present | **Passed offline:** full suite 1,209/1,209, package-consumer checks, typecheck and scripted eval passed. | **Pending** while T1-T6 required observations remain pending. No release or issue closure follows from this report. |

### Reproduction steps by journey

Each `bun test` command below uses fixtures with isolated user state. Inspect the
named assertion and its captured file/session/UI result; a green command alone
is not a human or provider observation.

| Journey | Offline reproduction and injection | Still needed for the installed acceptance lane |
| --- | --- | --- |
| T1 | `bun test tests/startup-installed.test.ts tests/packaging.test.ts`: `fresh` starts the installed binary outside the checkout, enters fixture credential and Thai multiline input, then checks one send and the JSONL user record. The package consumer runs its exported extension and headless tool path. | In a human installed terminal, repeat connect, model/auth selection, send and reopen with native credential storage and an authorized route. |
| T2 | `bun test tests/daily-use-journey.test.ts`: paste the Thai task, observe read→edit→bash exit zero, inspect/copy, search, review the changed file, compact and reload without replay. `tests/packaging.test.ts` checks the installed tool/extension and persisted branch/compact paths. | Repeat the assembled path in the installed TUI with a human reading/copying results; retain the actual diff and check output. |
| T3 | `bun test tests/codex-subscription.test.ts tests/startup-installed.test.ts tests/tui-retry.test.ts tests/tui-recovery.test.ts tests/tui-drafts.test.ts`: inject an expired/revoked token, explicit unavailable account model, partial stream then retry, failed session/draft writes, cancellation during retry/tool work, and killed or interrupted exit, respectively. Check the retained user/tool records and “not saved” labels after each separate checkpoint. | With an authorized route and operator, repeat auth repair and failed/cancelled installed turns; compare file effects before retry so no effect is replayed. |
| T4 | `bun test tests/interactive-memory.test.ts tests/recent-startup.test.ts tests/model-picker-routes.test.ts tests/tui-branches.test.ts tests/tui-drafts.test.ts tests/packaging.test.ts`: start two canonical workspaces, set a remembered route, override it with config/CLI and explicit headless settings, exercise both fixture auth routes, restart, use recent resume/branches, and restore/discard ordinary drafts while excluding sensitive entry. Inspect selected route before a turn. | Repeat both workspaces from installed fresh processes with each authorized real auth route and verify current billing selection before sending. |
| T5 | `bun test tests/tui-view.test.ts tests/startup-installed.test.ts`: exercise 80×24, 44×18, 32×12 and 24×8 renderer layouts with keyboard/focus/resize and Thai/Unicode; appearance cases cover auto/dark/light and `NO_COLOR`. The installed Linux PTY injects bracketed Unicode paste at 80×24, resizes to 32×12, sends Enter/Ctrl+L/Ctrl+C, and checks alternate-screen cleanup. | A human checks direct light/dark/no-color terminals and a multiplexer at normal/narrow sizes, including selection/copy and Unicode cell alignment. Record terminal versions and failures separately. |
| T6 | `bun run eval --provider scripted --case all` verifies only seven scripted coding cases. | Separately authorize a live route and operator; use installed Schway for one bounded real edit/check, exit and resume, then retain revision, model, diff and result without secrets. |
| T7 | `bun run typecheck`, `bun test`, the installed package tests above, and `bun run live-smoke --provider all` without live enablement show the offline outcomes and explicit skipped live routes. | Keep this gate open until every required installed, human and live checkpoint is observed passed; do not publish a release from this ticket. |

The first full `bun test` exposed a test-harness failure before repair: 1,204
passed and four failed across 91 files. All four were in
`tests/tui-view.test.ts`: three OpenTUI `waitFor` calls exhausted their 20
render passes while asynchronous command/model work was still settling, and one
skill-collision assertion read the transcript before its command completed.
An isolated rerun failed at two different asynchronous waits in the same file
(68 passed, two failed), which reproduced the timing sensitivity. The fixture
now waits for controller idle when a turn must settle and uses a bounded
wall-clock/UI refresh wait for observable command and panel states. No
production behavior changed. After the first repair, the isolated file passed
70/70 tests and `bun run typecheck` passed.

The second full run passed 1,206 and failed two tests: one app-exit subprocess
test exceeded Bun's default five-second test deadline under suite load, and
one invalid-command assertion observed idle before asynchronous rejection.
The subprocess test now has a 20-second test deadline; its own output/read
deadlines and production exit deadlines did not change. The command test now
waits for the error state. A later two-file run of `tui-view` and `tui-drafts`
passed 82/82 tests, and typecheck passed. The last full `bun test` before the
assembled working-journey fixture passed 1,208/1,208 tests across 91 files
with zero failures in 182.32 seconds. With the assembled fixture added, the
final full run passed 1,209/1,209 tests across 92 files with zero failures
in 123.63 seconds.

### Reproduce and complete the open lanes

1. From the issue branch at the recorded runtime base, run `bun install --frozen-lockfile`,
   `bun test tests/startup-installed.test.ts tests/packaging.test.ts`,
   `bun run typecheck`, and `bun test`. The installed tests create temporary
   consumers and isolated user state; they do not use developer credentials.
   The 13-file focused run also included `recent-startup`,
   `interactive-memory`, `tui-drafts`, `tui-recovery`, `tui-retry`,
   `tui-inspection`, `tui-search`, `tui-context`, `tui-review`,
   `tui-branches`, and `model-picker-routes`. It passed 133/133 tests in
   105.59 seconds. `bun run typecheck` passed.
2. Run `bun run eval --provider scripted --case all --output <private-json>`
   for the fixture coding cases. On this candidate all seven returned success
   with grader exit 0. Run `bun run live-smoke --provider all` without
   `--enable-live` to confirm the unrun live lanes remain explicit: this
   candidate returned aggregate `incomplete`, exit 2, and
   `skipped/live_disabled` for OpenAI API key, compatible and Codex (an Anthropic lane existed then and was removed in 0.4).
3. For the outstanding installed daily-use check, use an isolated HOME and
   a freshly packed candidate outside the checkout. In a human terminal,
   connect each authorized auth route, choose a model, paste a Thai multiline
   coding task, run read/edit/check tools, inspect/copy/search results,
   compact, review changed files and check exits, cancel once, exit, reopen
   and resume. Repeat in a second workspace with an explicit config/CLI
   override; verify no prior billing route is silently restored. Exercise
   ordinary draft restore/discard and confirm credential entry and sensitive
   commands are absent from draft artifacts. Record pass/fail per checkpoint,
   the terminal and size, exact revision/runtime/model/auth route, observed
   diff and check output, and friction without credential contents.
4. T6 needs separate operator and live-provider authorization. Use the
   installed package to make a bounded real Schway code edit, run a relevant
   check, exit and resume that same session. Native credential storage,
   browser OAuth and human terminal behavior need their own observations.
   If access or an operator is unavailable, retain **pending** with that
   missing prerequisite. Do not mark #106 or historical #58 passed, or
   publish a release, to clear the gap.


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
| v0.1 base path | Passed offline | `tests/v01-coding-workflow.test.ts` checks all seven tools, mutation barriers, bounded results, bash exit, cancellation/retry tests, saved JSONL and compaction; package test runs installed text/JSON and controller. Provider protocol fixtures covered Anthropic (removed in 0.4), OpenAI and compatible, not live availability. |
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

## Automated coverage by guide

### TUI

Moved from `tui.md`; the section names below identify each passage’s original location.

#### First launch and readiness

Automated coverage uses the actual renderer's keyboard, paste and resize input,
plus a packed-and-installed executable launched outside the checkout with isolated
HOME, credential storage, terminal and model fixtures. It covers fresh startup,
remembered credentials/model, setup cancellation and activation, one explicit send,
explicit subscription models absent from the fixture account catalog, denied
credential storage, missing profiles/HOME and invalid configuration. Renderer tests additionally delay startup, simulate offline
failure and fence late results after cancellation/disposal. These fixtures do not
verify a human terminal, real OS secure storage, live OAuth or a paid provider;
those checks remain unrun for the final installed-journey gate.

#### Returning to recent work

`tests/recent-startup.test.ts` exercises actual interactive startup in isolated
subprocesses with renderer keyboard, paste and resize: new/reopen, one-action
resume, explicit branch/auth/model, changed config over remembered billing,
credential repair, deleted/corrupt suggestions, and repeated navigation. Existing
interactive-memory tests cover missing profiles. These are deterministic model and
credential fixtures; live OAuth, real provider and human-terminal verification
remain unrun. Durable cross-process draft recovery is described in [the TUI guide](tui.md#leaving-and-recovering-unfinished-input).

#### Turn outcomes and change review

Automated verification covers the actual loop/controller with successful edits and
command exits, failed checks, cancellation and model failure after edits, pre-existing
snapshot dirt, concurrent on-demand edits, read-only/no-change and non-Git workspaces.
A real renderer fixture uses keyboard, paste, and resize input to navigate bounded
text, deleted, renamed and binary diffs, then restores the draft, cursor and scroll.
These deterministic fixtures use isolated workspaces and injected credentials; live
providers, OAuth, real credential storage and a human terminal journey remain unrun.

These are command results, not a claim that a test suite passed;
model prose and command invocation alone provide no verification evidence.

#### Color roles

Every text role meets a 4.5:1 contrast ratio on the canvas, both
surfaces and every tint it is used on; `tests/tui-view.test.ts` checks the pairs.

#### Motion and startup splash

Renderer fixtures run
with `off`; `tests/tui-motion.test.ts` covers the splash timeline and gating, key
forwarding, spinners, the completion flash and the streaming caret with an injected
clock.

#### Interaction: panel keyboard contract

| Panel | Navigation and action | Renderer fixture |
| --- | --- | --- |
| Preferences | Up/Down field, Left/Right value, Tab scope, Enter preview/confirm, Esc back | `tui-view.test.ts` appearance/preferences |
| Model, sessions, sign-in | Up/Down selection, Enter select, Esc back; model Ctrl+R retries catalog | `tui-view.test.ts`, `tui-sessions.test.ts` |
| Credential, callback, approval | Masked entry or external wait, Enter only on entry, Esc cancel | `tui-view.test.ts` credential/login/approval |
| Branch tree, change review | Up/Down selection, Enter branch choice, Esc back; review uses PageUp/PageDown | `tui-view.test.ts` branch/review |
| Help, command completion, search, inspection | Panel-specific navigation, Enter chosen action, Esc restores composer | `tui-view.test.ts`, `tui-search.test.ts`, `tui-inspection.test.ts` |

New panels added after this slice require their own renderer and installed
journey checks in the final gate; this contract alone does not verify them.

#### Offline preview and checks

From a development checkout:

```sh
bun tests/fixtures/tui-demo.ts
# Long streamed Markdown for mouse/PageUp/PageDown and resize checks:
bun tests/fixtures/tui-demo.ts --scroll
```

Type a task to run the scripted read/edit/check demonstration. A second task waits
for cancellation so Esc can be checked. Everything runs in a temporary workspace
and home directory, removed on exit. No model API or stored credentials are used.

```sh
bun test tests/tui-view.test.ts
bun test tests/tui-activity.test.ts
bun run typecheck
```

The route, connection, catalog, profile, keyboard, paste, and resize checks in
this repository use isolated credentials and scripted or protocol fixtures.
They verify the local interaction and request path. They do not establish live
OAuth approval, remote account entitlement, or success in a human terminal;
those checks remain for the installed-journey gate.

Renderer tests exercise real keyboard/paste events, Markdown, output disclosure,
draft preservation, scroll anchoring, theme changes, Unicode, and resizing. Tests
assert behavior and a few stable layout landmarks, not snapshots of every cell.

#### Offline preview and checks (preferences)

The preference journeys are covered by real renderer keyboard, paste, resize and
isolated persisted-state fixtures in `tests/tui-view.test.ts`: scoped save/reset,
restart, CLI shadowing, file/memory conflicts, malformed files, unavailable models,
staging cancellation, secret exclusion, draft/cursor restoration, appearance
palettes and environment precedence. `tests/startup-installed.test.ts` exercises
the appearance canvas and source through a packed executable in fresh isolated
processes, plus installed Unicode/resize/recovery input and terminal cleanup
through a Linux OS PTY. Live provider, OAuth and human-terminal preference checks have not
been run; they remain for the installed-journey gate.

#### Discover commands and skills

Automated coverage uses isolated credentials, controller/dispatcher fixtures,
actual renderer keyboard/paste/resize at 44×18, and fresh-process metadata/SDK
loading checks. Human terminal use, real OAuth, and live provider journeys were
not run for this slice and remain part of the installed-journey gate.

#### Context and conversation continuity

Implemented behavior is verified by isolated scripted controller/loop tests for
pressure, overflow, manual summary, incomplete streams, cancellation, persistence
failure, unknown usage, capacity changes, branch isolation and disk resume. A
real JSONL fault fixture verifies that restoring storage still leaves the old
handle fenced, and the actual `/resume` dispatcher reloads it before compaction
can succeed without losing original records.
Renderer keyboard/paste/resize fixtures invoke `/context`, retain a future draft
during real tool execution at 44×18, and keep the composer usable at 24×8.
These fixtures do not establish live-provider, OAuth, or human-terminal success;
those checks remain unrun for the installed-journey gate.

#### Recent sessions

Verified with isolated scripted-model dispatcher and renderer tests: 106 sessions,
search/paging, workspace roots/subdirectories/symlinks, branch and attachment
resume, interrupted/legacy/corrupt/deleted files, keyboard/paste/resize and cancel, cross-workspace draft/viewport round trips,
late resume cancellation, bounded previews and auth-command exclusion. Human
terminal and live-provider journeys remain unrun; fixtures do not certify them.

#### Alternate conversation paths

Automated verification uses renderer keyboard, bracketed paste and resize input for duplicate shared-head paths, named forks, narrow Unicode lists, busy/failing confirmation, and draft/reading-position restoration. Controller/session fixtures verify persisted compaction isolation and no tool replay. Human terminal and live-provider checks are unrun; these fixtures do not establish live-provider or release success.

#### Leaving and recovering unfinished input

Automated coverage uses real renderer keyboard/paste/resize input and isolated app
subprocesses: multiline checkpoint/kill/reopen, discard, accepted cleanup, late
acceptance, cross-workspace switching, masked keys/callbacks, permission/disk-full
failures, conflicting writers, normal-exit flush, a deliberately blocked exit writer, terminal stop/destroy and a silent
tool that ignores cancellation. Store subprocesses also kill an atomic replacement
between temporary-file sync and rename. These fixtures use scripted models and fake
credential stores; live providers, actual OAuth, human terminal restoration and
macOS filesystem behavior remain unrun installed-journey checks.

### Sessions

Moved from `sessions.md`; the section names below identify each passage’s original location.

#### Unsent draft checkpoints

No real macOS filesystem run is claimed by the Linux fixtures.

### Configuration

Moved from `configuration.md`; the section names below identify each passage’s original location.

#### Interactive models and configuration

The renderer delegates operations to `TuiController` (`openModelPicker`, `searchModels`, `moveModelPicker`, `selectPickerModel`, `selectModel`, `selectProfile`, `thinkingCommand`, and `configCommand`). `loadConfigEditor` loads layers without creating files; `prepare`, `prepareModel`, and `prepareProfile` return validated transactions that change nothing until `commit`. `forWorkspace` stages the project layer for a session switch. `stageInteractiveSettings` constructs a changed provider adapter and matching context budget, reusing the current adapter for unrelated edits. This lets a session without startup credentials set a compatible endpoint URL before selecting its optional-auth provider. These interfaces support deterministic controller/configuration tests without loading OpenTUI or using paid model APIs.

#### Remembering and forgetting choices

Deterministic coverage uses isolated credentials, scripted/protocol transports, fresh interactive/headless processes, and real renderer keyboard, paste and resize input (`bun test tests/interactive-memory.test.ts`). These checks do not establish live OAuth, provider service access or human terminal success; those remain part of the installed-journey verification gate.

#### Reasoning levels

Runnable example (no paid APIs; fixtures in `tests/reasoning.test.ts` inspect outgoing controls):

```sh
# OpenAI efforts via scripted fixtures
bun test tests/reasoning.test.ts
# Live-equivalent CLI (needs a key; shows validation, not fixtures)
schway --provider openai --model gpt-5.4 --thinking low -p 'plan only'
# OpenRouter: exact provider-advertised effort
schway --provider openai-compatible --base-url https://openrouter.ai/api/v1 --model meta/muse-spark-1.3-contributor --thinking medium -p 'hello'
# Other compatible services: reasoning via extraBody, thinking stays unset
schway --provider openai-compatible --base-url http://127.0.0.1:11434/v1 --body '{"reasoning_effort":"medium"}' -p 'hello'
```

Protocol tests in `tests/thinking-policy.test.ts` cover all auth routes without paid calls.

#### ChatGPT subscription (Codex OAuth)

The query is a verified Codex client compatibility version, **not** the Schway package version: sending Schway `0.1.0` returned an empty catalog on a real account.

A live subscription catalog request and TUI picker were tested on 2026-09-25 (7 visible models, 2 hidden); this does not prove inference or release readiness for every account.

Runnable examples (deterministic; no paid APIs or live subscription calls):

```sh
# Scripted login/refresh/selection/resume/redaction coverage plus a real tool round trip
bun test tests/codex-subscription.test.ts tests/codex-callback.test.ts
# Deterministic headless behavior without credentials: fails actionably, starts no browser
schway --provider openai --openai-auth codex -p 'hello'
# Live-equivalent API-key path (needs a key; shows validation, not fixtures)
schway --provider openai --openai-auth api-key -p 'hello'
```

Optional bounded live smoke stays separate evidence and is reported independently of fixture success.

#### Named OpenAI-compatible profiles

Runnable example with two local protocol fixtures (no paid APIs):

```sh
cat ~/.schway/config.json
# { "profiles": { "a": { "baseUrl": "http://127.0.0.1:8101/v1", "model": "model-a", "credentialEnv": "PROFILE_A_KEY" }, "b": { "baseUrl": "http://127.0.0.1:8102/v1", "model": "model-b", "credentialEnv": "PROFILE_B_KEY" } } }
PROFILE_A_KEY=sentinel-a PROFILE_B_KEY=sentinel-b schway --profile a -p 'hello from a'
PROFILE_A_KEY=sentinel-a PROFILE_B_KEY=sentinel-b schway --profile b --model override-model --header 'X-Test: ok' -p 'hello from b'
```

Each endpoint receives only its profile's model, body, headers, and sentinel credential; runtime overrides apply last; switching never leaks the earlier credential. See `tests/profiles.test.ts` for deterministic two-endpoint, precedence, isolation, auth-mode, and atomic-switch coverage.

#### Git change tracking

Runnable example (no paid APIs; temporary filesystems in `tests/git-changes.test.ts`):

```sh
bun test tests/git-changes.test.ts
```

### Credentials

Moved from `credentials.md`; the section names below identify each passage’s original location.

#### Deterministic checks and opt-in native smoke

```sh
bun test tests/credentials.test.ts tests/credential-store.test.ts tests/credential-management.test.ts tests/cli.test.ts tests/cli-process.test.ts tests/config-cli.test.ts
bun run typecheck
```

These checks inject an in-memory store. CLI subprocess tests preload a fake
`Bun.secrets`; a temporary `HOME` alone does **not** isolate the OS keychain.

The following optional smoke uses a unique test account, a non-production value,
and removes it in `finally`. Run it only when you explicitly want to exercise your
real OS credential store. It does not contact a model provider or alter Schway's
saved provider accounts:

```sh
bun --no-env-file -e '
const address = { service: "schway-smoke", name: crypto.randomUUID() };
try {
  await Bun.secrets.set({ ...address, value: "non-production-smoke-value" });
  if (await Bun.secrets.get(address) !== "non-production-smoke-value") throw new Error("read mismatch");
  if (!await Bun.secrets.delete(address)) throw new Error("delete mismatch");
  if (await Bun.secrets.get(address) !== null) throw new Error("credential still present");
  console.log(`OS store smoke passed: ${process.platform}, Bun ${Bun.version}`);
} finally {
  await Bun.secrets.delete(address);
}
'
```

Record the actual OS, Bun version and result. A fake-store test is not evidence
that any native store, all supported platforms, live providers or human terminal
interaction passed. Native smoke and human terminal dogfood remain pending until
performed explicitly.

### Workspaces

No verification prose was present in this guide when issue #139 separated usage from verification.

### Extensions

Moved from `extensions.md`; the section names below identify each passage’s original location.

#### Tool argument and result hooks

Deterministic tests exercise real temporary-file edits through the loop, invalid
and denied rewrites, post-execution failures without replay, scheduling barriers,
parallel siblings, every cancellation phase, and durable JSONL reload. The
headless CLI and installed-package tests use scripted/local protocol fixtures;
they are not live-provider or human terminal evidence.

#### Runnable example and verification

Deterministic tests use
the real controller and loop with scripted models, including cancellation,
collisions, listener failures/mutation, bounded queues, JSONL parity, and new/resume
cleanup. Request tests additionally cover actual scripted requests, ordered
waterfalls, retries, pressure/overflow summaries, durable JSONL resume, invalid
outputs, retained-reference mutation, and cancellation after tool settlement.
Installed-package verification uses a local protocol fixture. These checks do
not provide live-provider or human terminal validation.
