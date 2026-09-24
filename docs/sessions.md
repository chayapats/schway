# Durable sessions and conversation branches

Sessions use append-only semantic JSONL under `~/.schway/sessions`. Each session has a conversation root, globally unique entry IDs, saved branch IDs and heads, and one active branch. `main` is the default branch. A branch head identifies a path through parent entries back to the root; sibling entries remain saved but never enter the selected branch's model context. Runtime events and dynamic environment, instruction, and skill bodies are not session records.

## Using branches

Start or resume an interactive session, complete a turn, then use:

```text
/branch list
/branch fork <entry-id-from-list> alternate approach
/branch switch main
/branch switch <branch-id-from-list>
```

`list` shows exact branch IDs, labels, heads, and recent complete-turn entry IDs. It also shows the session root ID, which forks an empty conversation. It displays up to 50 branches and 12 recent fork points per branch; the core API exposes all summaries and fork points. IDs are authoritative: labels and ID prefixes are never resolved as selectors. Labels may repeat.

Forking creates and selects a new independent head at the exact requested entry. Later messages advance only that branch. Switching selects an existing saved head. A valid nonempty fork point is a tool-free terminal assistant reply after a user message, or a compaction following that completion. An accepted tool call, a tool result without a terminal reply, and a summary in the middle of a turn are not complete-turn boundaries. Invalid IDs and boundaries leave the active branch unchanged.

Fork and switch require idle execution. While a model, tool, summary, extension command, attachment validation, or session replacement is active, wait for it to finish. After Esc, accepted tools must settle before branch changes become available. Branch changes clear volatile skill activation and rebuild the visible transcript from the selected ancestry.

Both startup modes accept the same selection:

```sh
schway --resume <session-id> --branch <branch-id>
schway --resume <session-id> --branch <branch-id> -p "Continue this approach"
```

`--branch` requires `--resume`. Without it, resume selects the saved active branch. Resume and switch never rerun saved tools: interrupted accepted calls receive explicit error results only on the destination ancestry. The same unresolved call ID on another branch remains unrelated. Repeated resumes do not add another result for a settled call.

Conversation branching does **not** undo file changes, create Git branches, or restore an earlier filesystem. Primary workspace identity and attached roots remain session-wide. Extensions remain enabled according to the current workspace's configuration.

## Browsing branches in the TUI

Open the interactive tree, then browse with stable IDs while the durable head stays put until confirmation:

```text
/branch tree
```

The header and status line always show the durable branch as `session <id> [branch <branch-id>]`. The tree shows parent/child entries with branch labels, `*` for the active head, `o` for other heads, `>` for the preview selection, and `[fork]` for complete-turn fork points. Previews are bounded to one line; the preview pane shows the last 8 transcript rows for the highlight without changing model context or persistence.

- `Up`/`Down` moves the preview highlight across branches and fork points.
- `Enter` switches when the highlight is a branch head, otherwise forks its complete turn (the input line becomes the optional new-branch name).
- `Esc` cancels a running turn first, otherwise closes the tree without changing branches.
- `/branch list | fork <entry-id> [name] | switch <branch-id>` still works for scripts and retains exact-ID selection.
- `/resume <session-id> [branch-id]` restores one saved branch; a missing branch reports an error and keeps the current session.

Previewing never persists: only `Enter`, `/branch fork`, and `/branch switch` change ancestry, and they rebuild the transcript from the selected path without replaying tools. Compaction markers render as `Context compacted: …` only on their own branch. While a turn is active, switching and forking refuse with `Busy: … Press Esc to cancel the turn first`; `Esc` still cancels explicitly, and the tree refreshes after the turn settles. Large histories render at most 200 nodes with root, heads, and selection pinned; the snapshot is cached while a turn streams so text deltas never rebuild a huge tree.

From a checkout with `bun install` completed, this example builds the same renderer-free snapshot the TUI renders, without a model or terminal:

```sh
bun --no-env-file --eval '
import { createSession } from "./src/session/session.ts";
import { buildBranchTreeSnapshot } from "./src/tui/controller.ts";

const session = createSession([
  { type: "user", id: "A", content: [{ type: "text", text: "Start" }] },
  { type: "assistant", id: "B", content: [{ type: "text", text: "Ready" }] },
]);
const alt = session.forkBranch("B", "alternate");
session.append(
  { type: "user", id: "C", content: [{ type: "text", text: "Try C" }] },
  { type: "assistant", id: "D", content: [{ type: "text", text: "C done" }] },
);
session.selectBranch("main");
const tree = buildBranchTreeSnapshot(session, "D");
console.log(tree.activeBranchId, tree.selectedId, tree.nodes.map(node => node.id).join(","));
console.log(tree.branches.map(branch => `${branch.active ? "*" : "-"}${branch.id}->${branch.headId}`).join(" "));
'
```

`buildBranchTreeSnapshot(session, selectedId?)` returns stable entry IDs, parent links, bounded previews, fork/head flags, and branch rows. `TuiController` wraps it with `openBranchTree()`, `moveBranchTreeSelection()`, `focusBranchTreeForkPoint()`, `focusBranchTreeBranch()`, `selectBranchTreeNode()`, `previewBranchTreeNode()`, `activateBranchTreeBranch()`, `forkBranchTreeNode()`, and `confirmBranchTreeSelection()`; previews never touch `ContextManager`, and activation uses `forkBranch`/`selectBranch` plus a transcript rebuild.

## Renderer-free source API

