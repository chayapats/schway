# Research: Grok subscription integration for Schway

Status: **feasible, with moderate terms-of-service risk.** This is the research
handoff for the Grok subscription route (#134, part of the v1.0 spec #128).
Live inference: **not run**. The only network requests were reads of public pages
and one unauthenticated fetch of xAI's OIDC discovery document. No credentials
were used.

- Research date (UTC): 2026-09-29
- Schway baseline: `981601d`
- Grok Build source inspected: `xai-org/grok-build` at
  `f0e3be1100ef5252488e3be8bb0e91cf68d8c305` (2026-09-23)

## 1. Boundary Schway must keep

Schway owns the agent loop (specification §94.1). The Grok route must be a
**model transport only**: Schway builds the request, receives tool calls, runs its
own tools, returns the results, and keeps retries, compaction, cancellation and
sessions.

Driving Grok Build itself, headless or over its ACP (Agent Client Protocol)
interface, would hand the loop to Grok Build. That fails this boundary, so it is
out of scope. It is the same reason the Codex App Server path was rejected.

## 2. What Grok Build is (verified)

| Fact | Source |
|---|---|
| Grok Build is xAI's coding-agent CLI/TUI, written in Rust, Apache-2.0, with interactive, headless and ACP modes | <https://github.com/xai-org/grok-build>, <https://docs.x.ai/build/overview> |
| The repository accepts no external PRs; it is published for source transparency | CONTRIBUTING.md in the repository |
| Announced 2026-05-25 as an early beta for SuperGrok and X Premium+ subscribers | <https://x.ai/news/grok-build-cli> |
| 1.0.0 shipped 2026-08-07; the latest release at research time was 1.0.40 (2026-09-20) | <https://x.ai/build/changelog> |
| Usage is tiered: the source hides `/usage` for free and X Basic accounts. No official per-plan limit table was found. | Grok Build source, changelog |

## 3. OAuth (verified)

The OIDC discovery document at `https://auth.x.ai/.well-known/openid-configuration`
was fetched live on 2026-09-29:

- issuer `https://auth.x.ai`
- `authorization_endpoint` `https://auth.x.ai/oauth2/authorize`
- `token_endpoint` `https://auth.x.ai/oauth2/token`
- `device_authorization_endpoint` `https://auth.x.ai/oauth2/device/code`
- grants: `authorization_code`, `refresh_token`,
  `urn:ietf:params:oauth:grant-type:device_code`
- `token_endpoint_auth_methods_supported` includes `none`, so public clients are allowed
- `code_challenge_methods_supported`: `S256`
- scopes include `openid profile email offline_access grok-cli:access api:access`,
  plus conversation, workspace, team, billing and api-key scopes that Schway does not need

**Grok Build's own client:**

- Client identifier `b1a00492-073a-47ea-816f-4c329264a828`, wrapped in an
  `obfstr!` macro in its login crate's config.
- A loopback redirect `http://127.0.0.1:<port>/callback`.
- Default scopes add `conversations:*` and `workspaces:*` to the set above.
- A `referrer` field documented as "Client-supplied referrer so analytics can
  attribute OAuth usage"; Grok Build sends `grok-build`.
- Tokens are stored in `~/.grok/auth.json`.

**Third-party clients using the same client identifier, verified in their source:**

| Client | Details |
|---|---|
| OpenCode | `packages/opencode/src/plugin/xai.ts`: scopes `openid profile email offline_access grok-cli:access api:access`, `referrer: "opencode"`, device-code flow with RFC 8628 `slow_down` handling, refresh two minutes before expiry. Merged 2026-05-21 (PR #28557). |
| Zed | `crates/x_ai_subscribed`: loopback port 56121, Chat Completions. Its 403 message reads: "Login succeeded, but this Grok account cannot use the API (HTTP 403). Some plans do not include this access. You can also use the separate xAI provider with an API key from console.x.ai." (PR #63248, 2026-09-16) |
| Hermes | Device-code flow, Responses API, base URL `https://api.x.ai/v1`. Notes that access tokens are short-lived (~6 h) and refreshes one hour early. <https://hermes-agent.nousresearch.com/docs/guides/xai-grok-oauth> |

goose, Warp, litellm, vercel/ai, mastra, openclaw and Kilo also reference the same
client identifier (seen in code search; not individually verified).

## 4. Inference transport (verified)

- **Third-party clients** send the OAuth access token as `Authorization: Bearer`
  to the **public** API `https://api.x.ai/v1`.
- **Grok Build itself** calls a private proxy, `https://cli-chat-proxy.grok.com/v1`,
  with extra headers (`X-XAI-Token-Auth: xai-grok-cli`, `x-userid`,
  `x-grok-client-version`).
  - Schway must **not** use this proxy. It is a private interface of another client.
- **Protocol choice:** xAI recommends the Responses API and marks Chat Completions
  as deprecated/legacy (<https://docs.x.ai/developers/model-capabilities/text/reasoning>
  and the Responses comparison page).
  - The Responses API stores responses server-side for 30 days by default
    (`store: true`). Schway's existing Responses adapter already sends
    `store: false`, and the Grok route must keep that.
  - `grok-4.7` always returns `reasoning.encrypted_content` on Responses, and
    Schway already carries encrypted reasoning across turns for OpenAI.

## 5. Models and reasoning (verified from xAI docs, 2026-09-29)

- <https://docs.x.ai/developers/models> recommends `grok-4.7` for code. It also
  lists `grok-4.6`, `grok-4.5`, `grok-4.3` and the `grok-4.20-*` family, and
  `grok-build-0.1` (256k context).
- `GET /v1/models` lists the models available to the caller, with
  `capabilities.reasoning_effort`, `default_reasoning_effort` and `context_length`.
- On `grok-4.5`, `4.6` and `4.7`, reasoning effort accepts `low`, `medium` and `high`,
  plus `xhigh` on 4.6 and 4.7. The default is `high`, and reasoning cannot be
  turned off. Chat Completions takes `reasoning_effort`; Responses takes
  `reasoning.effort`.
- No official `grok-code-*` or `grok-5` model exists. `grok-code-fast-1` appears
  only in legacy references.

Model names must be read from `/v1/models` at implementation time, not copied
from this note (spec #128).

## 6. Terms of service

- **Verified, supportive:** xAI's post "Use Grok in OpenCode" (2026-05-21,
  <https://x.ai/news/grok-opencode>) promotes using a SuperGrok or X Premium
  subscription inside OpenCode through OAuth, and says "More open-source agents
  and integrations are coming soon."
- **Verified, neutral:** the consumer terms (<https://x.ai/legal/terms-of-service>,
  updated 2026-09-11) forbid sharing account credentials and route APIs to the
  enterprise terms. No clause permits or forbids third-party clients for consumer
  subscriptions.
- **Not found:** any published client registration for third-party developers,
  or any statement that other clients may reuse Grok Build's client identifier.
- **Precedent in Schway:** the Codex subscription route (#50) already uses the
  published Codex client identifier, which reversed the stricter stance in
  `research-codex-subscription.md` §1. The Grok route follows the same precedent.
  Grok Build obfuscates its identifier in source, but xAI's endorsement of
  OpenCode, which reuses it, is the stronger signal.
- **Contrast:** Anthropic reportedly banned subscription OAuth in third-party
  apps in February 2026 (secondary source only). A provider can change this at
  any time.

**Risk accepted in #128:** xAI could revoke or restrict the shared client
identifier, or gate it by plan. Because the Grok route is a hard v1 gate, such a
change would delay 1.0.

## 7. Decisions for #134

- Use OAuth against `auth.x.ai` as a public client with Grok Build's published
  client identifier and `referrer=schway`.
- Request only `openid profile email offline_access grok-cli:access api:access`.
- Support authorization code with PKCE (S256) over a loopback redirect, and the
  device-code flow (RFC 8628, honoring `interval` and `slow_down`).
- Store tokens in the OS credential store, never in Grok Build's files. Refresh
  ahead of expiry and after a 401. A rejected refresh requires interactive
  sign-in; headless fails with an actionable error.
- Send inference to `https://api.x.ai/v1` Responses with `store: false`, reusing
  the OpenAI Responses adapter behavior (including encrypted reasoning).
- Never read `~/.grok/auth.json`, and never call `cli-chat-proxy.grok.com`.
- A plan-level 403 shows an actionable message pointing to the xAI API-key
  route. There is no automatic billing fallback.
- Build reasoning choices from `/v1/models` capabilities. Models that always
  reason offer no `off`.

## 8. Open questions (to settle during #134 or live verification)

1. Whether OAuth tokens on `api.x.ai` draw on subscription quota for every plan,
   and which plans return 403. There is no official list; the maintainer's plan
   is SuperGrok.
2. Whether `api.x.ai/v1/models` called with an OAuth token reflects subscription
   entitlements or the generic API catalog. Hermes implies it works; unverified.
3. Actual access-token lifetime (reported ~6 h), refresh-token rotation, and what
   `referrer` changes server-side. All inferred from client code, not documented.
4. Whether xAI will publish per-client registration. If it does, switch to
   Schway's own client identifier.
