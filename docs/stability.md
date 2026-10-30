# Stability policy

These are Schway’s compatibility promises for 1.0 and later releases.

## Session JSONL

Session migration is forward only. Every release reads every earlier session
format, including formats 1–3 written by unpublished 0.1–0.3 builds. A migration
appends records, such as `session_format`; it never rewrites or deletes earlier
lines. Older releases are not required to read files upgraded by a newer release.

The same forward compatibility promise covers the undo pre-image store format:
every release reads pre-images written by any earlier release. Retention settings
may remove expired pre-images; compatibility does not disable retention.

The optional turn history sidecar (`~/.schway/history`) evolves the same way:
forward-only and append-only. Releases read every earlier sidecar version and
never rewrite saved history lines; a session without a sidecar stays readable.

Published-version fixtures enforce ordinary discovery and resume, selected-branch
history, compaction summaries, undo notes and append-only persistence. Synthetic
legacy tests continue to cover the unpublished formats.

## Config

A deprecated key keeps working and warns until the next major version, when it
may be removed. Warnings appear as a TUI notice, on headless stderr (including
with `--json`) and in `doctor`. See [configuration](configuration.md), including
the deprecated-key list and replacement precedence.

## Extension API

Semver applies to the extension and [application host](host.md) APIs. Only exports
of `schway/extensions` and `schway/host`, defined by their `src/*/index.ts` entries,
are public. These are the only subpaths in `package.json` `exports`. Deep imports
such as `schway/src/...` are private and may change in any release. Static host
capabilities identify the supported contract/features; a base entry does not
promise later exact-registry, route or managed-lifecycle capabilities. The explicit
context-policy contract advertises strict/controlled discovery and preserves
CLI defaults; current restrictions also apply when opening older native history.
The durable-sessions contract adds exclusive local-process ownership per canonical
session, flush-before-publication and exact saved-branch/result references. Its
leases fail closed for uncertain owners; native reopen owns interrupted-call
settlement without replaying tool effects. The ownership boundary and recovery
conditions are documented in [host contracts](host.md). It introduces no JSONL
format change or distributed transaction with an embedding application's store.
The exact tool-policy contract advertises an `exact` registry with hosted lookup
disabled-only; an empty registry advertises zero tools and no implicit built-in,
skill activation or hosted search appears via defaults, hooks or recovery. An
explicitly admitted `activate_skill` rebinds per session to the current context
policy. Read-only approval applies after hooks to effective arguments and is
distinct from isolation; relative tool paths retain primary-workspace-root
semantics. The auth-routes contract binds one exact model with the `codex` or
`grok` subscription route, exposes opaque credential references and static
configured state distinct from observed inference, and composes the existing
route-scoped renewal and generation fencing without changing billing, credential
sources or plaintext storage. Only the selected adapter loads when the route is
used; SDK retries stay disabled and no new credential import is introduced.
Unattended Linux availability remains unverified before S01 evidence. The
run-control contract adds finite `deadlineMs`/`maxAttempts` admission bounds,
transient progress distinct from durable results, honest null-preserving usage,
`completed`/`error`/`cancelled`/`max_turns`/`limit_exceeded` terminal outcomes
with selected route/session/run references, and cooperative cancel/settle with
late-callback fencing before ownership release. It composes the existing loop,
retry and scheduler without a competing durable job scheduler. The
managed-session-data contract adds narrow retire and delete for exact
host-owned native references: retirement tombstones block silent reopen,
deletion reuses Schway-owned conversation, history, draft, undo, metadata and
lease cleanup with honest `deleted`, `already-deleted`, `partial` and `blocked`
status, and busy, unknown, symlink, traversal and unrelated-store writers
delete nothing. It promises no remote provider erasure, no JSONL rewrite and
no general filesystem removal. The
session-snapshot contract adds quiesced export and validated restore for
closed managed sessions: copy leases make one captured set coherent with
`busy`/`conflict` fencing, manifests carry stable refs, ancestry, native and
contract versions plus SHA-256 inventory without credentials or unowned files,
and restore revalidates, quarantines incomplete or incompatible sets, and
resumes ancestry through Schway-owned forward-only migration without running
models or tools. Jit coordinates its own app store and deletion ledger; no
distributed atomicity is promised. The core-tools contract exports `read`,
`write`, `edit`, `bash`, `grep`, `find` and `ls` over a host-supplied
`ExecutionBackend` with the CLI's schemas, descriptions, effects and output
bounds. Schway keeps path confinement to the backend root and the output
bounds; nothing is admitted implicitly, and the backend is trusted host code,
not a sandbox. `localExecutionBackend` reproduces the CLI's behavior, and the
CLI and TUI registries are unchanged. The release contract composes all nine
sliced contracts as `schway.host.release/v2` (`release/v1` plus core-tools)
for versioned downstream pinning:
`hostCapabilities().releaseContract` and the `RELEASE_CONTRACT` export name the
supported behavior set, the packed artifact ships `schway/host` with reachable
`dist/types` declarations and the `examples/host` embedded consumer, and an
external temporary consumer installs that tarball without private source access
to prove the composed restrictions, lifecycle, route fixtures and compatibility.
The additive `schway.host.web-tools/v1` slice exports vendor-neutral search and
pinned, SSRF-guarded fetch tools, admitted explicitly with hosted lookup off.
Their bounded host results carry escaped `untrusted_data` envelopes; the app owns
search credentials, auditing and disclosure policy. This slice does not change
`RELEASE_CONTRACT`; the integration owner composes the next release.
Capability/configuration claims stay distinct from S01 Pi/account support:
`observedInference` remains `not-checked` until a committed route-bound run,
and Linux store availability is documented without claiming unattended support.
Actual npm/GitHub publication still requires existing repository authorization.

