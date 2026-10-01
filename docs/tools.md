# Tool output limits

## Read bounded output

Every core tool returns bounded model-facing output; oversized results are truncated with continuation guidance and never flood model context.

- `read`: ranged reads default to 2000 lines; model-facing text is capped at 50,000 characters with continuation info.
- `bash`: streaming stdout/stderr is capped at 50,000 characters; oversized output spills the full content to a temporary file and reports its path.
- `grep`: defaults to 100 matches; model-facing text is capped at 50,000 characters. Truncated searches say to narrow with `path`, `glob`, `maxResults`, or a more specific pattern.
- `find`: model-facing text is capped at 50,000 characters. Truncated listings say to narrow with a more specific pattern or path.
- `ls`: lists to depth 1 by default; model-facing text is capped at 50,000 characters.
- A non-zero `bash` exit code is ordinary command data (`{ stdout, stderr, exitCode }`), not infrastructure failure.
