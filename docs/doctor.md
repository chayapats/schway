# Local readiness diagnostics

## Diagnose local readiness

Doctor reports runtime, workspace, shell/search, session storage, configuration,
configured model, selected authentication and enabled skill/extension metadata
without starting a model or executing extensions.

Run `schway doctor` before starting a conversation; it does not call a model, open a login browser, install packages or execute extension modules.

Run `schway doctor --help` for grouped diagnostic options and examples. Use
`schway --help` for the main command, including model and session options.
Help does not read configuration or run diagnostics.

Use `schway --version` (or `schway -V`) to print `schway <package-version>`
without reading configuration, checking credentials or running diagnostics. It
works outside a Git repository and without `HOME`. Include this output when
reporting a bug, even if doctor cannot complete.

Run either version flag on its own. Adding `--help` or `-h` shows the main help
instead. Other combinations, including `doctor --version`, `--version --json`
and repeated version flags, fail with exit status **1** before setup is read.
Lowercase `-v` is not supported.

Choose an exact ID from the intended route with the [headless route guides](headless.md#choose-your-route-run-and-resume),
then assign it to `MODEL_ID` in a POSIX shell (`IFS= read -r MODEL_ID`). Doctor
checks its local configuration without testing remote access. Bare doctor
commands below diagnose existing config and can report a missing model; they
are not a promised healthy result after interactive sign-in.

```bash
schway doctor
schway doctor --json
schway doctor --provider openai-compatible --base-url http://127.0.0.1:11434/v1 --auth none --model "$MODEL_ID"
schway doctor --provider openai --openai-auth codex --model "$MODEL_ID"
```

For a missing-model error, list the intended route's models, choose an exact ID,
and rerun the task or doctor with that ID and the same auth selector. Interactive
model memory remains ignored. Doctor has no `--show-session`: only a text task
can emit a persisted resume hint. See [task output](headless.md#output-and-session-ids),
[sessions](sessions.md), [credentials](credentials.md) and
[configuration](configuration.md) for the full run/resume sequence.

## Options and exit status

The CLI reads the selected configuration from `~/.schway/config.json` and the canonical primary workspace's `.schway/config.json`. CLI provider, profile, model, authentication, connection and extension flags override or augment configuration, as in a normal run. `--env-file` is read only if explicitly requested; process `HOME` must already be set and cannot be relocated by a `HOME` entry in that file (matching ordinary runs). Doctor never prints API key contents, stored subscription tokens, HTTP headers or native store exceptions. Its checks only read metadata and key presence; a healthy local result does **not** prove connectivity, provider billing or a successful refresh. Subscription expiry/refresh warnings come from locally stored token timestamps, not a network validation.

Readable output is one `[OK]`, `[WARNING]` or `[ERROR]` line per check with a fix for non-OK results. `--json` emits a single object on stdout (`schemaVersion: 1`, `version`, `runtime`, `platform`, optional `workspace`, `provider`, `profile`, `authSource`, and `checks`). Each check has stable `id`, `status` (`ok`, `warning`, `error`), `summary` and `remedy` fields. A disabled optional capability (no extensions, optional compatible auth without a credential) is healthy or warning; an enabled missing module or required credential is an error. When configuration is malformed, unrelated workspace, runtime, storage and package findings remain visible; provider/auth status may require fixing config first.

Exit statuses: **0** no required check failed (warnings allowed); **1** diagnosed required failure; **2** doctor could not complete, such as invalid doctor arguments or cancellation. No files are written by doctor itself. Filesystem permission checks are observational and cannot guarantee that a later disk write succeeds. Extension runtime behavior and live authentication require a real run to verify.

## Configured model

The stable `model` check reports whether the effective headless settings name a
nonblank model. `--model` overrides file settings; project settings override user
settings. A selected compatible profile supplies its own model, with an explicit
`--model` taking precedence. A profile with no model does not inherit a direct
file model. Changing providers without selecting a model clears an inherited
model, as in a headless run.

An explicitly configured model produces `ok` and `Configured model: <id>`.
Printed IDs are bounded and stripped of terminal controls and recognized or
already observed credential values before display.
Custom IDs pass this presence check without catalog discovery or a remote
entitlement check. Capability and thinking validation remain separate: an
unsupported thinking setting can still produce a required provider/settings
failure while the model presence check is `ok`.

Without an explicit model, doctor reports `No model configured` as an `error`
and exits **1**. The remedy is `Pass --model <id> or set model in config, then run
schway doctor again.` This is a repair template, not a recommended model.
For the `local` profile shown in the [compatible setup](headless.md#compatible-endpoint-or-profile),
with `MODEL_ID` chosen from that endpoint, for example:

```bash
schway doctor --profile local --model "$MODEL_ID"
```

Malformed configuration or an unresolved provider/profile produces a `model`
warning with fix-configuration-first guidance. The underlying required error
and independent readiness checks remain visible. Missing credentials and a
missing model can both be reported.

Doctor does not read remembered TUI choices or use a historical session model
or built-in fallback to satisfy this check. It does not persist a selection,
fetch model catalogs, refresh credentials, request inference, or change the
selected auth route or billing. A successful local check does not establish
remote model availability or authorization.

## Repair invalid configuration

For example, `{"approval":{"mode":"readonly"}}` previously produced a vague
configuration error and an apparent package fault. Doctor now reports
`Invalid approval.mode · Use auto, ask, or read-only` under `config.user` or
`config.project`, with the affected file named in the remedy. Change the value
to `"read-only"`, then rerun `schway doctor`. Normal startup reports the same
cause and file, exits 1, and leaves stdout empty.

Both invalid files are reported when user and project configuration need repair.
When both scopes resolve to the same file, one config check reports the failure
and the other points to that check for repair.
Package inspection that depends on an invalid file is marked incomplete and
points back to its config check; a real missing package in another scope still
appears. Workspace, storage, skill and extension checks continue when safe.
Doctor does not modify the files or install anything.

Config-related checks can include an optional `diagnostics` array in JSON.
Each item has `source` (sanitized file path or settings source), `path` (known
schema fields), `category`, and `constraint`; enum failures also include
`values`. Categories are `json`, `root`, `unknown-setting`, `enum`, `type`,
`range`, `constraint`, `secret`, `unreadable`, `removed-provider`, and
`deprecated`. Unknown setting names and dynamic profile/header segments appear
as `<unknown setting>`, with known children retained, such as
`profiles.<unknown setting>.baseUrl`. Invalid values are never included.
Source identifiers are bounded and stripped of terminal controls and recognized
credentials. Doctor also redacts known API-key and credential-header values from
source labels and remedies before bounding them. This includes values loaded by
an explicit `--env-file` and environment values named by valid `credentialEnv`
references in either config file, including a file with other invalid settings.
Normal startup uses the same sanitized reasons. Schema version 1 and each
check's required fields remain unchanged.
For automation, use check ID, diagnostic source/path/category and status;
do not depend on prose or `package.<index>` ordering. See
[configuration](configuration.md#configuration-files) for another
recovery example and the full configuration contract.

## Grok login status

`schway doctor --provider xai --xai-auth grok` checks only the saved Grok OAuth login for authentication. It reports present, needs refresh (within two minutes of expiry), expired without refresh, invalid, or missing. The check is local: it does not load the Grok adapter, contact xAI, open a browser or read another CLI's cache. Use `/login grok` or `/login grok --device` to repair the login; explicitly select `--xai-auth api-key` if you intend to use API-key billing.

## Undo storage

The stable `undo-store` check reads only file sizes under `~/.schway/undo`.
It reports `Undo store: <size> MB.` in MiB to one decimal place, including
`Undo store: 0.0 MB.` when no store exists. It is `ok` within `undo.maxSizeMB`
(default `500`) and `warning` above it, with the remedy
`Lower undo.maxSizeMB or delete old sessions.` Doctor never prunes or creates
undo storage; this check also appears in `--json` output.

## Approval configuration

The stable `approval-config` check reports the effective file-configured approval mode. A looser project `approval.mode` produces a warning and names the config path to repair. Doctor ignores `--approval`; it diagnoses the saved user/project baseline rather than a run-time mode override.
