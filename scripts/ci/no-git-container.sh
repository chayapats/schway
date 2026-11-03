#!/usr/bin/env bash
# Runs inside the oven/bun image for the checks workflow's no-git container job (#450). It records what exists
# as the container user sees it (after the host's chown), runs the whole suite in one process exactly as the
# #450 report did, then fails if the run removed something it didn't create, or if the run never reached its
# final summary for at least the expected number of files (a crash or an early exit would otherwise pass).
# Test failures are reported and ignored: without git or network many tests fail by design.
#   no-git-container.sh <copy>
#     NO_GIT_COPY_STATE: a writable directory outside <copy>
#     SCHWAY_EXPECTED_TEST_FILES: test files bun test should discover (tracked, outside dot-directories)
#   no-git-container.sh --check-summary <log> <expected-files>   check one bun test log, for tests
set -uo pipefail

# Exit non-zero unless the log's last summary line reports at least one test across >= the expected files.
check_summary() {
  local log=$1 expected=$2 summary
  if ! [[ $expected =~ ^[1-9][0-9]*$ ]]; then echo "Expected test-file count must be a positive integer, not '$expected'." >&2; return 2; fi
  summary=$(grep -E '^Ran [0-9]+ tests? across [0-9]+ files?\.' "$log" | tail -n 1)
  if ! [[ $summary =~ ^Ran\ ([0-9]+)\ tests?\ across\ ([0-9]+)\ files? ]]; then
    echo "::error title=The suite didn't finish::bun test printed no final summary, so it crashed or exited early; see $log."
    return 1
  fi
  local tests=${BASH_REMATCH[1]} files=${BASH_REMATCH[2]}
  if [ "$tests" -eq 0 ] || [ "$files" -lt "$expected" ]; then
    echo "::error title=The suite didn't run every file::bun test ran $tests tests across $files files; expected at least $expected files."
    return 1
  fi
  echo "bun test ran $tests tests across $files files (expected at least $expected)."
}

if [ "${1:-}" = --check-summary ]; then
  check_summary "${2:?usage: no-git-container.sh --check-summary <log> <expected-files>}" "${3:?usage: no-git-container.sh --check-summary <log> <expected-files>}"
  exit
fi

copy=${1:?usage: no-git-container.sh <copy>}
ci=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
: "${NO_GIT_COPY_STATE:?NO_GIT_COPY_STATE must name a writable directory outside the copy}"
: "${SCHWAY_EXPECTED_TEST_FILES:?SCHWAY_EXPECTED_TEST_FILES must give the number of test files bun test should discover}"
if command -v git >/dev/null 2>&1; then echo "git is on PATH; this job needs an image without it." >&2; exit 2; fi
echo "uid $(id -u), HOME=$HOME, TMPDIR=${TMPDIR:-unset}, bun $(bun --version), no git on PATH."
bash "$ci/no-git-copy.sh" record "$copy" || exit 2

cd "$copy" || exit 2
log="$NO_GIT_COPY_STATE/bun-test.log"
bun test -t "" > "$log" 2>&1
status=$?
echo "bun test exited with status $status; test failures are expected here and ignored."
grep -E '^ *[0-9]+ (pass|fail|skip|todo)$' "$log" | tail -n 4

removals=0
bash "$ci/no-git-copy.sh" verify "$copy" || removals=$?
summary=0
check_summary "$log" "$SCHWAY_EXPECTED_TEST_FILES" || summary=$?
if [ "$removals" -ne 0 ]; then exit "$removals"; fi
exit "$summary"
