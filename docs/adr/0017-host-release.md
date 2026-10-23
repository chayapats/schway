---
status: accepted
scope: ENG09 host release
---

# Versioned packed host artifact with a composed release contract

ENG09 completes S02 with an installable `schway/host` artifact and one external packed-consumer conformance scenario for FR-02/13/14/15/16/17/18 and NFR-02/03/05/08/10/12, building on implemented ENG01/03/04/05/06/07/08 and S02 #393. It does not publish to npm/GitHub, claim live Pi/provider support, or add Jit features.

`hostCapabilities()` advertises the composed `schway.host.release/v1` as `releaseContract` alongside the eight sliced contracts, and `RELEASE_CONTRACT` exports the same version string. The packed artifact (`bun pm pack`) ships the `schway/host` subpath with reachable `dist/types/host/index.d.ts` declarations, the `examples/host/review.ts` strict-review embedded consumer, and the host user docs. Version selection stays repo-consistent: this branch keeps `package.json` at `1.0.0-rc.2` and records the immutable final HEAD SHA as the tested downstream artifact; the next `1.0.0-rc.3` publish under existing repository authorization carries these contracts. Jit pins either that tarball SHA or `schway@^1.0.0-rc.3` once published, plus `schway.host.release/v1` as the behavior contract.

`tests/host-release.test.ts` with `tests/fixtures/host-release-consumer.ts` is the primary seam. It packs the checkout, installs the tarball into an isolated temporary consumer without private source access or path aliases, checks the fixture imports only `schway/host`, and proves static release discovery without provider/TUI loading, strict review with adversarial workspace/home content and a narrow read-only tool, independent sessions with normalized usage and transient progress, tool execution, fresh-handle reopen, cooperative cancellation, quiesced two-session snapshot with hash-verified restore into a fresh store, retire/delete lifecycle with idempotent delete, and Grok/Codex route success plus 401/429 isolation with API-key bait and per-route adapter guards. Protocol fixtures and fake stores are used; no live account is required.

Capability/configuration claims stay distinct from S01 observed Pi/account support: `observedInference` remains `not-checked` until a committed route-bound run, and Linux store expectations remain documented without claiming unattended availability. Existing extension symbols and CLI/session behavior are preserved; only the additive release contract, its export, the example, and the packed `examples/host` file entry change the surface.

Evidence: `tests/host-release.test.ts` (packed install, composed lifecycle, per-route isolation, public-import check), existing `host`, `host-tool-policy`, `host-auth-routes`, `host-run-control`, `host-context-policy`, `host-managed-session-data`, `host-session-snapshot`, `extension-api-report` and CLI/session fixtures, `bun run typecheck` and full `bun test`. See [host contracts](../host.md), [stability](../stability.md) and [ENG09](https://github.com/chayapats/schway/issues/403).
