---
status: accepted
scope: ENG06 host run control
---

# Bound, cancel and settle embedded runs with honest terminal outcomes

ENG06 implements `schway.host.run-control/v1` for FR-07/14/15/18 and NFR-02/05/06/10, refining the implemented ENG01/03/04/05 seams and S02 #393. It does not certify a production Jit bridge, OS-level kill, a sandbox, Jit queue leasing or subscription cost estimates.

Host `limits` gain finite `deadlineMs` (1–86,400,000, default 300,000) and `maxAttempts` (1–10, default 3) alongside the existing round, concurrency, window and input bounds; malformed, non-integer or unlimited values fail admission before any session or model call. The deadline covers model rounds, transport retry backoff, overflow recovery and compaction waits. `submit`, `submitWithRoute` and `compact` accept `AbortSignal | HostRunOptions` with an injectable `HostClock` and a transient `onProgress` observer whose failures or detachment never duplicate or complete a run.

Terminal outcomes distinguish `completed`, `error`, `cancelled`, `max_turns` and `limit_exceeded`, carry the selected route/session/run references, the selected model identity and durable output references only when committed, plus honest `HostRunUsage` (null-preserving, per-attempt/compaction, completeness flags) and sanitized `HostRunError` diagnostics preserving the effective context/tool policy. Route-bound runs add safe `auth` readiness and `observedInference: "observed"` only on committed completion; a model-transport completion is never a Jit task/job success claim.

Cancellation precedence is explicit: pre-acceptance aborts reject `invalid-input` without durable input, while post-acceptance aborts, session `cancel()` or deadline expiry settle cooperative work as `cancelled`/`limit_exceeded` without a late result. The loop checks cancellation before durable publication and the host maps raced completions away from `completed`; session `cancel()` is repeat-safe and idle-safe, while `close()` stays idle-only (`busy` while admitted) and releases the exclusive lease after settlement. Noncooperative synchronous extension code stays outside hard-preemption guarantees. Schway adds no competing durable job scheduler; Jit owns queue priority and attempt generations.

Evidence: `tests/host-run-control.test.ts` (limits, deadline during backoff with real and manual clocks, cancel before/after input persistence, delayed provider completion, cooperative tools, transient progress, honest usage, policy-preserving failures, busy/cancel/close precedence), existing `host`, `host-tool-policy`, `host-auth-routes`, `agent-retry`, `headless-retry` and `turn-telemetry` fixtures, `bun run typecheck` and full `bun test`. See [host contracts](../host.md) and [ENG06](https://github.com/chayapats/schway/issues/400).
