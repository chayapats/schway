# 06: Execute parallel-safe tools around exclusive barriers

## What to build

When the model requests several tools, independent reads can run together while mutations form barriers. The model receives a complete, predictable sequence of results even when operations finish out of order or one fails. Scope: specification sections 29–30, 81.

## Acceptance criteria

- [ ] Consecutive parallel-safe calls execute concurrently with a default maximum of 10 running calls.
- [ ] An exclusive call waits for earlier calls, runs alone, and completes before subsequent calls begin. The scheduler uses each tool's declaration rather than a hard-coded tool-name list.
- [ ] Model-facing and durable-history results retain source call order; runtime completion events may reflect actual completion order.
- [ ] Every accepted call produces exactly one success, error, or cancelled result. One failure cannot discard sibling results or prevent necessary cleanup.
- [ ] Cancellation stops scheduling new work and settles queued and running calls appropriately.
- [ ] Real-loop tests use controllable tools to verify overlap, the concurrency cap, exclusive barriers, source-order results, sibling failures, and cancellation without timing-sensitive sleep assertions. A read/write/read scenario verifies mutations are visible only after the barrier.

## Blocked by

- 03: Create files and apply exact atomic edits.
