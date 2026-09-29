# Remove the Anthropic provider

The Anthropic route saw little use while its protocol and authentication support added ongoing maintenance cost. We removed the native provider in 0.4 and direct users to an OpenAI-compatible endpoint for Claude. The removal is implemented on main; this record also preserves the migration requirements and the effect of #132 on defaults.

The removal covers the Messages adapter, SDK dependency, protocol fixtures and tests, catalog entries, credential kind, auth route and provider documentation. Configuration or `--provider anthropic` fails at startup in both interactive and headless execution with the notice defined in `src/config/removed-provider.ts`:

```text
The Anthropic provider was removed in 0.4.
Use Claude through an OpenAI-compatible endpoint:
  schway --provider openai-compatible --base-url <url> --model <id>
See docs/configuration.md
```

Stored Anthropic credentials are ignored. `doctor` reports them as unused and supplies a removal command. Old sessions remain resumable with a supported route. Provider-specific reasoning data is never replayed to a different provider, and the canonical conversation model is unchanged.

## Consequences

There is no built-in default provider or model (#132). [ADR 0001](0001-interactive-choice-memory.md) retains its precedence: its built-in-defaults tier is now empty for provider and model. Remembered interactive choices remain below explicit configuration, and headless execution does not automatically consume them. Removing a provider does not restore an old billing route from session history.
