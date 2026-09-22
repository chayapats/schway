---
name: to-spec
description: Turn resolved decisions into a verifiable coding specification.
disable-model-invocation: true
---

Read the decisions artifact and relevant source documents supplied as arguments. Check that scope-changing questions are resolved. If inputs are absent, contradictory, or still require the user's answer, report the exact gap and wait for a fresh invocation with corrected inputs.

Write the requested specification (default `workflow/spec.md`). Preserve the task, decisions with source references, observable before/after examples, constraints, exclusions, and independently numbered acceptance criteria. Give each criterion a feasible verification command or inspection, and describe failure behavior where applicable. Explicitly identify any verification needing credentials or human judgment as pending rather than proven.

Completion means every resolved decision affecting behavior maps to a criterion, with unresolved items visible. Include `/to-tickets <spec-path> <local-tracker-directory>` as the proposed next user invocation in the artifact and final response. End this stage after writing the specification; the next role requires its own explicit turn.
