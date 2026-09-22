# Pi execution

Use this reference only in Pi with `pi-subagents`. The user default is three concurrent implementation workers, each at `xhigh`. The parent coordinator also defaults to `xhigh`. The configured `globalConcurrencyLimit` counts children inside a workflow, not the parent or independent Pi sessions. The coordinator claim provides the cross-session scheduling boundary.

## Preflight and assignment

1. Activate `subagents_enable` if the full `subagent` tool is absent. On the next tool turn, use `subagent` actions `list` with `capabilities: true` and `models` to verify `schway-worker` and `schway-reviewer`. Both inherit the parent's selected model and use `xhigh`. A missing profile, tool, provider or extension blocks dispatch; fix the same Pi setup rather than launching an unmanaged alternative.
2. Follow coordination.md to pin the base, reserve resources and create worktrees. These worktrees belong to this skill. Pass `worktree: false` to pi-subagents and each child's absolute assigned `cwd`. Pi must not create, capture or remove a second managed worktree. Leave claims/worktrees intact while review or PRs are pending.
3. Supply a complete worker.md assignment inline. Include the current managed-worker contract and implementation instructions even if their edits are not yet committed in the pinned base. Put ledger files and handoff artifacts under the canonical Git common directory's run directory. Avoid progress/context files in source trees. Give each child only its own issue token, never the coordinator token.

## Parallel dispatch

Use one top-level asynchronous `workflowScript` call for each wave. Launch the independent children through `runs.all`, with a distinct key and explicit cwd for each. Construct the script with JSON serialization of actual assignment data, not interpolated shell strings. Example shape (substitute real preflighted assignments):

```js
subagent({
  async: true,
  cwd: "/absolute/launch-checkout",
  worktree: false,
  globalConcurrencyLimit: 3,
  workflowScript: `
    const assignments = /* JSON array of {key, cwd, task} */;
    return await runs.all(assignments.map(item => ({
      key: item.key,
      agent: "schway-worker",
      cwd: item.cwd,
      task: item.task,
      context: "fresh",
      worktree: false
    })));
  `
});
```

Validate the completed script with `subagent({ action: "validate", workflowScript })` before launch. Do not set `async: true` on individual children inside `runs.all`: child promises must resolve to completed results, not launch receipts. Dispatch fewer than three only when readiness, ownership or resource conflicts prevent three independent assignments; report the exact reason.

Record the returned workflow/run IDs alongside claim identities in the private ledger. Use status, `bg_wait` and FleetView for live state. Answer `contact_supervisor` requests through `subagent_supervisor` after checking the claim/resource decision. Routine completion is the child's final handoff. An extension run status, timeout or released concurrency slot never transfers a claim or proves its subprocesses stopped.

## Review, integration and recovery

After worker handoffs, verify commits, dirty state, scope and tests in each assigned cwd. Schedule the repository's two-axis code-review with two `schway-reviewer` children at fresh context, both reading the same fixed candidate. Supply the complete diff/commit list, Standards brief with its smell baseline, and Spec brief with full acceptance criteria. These reviewers have no bash/edit/write tools; the coordinator runs Git/test commands and supplies their evidence. Drain the implementation wave before review so the three-child capacity covers both reviewers. Keep the candidate unchanged during review.

Send fixes to the owning worker/worktree through a retained child only if it is resumable and ownership still checks out. Otherwise follow the stopped-owner adoption protocol before dispatching a replacement. Preserve xhigh effort and the selected model; provider errors are blockers, not permission to switch models. Integrate one candidate at a time using the main skill.

The Schway worker loads only safety-guard; git-checkpoint and UI extensions stay in the parent. A noninteractive safety block is reported to the coordinator. Keep worker tools and read-only reviewer tools distinct. For restart, read coordination.md: a new Pi session must transfer claims atomically after stopped-owner evidence, rather than treating the saved run ID as authority.

## Operator commands

- `/schway-parallel` selects up to three eligible issues; append issue numbers to constrain the batch.
- `/skill:implement-parallel` invokes the full skill directly.
- `/subagents-fleet` inspects active workers; `/subagents-models` inspects effective model/effort routing; `/subagents-doctor` checks setup.

Restart Pi or use `/reload` after changing profiles, skills or settings. User settings live at `~/.pi/agent/settings.json`; concurrency/worktree defaults live at `~/.pi/agent/extensions/subagent/config.json`. Loading this reference or configuring Pi does not itself start issue work.
