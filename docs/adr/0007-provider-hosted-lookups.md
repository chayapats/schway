# Allow provider-hosted read-only lookups inside one response

Schway owns the agent loop. The Grok subscription route was accepted as a model transport only ([research](../research-grok-subscription.md#1-boundary-schway-must-keep)), and every tool call runs through Schway's executor and approval checks. xAI's Responses API also offers server-side web search: the provider runs a search inside one model response and returns `web_search_call` output items beside the answer. A turn that needs current facts can then take one model call instead of several rounds of shell scraping (#323).

## Decision

A provider-hosted, read-only lookup that finishes inside a single model response is allowed. It is a feature of that one response, like reasoning, not a tool Schway runs.

- **Schway still owns the loop.** Retries, cancellation, compaction, sessions and every function tool stay with Schway. Schway never hands a multi-turn loop to the provider: no `store: true`, no `previous_response_id` and no provider-side tool execution beyond the hosted lookup. A hosted lookup cannot write files, run commands or call Schway's tools.
- **Read-only, so every approval mode.** A hosted search reads public web pages on the provider's side. It runs in `auto`, `ask` and `read-only` alike and never waits for approval. Like `web_fetch` ([ADR 0005](0005-approval-modes-in-core.md#note-web_fetch-318)), reading only is not the same as staying offline: the provider derives the search query from the conversation, so workspace content can reach a search engine through it.
- **Closed and provider-independent.** `ModelRequest.hostedTools` is an optional list from the closed union `HostedTool`, which starts with `"web_search"`. Core holds no provider wire types. An adapter that cannot honor an entry ignores it and never fails the request because of it.
- **Chosen by Schway, once per session model.** The loop decides the list from the model, its route, the `webSearch` setting and the registered function tool names, and attaches it after extension hooks run. Hooks never see it and cannot set it. Compaction summaries, model lists, capability discovery, evals and live-smoke runs never send it.
- **Kept for replay in existing metadata.** Hosted output items are stored, capped, in message-level `providerMetadata` of the provider's namespace and replayed in their original position. No new content block and no session format change.

## Routes

Hosted search is sent only on routes and models in a static allowlist (`HOSTED_TOOL_ALLOWLIST` in `src/model/hosted-tools.ts`), and only while `webSearch` is `auto`. Each entry requires recorded live evidence of hosted search and stateless replay on that route and model. The production allowlist is empty because no such evidence is recorded.

| Route | Model | Hosted web search | Evidence |
| --- | --- | --- | --- |
| xAI API key | `grok-4.7` | **Off** | xAI documents hosted search and stateless conversations ([web search](https://docs.x.ai/developers/tools/web-search), [advanced usage](https://docs.x.ai/docs/guides/tools/advanced-usage), read 2026-10-08), but no route/model hosted-search and replay live evidence is recorded. |
| Grok subscription | any | **Off** | No route/model hosted-search and replay live evidence is recorded. |
| xAI API key | other models | **Off** | No route/model hosted-search and replay live evidence is recorded. |
| Native OpenAI, ChatGPT subscription, OpenAI-compatible | any | **Off** | Out of scope; these routes must stay off. |

A route and model enter the allowlist only with recorded live hosted-search and replay evidence, cited in the entry and in [live-provider guidance](../live-providers.md#hosted-web-search-check). Documentation, protocol fixtures and ordinary release evals do not establish this support. Real-work dogfood (#161) supplies latency evidence and may record this support; a separate live probe is not required (#316). The existing opt-in check remains an operator diagnostic. A route that rejects search is recorded as unsupported. If recorded live evidence shows xAI rejects replayed hosted items on `store: false` but accepts the follow-up without them, that route turns off `XAI_HOSTED_ITEM_REPLAY`: the items stay stored and are left out of the request.

## Consequences

- xAI bills hosted searches per call on the API-key route ([pricing](https://docs.x.ai/developers/pricing)). `webSearch: "off"` stops them. The per-call usage record carries the kept search count and xAI's own counter when reported.
- An extension that registers a function tool named `web_search` keeps it, and hosted search stays off for that session, so the model never sees two tools with that name.
- Search queries are stored with the session, like any other conversation content. Citations and source lists are not stored or shown; the TUI shows one compact line per answer that searched.
