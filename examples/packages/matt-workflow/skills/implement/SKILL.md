---
name: implement
description: Implement a selected local ticket and record observed verification.
disable-model-invocation: true
---

Read the ticket and specification paths supplied as arguments, any supplied review artifact, applicable repository instructions, and current source/tests. Check the ticket's prerequisite behavior in the checkout. For a review follow-up, check each failed or pending finding against the current source, address valid findings within the ticket's edit scope, and record the disposition and verification evidence. Keep findings requiring other work or unavailable evidence pending. Missing or contradictory inputs block dependent edits: record the precise gap and request corrected artifacts in a new `/implement` invocation.

Implement the selected ticket within its edit scope. Use the repository's test commands to establish the relevant current behavior and verify the changed behavior. Capture actual command exit codes and meaningful output; a model's claim is not test evidence. Keep the tracker local unless the user separately requests external writes.

Write an implementation record beside the ticket with changed paths, spec criterion IDs, verification commands/results, and passed/failed/pending status for each criterion. A failure or cancellation leaves completed edits intact and unverified criteria pending; on resume inspect files and rerun affected checks before claiming completion. Do not advance to review automatically.

Completion means the requested behavior is implemented and every required check has an observed result, with blockers reported honestly. Include `/code-review <ticket-path> <spec-path> <implementation-record-path>` as a proposed next user invocation. Commits, publication, and merges follow the user's repository workflow and authorization, not this package's stage order.
