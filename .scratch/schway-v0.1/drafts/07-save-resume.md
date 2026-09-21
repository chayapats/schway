# 07: Save and resume conversations from versioned JSONL

## What to build

A developer can stop Schway, select a saved session, and continue a conversation with its previous tool results and workspace identity intact. Durable history remains human-inspectable and distinct from runtime streaming events. Scope: specification sections 9, 11, 30, 36–40, 71, 81, 94.

## Acceptance criteria

- [ ] Sessions are append-oriented, per-session JSONL in Schway's canonical user session storage, with a versioned header containing session identity, creation time, workspace root, launch directory, and extra-roots metadata.
- [ ] Semantic messages and tool results are durable; runtime deltas and repeatedly assembled dynamic context are not appended as conversation history.
- [ ] Entries have stable identifiers and parent identifiers sufficient for the current linear history; loaders are version-specific and unsupported versions fail with an actionable error. Branch creation/navigation is deferred beyond v0.1.
- [ ] A headless resume option loads a selected session and continues with reconstructed native conversation, preserved opaque provider metadata, and the saved workspace identity.
- [ ] Loading an interrupted session detects unresolved durable tool calls and settles them explicitly without blindly rerunning side-effecting tools. A malformed or partial trailing record is handled deliberately without silently destroying valid history.
- [ ] Save/resume tests use the real loop and temporary storage to prove continuation after file tools, version validation, metadata round trips, interrupted writes, unresolved calls, and exclusion of runtime deltas/dynamic context.

## Blocked by

- 02: Let the agent inspect files and continue from tool results.
