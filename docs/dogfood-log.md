# Dogfood log

Severity definitions from [the product specification (#128)](https://github.com/chayapats/schway/issues/128):

- **P0:** Data loss or corruption, edits applied to the wrong file, or broken resume.
- **P1:** The user had to leave Schway to finish the task.
- **P2:** Any other friction.

## Round 1 (0.5.0)

Codex operates registry-installed Schway 0.5.0 for real tracked issue, PR or
review work at the maintainer's request. The maintainer helps inspect and validate
results, observations and this sanitized log. Assistant-operated work is not
presented as human-operated use; only real persisted sessions with completed
turns qualify. Raw session JSONL, private prompts, credentials and tokens stay
outside Git.

Status: day 1 started on 2026-10-01 (Asia/Bangkok); two qualifying sessions
recorded across ChatGPT and Grok so far. The round remains open.
The first date is the Asia/Bangkok calendar date of the first qualifying session,
not the release or log-creation date. The round needs three consecutive days,
at least one qualifying session per day, eight distinct sessions in total and
at least two auth routes.

### Daily setup

[#151](https://github.com/chayapats/schway/issues/151) is complete and
`schway@0.5.0` is published. The exact registry version was installed for daily
use on 2026-10-01; the installed executable's `doctor --json` reported `0.5.0`.
P0, P1 and P2 labels exist. This setup verification does not count as a session.

Start each day with:

```sh
command -v schway
schway doctor --json | jq -r .version
```

The version must be `0.5.0`. Run real issue, PR or review work through the
registry-installed `schway`; source-checkout runs do not count.
Each counted ID must exist under `~/.schway/sessions/` and contain at least one
completed turn. Resuming an ID does not create another session. Demos, evals,
live smoke, installation checks and direct Codex-only work do not count.

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

Dates use Asia/Bangkok. IDs were verified in the local session store.

### Friction

| Date | Session ID | Route | What happened | Severity | Issue |
| --- | --- | --- | --- | --- | --- |

Both day-1 sessions completed without an observed Schway runtime friction point.
The incorrect operator wording corrected in the first session was a prior
log-setup error, not a
Schway runtime defect. The maintainer can add observations from their review.
Record every observed friction point on the same day, including P2. Every P0/P1
requires a GitHub issue with the matching label. For fixed P0/P1 rows, record
the merged PR and local-main re-check date in the Issue cell.

### Restart and closing rules

A P0 stops the round. Keep earlier rows, then restart the three-day count after
its fix merges to main. Earlier sessions do not count toward the restarted
session and route minimums.

Every round P0/P1 must be fixed through a merged PR and rechecked on a local
main build (`bun run start` or a local `npm pack` install). These rechecks verify
fixes and do not replace normal registry-0.5.0 sessions. Fixes ship in 0.6;
a 0.5.x patch is not required. P2 fixes are outside this round's scope.

Before closing [#152](https://github.com/chayapats/schway/issues/152), add genuine
`What felt good` and `What did not` lists in a `### Round 1 summary` subsection,
record the totals line below with actual dates/counts/routes, and check that
open P0/P1 queries are empty on the recorded closing date:

```text
Round 1: <first date>–<last date> · <n> sessions · routes: <list> · P0 <n> · P1 <n> · P2 <n>
```

Add the matching `## Dogfood round 1 (<dates>)` section in
`docs/release-verification.md` with the totals line, a link to this log and the
P0/P1 empty-query check date. Commit both finished files to main, then comment
the verified totals line on #152 before closing the issue.
