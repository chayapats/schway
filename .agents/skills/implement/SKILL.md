---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Before editing a tracked issue, read `docs/agents/parallel-implementation.md` and establish ownership. Multiple issues/workers use the `implement-parallel` coordinator; do not run independent copies of this skill in the same checkout. A managed worker uses the assigned worktree, branch, claim token and write scope, with an explicit workdir for every command.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, use /code-review to review the work. In managed-worker mode, return the exact commit and verification handoff to the coordinator instead; the coordinator schedules review and owns PR/integration actions.

Commit only your work to the owned issue branch. In managed-worker mode, verify the claim and branch before committing; never switch or commit in the shared launch checkout. For untracked standalone work, preserve the user's intended branch and unrelated changes.
