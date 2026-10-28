---
status: accepted
scope: SCH01 host core tools
---

# Export core tools over a host-pluggable execution backend

SCH01 implements `schway.host.core-tools/v1` for Jit S11 ([jit#123](https://github.com/chayapats/jit/issues/123)), consumed by the execution-box backend in [jit#127](https://github.com/chayapats/jit/issues/127). Jit runs agent shells and file edits in a disposable container. Without this contract it would either reimplement Schway's core tools and lose their tested bounds, or run them in its service process, which decision C18 forbids.

`schway/host` exports `coreToolDefinitions(backend, options?)`, an `ExecutionBackend` interface and `localExecutionBackend(workspaceRoot)`. The definitions are the CLI's `read`, `write`, `edit`, `bash`, `grep`, `find` and `ls`, built from the same factories, so schemas, descriptions, scheduling, effects and bounds cannot drift. Each tool reaches files and processes only through the backend: `realpath`, `stat`, streaming `readFile`, `observeFile` plus `writeFileAtomically` for fenced replacement, `writePrivateFile` for spill files, one-level `list`, `glob`, bounded `search` and `spawn`. Grep and find keep their own limits because `search` takes an explicit match `limit` and `glob` yields paths that Schway budgets. Failures carry Node-style codes so model-visible errors match the CLI; a stale observation is `ECHANGED`.

Schway owns everything model-facing. It resolves model paths against `backend.workspaceRoot`, applies output caps, code-point-safe cuts, truncation notices and spill files, and fences late results after cancellation. Host-built tools are confined. Lexical escapes are refused before any backend call. Symlink escapes are refused after `realpath` and before any read, write or spawn, resolving new paths through the deepest existing ancestor. `read` may also open Schway-named spill files in `temporaryDirectory` so the truncation notice stays actionable. The backend is trusted host code; confinement is a path check, not a sandbox.

The CLI keeps an unconfined local access path over the same local implementation, so absolute and out-of-workspace paths, attached roots and tmp spill reads behave as before. A golden recorded from the pre-refactor CLI tools proves byte-identical results for both the CLI registry and `coreToolDefinitions(localExecutionBackend(root))`. Nothing is admitted implicitly: the exact tool policy (ADR0012) still governs admission, hooks, approval and unknown tools.

`coreToolDefinitions` and `localExecutionBackend` load tool code on first call, so importing `schway/host` and enumerating capabilities still loads no tool, provider or TUI module. `hostCapabilities()` adds `coreToolsContract: "schway.host.core-tools/v1"`. The composed release contract becomes `schway.host.release/v2`, which is `release/v1` plus core-tools with every `release/v1` behavior unchanged (ADR0017).

Rejected: a depth-recursive `list(path, depth)` (Schway would lose the ls byte budget and permission-skip rules); passing unchecked model paths to the backend (path safety would depend on each backend); racing the backend promise against abort (a local process could outlive its settled call, breaking the run-control settle guarantee).

Evidence: `tests/host-core-tools.test.ts`, `tests/fixtures/core-tools-golden.json`, the packed core-tools consumer in `tests/host-release.test.ts`, existing tool, host and CLI tests, `bun run typecheck` and full `bun test`. See [host contracts](../host.md).
