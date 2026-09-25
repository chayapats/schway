# Local readiness diagnostics

Run `schway doctor` before starting a conversation; it does not call a model, open a login browser, install packages or execute extension modules.

```bash
schway doctor
schway doctor --json
schway doctor --provider openai-compatible --base-url http://127.0.0.1:11434/v1 --auth none
schway doctor --provider openai --openai-auth codex
```

The CLI reads the selected configuration from `~/.schway/config.json` and the canonical primary workspace's `.schway/config.json`. CLI provider, profile, authentication, connection and extension flags override or augment configuration, as in a normal run. `--env-file` is read only if explicitly requested. Doctor never prints API key contents, stored subscription tokens, HTTP headers or native store exceptions. Its checks only read metadata and key presence; a healthy local result does **not** prove connectivity, provider billing or a successful refresh. Subscription expiry/refresh warnings come from locally stored token timestamps, not a network validation.

Readable output is one `[OK]`, `[WARNING]` or `[ERROR]` line per check with a fix for non-OK results. `--json` emits a single object on stdout (`schemaVersion: 1`, `version`, `runtime`, `platform`, optional `workspace`, `provider`, `profile`, `authSource`, and `checks`). Each check has stable `id`, `status` (`ok`, `warning`, `error`), `summary` and `remedy` fields. A disabled optional capability (no extensions, optional compatible auth without a credential) is healthy or warning; an enabled missing module or required credential is an error. When configuration is malformed, unrelated workspace, runtime, storage and package findings remain visible; provider/auth status may require fixing config first.

Exit statuses: **0** no required check failed (warnings allowed); **1** diagnosed required failure; **2** doctor could not complete, such as invalid doctor arguments or cancellation. No files are written by doctor itself. Filesystem permission checks are observational and cannot guarantee that a later disk write succeeds. Extension runtime behavior and live authentication require a real run to verify.
