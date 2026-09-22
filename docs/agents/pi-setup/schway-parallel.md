---
description: Implement ready Schway issues with three isolated workers and xhigh effort.
---

Use the implement-parallel skill at `~/.codex/skills/implement-parallel/SKILL.md`, including its Pi reference, to implement this batch in chayapats/schway: $@

Use one coordinator and up to three simultaneous issue workers with xhigh effort. If no issue numbers are supplied, select up to three currently eligible ready-for-agent issues after checking blockers and reserved resources. Each worker must have its own atomic claim, branch and worktree. Dispatch the eligible workers in parallel through pi-subagents. Keep issue implementation and GitHub lifecycle within the skill's authorization. This request authorizes the batch, its claims and progress comments; merge authority follows the user's existing instructions and repository rules.
