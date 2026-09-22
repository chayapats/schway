---
name: code-review
description: Compare implemented behavior with a ticket and its specification.
disable-model-invocation: true
---

Read the ticket, specification, and implementation record supplied as arguments. Inspect actual changed files and applicable repository standards; verify the relevant behavior using tests or reproducible commands. Treat the implementation record as a claim to check against observations.

Write the requested review artifact (default `workflow/review.md`) with two assessments: specification conformance for each acceptance ID, and compliance with repository standards. Each finding needs an affected path, concrete trigger, expected versus observed behavior, and severity. Record command results and explicitly separate passed, failed, and pending criteria. Missing inputs, failed commands, credentials, or human review are limitations, never implied passes.

Review is read-only apart from its report and local tracker evidence. Completion means every criterion has an observed disposition or a precise pending reason. If changes are required, propose a new `/implement <ticket-path> <spec-path> <review-path>` turn; otherwise report the verified outcome. The user decides any next stage, commit, or publication. Each later turn explicitly reactivates its chosen skill.
