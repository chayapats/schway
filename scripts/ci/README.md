# CI scripts

These scripts back `.github/workflows/checks.yml`.

## Test shards

`test-shard.ts <index> [total]` prints one shard's test files; `total` defaults to
`SHARD_COUNT`. Every tracked `*.test.ts(x)` file lands in exactly one shard. The
script assigns files with a deterministic greedy bin-pack: heaviest file first, each
to the lightest shard so far. Weights come from `test-timings.json`, which records seconds per file from CI
JUnit reports. A file missing from the table, such as a new test, gets the table's
90th-percentile weight, so it is never assumed to be cheap.

The workflow runs `SHARD_COUNT` (4) shards per architecture. The slowest file
(`tests/screen-catalog.test.ts`, about 4 minutes) sets the floor for the slowest
shard. More shards wouldn't finish sooner; they would only leave the other shards
idle. To change the count, change `SHARD_COUNT` and the `shard` list in the
workflow matrix together; `tests/ci-test-shard.test.ts` fails when they disagree.
An empty shard list fails its step rather than letting `bun test` run everything.

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
`/tmp/schway-no-git` and records what exists. The shard runs there, and
`no-git-copy.sh verify` then fails if anything recorded is gone: paths in the copy,
entries the runner user owns in `/tmp`, entries in `$HOME`, or the planted sentinels.
Tests may create files. The script's header lists what it records and what it can't
see, such as removals below the top level of `node_modules`, `/tmp` and `$HOME`.

The `tests (no-git container)` job repeats the #450 report's run: the whole suite in
one `bun test -t ""` process in `oven/bun:1.4.2` as uid 1000, without git or network,
from a copy without `.git` mounted at `/tmp/rv428`. `no-git-container.sh` records
inside the container, after the host's `chown`. Test failures from the missing git
and network are expected and ignored. The job fails on removals, and when the run
doesn't print a final `Ran N tests across M files` summary with at least one test and
every tracked test file outside dot-directories, so a crash or an early exit can't
pass. It runs on pushes to `main`, manual runs and weekly, so branch checks stay short.

Tests must remove only what they created, under their own `mkdtemp` roots. Use
`withTempDir`, `makeTempRoot`, `removeTempRoot` and `removeOwnedTree` from
`tests/helpers.ts`. `tests/temp-root-guard.test.ts` fails on any new direct
recursive removal (`rm`/`rmSync` and their aliases, `rm -r` in shell text or argv
lists, `find … -delete`) or `mkdtemp` under `tests/`. Existing sites are listed with
their exact counts in `tests/fixtures/temp-root-allowlist.json` until they move to
the helpers. The counts must match: lower or remove an entry when you migrate a site,
and never raise one. `tests/helpers/temp-root-sites.ts` lists what the scanner can't
see, such as options held in a variable.

## Tarball for Jit

`pack-artifact.sh <dir>` runs `bun pm pack` on the checked-out commit, renames the
tarball to `schway-<version>-<short-sha>.tgz` and writes a matching `.sha256` file.
It then installs that exact tarball in the packed-consumer test
(`tests/host-release.test.ts`, through `SCHWAY_PACKED_TARBALL`). The `package` job
runs it on pushes to `main` and on manual runs, after typecheck and tests pass,
and uploads both files as a workflow artifact. The job uses no secrets and pushes
nothing to a registry. Uploads use `overwrite: true`, so re-running a job replaces
its artifact instead of adding a second one with the same name.
`SCHWAY_PACKED_TARBALL` must name a tarball whose version and short SHA match the
checkout, or the packed-consumer test fails. To download and verify the artifact, see
[the Jit vendoring steps](../../docs/host-s14-conformance.md#pack-and-vendor-for-jit).
