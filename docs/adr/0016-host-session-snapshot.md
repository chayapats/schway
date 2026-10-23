---
status: accepted
scope: ENG08 host session snapshot
---

# Quiesced snapshots and validated restore without Jit format imports

ENG08 implements `schway.host.session-snapshot/v1` for FR-16/18 and NFR-02/05/08/10/12, refining the implemented ENG01/03/04/05/06/07 seams and S02 #393. It does not certify a production Jit bridge, backup purge, cloud backup/encryption policy, provider credential export, or a general session filesystem API.

`HostRuntime.snapshotSessions(references, options?)` captures one coherent set only after the caller closes handles and settles admitted runs. It acquires one copy lease per session id, so an open same-process handle rejects `busy` and a foreign writer, abandoned gate or replaced alias rejects `busy` or `conflict` before any copy. It records retired tombstones by default and skips them with `excludeRetired` for deletion-ledger filtering. The manifest holds stable native refs and captured branch ancestry, the native format version, the snapshot contract version, and the owned conversation/metadata inventory with SHA-256 and sizes. It holds no credentials, store bodies, leases or unowned host files. A retirement that lands mid-copy is detected by re-verification and rejects `conflict`; no mixed-generation manifest reports success.

`HostRuntime.validateSessionSnapshot(snapshot)` checks shape, hashes, sizes and supported versions without touching the store. `HostRuntime.restoreSessionSnapshot(snapshot, options?)` restores into a fresh store with the matching workspace root, revalidates integrity, quarantines missing, corrupt, unsupported-version, incomplete, conflict and workspace-mismatch sets with safe diagnostics, and resumes one captured ancestry through `loadJsonlSession` validation and forward-only migration. Restore never overwrites an existing conversation or tombstone, never runs model calls or tools, and never auto-activates a quarantined set. Partial keeps coherent writes with restored and remaining refs. Retired snapshots restore their tombstones and stay closed unless `excludeRetired` filters them. History, draft and undo sidecars stay outside the snapshot; Jit coordinates them separately.

The host lease makes the native set coherent; Jit coordinates its own app DB, tombstones, deletion ledger and outbox generations. There is no distributed atomicity.

Evidence: `tests/host-session-snapshot.test.ts` (two-session quiesced snapshot, fresh-store restore and ancestry resume without tool replay, busy/conflict fencing, retired ledger filtering, quarantine for missing/corrupt/incompatible/incomplete sets, older-version migration, existing-target conflict, workspace mismatch, sanitized manifests), existing `host`, `host-tool-policy`, `host-auth-routes`, `host-run-control`, `host-context-policy`, `host-managed-session-data` and CLI history, undo and sessions fixtures, `bun run typecheck` and full `bun test`. See [host contracts](../host.md) and [ENG08](https://github.com/chayapats/schway/issues/402).
