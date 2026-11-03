#!/usr/bin/env bash
# Runs tests from a copy of the checkout without .git and proves they removed nothing they didn't create (#450).
#   no-git-copy.sh prepare <copy>  copy the checkout (minus .git) to <copy>, plant sentinels, record what exists
#   no-git-copy.sh verify <copy>   fail when anything recorded by prepare has disappeared
# Recorded: every path in the copy (node_modules only at its top level), the entries in the copy's parent
# directory that this user owns (where the OS temp roots live), the entries in $HOME, and the sentinels.
# Tests may add files; only disappearance fails.
set -euo pipefail

action=${1:?usage: no-git-copy.sh prepare|verify <copy>}
copy=${2:?usage: no-git-copy.sh prepare|verify <copy>}
case $copy in /*) ;; *) echo "The copy path must be absolute: $copy" >&2; exit 2 ;; esac
checkout=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
parent=$(dirname "$copy")
state="${RUNNER_TEMP:-$parent}/no-git-copy-state"
sentinels=("$parent/schway-no-git-sentinel/nested/keep" "$HOME/.schway-no-git-sentinel/keep" "$copy/.schway-no-git-sentinel")

snapshot() {
  {
    find "$copy" -mindepth 1 -path "$copy/node_modules/*" -prune -o -print 2>/dev/null || true
    find "$copy/node_modules" -mindepth 1 -maxdepth 1 -print 2>/dev/null || true
    find "$parent" -mindepth 1 -maxdepth 1 -user "$(id -u)" -print
    find "$HOME" -mindepth 1 -maxdepth 1 -print
    printf '%s\n' "$copy" "${sentinels[@]}"
  } | sort -u
}

case $action in
  prepare)
    if [ -e "$copy" ]; then echo "$copy already exists; refusing to reuse it." >&2; exit 1; fi
    mkdir -p "$copy" "$state"
    tar -C "$checkout" --exclude=./.git -cf - . | tar -C "$copy" -xf -
    for sentinel in "${sentinels[@]}"; do mkdir -p "$(dirname "$sentinel")"; echo keep > "$sentinel"; done
    snapshot > "$state/before"
    echo "Copied $checkout to $copy without .git; recorded $(wc -l < "$state/before") paths."
    ;;
  verify)
    # Anything recorded before the run must still exist.
    missing=$(while IFS= read -r path; do [ -e "$path" ] || [ -L "$path" ] || printf '%s\n' "$path"; done < "$state/before")
    for sentinel in "${sentinels[@]}"; do
      if [ -e "$sentinel" ] && [ "$(cat "$sentinel")" != keep ]; then missing+=$'\n'"$sentinel (changed)"; fi
    done
    if [ -n "${missing//$'\n'/}" ]; then
      echo "::error title=Tests removed paths they didn't create::$(grep -c . <<< "$missing") paths disappeared; see the log."
      echo "These paths existed before the tests ran and are gone or changed now:"
      grep . <<< "$missing" | head -n 200
      exit 1
    fi
    echo "Nothing recorded before the run has disappeared ($(wc -l < "$state/before") paths checked)."
    ;;
  *) echo "Unknown action: $action" >&2; exit 2 ;;
esac
