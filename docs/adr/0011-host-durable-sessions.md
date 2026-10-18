---
status: accepted
scope: ENG04 native durable sessions
---

# Keep durable host ownership and recovery in Schway

`schway.host.durable-sessions/v1` gives each canonical native session one local-process writer lease, held from create/open through idle close across all its conversation branches. Admission and stale-owner recovery share an exclusive filesystem gate; recovery requires the same machine identity and positive stopped-process evidence (`ESRCH`), while uncertain ownership remains busy. This permits independent specialist sessions and ordinary crash/reopen without a native FFI dependency or time-based lease theft; an abandoned admission gate deliberately requires operator recovery, and cross-machine/PID-namespace stores and concurrent CLI/deep-import writers are outside the supported boundary.

Managed native appends flush before publishing history; exact artifact bytes/identity and ownership are checked before writes, requests and tool admission. A run captures branch ancestry and effective model/context/tool/limit configuration, while adapter requests and records are detached from durable state. Results identify committed native entries; failed writes return no provisional answer, and native reopen validates formats, repairs torn tails and settles interrupted calls without replaying effects. No JSONL format change or transaction with Jit application state is introduced; ENG02's current context restrictions still apply on reopen. See [host contracts](../host.md) and `tests/host-durable-sessions.test.ts` for the supported boundary and failure evidence.
