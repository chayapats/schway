---
status: accepted
scope: ENG05 host auth routes
---

# Bind explicit Grok/Codex routes with opaque shared credential lifecycle

ENG05 implements `schway.host.auth-routes/v1` for FR-13/17 and NFR-02/03/07/10, refining the implemented ENG01/03/04 seams and S02 #393. It does not certify a production Jit bridge, Linux unattended availability, a new secret backend, billing changes or foreign-CLI credential import.

Host `auth` binds one exact model with the `codex` or `grok` route. The selection carries only route, model, an opaque account/label reference, an optional isolated store, an optional environment map and an optional protocol-fixture fetch; raw tokens, API keys and stored bodies are rejected as `invalid-options` and unknown routes as `unsupported-policy`. Environment API keys are ignored for subscription routes. Grok and Codex endpoint, store-identity and renewal lifecycles stay isolated; auth, quota or model failures never switch provider, model, credential source, API-key billing or plaintext storage.

Static `describeAuthRoute` and `hostCapabilities` report support without store, network or adapter loading. `checkAuthReadiness` reads only the selected identity locally and returns `configured-unverified` distinct from observed inference, plus `needs-login`, `store-unavailable`, `invalid-store` and live failure categories with safe next actions. `submitWithRoute` reuses the existing subscription renewal and generation fencing: Grok's per-store lifecycle is shared directly, while Codex gains the same WeakMap-shared single-flight and generation-fenced writes so concurrent runs share one refresh and logout or account replacement prevents stale refresh writes. Cancelling one caller detaches without corrupting others. Only the selected adapter loads dynamically when the route is actually used; capability enumeration never initializes providers or the TUI. SDK retries stay disabled; transport refresh and Schway's bounded retry policy stay authoritative.

Failures map to `rejected`, `quota-exceeded`, `model-unavailable` and `integration-unavailable` without native secret errors, token payloads/headers or stored bodies in metadata, prompts or diagnostics. Classification never includes raw error text. Linux store expectations follow the credentials guide; unattended availability is not claimed before S01 evidence.

Evidence: `tests/host-auth-routes.test.ts`, protocol fixtures, fake stores, subprocess import traces, existing subscription-route/Grok/Codex compatibility fixtures, `bun run typecheck` and full `bun test`. See [host contracts](../host.md) and [ENG05](https://github.com/chayapats/schway/issues/398).
