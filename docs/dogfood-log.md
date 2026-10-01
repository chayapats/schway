# Dogfood log

Severity definitions from [the product specification (#128)](https://github.com/chayapats/schway/issues/128):

- **P0:** Data loss or corruption, edits applied to the wrong file, or broken resume.
- **P1:** The user had to leave Schway to finish the task.
- **P2:** Any other friction.

## Round 1 (0.5.0)

Codex operates registry-installed Schway 0.5.0 for tracked Schway issue, PR,
review or QA work and documented representative coding workflows for #152 at
the maintainer's request. The maintainer may help review results, observations
and this sanitized log. Evidence mode: accelerated agent-operated validation;
no three-day observation claim. This is not three-day human or daily-use
evidence. Only real persisted sessions with completed turns qualify. Raw session
JSONL, private prompts, credentials and tokens stay outside Git.

Status: validation completed on 2026-10-01 (Asia/Bangkok) under the amended
agent-operated criteria: eight distinct completed sessions across ChatGPT and
Grok. Three same-ID resumes passed and are counted only once per ID. No
calendar-day waiting gate was applied.

### Batch setup and validation

[#151](https://github.com/chayapats/schway/issues/151) is complete and
`schway@0.5.0` is published. The exact registry version was installed on
2026-10-01; the installed executable's `doctor --json` reported `0.5.0`.
P0, P1 and P2 labels exist. This setup verification does not count as a session.

Start each validation batch with:

```sh
command -v schway
schway doctor --json | jq -r .version
```

The version must be `0.5.0`. Run live tracked Schway implementation, review
or QA work, or a documented representative coding workflow for #152, through
the registry-installed `schway`, never `bun run dev` or a checkout. Each counted
ID must exist under `~/.schway/sessions/` with at least one completed turn.
Give each session a distinct useful task; do not split work artificially or
count a resumed ID again. Demos, evals, live smoke, offline fixtures,
installation checks and direct Codex-only work do not count as live sessions.

Record actual coverage of file read/write/edit, command and test execution,
and workspace-relative paths resolved against the primary workspace root.
Exercise an installed process restart with `--resume` and verify persisted
transcript integrity (completed turns and continuity after resume). Supplement
live sessions with deterministic installed-package branch and compaction
fixtures and the full offline `bun run typecheck` and `bun test` suite; record
results as supporting evidence, not additional live sessions. Do not claim
coverage until it has actually been checked.

Only release verification was authorized to spend USD 1 per route. This log
setup does not authorize new API-key spending. For dogfood, Codex uses the already
authenticated subscription routes: ChatGPT (`codex`, `gpt-6-sol`, `medium`) and
Grok (`grok`, `grok-4.7`, `medium`). These working release models and reasoning
choices are recorded in
[release verification](release-verification.md#050-release-2026-10-01).

### Sessions

| Date | Session ID | Route | Model | Task (issue/PR) | Outcome |
| --- | --- | --- | --- | --- | --- |
| 2026-10-01 | `b95fe502-f8ac-4e72-96cc-0a3bc2d9461a` | ChatGPT (`codex`) | `gpt-6-sol` · medium | [#152](https://github.com/chayapats/schway/issues/152): correct operator arrangement in the dogfood log | Updated only this log through installed 0.5.0; reviewed the diff and passed `git diff --check`. Persisted ID and final assistant reply verified; exit 0, completed. |
| 2026-10-01 | `cb2b9c76-e25b-430a-863e-d3b64538e845` | Grok (`grok`) | `grok-4.7` · medium | [#152](https://github.com/chayapats/schway/issues/152): acceptance review of the log draft | Read-only review found setup ready and correctly left the round open. Verified release/install/labels and diff checks. Persisted ID and final assistant reply verified; exit 0, completed. |
| 2026-10-01 | `598707ac-8bd4-499c-9338-bf9befcebb3d` | ChatGPT | `gpt-6-sol` · medium | [#152](https://github.com/chayapats/schway/issues/152): Apply amended #152 validation criteria | Updated this log through installed 0.5.0. Initial transport timeout was recovered with same-ID `--resume`; final turn completed, exit 0; prior JSONL bytes preserved. |
| 2026-10-01 | `e795506f-262a-49e5-a36d-051b576aea2b` | Grok | `grok-4.7` · medium | [#152](https://github.com/chayapats/schway/issues/152): Full offline validation and installed-fixture coverage review | Typecheck exit 0; 1,845 tests across 117 files passed, zero failures. Reviewed installed branch/compaction/resume fixtures; final turn completed, exit 0. |
| 2026-10-01 | `f162e27d-9cc0-4127-9a1c-da8ac8b577ef` | Grok → ChatGPT (same ID) | `grok-4.7 → gpt-6-sol` · medium | [#152](https://github.com/chayapats/schway/issues/152): Representative file/tool and primary-root workspace QA | Seeded marker failure repaired; 2 tests passed. Relative edit/write from nested launch cwd targeted the primary Git root; attached sentinel unchanged. Restart/resume on ChatGPT passed; prior bytes preserved; no write replay. |
| 2026-10-01 | `733e660a-29c3-432c-85d7-57242ba289c6` | ChatGPT | `gpt-6-sol` · medium | [#152](https://github.com/chayapats/schway/issues/152): Representative JSONL consumer diagnosis/edit/test workflow | Fixed only the isolated fixture consumer; seeded 3-pass/1-fail result became 4-pass/0-fail. Blank/CRLF handling passed and malformed input remained an error. Final turn completed, exit 0. |
| 2026-10-01 | `6db59e2b-1501-46ef-9b22-665c3c229fb8` | Grok | `grok-4.7` · medium | [#152](https://github.com/chayapats/schway/issues/152): durability, installed-artifact and headless-resume audit | Verified six earlier IDs and saved transcript structure; installed CLI/loop/session sources matched. Initial operator-set 20-round limit required same-ID continuation; final report completed, exit 0; prior bytes preserved. |
| 2026-10-01 | `305bed5a-39f3-47b2-8c62-63ed91d26629` | ChatGPT | `gpt-6-sol` · medium | [#152](https://github.com/chayapats/schway/issues/152): prepare closing evidence and operator summary | Updated only the two evidence docs from verified results; checked empty P0/P1 queries and diff formatting. Final assistant reply and persisted ID verified after completion; exit 0, completed. |

Dates use Asia/Bangkok. IDs were verified in the local session store. The
representative isolated live fixtures in sessions 5 and 6 were useful coding/QA
workflows under amended #152, not deterministic fixture runs counted as sessions.
Same-ID resumes count once. The evidence-writing session was added only after
its turn completed and Codex verified its persisted ID and final assistant reply.

### Friction

| Date | Session ID | Route | What happened | Severity | Issue |
| --- | --- | --- | --- | --- | --- |
| 2026-10-01 | `598707ac-8bd4-499c-9338-bf9befcebb3d` | ChatGPT | Request ended after one Schway retry with `getaddrinfo ETIMEOUT chatgpt.com`. Same-ID resume completed the task and preserved earlier bytes. No API-key fallback was used. | P2 | — (transient network interruption; recovered) |
| 2026-10-01 | `e795506f-262a-49e5-a36d-051b576aea2b` | Grok | The offline-validation operator noticed this log changing during its checks. This was the authorized concurrent criteria update in the same owned worktree; source/tests were untouched. Subsequent evidence work is serialized. | P2 | — (coordination observation, not a product defect) |
| 2026-10-01 | `6db59e2b-1501-46ef-9b22-665c3c229fb8` | Grok | Headless runtime JSON has no structured persisted session ID, so the operator had to inspect the session store before resume. Stored history and resume were intact. | P2 | [#209](https://github.com/chayapats/schway/issues/209) |
| 2026-10-01 | `6db59e2b-1501-46ef-9b22-665c3c229fb8` | Grok | The audit reached the operator-set 20-round limit after 55 tool calls before its final report. Same-ID continuation produced the report; no records were lost. | P2 | — (bounded-run workflow; recovered) |

The table records every observed batch friction point so far, including external
transport and coordination observations. Seeded failures in the isolated coding
fixtures are intentional task inputs, not Schway defects. The initial operator
wording error and corrected private collector metadata filter are evidence-setup
errors, not lost or corrupt Schway sessions. Raw headers and final replies were
independently checked after correcting the collector's nested-cwd assumption.
Every P0/P1 requires a GitHub issue with the matching label, linked in the
friction table. For fixed P0/P1 rows, record the merged PR and local-main
re-check date in the Issue cell.

### Round 1 summary

These are agent-operator observations from installed, headless validation, not
human feedback on the TUI.

**What felt good**

- File search/read, edit/write and command/test workflows worked with Thai text;
  workspace-relative paths resolved to the primary Git root from a nested launch
  directory, while the attached workspace sentinel stayed unchanged.
- Installed process restarts, including a cross-route same-ID resume, preserved
  transcript prefixes and did not replay writes.
- The full offline suite passed 1,845 tests across 117 files with 0 failures;
  typecheck passed. Installed 0.5.0 CLI, loop and session sources matched the
  unchanged worktree sources byte for byte.

**What did not**

- A transient ChatGPT transport timeout interrupted one turn; a same-ID resume
  recovered it. This was a transport interruption, not observed data loss.
- The offline-QA operator noticed a concurrent coordinator edit to this log.
  This was a shared-worktree coordination constraint, not a Schway wrong-file edit.
- Headless JSON output lacked a structured saved-session ID, requiring session
  store inspection before resume ([#209](https://github.com/chayapats/schway/issues/209), P2 discoverability).
- The operator-configured 20-round audit limit stopped the final report; same-ID
  continuation completed it. This was a bounded-run constraint, not a lost record.

Evidence mode: accelerated agent-operated validation; no three-day observation claim.

Round 1: 2026-10-01–2026-10-01 · 8 sessions · routes: ChatGPT, Grok · P0 0 · P1 0 · P2 4

**Validation verdict: passed against the amended round-1 criteria.** No P0/P1
was observed across the eight sessions. The four P2 rows are observations, not
four product bugs: one tracked discoverability gap, one external transport
interruption and two operator/coordination constraints. On the closing check
date, 2026-10-01, `gh issue list --state open --label P0` and
`gh issue list --state open --label P1` each returned an empty list. No P0/P1
fix, merged-fix recheck or P0 restart was required. The repository's independent-review
and current-HEAD CodeRabbit gates apply to evidence integration.

Headless agent validation cannot establish multi-day reliability or human TUI
usability.

### Restart and closing rules

A P0 stops validation. Keep earlier rows. Once its fix merges to main, rerun
affected installed workflows and start a fresh validation set with eight new
qualifying sessions across two routes. Earlier sessions do not count toward
the fresh session and route minimums; no calendar-day wait is required.

Every round P0/P1 must be fixed through a merged PR and rechecked on a local
main build (`bun run start` or a local `npm pack` install). These rechecks verify
fixes and do not replace normal registry-0.5.0 sessions. Fixes ship in 0.6;
a 0.5.x patch is not required. P2 fixes are outside this round's scope.

Before closing [#152](https://github.com/chayapats/schway/issues/152), add genuine,
non-empty `What felt good` and `What did not` lists in a `### Round 1 summary`
subsection. Precede the totals line with:

```text
Evidence mode: accelerated agent-operated validation; no three-day observation claim.
```

Record actual dates/counts/routes (the first and last dates of the qualifying
validation set), and check that `gh issue list --state open --label P0` and
`gh issue list --state open --label P1` both print nothing on the recorded
closing date:

```text
Round 1: <first date>–<last date> · <n> sessions · routes: <list> · P0 <n> · P1 <n> · P2 <n>
```

Add the matching `## Dogfood round 1 (<dates>)` section in
`docs/release-verification.md` with the totals line, a link to this log and the
P0/P1 empty-query check date. Review both finished docs, commit them to main,
then comment the verified totals line on #152 before closing the issue. Apply
these checks before reporting completion.
