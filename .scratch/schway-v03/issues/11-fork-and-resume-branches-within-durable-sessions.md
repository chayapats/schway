# #43: Fork and resume branches within durable sessions

GitHub: https://github.com/chayapats/schway/issues/43

<!-- schway-roadmap:v03:11 -->

**Milestone:** v0.2
**Planning baseline:** revision `875055e`, package `0.1.0`. Inspect current code before implementation to reuse subsequently landed work. This issue contains its own product requirements and prerequisite contracts; other issue discussions are not required context.

## What to build

Users fork a saved conversation at a complete-turn boundary and continue either path through headless branch selection and a minimal interactive command. Scope: sections 37–39, 41–44, 81, 90.

## Existing behavior and problem

The current JSONL writer adds entry IDs and parent IDs but the loader exposes one linear list of records. Compaction uses that list plus durable summary/first-kept references. Parent links alone are not a working branch feature. This ticket introduces selection/reconstruction and a minimal user path before a graphical tree.

## Prerequisite contract

No new feature blocker. Existing native records, versioned JSONL, context preparation and compaction are available. Export renderer-free branch operations and summaries for a later tree controller.

## Required behavior and decisions

1. Represent branch identity, active head and parent ancestry separately from all stored records. Context preparation consumes only the selected branch's valid ancestry; storage retains sibling records.

2. Expose /branch list, /branch fork <entry-id> [name], /branch switch <branch-id>, and deterministic headless selection with --resume <session-id> --branch <branch-id>. Document IDs as authoritative and optional names as labels.

3. A fork point must be a complete user-turn boundary with all accepted tool calls settled, or the empty conversation root. Reject partial assistant/tool groups, invalid IDs and ambiguous references without changing the active branch.

4. Fork/select is permitted only while idle. Forking creates an independent head at the selected point and selects it; switching selects an existing head. Later appends advance only that branch.

5. Persist branch/head changes as semantic versioned records with crash-safe recovery. Load v0.1 linear sessions as one default branch. If a newer format is needed, use a separate version-specific loader/migration and preserve the original recoverable history.

6. Reconstruct compaction only from the selected ancestry. firstKeptId and prior-compaction references must resolve on that path. A summary created after divergence on branch A is never used by branch B.

7. Validate duplicate IDs, missing parents, cycles, invalid heads and unmatched tool/result groups. A malformed trailing write may be recovered deliberately; corrupt interior ancestry must not silently fall back to a different branch.

8. Resume never reruns durable tools. Settle interrupted calls on the selected ancestry without marking calls on unrelated branches completed. Session-wide workspace attachments remain session-wide; they are not copied into each branch.

## Scope boundary

Branch primitives, persistence and minimal commands/flags. No rich tree renderer, Git branch creation or filesystem rollback; conversation branching does not undo previous file changes.

## Implementation constraints

- Use Bun and TypeScript. Run `bun run typecheck`; run `bun test` for behavior changes. Deterministic checks use scripted models, protocol fixtures and temporary filesystems rather than paid APIs.
- Schway owns the loop, session engine, context/compaction and tool scheduling. Provider SDKs are protocol clients with automatic retries disabled; core contracts use native conversation types.
- Keep core independent of OpenTUI and provider wire types. Headless execution must not load the TUI; only selected providers and explicitly enabled executable extensions load.
- Resolve tool-relative paths from the canonical primary workspace root (nearest Git root, otherwise launch cwd). Keep runtime events separate from durable semantic session records.
- Document newly exported functions/types with a one-line TSDoc contract. Preserve bounded model-facing output, exactly one result per accepted call and existing credential redaction.

## Verification scenarios

| Scenario | Observable result |
| --- | --- |
| Divergence | Fork from common A/B into C and X; scripted model requests contain only the selected ancestry. |
| Compaction | Compact C, switch to X, then reload both: C's summary never enters X. |
| Side effects | A non-idempotent tool runs once before fork and is not replayed by switch/resume. |
| Compatibility | A v0.1 fixture loads as one branch with identical effective conversation. |
| Recovery | Invalid fork boundary, missing parent, cycle, interrupted head append and unresolved call have explicit tested outcomes. |

## Acceptance criteria

- [ ] Represent active branch/head explicitly and reconstruct the selected ancestry from entry IDs and parent IDs while preserving sibling history.
- [ ] Provide a minimal user-facing fork/select operation and deterministic headless resume selection; block switching during unsettled work or cancel/settle it explicitly.
- [ ] Fork only valid boundaries so no selected path contains unmatched tool calls; never replay old tool side effects.
- [ ] Compaction records and first-kept references apply only to valid ancestry; branching before/after compaction must not leak another branch's summary.
- [ ] Load existing v0.1 linear sessions deliberately; handle duplicate IDs, cycles, missing parents, interruption and unsupported versions with actionable outcomes.
- [ ] Real-loop persistence tests create divergent file-reading conversations, compact one branch, reload both and prove independent model contexts. Rich tree UI is outside this slice; the branch operations must expose summaries that a later tree can consume.
- [ ] All required behavior and verification scenarios above are covered, including failure/cancellation cases relevant to this slice.
- [ ] User-facing commands/configuration and public contracts introduced by this issue are documented with a runnable example where applicable.

## Completion evidence

Report the implemented user path, relevant checks with observed results, and any remaining limitations. A fixture success does not count as live-provider or human dogfood evidence. Label any required external evidence not run as pending. Do not mark a required failed or pending acceptance item as passed.

## Blocked by

None (can start immediately).
