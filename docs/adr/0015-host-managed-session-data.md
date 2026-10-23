---
status: accepted
scope: ENG07 host managed session data
---

# Retire and delete owned native sessions without stale writers

ENG07 implements `schway.host.managed-session-data/v1` for FR-16/18 and NFR-02/05/08/10/12, refining the implemented ENG01/03/04/05/06 seams and S02 #393. It does not certify a production Jit bridge, backup purge, bulk CLI erasure, JSONL redaction, or remote provider copy erasure.

`HostSession.retire()` retires its idle handle and `HostRuntime.retireSession(reference)` retires an exact managed reference after the caller cancels, settles and closes open handles. Both require idle exclusive ownership, reject `busy` while a run is admitted or a handle is open, and write a validated tombstone under the configured store without rewriting native history. A retired context rejects later `openSession`, `submit`, `compact` and `readResult` with `closed`, so it cannot silently reopen through replay or a stale writer.

`HostRuntime.deleteSession(reference)` validates the UUID-shaped opaque reference, rejects traversal and malformed identities with `invalid-reference`, rejects symlink and hardlink aliases with a blocked `conflict` without deleting their targets, and rejects workspace-mismatched or unrelated global CLI sessions without touching them. An active or unknown writer yields a blocked `busy` or `conflict` status and deletes no partial state. A late already-admitted writer cannot recreate a deleted artifact or publish accepted output: the loop checks cancellation before durable publication and managed writes fence missing or replaced artifacts.

Deletion reuses the private `deleteJsonlSession` path for Schway-owned conversation, history, draft, undo, metadata and lease cleanup; it never exports a raw arbitrary-path remover and never rewrites native formats. It returns a sanitized `HostSessionDeletion` with `deleted`, `already-deleted`, `partial` or `blocked` status, the removed and remaining artifact inventory, and retry guidance. Partial never reports success. Missing and already-deleted references report `already-deleted` idempotently; retry after a partial failure is safe.

Jit owns authorization, memory and source lineage, deletion generations, backup retention and external copies. This API neither accepts model-issued deletion authority nor promises remote provider erasure. Native format migration stays outside Jit.

Evidence: `tests/host-managed-session-data.test.ts` (retire and delete happy paths, handle and runtime retirement, busy and unknown ownership, traversal and symlink sentinels, unrelated CLI preservation, injected metadata failure with partial status, already-deleted retry, delayed completion fencing, sidecar cleanup, sanitized status), existing `host`, `host-tool-policy`, `host-auth-routes`, `host-run-control`, `host-context-policy`, `host-durable-sessions` and CLI history, undo and sessions fixtures, `bun run typecheck` and full `bun test`. See [host contracts](../host.md) and [ENG07](https://github.com/chayapats/schway/issues/401).
