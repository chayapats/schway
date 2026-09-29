# Use public xAI OAuth for Grok subscriptions

SuperGrok subscribers need to use their account through Schway's own agent loop. Schway uses Grok Build's published public OAuth client identifier `b1a00492-073a-47ea-816f-4c329264a828`, with `referrer=schway`, for PKCE browser approval and device approval. This decision is implemented by #134; live verification with the maintainer's account remains tracked in #138.

Request only `openid profile email offline_access grok-cli:access api:access`. Store and refresh tokens in the OS secure store under `grok-subscription:xai`. Inference uses the public `api.x.ai` Responses API, reuses the xAI adapter and sets `store: false`. Never read `~/.grok/auth.json` or call the private Grok Build proxy. Schway owns tools, sessions, cancellation and transient retries; a rejected access token gets one refresh and one resend within the transport.

Grok subscription and xAI API-key billing are separate routes. Explicit selection never reads the other route's credentials, and renewal or plan failures never cause billing fallback. A plan-level 403 leaves the saved login available for a retry after the plan changes. Only explicit logout removes it.

## Consequences

The shared client is not controlled by Schway. xAI may revoke, restrict or plan-gate it. Grok is a hard v1 release gate, so withdrawal of access delays 1.0. The [research note](../research-grok-subscription.md) records the feasibility evidence and shared-client risk without claiming live inference verification.
