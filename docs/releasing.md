# Releasing Schway

Run this checklist in order. A failed step stops the release: file an issue with
evidence and a severity label, and leave the release ticket open. Missing live
access must be repaired and tested; skipped or pending lanes cannot pass.

Set `V` to the version being released, without a leading `v`. Keep raw JSON and
logs private, outside Git:

```sh
V=0.4.0
EVID="$HOME/schway-release-evidence/$V"
mkdir -p "$EVID"
chmod 700 "$EVID"
```

Only reviewed summaries belong in a new top section of
`docs/release-verification.md` headed `## $V release (<YYYY-MM-DD>)`.

## 1. Preconditions

- [ ] All release blockers are closed and their changes are in `main`.
  `gh issue list --milestone <milestone> --state open` lists only the release
  ticket. For 0.4, check #129–#137 and #166.
- [ ] Create or update severity labels idempotently, then inspect
  `gh label list`. Every truth-pass defect must carry exactly one severity.

  ```sh
  gh label create P0 --force --description "Data loss or corruption, edits to the wrong file, or broken resume"
  gh label create P1 --force --description "User had to leave Schway to finish the task"
  gh label create P2 --force --description "Other friction"
  gh label list
  ```

- [ ] Both `gh issue list --state open --label P0` and
  `gh issue list --state open --label P1` print nothing. Record the check date.
- [ ] `npm whoami` identifies the maintainer with package publish rights;
  publish 2FA is ready. Check `npm view "schway@$V" version` to confirm the
  version is unused. An unpublished package's E404 alone does not prove
  ownership or publish permission.
- [ ] Obtain operator model selections and consent for paid smoke/evals.
  Keep keys in the process environment or Schway's OS secure store.

## 2. Release commit

- [ ] Prepare one release PR and merge it to `main`. Set `package.json`
  `version` to `$V`; bump the Schway peer range in
  `examples/packages/greeting/package.json` and the `README.md`
  `peerDependencies` example to `^$V`.
- [ ] Package compatibility tests read the installed version from
  `package.json`, rather than hard-coding a previous release.
