# CI scripts

These scripts back `.github/workflows/checks.yml`.

## Test shards

`test-shard.ts <index> <total>` prints one shard's test files. Every tracked
`*.test.ts(x)` file lands in exactly one shard. The script assigns files with a
deterministic greedy bin-pack: heaviest file first, each to the lightest shard so
far. Weights come from `test-timings.json`, which records seconds per file from CI
JUnit reports. A file missing from the table, such as a new test, gets the table's
90th-percentile weight, so it is never assumed to be cheap.

The workflow runs 4 shards per architecture. The slowest file
(`tests/screen-catalog.test.ts`, about 4 minutes) sets the floor for the slowest
shard. More shards wouldn't finish sooner; they would only leave the other shards
idle. Change the count in both the matrix and the `test-shard.ts` argument.

### Refresh the timing table

Every `checks` run uploads one `junit-<arch>-<shard>` artifact per shard. Refresh
the table from a recent successful run on `main` when shards drift apart, or after
adding or removing a slow test file:

```sh
run=$(gh run list --workflow checks.yml --branch main --status success --limit 1 --json databaseId --jq '.[0].databaseId')
dir=$(mktemp -d)
gh run download "$run" --pattern 'junit-*' --dir "$dir"
bun scripts/ci/test-timings.ts "$dir"
git diff --stat scripts/ci/test-timings.json
```

`test-timings.ts` keeps the slowest time per file across all reports (x64 and
ARM64), rounds up to a tenth of a second, and drops files that are no longer
tracked. Commit the updated table with the change that needs it.

## Runs from a copy without `.git`

On x64, `no-git-copy.sh prepare` copies the checkout without `.git` to
`/tmp/schway-no-git`. The shard runs there, and `no-git-copy.sh verify` then fails
if anything that existed before the run is gone: paths in the copy, entries the
runner user owns in `/tmp`, entries in `$HOME`, or the planted sentinels. Tests
may create files; they must remove only what they created, under their own
`mkdtemp` roots (see `makeTempRoot` and `removeTempRoot` in `tests/helpers.ts`).

## Tarball for Jit

`pack-artifact.sh <dir>` runs `bun pm pack` on the checked-out commit, renames the
tarball to `schway-<version>-<short-sha>.tgz` and writes a matching `.sha256` file.
It then installs that exact tarball in the packed-consumer test
(`tests/host-release.test.ts`, through `SCHWAY_PACKED_TARBALL`). The `package` job
runs it on pushes to `main` and on manual runs, after typecheck and tests pass,
and uploads both files as a workflow artifact. It uses no secrets and pushes
nothing to a registry. To download and verify the artifact, see
[the Jit vendoring steps](../../docs/host-s14-conformance.md#pack-and-vendor-for-jit).
