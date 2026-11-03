#!/usr/bin/env bash
# Runs tests from a copy of the checkout without .git and proves they removed nothing they didn't create (#450).
#   no-git-copy.sh copy <copy>     copy the checkout, minus .git, to <copy>; refuses an existing <copy>
#   no-git-copy.sh record <copy>   plant sentinels and record what exists now
#   no-git-copy.sh prepare <copy>  copy, then record
#   no-git-copy.sh verify <copy>   fail when anything recorded has disappeared or a sentinel changed
# Record after any ownership change (chown), and in the same filesystem view as the tests: the recorded set
# depends on who owns what. Verify only checks that each recorded path still exists, whoever owns it now.
#
# What is recorded:
#   - every path in <copy>, except below <copy>/node_modules, where only the top-level entries are listed;
#   - the top-level entries this user owns in <copy>'s parent directory (the OS temp directory in CI), since
#     other users' services create and remove their own entries there;
#   - the top-level entries in $HOME;
#   - sentinel files in the parent directory, in $HOME and in <copy>.
# Limits: removal below depth 1 in node_modules, the parent directory or $HOME goes unnoticed, and so does an
# entry that is removed and then recreated, even empty, at a recorded path. Tests may add files freely.
# Paths are NUL-delimited, so names with newlines are handled. State lives in $NO_GIT_COPY_STATE, defaulting to
# $RUNNER_TEMP/no-git-copy-state.
set -euo pipefail

action=${1:?usage: no-git-copy.sh copy|record|prepare|verify <copy>}
copy=${2:?usage: no-git-copy.sh copy|record|prepare|verify <copy>}
case $copy in /*) ;; *) echo "The copy path must be absolute: $copy" >&2; exit 2 ;; esac
parent=$(dirname "$copy")
state=${NO_GIT_COPY_STATE:-${RUNNER_TEMP:-$parent}/no-git-copy-state}
sentinels=("$parent/schway-no-git-sentinel/nested/keep" "$HOME/.schway-no-git-sentinel/keep" "$copy/.schway-no-git-sentinel")

copy_checkout() {
  local checkout
  checkout=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
  if [ -e "$copy" ]; then echo "$copy already exists; refusing to reuse it." >&2; exit 1; fi
  mkdir -p "$copy"
  tar -C "$checkout" --exclude=./.git -cf - . | tar -C "$copy" -xf -
  echo "Copied $checkout to $copy without .git."
}

record() {
  mkdir -p "$state"
  for sentinel in "${sentinels[@]}"; do mkdir -p "$(dirname "$sentinel")"; echo keep > "$sentinel"; done
  {
    find "$copy" -mindepth 1 -path "$copy/node_modules/*" -prune -o -print0
    if [ -d "$copy/node_modules" ]; then find "$copy/node_modules" -mindepth 1 -maxdepth 1 -print0; fi
    find "$parent" -mindepth 1 -maxdepth 1 -user "$(id -u)" -print0
    find "$HOME" -mindepth 1 -maxdepth 1 -print0
    printf '%s\0' "$copy" "${sentinels[@]}"
  } | sort -zu > "$state/before"
  echo "Recorded $(tr -cd '\0' < "$state/before" | wc -c | tr -d ' ') paths as uid $(id -u) with HOME=$HOME."
}

verify() {
  local missing=() changed=() path count
  if [ ! -s "$state/before" ]; then echo "No record at $state/before; run record first." >&2; exit 2; fi
  while IFS= read -r -d '' path; do
    [ -e "$path" ] || [ -L "$path" ] || missing+=("$path")
  done < "$state/before"
  for sentinel in "${sentinels[@]}"; do
    if [ -e "$sentinel" ] && [ "$(cat "$sentinel")" != keep ]; then changed+=("$sentinel"); fi
  done
  count=$(tr -cd '\0' < "$state/before" | wc -c | tr -d ' ')
  if [ "${#missing[@]}" -gt 0 ] || [ "${#changed[@]}" -gt 0 ]; then
    echo "::error title=Tests removed paths they didn't create::${#missing[@]} recorded paths disappeared and ${#changed[@]} sentinels changed; see the log."
    if [ "${#missing[@]}" -gt 0 ]; then
      echo "These paths existed before the tests ran and are gone now (first 200, shell-quoted):"
      printf '%q\n' "${missing[@]:0:200}"
    fi
    if [ "${#changed[@]}" -gt 0 ]; then echo "These sentinels changed:"; printf '%q\n' "${changed[@]}"; fi
    exit 1
  fi
  echo "Nothing recorded before the run has disappeared ($count paths checked)."
}

case $action in
  copy) copy_checkout ;;
  record) record ;;
  prepare) copy_checkout; record ;;
  verify) verify ;;
  *) echo "Unknown action: $action" >&2; exit 2 ;;
esac