- [ ] Update `CHANGELOG.md`. Keep `# Changelog`, `## [Unreleased]`, then
  `## [$V] - <YYYY-MM-DD>` in that order. Use `### Breaking`, `### Added`,
  `### Changed` and `### Fixed` where needed. Future entries retain this
  heading format for the session-fixture generator (#158). The 0.4.0 entry
  states that earlier versions were not published to npm.
- [ ] Describe breaking changes with exact migration/error messages.
  For 0.4.0, quote `ANTHROPIC_REMOVED_MESSAGE` from
  `src/config/removed-provider.ts`, explain `schway doctor` and its leftover
  Anthropic-key cleanup command, and record the no-model headless error.
  Cover xAI API keys, Grok subscription sign-in, provider model lists and
  `bun run eval --max-spend` in Added.
- [ ] `package.json` `files` includes `CHANGELOG.md`; the packaging test
  requires `package/CHANGELOG.md`. This checklist and release-verification
  evidence stay outside the published files.
- [ ] Demo GIF regeneration (#150): placeholder for its approved generation,
  review and artifact steps.
- [ ] Session fixture generation (#158): placeholder for its changelog-driven
  generation, validation and artifact steps.
- [ ] On the actual merge commit, run `bun install --frozen-lockfile`,
  `bun run typecheck` and `bun test`. Record the test count and commit SHA
  as `R`. Pre-merge results do not substitute for this gate.

## 3. Live verification on the release commit

- [ ] Check out `R`; `git status --porcelain` prints nothing.
- [ ] ChatGPT is signed in through `/login codex`; Grok through
  `/login grok` or `/login grok --device`. Export `OPENAI_API_KEY` and
  `XAI_API_KEY`. Configure `COMPAT_URL` and `COMPAT_MODEL`, with
  `OPENAI_COMPATIBLE_API_KEY` for a remote compatible endpoint. Loopback
  without credentials uses `--auth none`.
- [ ] Run all five smoke lanes for every minor release. Use the operator's
  selected models with repeated `--model provider=model-id` flags when they
  differ from defaults; lane IDs are `codex`, `grok`, `openai-api-key`,
  `xai-api-key` and `compatible`.

  ```sh
  bun run live-smoke --enable-live --provider all --base-url "$COMPAT_URL" > "$EVID/live-smoke.json"
  SMOKE_EXIT=$?
  printf 'exit %s\n' "$SMOKE_EXIT"
  jq -r '.aggregate' "$EVID/live-smoke.json"
  ```

  Exit must be 0 and aggregate `passed`. No lane may be skipped or pending;
  repair access and rerun. A `failed_*` lane gets a severity-labelled issue.
  A route that cannot complete smoke is P1 and blocks publishing.
- [ ] Record each lane's route, `provider`, actual `model`, `authSource`,
  `status`, `reason`, `testedAt` and `revision` in the evidence table;
  every revision must equal `R`.
- [ ] At release candidates and 1.0, also run full live evals with
  `bun run eval --allow-paid --case all --max-spend <remaining-usd>` and the
  selected provider/model/endpoint. Verify current prices and supply
  `--input-price` / `--output-price` when needed. All release eval runs
  together must stay within the $10 cap, or the operator's smaller cap.
  Record per-case outcomes, grader exits, total spend and whether usage is
  exact; reconcile incomplete billing before more paid runs. Full evals must
  pass on all five auth routes at rc and 1.0. A route unsupported by the eval
  runner is a pending gate that blocks those releases until support exists;
  recording it does not satisfy the gate.
  Full evals are not required for ordinary minor releases such as 0.4.

See [live smoke](live-providers.md) and [evals](evals.md) for runner limits and
report fields.

## 4. Publish and tag

- [ ] From `R` with a clean tree, `npm pack --dry-run` lists
  `bin/schway`, `src/`, `examples/`, the docs declared in
  `package.json` `files`, `README.md`, `LICENSE` and `CHANGELOG.md`.
  It includes no `tests/`, `.scratch/` or
  `docs/release-verification.md`.
- [ ] Publish stable versions with `npm publish --access public`.
  Publish prereleases with `npm publish --access public --tag next`, so they
  do not replace `latest`. Do not add an npm release/publish script or
  a CI publish job.
- [ ] `npm view "schway@$V" version` equals `$V`. Check
  `npm view schway dist-tags.latest` for stable releases or
  `npm view schway dist-tags.next` for prereleases. If
  `npm view "schway@$V" gitHead` returns a SHA, it must equal `R`.
- [ ] Create and push the annotated tag, then verify its commit:

  ```sh
  git tag -a "v$V" -m "schway $V" "$R"
  git push origin "v$V"
  git rev-parse "v$V^{commit}"
  ```

  The result must equal `R`.

## 5. Registry install with a clean HOME

- [ ] Keep Bun on `PATH`; install the exact registry version outside the
  checkout, with an empty home and a separate Git workspace:

  ```sh
  T=$(mktemp -d)
  mkdir -p "$T/home" "$T/work"
  npm install -g --prefix "$T/g" --no-audit --no-fund "schway@$V"
  S="$T/g/bin/schway"
  cd "$T/work"
  git init -q
  env HOME="$T/home" "$S" --help
  env HOME="$T/home" "$S" doctor --json > "$EVID/install-doctor.json"
  jq -r .version "$EVID/install-doctor.json"
  ```

  Help exits 0; doctor reports `$V`. A temporary HOME does not isolate the
  OS secure store. Do not run login/logout or alter saved production accounts.
- [ ] `env HOME="$T/home" "$S" -p "hello"` exits 1 and prints
  `No model configured. Pass --provider and --model, or set them in config.`
- [ ] Run the selected compatible endpoint:

  ```sh
  env HOME="$T/home" "$S" -p "Reply with the word OK." --provider openai-compatible --base-url "$COMPAT_URL" --model "$COMPAT_MODEL" --json > "$EVID/install-turn.jsonl"
  INSTALL_EXIT=$?
  printf 'exit %s\n' "$INSTALL_EXIT"
  jq -r 'select(.type=="agent.finished") | .reason' "$EVID/install-turn.jsonl"
  find "$T/home/.schway/sessions" -type f -name '*.jsonl'
  ```

  Add `--auth none` for unauthenticated loopback. Exit is 0, the final
  reason is `completed`, and exactly one session JSONL exists.
- [ ] Set `$T/home/.schway/config.json` to `{"provider":"anthropic"}`.
  `env HOME="$T/home" "$S" -p hi` exits 1 with the exact removal message.
- [ ] Record OS, Bun and npm versions and each command's exit code.

## 6. Close out

- [ ] The evidence section contains `**Verdict: $V published.**`, `R`,
  the tag, npm version, offline test count/typecheck, live smoke table,
  clean-HOME results and dated open P0/P1 check. Record required rc/1.0
  eval evidence as well. Do not use a published verdict while any gate is
  pending or failed.
- [ ] Commit the evidence section to `main`. Review the diff for credentials
  before committing; raw reports remain private.
- [ ] Post a link to the evidence section on the release issue, then close it.
  A GitHub Release page, npm provenance and CI publishing are outside this
  checklist.
