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
is `active`, `retired` or `deleted`. `limit` bounds returned entries, not scanned
identities. Empty filtered ranges are scanned internally; `next` is the last
returned workspace UUID only when another matching identity was observed.
An empty page has no continuation. Follow `next` until absent, and begin another
full sweep after concurrent app creation is fenced.
Discovery is metadata only. Retire/delete discovered references without
reopening them; native exclusive leases still gate every mutation. The app owns
correlation, original authority, conservative unknown-usage accounting and any
decision to start a new run. Existing app grants are never inferred from native
inventory. A deleted app context can delete an orphan using these same methods.

## Deterministic evidence

| Seam | Coverage |
| --- | --- |
| `tests/host-credential-lifecycle.test.ts` | Separate hosts, fake stores/fetch, fake-clock run bounds and explicit promise barriers for overlap, rotating renewal with late siblings during pre/post-write guards and readiness, cancellation/guard refusal controls, overlapping logout success/failure quarantine with replacement sign-in, logout during fetch/write, disposal, exact cleanup, uncertain cleanup and route/store isolation. |
| `tests/host-session-recovery.test.ts` | Process crashes before creation, after native persistence before app commit, and after app commit; retirement/deletion fixtures; child-process barriers immediately before and after actual conversation unlink; torn headers/tombstones, untouched torn transcripts, complete pagination across foreign ranges without cursor disclosure, workspace/store scope, live lease refusal, aliases and snapshot quarantine. |
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
TMPDIR=/Users/Shared bun test # Canonical temporary root for macOS fixtures.
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
assuming distinct default hosts share renewal, follow workspace-only inventory
continuations until absent, preserve deleted tombstones as management metadata, and
keep corrupt/busy recovery unresolved. Discovery's `main` reference is for
id-wide management; it must not replace an app's saved execution branch.

[#428](https://github.com/chayapats/schway/issues/428) remains the cross-process
credential-lock follow-up, including lock-location override. This work shares
the existing lock boundary without replacing it. Abortable local readiness and
exact provider-request accounting ([#415](https://github.com/chayapats/schway/issues/415))
now ship in the S15 slice below. Do not add Jit-owned refresh or retry protocols.

## S15 dispatch authorization and provider requests

Two more additive slices remain under `schway.host.release/v2`:

| Capability property | Exact version |
| --- | --- |
| `dispatchAuthorizationContract` | `schway.host.dispatch-authorization/v1` |
| `providerRequestsContract` | `schway.host.provider-requests/v1` |

Require both before reporting governed model dispatch as guarded. Pass a
synchronous `authorizeDispatch` to `submitWithRoute(input, { authorizeDispatch })`
or to `host.auth.createModel({ authorizeDispatch })` for `submit` and `compact`.
It runs once per physical inference send, immediately before the request starts,
including transient retries, compaction and the Grok auth-retry resend; throw to
refuse. Check each `HostDispatch` (`route`, `provider`, `model`, `kind`,
`sequence`, `bodySha256`, `bodyBytes`) against the app's recipient, budget and
revocation policy at that moment. A refusal sends nothing, is never retried, and
reports `auth.status: "dispatch-refused"` on route runs; `isDispatchRefused`
recognizes it on direct streams.

Read `result.usage.providerRequests` to reconcile admitted work with physical
requests: inference requests are `initialSends + authRetrySends`, and
`renewalRequests` counts the token refreshes this run started. A shared renewal
counts once, for the run that started it, so totals across runs are exact.
`null` means a model call was not observable (a host-supplied model or a wrapper
that drops `call`); treat it as unknown, never zero. Bound local readiness with
`checkReadiness({ signal, deadlineMs })`; it rejects `AbortError` or
`TimeoutError` and never writes. `submitWithRoute`'s admission read is not
bounded by these options.

| Seam | Coverage |
| --- | --- |
| `tests/host-dispatch-authorization.test.ts` | Fake fetch and stores with promise barriers: Grok 401 resend authorized twice and refusable on the second call with one request sent; revocation during a blocked credential read or renewal; Codex renewal before one authorized send; retries and compaction; exact body hashes; no-authorizer byte identity; secret sentinels; option validation. |
| `tests/host-provider-requests.test.ts` | Exact counts per run, shared renewal attributed once across lifecycle-sharing hosts, bounded retries, `null` for unobservable models, readiness abort and deadline without writes. |
| `tests/host-release.test.ts` | The packed consumer advertises both capabilities, authorizes the Grok initial and auth-retry sends with matching hashes, refuses the resend, reads exact counts and bounds readiness, importing only `schway/host`. |