Adding a member to an exported union such as `ExtensionEvent` or
`ConversationItem`, or adding a new optional field, is a minor change. Removing
or renaming a member, or making a field required, is a major change.

The additive `schway.host.credential-lifecycle/v1` and
`schway.host.session-inventory/v1` slices remain under `schway.host.release/v2`.
The first adds an opaque process-local secure-store owner shared across separate
hosts, with per-caller guards/cancellation, selected-route logout fencing and
idle disposal. The second adds bounded store/workspace metadata enumeration and
durable deletion intent before conversation removal, with no transcript access,
execution, lease bypass or automatic app-job resumption. Existing JSONL and
snapshot formats, branch/result references, retry policy and route/model/billing
selection are unchanged. Inventory uses existing retirement tombstones,
including deleted identities; complete sweeps converge under quiescent app
creation, and corrupt metadata stays explicitly unresolved. This is a minor,
additive host API change; capability names must be checked by consumers. See
[host contracts](host.md) and [S14 conformance](host-s14-conformance.md).

## Core tool semantics

The core tools are `read`, `write`, `edit`, `bash`, `web_fetch`, `grep`, `find`
and `ls`. Any change to their meaning needs a major version, whether they run in
the CLI or through `coreToolDefinitions` over a host execution backend. Semantic
changes include:

- Renaming or removing a tool or parameter.
- Changing a parameter’s meaning.
- Changing path resolution: tool-relative paths resolve from the primary workspace
  root (the nearest Git root, otherwise launch cwd), canonicalized through real paths.
- Changing the declared effect: reads only or can change state.
- Changing when a call is an error.
- Editing a core tool’s model-facing description text.
- Changing output bounds, such as the 50,000-byte cap or the `web_fetch`
  deadlines, raw-body cap, 32 KiB output cap and redirect limit.

## Changelog

Every published version has a `CHANGELOG.md` entry. Breaking changes and
deprecations get their own sections, `### Breaking` and `### Deprecations`.
