# Pi parallel issue setup

Configuration captured on 2026-09-22 with Pi `0.86.1` and `pi-subagents` `0.70.1`. It uses the existing OpenRouter route `meta/muse-spark-1.3-contributor`, xhigh effort, and at most three independent issue workers. Authentication remains in the operator's Pi configuration; these templates contain no credentials.

## Install or reproduce

1. Install the tested extension with `pi install npm:pi-subagents@0.70.1`.
2. Install this repository's `.agents/skills/implement-parallel/` folder at `~/.codex/skills/implement-parallel/`, preserving its scripts and references. Compare and back up an existing personal installation before replacing it. The repo copy also supports project skill discovery.
3. Merge `settings.example.json` into `~/.pi/agent/settings.json`, preserving existing packages, skills, credentials configuration and unrelated preferences. The package list in the example is additive. Profile-specific effort overrides matter because builtin roles can set their own thinking level.
4. Merge `subagent-config.example.json` into `~/.pi/agent/extensions/subagent/config.json`. This caps children within one workflow; the skill's coordinator claim prevents competing Schway schedulers across sessions of the same clone.
5. Copy `schway-worker.md` and `schway-reviewer.md` into `~/.pi/agent/agents/`. Copy `schway-parallel.md` into `~/.pi/agent/prompts/`. Back up same-name local files before replacement. Expand `~` in the worker's `extensions` frontmatter to your absolute home path so extension resolution is unambiguous.
6. The worker uses `~/.pi/agent/extensions/safety-guard.ts`. Preserve an existing guard; the captured `safety-guard.ts` is available for a machine without it. Workers intentionally exclude git-checkpoint and UI extensions. Reviewers have no shell/edit/write tools.
7. Start a fresh Pi session in the repository. Run `/subagents-doctor` and `/subagents-models schway-worker` to check loading and model/effort routing.

Invoke `/schway-parallel` to select up to three eligible ready-for-agent issues, or append issue numbers to constrain the batch. `/subagents-fleet` shows live workers and their transcripts. The coordinator keeps claims and worktrees through review/PR handoff; worker completion is not issue integration. Full dispatch, review and recovery rules live in the skill's `references/pi.md`.

## Verification captured during setup

- Pi loaded the extension, project skills, personal coordinator skill and prompt template without extension errors.
- Effective worker and reviewer roles both inherited the selected Muse model with xhigh thinking and fresh context. Reviewer tools excluded shell, edits and writes.
- The installed extension accepted a three-child workflow with explicit per-child cwd and `worktree: false`.
- Three real Muse read-only children returned their distinct fixture contents from three temporary directories. Their runtime intervals overlapped by 5,231 ms; see `smoke-verification.json`. This smoke verified model access, tool use and concurrent background dispatch, not full issue implementation or code quality.
- Atomic ownership helper tests passed: 11 tests, 42 assertions. Skill validation passed.

The live smoke is separate from deterministic repository tests. Raw model transcripts, temporary session paths, personal settings backups and the one-off SDK harness remain local. No actual tracked issue was implemented by setup.
