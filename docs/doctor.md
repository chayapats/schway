# Local readiness diagnostics

## Diagnose local readiness

Doctor reports runtime, workspace, shell/search, session storage, configuration,
selected authentication and enabled skill/extension metadata without starting a
model or executing extensions.

Run `schway doctor` before starting a conversation; it does not call a model, open a login browser, install packages or execute extension modules.

Run `schway doctor --help` for grouped diagnostic options and examples. Use
`schway --help` for the main command, including model and session options.
Help does not read configuration or run diagnostics.

```bash
schway doctor
schway doctor --json
schway doctor --provider openai-compatible --base-url http://127.0.0.1:11434/v1 --auth none
schway doctor --provider openai --openai-auth codex
```

## Options and exit status

The CLI reads the selected configuration from `~/.schway/config.json` and the canonical primary workspace's `.schway/config.json`. CLI provider, profile, authentication, connection and extension flags override or augment configuration, as in a normal run. `--env-file` is read only if explicitly requested; process `HOME` must already be set and cannot be relocated by a `HOME` entry in that file (matching ordinary runs). Doctor never prints API key contents, stored subscription tokens, HTTP headers or native store exceptions. Its checks only read metadata and key presence; a healthy local result does **not** prove connectivity, provider billing or a successful refresh. Subscription expiry/refresh warnings come from locally stored token timestamps, not a network validation.

Readable output is one `[OK]`, `[WARNING]` or `[ERROR]` line per check with a fix for non-OK results. `--json` emits a single object on stdout (`schemaVersion: 1`, `version`, `runtime`, `platform`, optional `workspace`, `provider`, `profile`, `authSource`, and `checks`). Each check has stable `id`, `status` (`ok`, `warning`, `error`), `summary` and `remedy` fields. A disabled optional capability (no extensions, optional compatible auth without a credential) is healthy or warning; an enabled missing module or required credential is an error. When configuration is malformed, unrelated workspace, runtime, storage and package findings remain visible; provider/auth status may require fixing config first.

Exit statuses: **0** no required check failed (warnings allowed); **1** diagnosed required failure; **2** doctor could not complete, such as invalid doctor arguments or cancellation. No files are written by doctor itself. Filesystem permission checks are observational and cannot guarantee that a later disk write succeeds. Extension runtime behavior and live authentication require a real run to verify.

## Grok login status

`schway doctor --provider xai --xai-auth grok` checks only the saved Grok OAuth login for authentication. It reports present, needs refresh (within two minutes of expiry), expired without refresh, invalid, or missing. The check is local: it does not load the Grok adapter, contact xAI, open a browser or read another CLI's cache. Use `/login grok` or `/login grok --device` to repair the login; explicitly select `--xai-auth api-key` if you intend to use API-key billing.

## Undo storage

The stable `undo-store` check reads only file sizes under `~/.schway/undo`.
It reports `Undo store: <size> MB.` in MiB to one decimal place, including
`Undo store: 0.0 MB.` when no store exists. It is `ok` within `undo.maxSizeMB`
(default `500`) and `warning` above it, with the remedy
`Lower undo.maxSizeMB or delete old sessions.` Doctor never prunes or creates
undo storage; this check also appears in `--json` output.
