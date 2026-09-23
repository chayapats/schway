---
name: to-tickets
description: Draft independently actionable local tickets from a specification.
disable-model-invocation: true
---

Read the specification supplied as an argument and inspect its target code. Use the requested local tracker directory (default `workflow/tickets/`) for Markdown tickets and an index. This invocation authorizes local drafting; external tracker or messaging writes require the user's separate explicit instruction.

Give each ticket a stable ID, goal, current behavior, expected behavior, relevant source paths and prerequisite contracts, bounded edit scope, acceptance criteria copied with their spec IDs, and exact verification steps. Include enough decisions and examples to implement a ticket without reconstructing earlier conversation. Record dependencies only where behavior actually requires another ticket. The index maps every spec criterion to a ticket and marks drafted work as pending implementation.

Completion means every in-scope criterion has an owner ticket and each ticket is actionable with its stated prerequisites. Include a proposed `/implement <ticket-path> <spec-path>` invocation for the next eligible ticket. The user selects and initiates implementation in a separate turn.
