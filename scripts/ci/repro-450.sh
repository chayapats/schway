#!/usr/bin/env bash
# TEMPORARY (#450): run tests from a copy without .git and report anything that disappears.
# Usage: repro-450.sh per-file <copy|symlink> <shard> | suite <container|host>
set -u
mode=$1
src=$GITHUB_WORKSPACE
real=/tmp/rv428
report=/tmp/repro-report.txt
: > "$report"

copy_tree() {
  rm -rf "$real" && mkdir -p "$real"
  tar -C "$src" --exclude=./.git -cf - . | tar -C "$real" -xf -
  test ! -e "$real/.git" || { echo "copy still has .git"; exit 2; }
}

seed_sentinels() {
  mkdir -p /tmp/outside-450/nested "$HOME/outside-450"
  echo keep > /tmp/outside-450/nested/f
  echo keep > "$HOME/outside-450/f"
  echo keep > /tmp/outside-450-file
}

snapshot() { # $1 = output prefix
  ls -A /tmp | sort > "$1.tmp"
  ls -A "$HOME" | sort > "$1.home"
  (cd "$real" && find . -path ./node_modules -prune -o -print | sort) > "$1.copy"
}

required=("$real" "$real/package.json" "$real/src" "$real/tests" "$real/node_modules" /tmp/outside-450/nested/f "$HOME/outside-450/f" /tmp/outside-450-file)

check_after() { # $1 = label; returns 1 when something disappeared
  local lost=0
  for path in "${required[@]}" ${link:+"$link"}; do
    if [ ! -e "$path" ]; then echo "MISSING after $1: $path" | tee -a "$report"; lost=1; fi
  done
  snapshot /tmp/after
  for kind in tmp home copy; do
    local gone
    gone=$(comm -23 "/tmp/before.$kind" "/tmp/after.$kind")
    if [ -n "$gone" ]; then
      printf 'GONE (%s) after %s:\n%s\n' "$kind" "$1" "$(echo "$gone" | head -40)" | tee -a "$report"
      lost=1
    fi
    local added
    added=$(comm -13 "/tmp/before.$kind" "/tmp/after.$kind" | grep -v '^schway-' | head -20)
    if [ "$kind" = copy ] && [ -n "$added" ]; then printf 'ADDED (copy) after %s:\n%s\n' "$1" "$added" | tee -a "$report"; fi
  done
  return $lost
}

echo "git: $(command -v git || echo missing); uid=$(id -u); TMPDIR=${TMPDIR:-unset}; HOME=$HOME"

if [ "$mode" = per-file ]; then
  layout=$2 shard=$3
  (cd "$src" && bun scripts/ci/test-shard.ts "$shard" 8) > /tmp/files.txt
  copy_tree; seed_sentinels
  link=""
  root=$real
  if [ "$layout" = symlink ]; then link=/tmp/rv428-link; ln -s "$real" "$link"; root=$link; fi
  snapshot /tmp/before
  while IFS= read -r file; do
    start=$(date +%s)
    (cd "$root" && bun test -t "" --timeout 60000 "$file") > /tmp/out.log 2>&1
    code=$?
    echo "::group::$file exit=$code $(( $(date +%s) - start ))s"; tail -n 15 /tmp/out.log; echo "::endgroup::"
    if ! check_after "$file"; then
      echo "::error::Something disappeared after $file"
      tail -n 80 /tmp/out.log
      break
    fi
    # Later files compare against the post-file state, so each loss is attributed once.
    for kind in tmp home copy; do cp "/tmp/after.$kind" "/tmp/before.$kind"; done
  done < /tmp/files.txt
else
  variant=$2
  copy_tree; seed_sentinels
  link=""
  snapshot /tmp/before
  (while true; do for path in "${required[@]}"; do [ -e "$path" ] || echo "$(date +%T.%N) MISSING $path"; done; sleep 0.2; done) > /tmp/watch.log &
  watcher=$!
  stamp() { while IFS= read -r line; do printf '%s %s\n' "$(date +%T.%N)" "$line"; done; }
  if [ "$variant" = container ]; then
    sudo chown -R 1000:1000 "$real"
    docker run --rm --user 1000:1000 --network none -v "$real:$real" -w "$real" oven/bun:1.4.2 \
      sh -c 'echo "container git: $(command -v git || echo missing) HOME=$HOME"; bun test -t ""; echo "EXIT=$?"; ls -la /tmp; ls -A /tmp/rv428 | head -40' 2>&1 | stamp > /tmp/suite.log
  else
    (cd "$real" && bun test -t ""; echo "EXIT=$?") 2>&1 | stamp > /tmp/suite.log
  fi
  kill "$watcher"
  grep -E 'container git|EXIT=| pass$| fail$|^[0-9:.]+ Ran ' /tmp/suite.log | tail -n 20
  echo "--- first watcher hits"; head -n 20 /tmp/watch.log
  first=$(head -n 1 /tmp/watch.log | cut -d' ' -f1)
  if [ -n "$first" ]; then
    echo "--- suite output before first loss at $first"
    awk -v t="$first" '$1 <= t' /tmp/suite.log | tail -n 60
  fi
  check_after "whole suite" || echo "::error::Something disappeared during the whole-suite run"
  grep -E '^[0-9:.]+ tests/.*\.test\.tsx?:$' /tmp/suite.log | tail -n 5
fi
echo "=== report"; cat "$report"
test ! -s "$report"
