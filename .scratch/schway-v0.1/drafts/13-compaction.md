# 13: Continue long coding sessions with durable compaction

## What to build

Schway preserves the useful state of a long coding session as context fills, continues from a structured summary plus recent turns, and reconstructs the same effective context after resume. Scope: specification sections 16, 41–44, 81, 89.

## Acceptance criteria

- [ ] ContextManager initiates compaction from model-aware token pressure and exposes a manual-compaction operation for presentation clients; compaction is not implemented inside the agent loop.
- [ ] Compact oldest complete turns, keep recent complete turns, and prune oversized tool output only from summarization input. Never split a tool-call/result group or delete original history.
- [ ] The summary retains goal, constraints, progress, key decisions, current state, next steps, and read/modified files in a coding-oriented structure.
- [ ] Append a durable compaction record with identity, parent linkage, summary, and the first retained record; subsequent requests and resumed sessions use the summary plus retained records.
- [ ] An actual provider context-overflow error forces compaction and retries the original operation once. Repeated overflow terminates clearly rather than looping; this is distinct from transient transport retries.
- [ ] Failed/cancelled summarization leaves prior usable context and history intact and does not append a misleading successful compaction record.
- [ ] Scripted-model real-loop tests cover pressure-triggered and manually invoked compaction, unknown-model budgets, failed summarization, one-shot overflow recovery, repeated compaction, complete-turn boundaries, preservation of raw history, and equivalent reconstruction after resume.

## Blocked by

- 11: Select providers and models with validated basic configuration.
- 12: Cancel and retry runs without corrupting session state.