From a checkout with `bun install` completed, this example creates, saves, forks, and reloads a session without a model or TUI:

```sh
bun --no-env-file --eval '
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSession, loadJsonlSession } from "./src/session/jsonl.ts";

const directory = await mkdtemp(join(tmpdir(), "schway-branches-"));
try {
  const root = await realpath(process.cwd());
  const session = await createJsonlSession({ directory,
    workspace: { root, launchCwd: root, extraRoots: [] } });
  session.append(
    { type: "user", id: "A", content: [{ type: "text", text: "Start" }] },
    { type: "assistant", id: "B", content: [{ type: "text", text: "Ready" }] },
  );
  const alternate = session.forkBranch("B", "alternate");
  session.append(
    { type: "user", id: "C", content: [{ type: "text", text: "Try C" }] },
    { type: "assistant", id: "D", content: [{ type: "text", text: "C done" }] },
  );
  const resumed = await loadJsonlSession({ directory, id: session.header.id, branchId: "main" });
  console.log(resumed.items.map(item => item.id)); // A, B
  resumed.selectBranch(alternate);
  console.log(resumed.items.map(item => item.id)); // A, B, C, D
  console.log(resumed.listBranches());
} finally { await rm(directory, { recursive: true, force: true }); }
'
```

`src/session/session.ts` exports `Session` and `createSession` for memory-only use. `Session.items` is selected ancestry; `entries` contains all retained entries, including siblings. `rootId`, `activeBranchId`, `listBranches()`, `forkBranch(entryId, name?)`, and `selectBranch(branchId)` form the renderer-free branch interface. `SessionEntry`, `SessionBranch`, and `BranchSummary` are exported from `src/session/branches.ts`; summaries include `headId`, `active`, `entryCount`, and `forkPoints`.

`append(...records)` validates and persists an entire batch before publishing it in memory. Durable entry IDs must be unique across the entire session; provider tool-call IDs may repeat in later settled groups, but an unresolved group must be unambiguous. `acquireOperation()` returns an idempotent release function and prevents branch changes until release. The agent loop and compaction use this lease through cancellation and tool settlement. Custom asynchronous callers that own the selected ancestry should hold the same lease with `try/finally`.

## Format 3 and recovery

New sessions have a version 3 `session` header retaining the initial workspace, launch directory, and extra roots. Branch operations are versioned semantic records. Their entries wrap conversation data and its exact parent:

```json
{"type":"branch_append","version":1,"branchId":"main","entries":[{"parentId":"session-id","item":{"type":"user","id":"A","content":[{"type":"text","text":"Start"}]}},{"parentId":"A","item":{"type":"assistant","id":"B","content":[{"type":"text","text":"Ready"}]}}]}
{"type":"branch_fork","version":1,"branchId":"alternate-id","headId":"B","name":"alternate"}
{"type":"branch_select","version":1,"branchId":"main","settlements":[]}
```

One complete JSONL operation atomically changes entries and the relevant head. Fork creates and selects in one record. Select changes the active branch and appends any required interrupted-call settlements in one record. There is no separately written head that can point at a half-written entry batch.

The loader validates the complete graph, including inactive branches, before repair or settlement writes. It rejects duplicate IDs, missing parents, cycles, invalid heads, unmatched or repeated results, and invalid compaction references. A requested branch is also validated before any write. Corruption never silently redirects to another branch.

A syntactically incomplete or malformed final JSON line is treated as an interrupted write; recovery removes only that suffix and retains the preceding bytes. Malformed interior JSON and valid JSON with invalid semantic content are errors, including semantic corruption in the final line. If an append reports an I/O failure, that in-memory persisted handle refuses further writes: reload so the last complete operation can be recovered before continuing. These guarantees cover process interruption and append failure; session files are not a multi-process transaction store and should have one writer.

### Legacy migration

Formats 1 and 2, including a format 1 header followed by a format 2 upgrade, load as one default `main` branch at the validated linear tip. Reading a valid settled legacy session preserves its bytes. Its first conversation/branch mutation or interrupted-call settlement appends:

```json
{"type":"session_format","version":3}
```

New operations follow that marker; the original header and linear records remain recoverable byte for byte. A crash after the complete marker but before the operation keeps the previous graph; reopening uses format 3 without repeating the marker. Upgrades must increase the version. Repeated, downgraded, and unknown versions are errors. Older Schway builds do not understand upgraded files.

### Compaction and shared roots

Compaction derives its summary and retained conversation only from selected ancestry. `firstKeptId` must name an earlier user-turn boundary on that path and cannot rewind before the preceding retained boundary. `parentCompactionId` must identify that path's preceding compaction. A post-divergence summary cannot leak into a sibling, including after reload. A cancelled summarizer's late output is discarded.

Accepted attachments append independent metadata:

```json
{"type":"workspace_roots","version":1,"extraRoots":["/canonical/library"]}
```

This record has no entry ID or parent, advances no branch, and never becomes model conversation. The last metadata snapshot across the entire file supplies `Session.metadata.extraRoots`. The initial header remains unchanged. A format 1 session's first root-only change still appends `session_format` version 2 before the roots snapshot; it upgrades to version 3 later when branch data changes.

`setExtraRoots` writes before publishing metadata; repeated accepted lists are a no-op. Resume callers use current `session.metadata.extraRoots`, not initial `header.extraRoots`, and validate availability through `restoreWorkspace`. Missing roots remain saved while runtime context excludes them. See [workspaces](workspaces.md).
