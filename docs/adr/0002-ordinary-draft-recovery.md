# Recover ordinary drafts separately from conversation history and credentials

The user approved storing ordinary unsent composer drafts locally per session so they can be recovered after reopening, with an explicit discard action. Draft checkpoints stay separate from accepted conversation turns and secure credentials; masked credential entry, OAuth callbacks, and sensitive authentication commands must never enter draft storage or prompt recall.

Keep only the latest checkpoint, remove it on accepted submission or explicit discard/session deletion, and do not create a hidden draft archive. This trades local retention of unfinished ordinary text for continuity while keeping authentication material outside that retention boundary; abrupt termination can recover only a completed checkpoint, not promise every keystroke was saved. These are accepted product decisions for the experience-polish implementation, not a claim that draft persistence already exists.
