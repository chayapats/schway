# Dogfood log

Severity definitions from [the product specification (#128)](https://github.com/chayapats/schway/issues/128):

- **P0:** Data loss or corruption, edits applied to the wrong file, or broken resume.
- **P1:** The user had to leave Schway to finish the task.
- **P2:** Any other friction.

## Round 1 (0.5.0)

The maintainer operates Schway; Codex checks persisted session evidence and
maintains this sanitized log. No assistant-operated run is counted as human use.
Raw session JSONL, private prompts, credentials and tokens stay outside Git.

Status: setup complete; no qualifying session or dogfood day recorded yet.
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
setup does not authorize new API spending; the maintainer chooses and operates
dogfood routes. Working release models and reasoning choices are recorded in
[release verification](release-verification.md#050-release-2026-10-01).

### Sessions

| Date | Session ID | Route | Model | Task (issue/PR) | Outcome |
| --- | --- | --- | --- | --- | --- |

No qualifying sessions recorded. Dates use Asia/Bangkok.

### Friction

| Date | Session ID | Route | What happened | Severity | Issue |
| --- | --- | --- | --- | --- | --- |

No observations recorded yet. This does not mean friction-free use.
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

Commit the finished log and the matching `## Dogfood round 1 (<dates>)` section
in `docs/release-verification.md` to main before closing the issue.
