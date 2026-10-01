# Contextual workspaces

The primary workspace is the nearest Git root, or the launch directory when no Git root exists. Both the primary root and launch directory are canonical real paths. Attaching another project preserves both identities.

## Workspace paths

Tool-relative paths resolve from the primary workspace root: the nearest Git root, otherwise the launch directory. Both are canonicalized through real paths (symlinks resolved) before use.

- `read`, `write`, `edit`, `grep`, `find`, and `ls` resolve `path` against the workspace root.
- `bash` defaults `cwd` to the workspace root; relative explicit `cwd` operands resolve there too.
- Launching from a nested subdirectory keeps the Git root as the workspace root; nested `AGENTS.md` files are still discovered when work enters that subtree.

Attach contextual projects with repeatable `--add-dir <directory>` flags, or `/add-dir <directory>` while idle. Operands resolve from the primary root and must identify accessible existing directories; symlink aliases and duplicate roots attach once. An invalid batch leaves roots unchanged. Relative tools and default bash cwd keep using the primary root; attachments are not filesystem permissions.

```sh
schway --add-dir ../library --add-dir ../service -p "/skills"
schway --resume <session-id> --add-dir ../library
```

Attached project instructions apply only after work enters their scope, and attached local skills share primary-local precedence (same-tier duplicates are explicit ambiguities). Roots appear in model environment context, interactive status, and `/config`. Attachments persist session-wide; unavailable saved directories are reported and excluded from usable context while keeping their saved identity. See [attach projects](#attach-projects) for scoping, recovery, public contracts, and a complete runnable example.

## Attach projects

Use repeatable `--add-dir <directory>` flags at startup, including with `--resume`, or `/add-dir <directory>` in an idle interactive session. Relative operands resolve from the **primary root**, even when Schway launched in a nested directory or a previous bash command changed directory. The TUI command treats its entire trailing argument as one path, so spaces do not need shell quotes; quote CLI arguments according to your shell.

```sh
mkdir -p /tmp/schway-primary /tmp/schway-library/.agents/skills/library-info
cat > /tmp/schway-library/AGENTS.md <<'EOF'
Use the library's public API when working in this project.
EOF
cat > /tmp/schway-library/.agents/skills/library-info/SKILL.md <<'EOF'
---
name: library-info
description: Explain the attached library's public API
---
Read this project's files before explaining its public API.
EOF
cd /tmp/schway-primary
schway --add-dir ../schway-library -p "/skills" # discovery only; no model call
schway --add-dir ../schway-library             # interactive session
```

Inside that interactive session, `/add-dir ../schway-library` is a harmless duplicate and `/config` shows the primary, launch, and attached root identities. The status line and each newly prepared environment section also show the usable roots. `/skills` lists attached skills and `/library-info` invokes one. Model requests can activate eligible attached skills using `activate_skill`.

All requested directories must exist, be accessible directories, and resolve through real paths. Aliases, duplicate operands, and the primary root attach only once. An invalid CLI batch or interactive request leaves the accepted root set unchanged. Interactive validation reserves the controller before its asynchronous work: prompts and competing operations cannot start mid-change. Esc cancels validation without publishing or persisting attachments.

Attachments contribute context, **not filesystem permissions**. Relative `read`, `write`, `edit`, `grep`, `find`, and `ls` paths still use the primary root. `bash` starts there unless given an explicit `cwd`; `cd` in one call cannot change the next call's default. Absolute tool paths may access attached or unattached locations subject to the operating system.

Instructions are scoped to active work. The first request of each user turn uses the launch directory's ancestor chain. After a path-bearing tool batch, the next request uses that batch's canonical `path`/`cwd` locations, including existing ancestors of a new file. Native directory defaults for bash/search/listing count as primary-root work. A newer path-bearing batch replaces the previous locations; old turns and sibling project rules do not accumulate. Global instructions precede applicable project and nested `AGENTS.md` files; nested discovery remains lazy. Instructions for an attached project appear after work first enters it, rather than upon attachment alone.

Primary and attached `.agents/skills` directories share the highest project-local tier. A name defined by distinct skill directories in that tier is explicitly ambiguous and cannot fall back to a lower tier. Remaining tiers retain their order: enabled primary-project packages, user-global local skills, then enabled global packages. Bodies and relative resources retain the skill's canonical source directory. Attaching a project does not enable its configuration, packages, or executable extensions. An extension command that later conflicts with an attached skill is refused with a diagnostic.

Accepted changes are durable session-wide metadata, separate from conversation ancestry; see [session format](sessions.md). Resume restores metadata before context preparation. Saved directories that are missing or inaccessible produce diagnostics and are excluded from usable instructions/skills, while their identities remain saved and visible in `/config`. Restore the directory and retry `/add-dir` (or `--add-dir` on resume) to use it again. The primary workspace identity stays unchanged. Root removal is not part of this interface.

Forking or switching conversation branches retains the same accepted root set. Root metadata is read from the whole session file, including changes made while another branch was active; it is never copied into a branch's ancestry. New format 3 sessions and legacy format 1/2 upgrades retain this behavior. Branch changes also preserve the current executable extension runtime and do not undo files in any root.

The core `addWorkspaceRoots(workspace, directories, signal?)` returns a validated copy without mutating its input. `restoreWorkspace(workspace)` returns usable roots plus diagnostics, leaving the supplied saved root list intact. `Session.metadata.extraRoots` stores accepted identities; `Session.setExtraRoots(roots)` persists metadata without adding model-facing records. Callers must validate roots before persisting them and bind the context manager and tools to the same active workspace.

Test coverage for this guide: [release verification](release-verification.md#workspaces).
