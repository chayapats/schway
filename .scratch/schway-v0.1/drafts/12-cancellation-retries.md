# 12: Cancel and retry runs without corrupting session state

## What to build

A developer can interrupt a running conversation and later resume it safely. Temporary provider failures recover with a bounded retry policy, while command or editing failures are returned to the model rather than automatically repeated. Scope: specification sections 8, 29–31, 36, 81, 89.

## Acceptance criteria

- [ ] One shared AbortSignal propagates from the CLI to model streaming, running tools, and applicable provider operations. Cancellation during backoff exits promptly and prevents another attempt.
- [ ] Schway retries transient network failures, rate limits, and temporary overloads with exponential backoff and provider Retry-After hints, allowing at most three total transient attempts.
- [ ] Authentication failures, malformed requests, invalid tool arguments, failed shell commands, and edit mismatches are not automatically retried.
- [ ] Interrupted/retried streams do not append duplicate durable assistant messages, execute partial tool calls, or replay completed side-effecting tools; runtime output makes abandoned attempts distinguishable.
- [ ] Graceful cancellation settles every accepted tool call exactly once, persists terminal results in source order, and leaves a resumable session. Abrupt termination remains recoverable through session loading.
- [ ] Exhausted retries and loop bounds end with clear errors/status and release provider streams and shell resources.
- [ ] Deterministic real-loop tests control time/backoff and inject failures before output, mid-stream, during tools, and during cancellation. Verify the attempt cap, Retry-After handling, no retry of ordinary tool failures, and cancellation followed by resume.

## Blocked by

- 04: Run shell commands with streaming bounded results.
- 07: Save and resume conversations from versioned JSONL.
