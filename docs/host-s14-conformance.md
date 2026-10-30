# S14 host conformance and Jit artifact

The checked declarations are [api/host.api.md](../api/host.api.md). Both slices
are additive under `schway.host.release/v2`:

| Capability property | Exact version |
| --- | --- |
| `credentialLifecycleContract` | `schway.host.credential-lifecycle/v1` |
| `sessionInventoryContract` | `schway.host.session-inventory/v1` |

Import only `schway/host`. Create one `createHostCredentialLifecycle()` for the
embedding process and pass it as `auth.lifecycle` to each independent run's
`createHost`. Keep context, exact tools, workspace, limits and cancellation in
each run's options. Retain the lifecycle until every admitted run and write has
settled. `logout(route)` revokes participating work for exactly that route;
`close()` disposes an idle handle without logout. No credential is available
through the opaque handle. Factory `store`/selection `fetch` seams are for
trusted isolated fixtures, and require no live account or paid request.

`HostRuntime.listSessions({ limit?, after? })` returns `{ sessions, next? }`,
where every entry is `{ reference: { id, branchId: "main" }, state }` and state
is `active`, `retired` or `deleted`. Follow `next`, including on empty filtered
pages, and begin another full sweep after concurrent app creation is fenced.
Discovery is metadata only. Retire/delete discovered references without
reopening them; native exclusive leases still gate every mutation. The app owns
correlation, original authority, conservative unknown-usage accounting and any
decision to start a new run. Existing app grants are never inferred from native
inventory. A deleted app context can delete an orphan using these same methods.

## Deterministic evidence

| Seam | Coverage |
| --- | --- |
| `tests/host-credential-lifecycle.test.ts` | Separate hosts, fake stores/fetch, fake-clock run bounds and explicit promise barriers for overlap, renewal failure, cancellation, independent guards, logout during fetch/write, disposal, exact cleanup, uncertain cleanup and route/store isolation. |
| `tests/host-session-recovery.test.ts` | Process crashes before creation, after native persistence before app commit, and after app commit; retirement/deletion fixtures; child-process barriers immediately before and after actual conversation unlink; torn headers/tombstones, untouched torn transcripts, pagination, workspace/store scope, live lease refusal, aliases and snapshot quarantine. |
| `tests/host-managed-session-data.test.ts` | Existing retire/delete idempotency, history-lock refusal without partial state, exact artifact accounting, unknown/live owners and delayed-writer fencing. |
| `tests/host-session-snapshot.test.ts` | Existing quiescence, restore quarantine, retirement and deletion semantics. |
| `tests/host-release.test.ts` | Packs and installs an isolated artifact; its external consumer resolves only `schway/host`, proves renewal across separate hosts, advertises both capability versions, discovers an uncommitted orphan, refuses its live lease, then retires/deletes without provider or TUI loading. |

Before native creation, an app intent can reconcile to no session. After native
persistence, the UUID is discoverable even without an app reference. After app
commit, the same UUID correlates normally. Retirement preserves its tombstone;
deletion preserves that identity before removing conversation data, so retry
converges across either unlink boundary. Partial/corrupt metadata rejects
`storage`; aliases reject `conflict`; uncertain or live ownership remains `busy`
when management is attempted. Those cases remain unresolved rather than
reporting deletion or silently granting execution. These fixtures certify no
external exactly-once effects or live reboot/account availability.

Run from Schway's tested commit:

```sh
bun install --frozen-lockfile
bun scripts/extension-api-report.ts --host
bun run typecheck
bun test
git diff --check
```

## Pack and vendor for Jit

No version bump, npm publication, migration script or new build dependency is
needed for a commit-pinned tarball. `package.json` remains `1.0.0-rc.2`.
`bun pm pack` automatically runs `prepack`, which invokes
`bun scripts/build-extension-types.ts` for the public host/extension declarations.
Regenerate an intentional API change with
`bun scripts/extension-api-report.ts --host --update` before final validation.
Any eventual npm RC publication remains a separate release-owner step.

Pack the reviewed/merged Schway revision into a fresh directory, name it by that
revision, and record its full Git SHA and SHA-256 digest alongside Jit's bump:

```sh
# In the Schway checkout at the exact tested revision:
artifact_dir=$(mktemp -d)
bun pm pack --destination "$artifact_dir"
schway_revision=$(git rev-parse --short=7 HEAD)
mv "$artifact_dir/schway-1.0.0-rc.2.tgz" "$artifact_dir/schway-1.0.0-rc.2-$schway_revision.tgz"
shasum -a 256 "$artifact_dir/schway-1.0.0-rc.2-$schway_revision.tgz"
# Copy that exact artifact into Jit's vendor directory, then in Jit:
# bun add ./vendor/schway-1.0.0-rc.2-<revision>.tgz
```

Keep Jit's dependency in its existing `file:vendor/schway-1.0.0-rc.2-<revision>.tgz`
form, update its Bun lockfile, and rerun Jit's public packed-consumer acceptance.
Require both exact capability versions above plus `release/v2` before enabling
the corresponding concurrency/recovery integration. Jit keeps its current
concurrency guard until that integration passes; Schway does not change Jit here.

Compared with Jit's current `2068b71` pin, the prior main changes are documentation
and Greptile configuration only. This batch removes or renames no public export,
changes no existing call signature, JSONL/snapshot format, tool behavior or
route/model/billing selection. There is no breaking runtime migration. Consumers
that construct structural `HostRuntime`/`HostCapabilities` test doubles must add
the new method/capability fields. Jit must opt into `auth.lifecycle` instead of
assuming distinct default hosts share renewal, handle empty inventory pages
with continuations, preserve deleted tombstones as management metadata, and
keep corrupt/busy recovery unresolved. Discovery's `main` reference is for
id-wide management; it must not replace an app's saved execution branch.

[#428](https://github.com/chayapats/schway/issues/428) remains the cross-process
credential-lock follow-up, including lock-location override. This work shares
the existing lock boundary without replacing it. [#415](https://github.com/chayapats/schway/issues/415)
still owns abortable local readiness and exact provider-request accounting;
neither is claimed here. Do not add Jit-owned refresh or retry protocols.
