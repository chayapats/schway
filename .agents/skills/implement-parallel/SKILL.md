---
name: implement-parallel
description: Coordinate several ready-for-agent GitHub issues with atomic local claims, separate worktrees, conflict-aware scheduling, and one integration owner. Use when implementing multiple issues concurrently or preventing agents from claiming or editing each other's work.
---

# Parallel implementation

One coordinator schedules a bounded batch; one worker owns one issue and worktree. Use the repository's `implement` workflow inside each assignment, with the managed-worker boundary below. Creating this skill does not start a batch; invocation to implement a batch authorizes its issue claims and progress comments, not unrelated messages or automatic merges.

Read [coordination.md](references/coordination.md) before claiming anything. The bundled `scripts/claims.ts` is the atomic ownership mechanism. GitHub assignment and comments communicate ownership but are not locks: several agents may share the same account.

When running in Pi, read [pi.md](references/pi.md) before dispatch. It defines the Pi tools, installed worker roles, three-worker default, effort and worktree ownership. Use the host-specific protocol rather than assuming Codex tools are available.

## Start one batch

1. Read repository instructions, tracker conventions and the local `implement` skill. Pin repository identity, target branch and its exact commit. Preserve the user's current checkout and uncommitted changes. Create a unique run ID and acquire the `coordinator` claim before reserving issues or posting claims. A competing coordinator reports the existing owner and does not start another scheduler.
2. Read open `ready-for-agent` issues and their current native blockers, assignees and linked/open PRs. An issue is eligible only when blockers are complete **and their required behavior is in the pinned base**. Resolve missing prerequisite evidence; a label or closed issue alone does not prove the base contains it. Respect assignments, explicit ownership comments and existing PRs, including ones by the same GitHub account.
3. Inspect likely write locations and shared contracts for each candidate. Reserve exact files/directories as `path:` resources and shared semantics as `contract:` resources. Changes to the same source file, lockfile, config schema, CLI dispatch or session format are competing work even if GitHub declares no blocking edge. Schedule them sequentially unless scope can genuinely be separated. Do not invent tracker dependencies just to express a temporary resource conflict.
4. Default to at most three implementation workers, further bounded by available agent slots; use the user's requested limit when feasible. Reserve capacity for the coordinator. Three is a concurrency ceiling, not permission to dispatch blocked or overlapping issues. Select independent issues, acquire their claims, then create unique branches/worktrees from the pinned base. Install required dependencies independently in each worktree. Re-read eligibility immediately before dispatch; abandon a reservation with evidence if someone else has claimed it.
5. Record a durable run ledger under the canonical Git common directory's `schway-agent-runs/<run-id>/`: coordinator token, pinned base, issue/token/worker/worktree/branch mapping, statuses, PRs and handoffs. Keep tokens local, out of public issue comments. A worker receives only its issue token. Post one concise ownership comment per dispatched issue with run ID, worker identity, branch and base; update assignment according to tracker conventions.

Completion: every dispatched issue has one atomic claim, one isolated worktree, a complete assignment and current readiness evidence.

## Dispatch and supervise

Use [worker.md](references/worker.md) as the assignment template. Include the issue body and acceptance criteria inline, plus any decision from comments that changes them. Include prerequisite **contracts**, not just links. Spawn workers only after reservation succeeds. If delegation is unavailable, keep the same ownership protocol and run sequentially; do not pretend independent workers exist.

Workers share the tool process's default directory in some harnesses. Every shell command must set its assigned workdir or use `git -C`; patches use absolute paths under that worktree. A branch name in a prompt does not isolate a checkout.

Workers implement and test, then commit only their issue and return a structured handoff. They do not choose new issues, spawn implementation/review agents, update other workers' branches, merge, close issues, or take over stalled work. The coordinator owns tracker lifecycle and integration. This managed mode supersedes `implement`'s default worker-side review/commit ordering: worker commits are review candidates; final acceptance comes after coordinator review.

If a worker needs another resource or shared API change, it first requests a reservation expansion. On conflict, stop edits to that resource and replan the wave; do not quietly fix the other issue. Other workers may continue in their independent scopes. Unexpected changes outside the assignment are evidence to stop and report, never a reason to reset, stash or delete someone else's work.

## Review and integrate serially

1. Require the worker's exact HEAD SHA, clean/dirty state, changed files, acceptance evidence and known failures. Verify the SHA and diff in its assigned worktree; a success message alone is insufficient. Keep the issue claim while review or a PR is pending.
2. Schedule review when agent capacity exists. The existing two-axis `code-review` needs two review slots; drain implementation workers before invoking it if necessary. Supply the issue specification, pinned base, reviewed HEAD and explicit worktree to both read-only reviewers. They review that worktree, not the coordinator's cwd. Fix findings through the same owner/worktree and rerun affected checks.
3. Use one integration owner and one candidate at a time. Revalidate against the current target tip; if it advanced, update the candidate in its own worktree, inspect conflicts and retest. Recheck acceptance after integration-related edits. Different-file changes can still break shared behavior.
4. Within existing authorization, push the issue branch and create/update a draft PR with test evidence and `Closes #<issue>`. Do not close the issue when implementation finishes. Merge only when the user/repository workflow already authorizes it and required review/checks pass. Otherwise leave the PR and claim in `ready`, without asking again for previously granted authority.
5. Verify the actual merged result before setting `integrated`, closing/releasing the claim, or making dependents eligible. Reconcile branch deletion/PR failure without losing the worktree. Remove worktrees/branches only when clean, integrated, no active worker uses them, and removal is authorized; keeping them is safe.

At batch end, stop all workers and capture their handoffs before releasing the coordinator. Preserve issue claims for pending PRs or blocked work. Report issue → worker → branch/worktree → PR/status, exact checks, remaining blockers and the next eligible frontier. Do not wait indefinitely for external review.

## Resume or interruption

Read the ledger and live claim registry before starting/resuming a worker. Verify the current branch, HEAD, worktree, PR and agent liveness. Send handoff messages with run ID, issue ID and HEAD so stale messages cannot overwrite a newer result. A new conversation must use the atomic `resume`/`adopt` transfer in coordination.md after the previous owners are proved stopped; directly reusing their saved tokens is not a resumption protocol. Losing a transfer race means stop, not fetch the winner's token and try again.

Claims do not expire automatically. A timeout, silence or an old timestamp is not permission to take over. For uncertain/crashed ownership, use the recovery procedure in coordination.md; preserve work and require proof of stopped ownership before reassignment. These are cooperative locks for one Git common directory, not a sandbox or a distributed lock across independent clones.
