---
name: grill-with-docs
description: Resolve a coding task's decisions against repository evidence.
disable-model-invocation: true
---

Read the task, repository documents, and any prior decisions artifact named in the invocation. Inspect the relevant behavior before questioning assumptions. Ask about unresolved choices that change observable acceptance, constraints, or scope; identify the repository evidence behind each question.

Write the requested decisions artifact (default `workflow/decisions.md`) with the task, source paths, questions, the user's answers, resolved decisions, and remaining questions. Label proposed defaults as unresolved until the user accepts them. If an answer is missing, ask for it and stop this stage; on the next turn the user invokes `/grill-with-docs <decisions-path> <answers>` again.

Completion means each acceptance-changing question has a recorded answer or an explicit user decision to defer it. Distinguish that from merely asking questions. Include a proposed next invocation `/to-spec <decisions-path> <spec-output-path>` in the artifact and final response. The user initiates that separate turn; each invocation activates only the current role.
