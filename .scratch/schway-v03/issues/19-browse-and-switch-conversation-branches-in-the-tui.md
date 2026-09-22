# #51: Browse and switch conversation branches in the TUI

GitHub: https://github.com/chayapats/schway/issues/51

<!-- schway-roadmap:v03:19 -->

**Milestone:** v0.3
**Planning baseline:** revision `875055e`, package `0.1.0`. Inspect current code before implementation to reuse subsequently landed work. This issue contains its own product requirements and prerequisite contracts; other issue discussions are not required context.

## What to build

Users visually browse the session tree, inspect branch previews, fork at valid turns and switch paths while seeing the active branch clearly.

## Existing behavior and problem

The branch prerequisite provides renderer-free list/fork/select operations, persisted branch/head identity, ancestry reconstruction and minimal commands. Forking occurs at complete-turn boundaries; it changes conversation ancestry only and never reverses filesystem effects. Build a usable interactive tree on those operations.

## Prerequisite contract

Consumes a tree/branch summary containing stable IDs, parent relations, previews/record references and active head, plus fork/select operations that validate complete turns and reconstruct compaction correctly. Those are the required outputs of the branch prerequisite.

## Required behavior and decisions

1. Render the current session's parent/child conversation tree with branch labels/IDs, active head and bounded previews. Use stable IDs for selection even when labels or preview text match.

2. Support keyboard navigation between branches and eligible fork points, preview before switching, activation of a branch and forking from the selected complete-turn point. Preserve minimal textual branch commands.

3. Show the current branch in session/status information and rebuild the transcript from its selected ancestry. Render compaction markers clearly without blending hidden raw history into another branch.

4. Keep tree selection/scroll state separate from durable active head until the user confirms switching. Previewing a node must not change model context or persist a new branch.

5. Reject switch/fork while a turn is active with a clear busy indication; cancellation remains the existing explicit action. Refresh the tree after settled turns and successful branch operations.

6. Restore the active branch after restart/resume. Missing/corrupt branch targets report errors and leave the previous valid branch usable; never silently choose the newest unrelated head.

7. Use bounded/lazy rendering for large histories and avoid recomputing an entire huge tree on every text delta. Keep controller/state logic independent of OpenTUI.

## Scope boundary

Session-tree presentation and interaction. No persistence redesign, Git branch management or filesystem restoration.

## Implementation constraints

- Use Bun and TypeScript. Run `bun run typecheck`; run `bun test` for behavior changes. Deterministic checks use scripted models, protocol fixtures and temporary filesystems rather than paid APIs.
- Schway owns the loop, session engine, context/compaction and tool scheduling. Provider SDKs are protocol clients with automatic retries disabled; core contracts use native conversation types.
- Keep core independent of OpenTUI and provider wire types. Headless execution must not load the TUI; only selected providers and explicitly enabled executable extensions load.
- Resolve tool-relative paths from the canonical primary workspace root (nearest Git root, otherwise launch cwd). Keep runtime events separate from durable semantic session records.
- Document newly exported functions/types with a one-line TSDoc contract. Preserve bounded model-facing output, exactly one result per accepted call and existing credential redaction.

## Verification scenarios

| Scenario | Observable result |
| --- | --- |
| Navigation | Controller moves, previews, selects and forks with stable identities. |
| Branch isolation | Transcripts and prepared model context match the chosen ancestry, including a compacted branch. |
| No replay/rollback | Switching does not rerun a side-effecting tool or revert its file changes. |
| Busy/error state | Active run, invalid target and failed load preserve the previous branch. |
| Resume/scale | Selection survives reload and large fixture trees render bounded visible content; use at most focused stable layout checks. |

## Acceptance criteria

- [ ] Render navigable parent/child relationships and active head with useful bounded previews; retain existing session listing/resume.
- [ ] Drive the established branch operations from keyboard controls, including branching from complete-turn boundaries.
- [ ] Rebuild transcript, workspace context and compaction state for the selected branch without replaying tools.
- [ ] Handle busy turns, missing/corrupt records and cancellation actionably without losing either branch.
- [ ] Controller tests cover divergent histories, compacted branches and resumed sessions; use only a small stable layout smoke check if needed.
- [ ] All required behavior and verification scenarios above are covered, including failure/cancellation cases relevant to this slice.
- [ ] User-facing commands/configuration and public contracts introduced by this issue are documented with a runnable example where applicable.

## Completion evidence

Report the implemented user path, relevant checks with observed results, and any remaining limitations. A fixture success does not count as live-provider or human dogfood evidence. Label any required external evidence not run as pending. Do not mark a required failed or pending acceptance item as passed.

## Blocked by

- #43: Fork and resume branches within durable sessions
