# Managed implementation assignment

The coordinator supplies every field; a missing ownership or worktree field blocks edits.

- Run ID and coordinator identity:
- Issue number, URL, current full body and acceptance criteria:
- Relevant decisions from comments and prerequisite contracts:
- Pinned base SHA and target branch:
- Worker identity:
- Absolute assigned worktree and unique branch:
- Claims helper absolute path, claim key and issue token:
- Reserved `path:` and `contract:` resources:
- Relevant repository instructions and test commands:
- Existing baseline failures and evidence, if any:
- Authorization for commits; PR/merge authority remains with coordinator:

## Worker contract

1. Read the repository's implement instructions. Use its implementation/test discipline in managed mode. Verify the claim with the helper's `check` command from the assigned worktree before the first edit, before each edit batch, and before commit. Confirm branch and canonical Git common directory; a failed check means stop and notify the coordinator.
2. Set explicit workdir on every command. Apply patches only to absolute paths under the assigned worktree. Keep the shared launch checkout unchanged. Read other areas as needed, but request resource expansion before writing outside reserved paths or altering an unreserved shared contract.
3. Implement only this issue. Use scripted/protocol fixtures for deterministic tests and project-required checks. Do not hide a failure as pre-existing without reproducing or obtaining pinned-base evidence; report any required failing check as failing.
4. On conflict or unclear shared behavior, send run/issue/HEAD, the exact needed resource or decision, and the smallest proposed change. Pause the dependent work while continuing independent in-scope work. Never cherry-pick, reset, rebase or commit another worker's branch.
5. Check the diff for scope, stage explicit files, and commit only your work on the assigned branch. Return it as `review` work, not merged/completed work. Do not spawn subagents or run the multi-agent code-review yourself; the coordinator schedules review slots.
6. On stop/cancel, cease mutations, report in-progress commands, uncommitted files and HEAD, and acknowledge that you are stopped. An agent status alone is not proof that a spawned shell process has stopped; identify and settle your own processes. Do not release the claim or remove the worktree.

## Handoff

- Run / issue / worker / claim key:
- Absolute worktree / branch / base SHA / final HEAD SHA:
- Acceptance criteria: passed, failed or pending with observed evidence:
- Commands run and results, including baseline versus new failures:
- Changed paths and shared contracts:
- Remaining dirty files, running processes, limitations or blockers:
- Proposed PR summary and review concerns:
- Status: review, blocked, or stopped; ownership stays reserved:

The coordinator verifies this handoff against Git and the claim record before accepting it. Every follow-up retains the same worktree/token unless the coordinator has explicitly completed a safe reassignment.
