#!/usr/bin/env bash
# Runs inside the oven/bun image for the checks workflow's no-git container job (#450). It records what exists
# as the container user sees it (after the host's chown), runs the whole suite in one process exactly as the
# #450 report did, then fails if the run removed something it didn't create, or if the run didn't finish:
# a signal, an unexpected exit status, or a last output line other than bun's summary for at least one test
# across at least the expected number of files. Test failures (exit status 1) are reported and ignored:
# without git or network many tests fail by design.
#   no-git-container.sh <copy>
#     NO_GIT_COPY_STATE: a writable directory outside <copy>
#     SCHWAY_EXPECTED_TEST_FILES: test files bun test should discover (tracked, outside dot-directories)
#   no-git-container.sh --check-summary <log> <expected-files> <bun-exit-status>   check one run, for tests
set -uo pipefail

artifact="the no-git-container-log artifact"

# Exit non-zero unless bun exited 0 or 1 and its last non-empty output line reports at least one test across at
# least the expected number of files. Anything printed after the summary, such as a crash, fails the check.
check_summary() {
  local log=$1 expected=$2 status=$3 last
  if ! [[ $expected =~ ^[1-9][0-9]*$ ]]; then echo "Expected test-file count must be a positive integer, not '$expected'." >&2; return 2; fi
  if ! [[ $status =~ ^[0-9]+$ ]]; then echo "bun's exit status must be a number, not '$status'." >&2; return 2; fi
  if [ "$status" -gt 128 ]; then
    echo "::error title=The suite didn't finish::bun test was killed by signal $((status - 128)); see $artifact."
    return 1
  fi
  if [ "$status" -gt 1 ]; then
    echo "::error title=The suite didn't finish::bun test exited with status $status rather than 0 or 1; see $artifact."
    return 1
  fi
  last=$(sed $'s/\x1b\\[[0-9;]*[A-Za-z]//g' "$log" | grep -v '^[[:space:]]*$' | tail -n 1)
  if ! [[ $last =~ ^Ran\ ([0-9]+)\ tests?\ across\ ([0-9]+)\ files?\. ]]; then
    echo "::error title=The suite didn't finish::bun test's last output line isn't its final summary, so it crashed or exited early; see $artifact."
    return 1
  fi
  local tests=${BASH_REMATCH[1]} files=${BASH_REMATCH[2]}
  if [ "$tests" -eq 0 ] || [ "$files" -lt "$expected" ]; then
    echo "::error title=The suite didn't run every file::bun test ran $tests tests across $files files; expected at least $expected files. See $artifact."
    return 1
  fi
  echo "bun test ran $tests tests across $files files (expected at least $expected)."
}

if [ "${1:-}" = --check-summary ]; then
  usage="usage: no-git-container.sh --check-summary <log> <expected-files> <bun-exit-status>"
  check_summary "${2:?$usage}" "${3:?$usage}" "${4:?$usage}"
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
echo "bun test exited with status $status; test failures (status 1) are expected here and ignored."
grep -E '^ *[0-9]+ (pass|fail|skip|todo)$' "$log" | tail -n 4

removals=0
bash "$ci/no-git-copy.sh" verify "$copy" || removals=$?
summary=0
check_summary "$log" "$SCHWAY_EXPECTED_TEST_FILES" "$status" || summary=$?
if [ "$removals" -ne 0 ]; then exit "$removals"; fi
exit "$summary"
