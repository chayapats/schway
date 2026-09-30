# Changelog

## [Unreleased]

## [0.4.0] - 2026-09-30

Versions before 0.4.0 were not published to npm.

### Breaking

- The Anthropic provider was removed (#131). Selecting it prints this notice:

  ```text
  The Anthropic provider was removed in 0.4.
  Use Claude through an OpenAI-compatible endpoint:
    schway --provider openai-compatible --base-url <url> --model <id>
  See docs/configuration.md
  ```

  Run `schway doctor` to detect an unused Anthropic key in the OS secure store.
  If present, doctor prints this cleanup command:

  ```sh
  bun -e 'await Bun.secrets.delete({ service: "schway", name: "api-key:anthropic" })'
  ```

- Headless runs without a configured model now fail with
  `No model configured. Pass --provider and --model, or set them in config.`
  (#132).

### Added

- xAI API-key access through `--provider xai --xai-auth api-key`, with
  `XAI_API_KEY` or a key saved through `/login xai` (#133).
- Grok subscription browser and device sign-in through `/login grok` and
  `/login grok --device`, with separate secure storage and no API-key billing
  fallback (#134).
- Provider model lists, account model discovery after sign-in, and model
  selection from advertised capabilities (#132).
- `bun run eval --max-spend <usd>` to limit live eval spend between cases,
  including a stop when usage is incomplete (#130).
