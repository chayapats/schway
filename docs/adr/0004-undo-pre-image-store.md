# Store file pre-images for turn undo

Users need to undo a turn's file changes without losing later work. The 0.6 milestone will add a user-local, content-addressed pre-image store keyed by session and accepted turn, because current Git snapshots hold hashes only, `write` does not record prior content, and tool details are not persisted. This is an accepted decision that is not yet implemented.

Before `edit` or `write` changes a file, capture its prior content or the fact that it did not exist. After the change, record the resulting content hash. A user-invoked `/undo` previews the changes and restores a file, or deletes a file created by the turn, only when its current content matches the recorded post-turn hash. Otherwise skip the file, show the difference, and never overwrite it. Undo never runs automatically.

Only file changes made by `edit` and `write` are undoable. Changes made by shell commands are not. Where Git is available, flag shell changes from a per-turn status capture; without Git, report that detection as unavailable.

Undo never changes conversation branches or history. Append a durable record marking the undo and telling the model which files were reverted. This requires a session schema version bump with forward migration. Accepted turns remain accepted turns, consistent with [ADR 0002](0002-ordinary-draft-recovery.md); an undo does not recreate a composer draft.

Keep pre-images per session and delete them with the session. Prune oldest first above 30 days or 500 MB total, with both limits configurable.
