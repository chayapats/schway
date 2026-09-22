# Session format and contextual roots

Sessions use append-only semantic JSONL under `~/.schway/sessions`. Runtime events and dynamic environment/instruction/skill bodies are not session records. Resume reads saved state without replaying tool effects and settles interrupted accepted tool calls with explicit error results.

New sessions use format **2**. The first `session` record retains the initial primary workspace, launch directory and initial extra roots. Conversation records (`user`, `assistant`, `tool_result`, `compaction`) keep their IDs and `parentId` chain.

Accepted root changes append a separate, versioned metadata snapshot:

```json
{"type":"workspace_roots","version":1,"extraRoots":["/canonical/library"]}
```

This record has no `id` or `parentId`. It does not advance the conversation tip, appear in `Session.items`, affect compaction, or become a model message. The last metadata snapshot in the file supplies `Session.metadata.extraRoots`; the original header remains unchanged. This is session-wide state, independent of any conversation ancestry. Future branch readers must replay metadata from the entire file rather than only the selected conversation path.

Format **1** remains readable. Its first actual root change appends an upgrade marker followed by the metadata snapshot, preserving the original header and all prior records byte for byte:

```json
{"type":"session_format","version":2}
{"type":"workspace_roots","version":1,"extraRoots":["/canonical/library"]}
```

The upgrade marker does not advance ancestry either. A crash after the complete marker but before a complete roots snapshot leaves the prior roots active; the next accepted change appends roots without a second upgrade marker. A corrupt/truncated trailing record is repaired while retaining valid history. Unsupported header, upgrade, or metadata versions are errors and are never silently truncated. Use a current Schway build for files upgraded this way; older builds do not understand the new semantic records.

`setExtraRoots` writes before publishing the in-memory metadata. Repeating the same accepted list is a no-op. Resume callers must use current `session.metadata.extraRoots`, not `header.extraRoots`, and validate availability separately through `restoreWorkspace`. Missing roots remain saved while the usable runtime workspace excludes them. This lets the user restore a directory without losing its identity or changing the primary root.
