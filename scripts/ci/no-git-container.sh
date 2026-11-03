#!/usr/bin/env bash
# Runs inside the oven/bun image for the checks workflow's no-git container job (#450). It records what exists
# as the container user sees it (after the host's chown), runs the whole suite in one process exactly as the
# #450 report did, then fails only if the run removed something it didn't create. Test results are reported
# and ignored: without git or network many tests fail by design.
#   no-git-container.sh <copy>   (NO_GIT_COPY_STATE must name a writable directory outside <copy>)
set -uo pipefail

copy=${1:?usage: no-git-container.sh <copy>}
ci=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
: "${NO_GIT_COPY_STATE:?NO_GIT_COPY_STATE must name a writable directory outside the copy}"
if command -v git >/dev/null 2>&1; then echo "git is on PATH; this job needs an image without it." >&2; exit 2; fi
echo "uid $(id -u), HOME=$HOME, TMPDIR=${TMPDIR:-unset}, bun $(bun --version), no git on PATH."
bash "$ci/no-git-copy.sh" record "$copy" || exit 2

cd "$copy" || exit 2
log="$NO_GIT_COPY_STATE/bun-test.log"
bun test -t "" > "$log" 2>&1
status=$?
echo "bun test exited with status $status; this job ignores test results and fails only on removals."
grep -E '^ *[0-9]+ (pass|fail|skip|todo)$|^Ran [0-9]+ tests' "$log" | tail -n 5

exec bash "$ci/no-git-copy.sh" verify "$copy"
