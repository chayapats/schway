# Parallel issue ownership

For implementing tracked issues, use `.agents/skills/implement-parallel/SKILL.md`. A personal installation at `~/.codex/skills/implement-parallel/SKILL.md` is also supported. A single-issue run uses the same protocol with one worker. If the skill/helper is unavailable, do not claim that ownership is protected; restore the skill before concurrent implementation.

For Pi installation, the three-worker/xhigh configuration and role templates are in [pi-setup/README.md](pi-setup/README.md). Setup does not claim or implement issues.

This repo's agents may share a launch checkout and a GitHub account. Assigning an issue to `@me`, seeing `ready-for-agent`, or choosing a branch name does not establish exclusive ownership.

- Reserve through the skill's atomic registry in the canonical Git common directory before editing. Honor existing issue/PR ownership even if the GitHub account matches yours.
- Use one issue per worker, one unique branch/worktree per issue, and explicit workdirs/absolute patch paths. Keep the user's launch checkout unchanged.
- Reserve expected write paths and shared contracts before dispatch. GitHub blockers determine prerequisite readiness; overlapping writes/contracts determine whether ready work can run together.
- A managed worker reports to its coordinator and never selects a second issue, takes over another worker, merges, closes issues or releases claims. The coordinator verifies evidence and integrates serially within the user's existing authorization.
- Preserve claims while PRs are pending. Stale timestamps do not transfer ownership. Follow the skill's stopped-owner recovery procedure before a takeover.

These rules apply when implementation starts, not while merely planning tickets or editing the coordination skills themselves. The full commands, handoff and recovery rules have one source of truth in `implement-parallel`.
