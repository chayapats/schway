# Tool output limits

## Read bounded output

Every core tool returns bounded model-facing output; oversized results are truncated with continuation guidance and never flood model context.

- `read`: ranged reads default to 2000 lines; model-facing text is capped at 50,000 characters with continuation info.
- `bash`: streaming stdout/stderr is capped at 50,000 characters; oversized output spills the full content to a temporary file and reports its path.
- `grep`: defaults to 100 matches; model-facing text is capped at 50,000 characters. Truncated searches say to narrow with `path`, `glob`, `maxResults`, or a more specific pattern.
- `find`: model-facing text is capped at 50,000 characters. Truncated listings say to narrow with a more specific pattern or path.
- `ls`: lists to depth 1 by default; model-facing text is capped at 50,000 characters.
- A non-zero `bash` exit code is ordinary command data (`{ stdout, stderr, exitCode }`), not infrastructure failure.

## File permissions

`edit` and replacement `write` preserve an existing regular file's ordinary POSIX
permission bits (`mode & 0777`), including executable and private modes, even under
a restrictive umask. New files keep the usual `0666 & ~umask` creation defaults.
Replacement files are created exclusively with `0600` or stricter permissions
inside an owner-only staging directory beside the destination. The final mode is
applied only after the content is complete and before rename. The directory keeps
completed bytes inaccessible to other local users until publication, including
when final validation rejects a replacement with a readable final mode.
Its ordinary permissions are `0700`; inherited directory setgid is retained so
new files keep the parent directory's group inheritance.
Cancellation or failure before publication leaves the destination intact and
attempts to remove the owned temporary file and empty staging directory. Cleanup
does not recursively delete unexpected entries. If cleanup fails or the process
is killed, remaining staged bytes stay behind the private directory.

The destination's identity, mutation metadata and permissions are rechecked just
before publication; reads used by edit are also checked against their original
bytes. Observable saves, chmods and replacements cause the operation to fail.
This check and rename are separate filesystem operations, not a kernel-level
compare-and-swap. Path resolution and existing symlink behavior are unchanged.
`write` still replaces dangling symlinks and non-directory special entries such
as FIFOs or sockets using fresh-file defaults; it observes the link entry
separately from any existing target. Nonregular reads used by `edit` retain their
single-read behavior and revalidate metadata instead of consuming the stream again.

Windows does not provide the ordinary POSIX permission model: permission metadata
is omitted, final POSIX chmod is skipped, and native creation/access rules apply.
Other platforms rely on their filesystem's POSIX mode support; a failed chmod
aborts publication instead of silently weakening permissions. ACLs, ownership,
extended attributes and setuid/setgid/sticky restoration are outside this behavior.
