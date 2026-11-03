#!/usr/bin/env bash
# Packs the checked-out commit as schway-<version>-<short-sha>.tgz with a matching .sha256 file in <dir>,
# verifies the checksum, then installs that exact tarball in the packed-consumer test. When GITHUB_OUTPUT is
# set, it records `name` (the tarball without .tgz) and `dir` for the upload step. Nothing leaves this machine.
#   pack-artifact.sh <dir>
set -euo pipefail

dir=${1:?usage: pack-artifact.sh <dir>}
case $dir in /*) ;; *) echo "The output directory must be absolute: $dir" >&2; exit 2 ;; esac
checkout=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$checkout"
if [ -e "$dir" ] && [ -n "$(ls -A "$dir")" ]; then echo "$dir is not empty." >&2; exit 1; fi
mkdir -p "$dir"

version=$(bun -e 'console.log((await Bun.file("package.json").json()).version)')
revision=$(git rev-parse --short=7 HEAD)
name="schway-$version-$revision"
# `bun pm pack` runs prepack, which builds the public host and extension declarations.
bun pm pack --destination "$dir"
mv "$dir/schway-$version.tgz" "$dir/$name.tgz"
(cd "$dir" && sha256sum "$name.tgz" > "$name.tgz.sha256" && sha256sum --check "$name.tgz.sha256")
echo "SHA-256: $(cut -d' ' -f1 "$dir/$name.tgz.sha256")"

# The packed-consumer test installs this exact file instead of packing the checkout again.
SCHWAY_PACKED_TARBALL="$dir/$name.tgz" bun test --timeout 60000 ./tests/host-release.test.ts
(cd "$dir" && sha256sum --check "$name.tgz.sha256")

if [ -n "${GITHUB_OUTPUT:-}" ]; then printf 'name=%s\ndir=%s\n' "$name" "$dir" >> "$GITHUB_OUTPUT"; fi
