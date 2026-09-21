# 08: Apply project instructions with scoped dynamic context

## What to build

Schway follows global, parent, repository, and nested project instructions while working in a repository, without loading unrelated subtrees into every prompt. A user can also replace or append to the base system prompt without disabling structural context. Scope: specification sections 10–13, 32–33, 81.

## Acceptance criteria

- [ ] Discover applicable global, parent-directory, root, and nested AGENTS.md instructions and assemble them from general to specific, with the deepest applicable instructions taking precedence.
- [ ] Discover nested scopes lazily when work enters a subtree; make newly applicable instructions available to the model before it proceeds with work governed by that scope.
- [ ] Scope selection uses canonical workspace/target paths and does not accidentally apply a sibling directory's instructions to an unrelated task.
- [ ] Keep environment and project instructions separate from durable conversation items; refresh dynamic context for subsequent model requests.
- [ ] Honor the specified user-global system replacement and append files while still assembling tool guidelines and applicable project instructions. Project-local system-prompt replacement is not introduced.
- [ ] Scripted-model tests inspect actual prepared requests for launches inside a Git subtree, parent precedence, lazy nested discovery, sibling isolation, missing optional instructions, and global prompt replacement/append behavior.

## Blocked by

- 02: Let the agent inspect files and continue from tool results.
