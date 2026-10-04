# Durable sessions and conversation branches

Sessions use append-only semantic JSONL under `~/.schway/sessions`. Each session has a conversation root, globally unique entry IDs, saved branch IDs and heads, and one active branch. `main` is the default branch. A branch head identifies a path through parent entries back to the root; sibling entries remain saved but never enter the selected branch's model context. Runtime events and dynamic environment, instruction, and skill bodies are not session records.

## Sessions: save, branch, and resume

Headless and interactive runs persist versioned JSONL sessions under
`~/.schway/sessions`. Config files are never created automatically, but accepted
work is saved so it can resume. A session restores conversation and workspace
history; current flags and config choose credentials, the model and billing.
Headless tasks intentionally ignore the TUI's remembered model choice.

This **POSIX shell** flow assumes you saved an OpenAI API key through interactive
`/login openai`, then returned to your project shell. It explicitly selects
API-key billing, even if a ChatGPT subscription is also saved. Each `read` waits
for you to paste an exact ID and press Enter; placeholders are not catalog results.
For ChatGPT/Codex, xAI, Grok or a compatible endpoint, use the separate
[complete route flows](headless.md#choose-your-route-run-and-resume).

<!-- headless-flow:sessions -->
```sh
schway models list --provider openai --openai-auth api-key
# Paste an exact model ID returned above, then press Enter.
IFS= read -r MODEL_ID
schway -p "Start the migration" --provider openai --openai-auth api-key --model "$MODEL_ID" --approval read-only --show-session
schway sessions list
# Paste the exact Session hint ID or its matching saved-work row.
IFS= read -r SESSION_ID
schway -p "Continue the migration" --provider openai --openai-auth api-key --model "$MODEL_ID" --resume="$SESSION_ID" --approval read-only --show-session
```

Keep the same intended route when continuing; resume never switches to old
credentials or restores an earlier billing preference. A flag-light alternative
requires the [explicit saved config](headless.md#use-explicit-saved-settings)
shown in the headless guide. CLI flags override project and user config. See
[credentials](credentials.md), [configuration](configuration.md), and the
[README handoff](../README.md#run-a-headless-task) for setup. If no model is
configured, list the intended route, choose an exact ID, and retry with `--model`;
[doctor](doctor.md) checks local readiness with that model, not live access.

Use `/branch list` to obtain exact branch IDs, entry IDs, and the empty conversation root ID. While idle, `/branch fork <entry-id> [name]` creates and selects an independent head at a complete user-turn boundary; `/branch switch <branch-id>` selects an existing head. Names are labels, so duplicate names are allowed and cannot select a branch. Each new reply advances only the selected branch. Branching changes conversation context; it does not undo file changes. Workspace attachments stay shared across branches.

Resume rebuilds only the selected ancestry without replaying tool effects. Omit `--branch` to restore the saved active branch; `--branch` requires `--resume`. Interrupted accepted calls receive error results only on the selected ancestry. A syntactically torn final JSON write is repaired while preserving the preceding bytes; valid JSON with invalid ancestry or records is an error, even at the end of the file.

New files use format 4 with atomic branch operations containing semantic `user`, `assistant`, `tool_result`, `compaction`, and `turn_undo` entries. Formats 1 and 2 load as one `main` branch and gain an append-only upgrade marker when branch data changes. Runtime-only deltas (`model.delta`, `tool.delta`) are never persisted. See [renderer-free source API](#renderer-free-source-api) and [format 4 and recovery](#format-4-and-recovery) for runnable examples, compaction isolation, and recovery details.

Text mode writes model text to stdout. Opt-in `--show-session` writes one exact
resume hint to stderr after the task session is persisted and ready, including
when a later model/tool failure or cancellation occurs. Pre-ready setup failure,
unpersisted sessions and `/skills` produce no hint. An ID containing an observed
credential, terminal/format controls or line/paragraph separators produces no
text hint; it is never rewritten into a different token. Unquoted resume hints
accept only Unicode letters, marks, numbers, pictographic emoji and `._-`, with
no leading `-`. Use the JSONL workflow below to capture other exact IDs as data.

`--json` already streams normalized runtime events as JSONL on stdout, including
`session.ready` with the exact `sessionId`; diagnostics stay on stderr. Its
existing encoding and secret-suppression rule are unchanged. Do not combine
`--show-session` with `--json`, omit `-p`, or add it to doctor/version/list commands.
Use the [complete-stream JSONL extraction example](headless.md#output-and-session-ids)
to capture an exact ID safely. Model and session listings each emit one JSON
object, not runtime JSONL. Runtime events and durable session records are
different concepts: the first is transient observability, the second is resumable
state. See [task input and recovery](headless.md#task-input-and-recovery) for
nonempty `-p` tasks, redirected input/output and immediate headless `ask` denial.

## Starting new work or resuming

An ordinary interactive launch starts fresh and offers **Alt+B** to restore the
latest meaningful session in this canonical workspace. `/sessions` retains access
to other workspaces and damaged histories. Explicit `--resume` / `--branch` choose
the destination directly. Restoration displays the workspace, active conversation
branch and current effective connection; history does not restore old credentials
or billing settings and never replays tools.

Untouched interactive conversations are held in memory: startup, `/new`, and
opening/dismissing history navigation do not leave empty JSONL files. The first
durable mutation writes the header together with that operation before changing
in-memory history. Existing saved files and the default session API remain durable;
headless behavior is unchanged. A failed write fences the handle until reload as
before. Missing or corrupt suggested history leaves the new-task editor usable and
never silently selects a substitute.

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

Both startup modes accept the same selection. In the same POSIX shell as the
OpenAI API-key flow above, retain `MODEL_ID` and `SESSION_ID`. Copy an exact
conversation branch ID from interactive `/branch list`: run
`IFS= read -r BRANCH_ID`, paste that ID and press Enter. It is not a Git branch
name or a shortened ID. To continue with a headless task:

<!-- headless-flow:sessions-branch -->
```sh
schway --provider openai --openai-auth api-key --model "$MODEL_ID" --resume="$SESSION_ID" --branch "$BRANCH_ID" -p "Continue this approach" --approval read-only --show-session
```

To open that same branch interactively in a terminal instead:

```sh
schway --provider openai --openai-auth api-key --model "$MODEL_ID" --resume="$SESSION_ID" --branch "$BRANCH_ID"
```

`--branch` requires `--resume`. Without it, resume selects the saved active branch. Resume and switch never rerun saved tools: interrupted accepted calls receive explicit error results only on the destination ancestry. The same unresolved call ID on another branch remains unrelated. Repeated resumes do not add another result for a settled call.

Conversation branching does **not** undo file changes, create Git branches, or restore an earlier filesystem. Primary workspace identity and attached roots remain session-wide. Extensions remain enabled according to the current workspace's configuration.

## Browsing branches in the TUI

Open `/branch tree` to preview conversation history. Opening it never changes the durable active path.

The browser starts in **Continue existing** mode. `●` marks the active path and `›` the preview selection. Labels and bounded task previews identify paths; numbered rows distinguish duplicate labels, even when they share one head. Selection uses the underlying stable branch ID. The list pages around the highlight, including paths beyond the first page.

- `Up`/`Down` previews existing paths without activation.
- `Tab` changes to **New fork at complete turn**; arrows browse complete turns. Type an optional human name, then `Enter` creates and selects a new branch, even if that turn already heads an existing branch. `Tab` returns to existing paths.
- `Enter` in Continue existing mode selects that exact path. Successful confirmation returns to the conversation and restores the ordinary draft.
- `Esc` closes preview and restores the draft, cursor and reading position. It does not cancel a running turn while the browser is open; close the browser first to cancel the turn.
- Files/Git remain unchanged is shown beside confirmation controls, including at narrow widths. This browser changes conversation ancestry, never file contents or Git branches.
- Busy or failed confirmation keeps the previous ancestry and saved draft.
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

## Format 4 and recovery

New sessions have a version 4 `session` header retaining the initial workspace, launch directory, and extra roots. Branch operations are versioned semantic records. Their entries wrap conversation data and its exact parent:

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

### Durable turn undo

A `turn_undo` entry appends the outcome of `/undo` to the active conversation
branch. It preserves earlier entries and records display paths, file actions,
skipped reasons, and the exact note supplied to the next model request:

```json
{"type":"turn_undo","id":"undo-id","turnId":"user-record-id","turnNumber":7,"reverted":[{"path":"clamp.ts","action":"restored"},{"path":"src/new.ts","action":"deleted"}],"skipped":[{"path":"README.md","reason":"changed"}],"note":"The user undid your file changes from the previous turn: clamp.ts, src/new.ts. README.md was not reverted because it changed afterwards."}
```

This payload sits inside a normal `branch_append` operation. Reverted actions
are `restored` or `deleted`; skipped reasons are `changed` or `failed`. The model
receives the note as a user message at its original position, while compaction
treats it as part of the preceding accepted turn. Resume displays the saved undo
result without replaying file operations.

Existing format 1–3 files keep their original bytes. Ordinary format-3 operations
need no marker. The first operation containing a `turn_undo` writes this marker
once, immediately before that operation:

```json
{"type":"session_format","version":4}
```

Headers and original records remain unchanged. Readers accept header versions
1–4 and increasing transitions to 2, 3 or 4; undo entries require format 4.

The private pre-image store is `<home>/.schway/undo/<session-id>/`, with raw bytes
in `blobs/<sha256>` and a first-change-ordered manifest for each accepted user
record in `turns/<turn-id>.json`. File tools capture original bytes before
execution and record the settled hash afterwards, including failed or cancelled
calls that changed a file. Recovery of the same accepted turn joins its existing
manifest. Undo reads this store on restart and leaves manifests unchanged.

New version-1 manifests also store optional `beforeMode` and `afterMode` integer
permissions (`0` through `0777`) beside each content hash. Repeated changes keep
the first pre-image and its mode, and the latest settled post-image and mode.
Undo restores original bytes and supported ordinary permissions together. Complete
restore files stay inside an owner-only staging directory on the destination's
filesystem until final validation and atomic rename, even when the recorded mode
allows other users to read the published file. Restore preparation uses the same
[POSIX parent checks as file tools](tools.md#file-permissions): an exposed shared
writable parent that lets another user replace staging paths is refused. Use a
directory protected from other users; shared writable descendants of a private
ancestor and sticky temporary directories remain supported. These checks use
ordinary POSIX path access and do not cover ACLs or trusted-owner namespace changes.
A later chmod is a conflict even
when the bytes still match, including for a newly
created file that undo would delete. Preview observations are checked again just
before restore or deletion, including the file's identity and permissions.

Legacy manifests remain readable without rewriting them. When the original mode
is absent, undo preserves the destination's current mode recorded at preview and
rejects mode drift after preview. Details explains that original permissions were
unavailable and chmod changes before preview cannot be verified. Missing,
nonregular and symlink destinations are skipped. Windows omits POSIX permission
metadata and restoration; native access rules apply, without a POSIX fidelity
guarantee. Undo blobs and manifests remain private (`0600` files and `0700`
directories) independently of workspace modes. As with file tools, final checks
and filesystem mutations are separate operations, not an atomic compare-and-swap.

### Compaction and shared roots

Compaction derives its summary and retained conversation only from selected ancestry. `firstKeptId` must name an earlier user-turn boundary on that path and cannot rewind before the preceding retained boundary. `parentCompactionId` must identify that path's preceding compaction. A post-divergence summary cannot leak into a sibling, including after reload. A cancelled summarizer's late output is discarded.

Accepted attachments append independent metadata:

```json
{"type":"workspace_roots","version":1,"extraRoots":["/canonical/library"]}
```

This record has no entry ID or parent, advances no branch, and never becomes model conversation. The last metadata snapshot across the entire file supplies `Session.metadata.extraRoots`. The initial header remains unchanged. A format 1 session's first root-only change still appends `session_format` version 2 before the roots snapshot; it upgrades to version 3 later when branch data changes.

`setExtraRoots` writes before publishing metadata; repeated accepted lists are a no-op. Resume callers use current `session.metadata.extraRoots`, not initial `header.extraRoots`, and validate availability through `restoreWorkspace`. Missing roots remain saved while runtime context excludes them. See [workspaces](workspaces.md).

## Turn history sidecar

Each accepted user turn records plain-data evidence beside its saved session in
`~/.schway/history/<session-id>.jsonl`. The directory is created with mode
`0700` and each file with `0600`. The sidecar is optional: it never enters model
context, the session JSONL and undo formats are unchanged, and a session without
one opens normally with its turns shown as `Details unavailable`. Interactive and
headless runs use the same renderer-free collector (`src/history/`).

The file is append-only. Its first line is a versioned header naming the session
root; later lines are attempt starts and revisioned outcomes:

```json
{"type":"history","version":1,"sessionId":"<session-id>","createdAt":"2026-01-15T09:30:00.000Z"}
{"type":"turn_start","version":1,"turnId":"<user-record-id>","attemptId":"<uuid>","ordinal":1,"branchId":"main","parentId":"<parent-entry-id>","workspaceRoot":"/abs/project","mode":"tui","startedAt":"…","task":"Fix the clamp upper bound"}
{"type":"turn_finalize","version":1,"turnId":"<user-record-id>","attemptId":"<uuid>","revision":1,"outcome":"completed","finishedAt":"…","activeMs":2400,"toolResults":2,"failedTools":0,"commands":{"total":1,"exitZero":1,"nonzero":0,"unknown":0,"truncated":false,"items":[{"id":"<digest>","command":"bun test","exitCode":0,"ended":"exit","status":"success"}]},"files":{"total":1,"truncated":false,"items":[{"path":"clamp.ts","source":"tool","added":1,"removed":1}]},"git":{"status":"captured"}}
```

- **Identity.** A turn is the accepted user record (`turnId`), which is unique
  across every branch. The start also stores that record's parent entry, the
  branch it ran on and the attempt's own workspace root, so a reader attaches
  evidence only to the exact record at its saved graph position on the selected
  ancestry. Evidence for other branches is ignored, never reattached.
- **Lifecycle.** The start is persisted before the attempt runs. Its outcome is
  appended once it settles: `completed`, `failed`, `stopped` or `limit`. A start
  without an outcome, for example after a crash or forced quit, reads as
  incomplete with unknown time; nothing is repaired or backfilled.
- **Idempotency.** Repeating identical evidence writes nothing; changed evidence
  for the same attempt gets the next `revision`, and the highest revision wins.
  Duplicate lines, repeated tool results for the same call and replayed starts
  never add turns or observations. Completed tools are never replayed to rebuild
  metadata.
- **Continuation.** Continuing the same accepted turn adds a new attempt. The
  timeline shows one row with the latest attempt's outcome, deduplicated files
  and commands, and the sum of known active durations; unknown durations stay
  explicit.
- **Evidence.** Files come from successful `edit` and `write` results and, when
  change tracking already captured before/after snapshots, from paths Git found
  changed (`source: "shell"`). Command exits come only from structured `bash`
  results, never from prose. Tracking `off`, non-Git workspaces, failed captures
  and headless runs (which take no snapshots) record `git` as unavailable with a
  reason; no Git process runs only to populate history. Undo outcomes are read
  from the session's `turn_undo` records.
- **Bounds.** Each record keeps at most 50 command summaries of 200 characters
  and 200 file rows; totals still count every observation and each shortened
  list sets `truncated`. Task excerpts keep at most 160 graphemes, cut only at
  grapheme boundaries; a grapheme stacking more than 32 code points (for
  example many combining marks) keeps only its base character, so a nonempty
  task never becomes empty. Every serialized line, including its LF, fits 128 KiB of
  UTF-8: item counts apply first, then whole trailing entries are omitted until
  the escaped JSON fits. A single path over 4096 bytes is omitted and counted.
  Identity fields are validated, never truncated. Readers use a bounded line
  reader and skip malformed, oversized or unknown lines; a header from a newer
  format makes the file unsupported rather than guessed at.
- **Privacy.** Terminal controls are stripped and known secrets redacted before
  bounding. Records keep no provider payloads, reasoning, credentials, full tool
  output or file contents. Slash commands and credential-like tasks store no
  excerpt.
- **Locking and deletion.** Appends and deletion share a cross-process lock at
  `~/.schway/history.lock`. A sidecar is created only while its saved session
  exists. Its header and first record are written to a temporary file, synced and
  hard-linked into place, so a failed creation never leaves a torn sidecar;
  appends retry short writes and report failure instead of a torn record.
  `/delete-session` takes the lock before clearing the draft, undo data, session
  file and evidence, so evidence is never recreated afterwards.
- **Failures.** A history write failure never blocks execution or changes the
  session-write rules. The conversation and tool results are saved as usual; the
  TUI shows `History not saved · /history shows gaps · F2 details` and headless
  runs print `History not saved · Check ~/.schway/history access (<reason>) · Task continues`
  on stderr. An outcome that cannot be appended leaves the attempt incomplete:
  its counts and time read as unknown, never as zero. If another process holds
  the history lock, `/delete-session` stops before deleting anything and shows
  `Session not deleted: history busy · /delete-session retry · F2 details`.

History follows the saved-session lifecycle. There is no separate retention timer
or automatic pruning; per-record bounds and 50-turn pages do not cap a session's
total history. Undo pruning removes pre-images only, so history then reports undo
as unavailable while its observations stay as recorded. Format changes are
forward-only and append-only.

## Compaction

Long sessions compact context instead of failing when pressure builds.

- Automatic pressure compaction triggers at 80% of the resolved context window and retains the 10 most recent complete turns plus the running summary.
- Context overflow (`context_length_exceeded` / `prompt-too-long`) forces one compaction and retries once; repeated overflow terminates with a clear error instead of looping.
- Compaction never splits a tool-call/result group: the retained window starts at a turn boundary.
- Oversized tool output is pruned only for summarization input; raw history keeps the full records.
- The summary plus retained records reconstruct identically after `--resume`.

Interactive `/compact` runs the same context manager's manual compaction path. Automatic pressure and overflow recovery also apply in headless and interactive runs.

## Discovery metadata

`/sessions` (Alt+S) provides searchable task/workspace discovery with explicit
all-workspace and recovery scope (Ctrl+W). It never deletes history. See
[the TUI guide](tui.md#recent-sessions) for paging and scan limits.

New committed `branch_append` operations carry an optional `committedAt` ISO time.
Readers that ignore unknown fields remain compatible with formats 1–4. Branch
selection, fork creation, metadata changes, interrupted-call settlement and
preview do not advance conversational activity. Historical timestamps are not
invented from filesystem modification times.

A replaceable `<id>.jsonl.meta` file caches only the last known committed activity
and a task preview of at most 160 characters. It is advisory: malformed or missing
cache data cannot reject an already committed append or make history unreadable.
Small histories recover metadata from validated JSONL; large histories display a
partial-preview state. Cache updates use same-directory temporary replacement;
JSONL remains the durable conversation authority. Recovery tools that enumerate
transcripts should select `.jsonl` files, not every file in the sessions directory.

## List saved work from the CLI

`schway sessions list` inspects saved work without opening the TUI or resuming a
session. It works with redirected input/output and needs no model or credentials.
Copy an exact listed ID into `SESSION_ID` in the
[complete run/resume flow](#sessions-save-branch-and-resume), retaining your
chosen model and route. Listing itself does not configure either one.

```bash
schway sessions list
schway sessions list --workspace ../project --limit 10 --offset 20
schway sessions list --all --preview --json
```

The command reads sessions from the process `HOME` under `.schway/sessions`.
Without `--all`, it filters to the launch directory's canonical primary workspace;
`--workspace` resolves an explicit directory with the same nearest-Git-root and
realpath rules. `--all` and `--workspace` conflict. Limit defaults to 20 and accepts
1–100; offset defaults to 0 and must be a nonnegative integer. A missing session
directory is an empty success. Missing/inaccessible `HOME`, inaccessible storage
and cancellation produce actionable stderr diagnostics. Unrelated provider,
task, authentication and mutation flags are rejected before storage is read.

Listing captures candidate names once, produces at most one row per exact
filename-derived ID, and inspects each history with at most 64 KiB of transcript
plus at most 2 KiB of activity metadata. It sorts the captured rows by valid
`activityAt`, falling back to valid `createdAt`, descending; unknown times come
last and exact IDs break ties in ascending order. Workspace filtering precedes
pagination over the whole set. Concurrent writes are not an atomic filesystem
snapshot: later invocations and offset pages can move as saved work changes.

Default output contains exact ID, time, workspace and observed state. `--preview`
adds a one-line task excerpt of at most 160 Unicode code points. It never displays
draft text or tool arguments/results. Sensitive command/callback/credential
patterns suppress the excerpt; explicitly known environment secrets are masked
in raw and trimmed forms and after display normalization. Arbitrary secrets are
not detected, so excerpts may still contain user-sensitive content. Sensitive or
control-bearing IDs are omitted with a partial-result warning; they are never
redacted into false resume tokens. Sensitive workspace paths are omitted from
rows and scope. Damaged headers with unknown workspaces remain visible with
`--all`.

`--json` writes one object with `schemaVersion: 1`, `scope: {workspace?, all}`,
`limit`, `offset`, `hasMore`, `status`, `sessions` and `warnings`. Each session row
has `id`, optional `createdAt`, `activityAt` and `workspaceRoot`, a `state`, and
`previewIncomplete`. The optional `preview` key appears only with `--preview`
and only when a safe excerpt is available. Machine states contain no TUI hints.

State precedence is: unreadable bytes (`unreadable`); corrupt or mismatched header
(`corrupt`); structurally valid unsupported format (`unsupported`); observed
known-format corruption (`corrupt`); incomplete validation window (`partial`);
observed interruption (`interrupted`); empty history with a valid present draft
(`draft`); empty history without one (`empty`); supported nonempty legacy history
(`legacy`); otherwise `ready`. A window ending inside an unfinished header is
`partial`, with no invented workspace or draft evidence. `previewIncomplete`
marks incomplete transcript validation; explicit resume validates the full file.
Draft and legacy status cannot conceal corruption, unsupported data or interruption.

The inventory's `status` is `complete`, `partial` or `error`. Exit 0 means the
captured inventory completed, including empty results and discoverable damaged
histories. A bounded `partial` history row alone does not make the inventory
partial. Exit 1 means an incomplete inventory, cancellation or operational error;
accessible completed rows remain available with warnings. Exit 2 means invalid
arguments and leaves stdout empty. Operational JSON remains parseable and stderr
carries diagnostics.

No listing operation loads config, environment files, provider credentials or
remembered TUI settings. It never invokes the resume loader, repairs or truncates
histories, settles interrupted calls, replays tools, switches branches, prunes
undo/drafts, or recovers stopped draft writers. Draft detection only inspects a
read-only checkpoint envelope, bounded to 4 MiB, and returns validity, identity
and present/cleared evidence. Inaccessible or unverifiable checkpoints produce a
warning rather than a claim that a recoverable draft exists. Checkpoint contents,
stale locks and recovery artifacts remain untouched.

## Unsent draft checkpoints

Interactive ordinary input checkpoints separately under `~/.schway/drafts` after
500 ms of idle typing. The first checkpoint materializes its session header, so a
conversation containing only an unsent draft can be reopened from **Alt+B** or
`/sessions`. Ordinary launch still starts a new conversation. Explicit resume
restores the draft in its original session without submitting it. **Alt+D** removes
the current draft; accepted submission removes the accepted text without clearing a
newer draft typed while the handoff was pending.

**Draft saved** confirms the current text. A newer edit removes that confirmation
until saving completes. **Draft restored** appears after the saved text is loaded
into the composer. Both notices offer **Alt+D discard**. If saving fails, the text
stays editable and **Draft not saved** asks you to select text and press **Ctrl+C**
to copy it. Failed discard retains the text and offers **Alt+D retry**; it does
not treat a newer unsaved edit as already saved.

Only the latest checkpoint is retained, with no automatic expiry or history archive.
A content-free generation marker remains after cleanup to prevent stale writers
from restoring deleted text. To delete a saved conversation and associated draft
content, switch away with `/new`, then run `/delete-session <exact-session-id>`.
Deleting the currently active session is rejected. Manually removing only a JSONL
file does not perform this draft cleanup; use the command.

Deleting a session with `/delete-session` removes its private undo directory after
clearing its draft and before deleting the conversation file. If undo removal
fails, the session file is kept. Age and size retention also clean undo storage
at startup; see [undo retention](configuration.md#undo-retention).

Checkpoints use private directories (0700), files (0600), exclusive writer locks,
and same-directory atomic replacement. Encoded checkpoints larger than 4 MiB are
rejected while the in-memory text and previous checkpoint remain available. Masked
credential input, OAuth callback entry, sensitive auth commands and known credentials
are excluded before any temporary write; all composer checkpointing pauses while a
credential surface is open. Other slash commands are not checkpointed as drafts.

Reopening removes a stopped writer's incomplete replacement only when its recorded
process is proved absent. Active, reused, unknown or malformed writer identities
remain locked and produce a save failure rather than silently taking ownership.
Unexpected symlink targets are rejected. Linux pins directory descriptors; portable
platforms check no-follow directory opens and inode identities immediately before
synchronous access. The portable check is not a sandbox against hostile same-user
filesystem races.

After abrupt termination only the latest completed checkpoint is recoverable, not
every keystroke. Ordinary exit freezes edits and attempts one current checkpoint in an isolated
writer with a 500 ms deadline, requests cancellation, and restores the terminal
without awaiting model/tool settlement. A slow writer is killed; an unconfirmed
replacement is never reported as saved. The writer compares the captured checkpoint
generation before changing storage, so shutdown cannot overwrite another process.
The exit message says **Draft saved.** only after confirmation. If saving fails or
times out, it warns that your latest text may not be saved. A resume command is
printed only when a durable session exists. Interrupted tools may already have changed files; resume
marks pending tool calls interrupted and never replays them or claims to undo them.

Test coverage for this guide: [release verification](release-verification.md#sessions).

See the [stability policy](stability.md) for compatibility promises.
