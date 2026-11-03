# API keys and OS secure storage

Schway resolves API keys in this order: an explicit `--api-key`, the selected
provider's environment variable, its saved OS credential, then missing credentials.
An explicitly empty `--api-key` is an error and never falls back. Blank environment
values fall through. Usable runtime/environment keys bypass the OS store, so a
locked store does not stop these runs.

| Provider | Environment override | Stored identity |
| --- | --- | --- |
| `openai` | `OPENAI_API_KEY` | Native OpenAI |
| `xai` | `XAI_API_KEY` | `api-key:xai` |
| `openai-compatible` | `OPENAI_COMPATIBLE_API_KEY` | Canonical configured endpoint |

`OPENAI_COMPATIBLE_API_KEY` explicitly applies to the currently selected compatible
endpoint. Native `OPENAI_API_KEY` is never used for a compatible endpoint. Saved
compatible keys are isolated by canonical HTTP(S) URL: host case, default ports and
trailing slashes normalize; paths, query values and user information remain part
of identity. The store uses an opaque SHA-256 account identifier, and display labels
show only the host and a short identity digest. A compatible endpoint pointing at
OpenAI still has a separate identity from native OpenAI.

## Explicit interactive management

Start an interactive session and type `/login` or press Alt+L. The chooser groups
connections by what you pay for: **Subscription** (ChatGPT, Grok), **API key**
(OpenAI, xAI), and **Custom endpoint** (OpenAI-compatible). ChatGPT browser approval
is recommended. Use ↑↓ to select a row and Enter to start its primary method.
Tab on ChatGPT opens **Device approval** and **Paste browser callback**; Tab on Grok
opens **Device code**. Esc returns one level. Callback and API key entry are masked,
stay outside prompt recall and session history, and return to their originating
chooser row on Esc. Your composer draft and cursor survive every step.

Your first connection works the same from `/login` and `/model`: after saving the
credential, Schway lists the route's models and activates a provider-marked default,
a known supported model present in the list, or the only listed model. The composer
returns ready to type, with the selected model and access/billing route visible.
No task is sent during sign-in. If discovery fails, returns no models, or has no
reliable default, use `/model` to choose or retry. The credential stays saved;
Alt+L lets you sign in again.

Adding a connection while another model is usable keeps that model and its billing
route. Use `/model` when you want to switch. Reconnecting an active ChatGPT or Grok
subscription refreshes its adapter while retaining its selected model. If that model
is no longer available, choose another explicitly. Authentication, quota and model
discovery failures never switch to another model or API-key billing automatically.

OpenAI-compatible asks for an **Endpoint URL**, then a masked API key. Nothing is
saved until you submit the key. With no usable model, the new URL replaces a selected
compatible profile for this session only; user and project config files stay unchanged.
Schway lists that endpoint's models and selects a reliable default. If listing or
activation fails, the saved session URL remains available through `/model`.
With a usable model, only the endpoint's key is saved; the active settings stay intact.
To make that endpoint available for selection, set its URL with
`/config set baseUrl <url>`, then use `/model` to choose its model. This explicit
setting change can change the endpoint used by an active compatible connection.
To keep the URL, run `/config set baseUrl <url> --scope user`. Esc from key entry
returns to the typed URL; another Esc returns to the compatible chooser row.
The direct `/login openai-compatible` command keeps its key-only behavior against
the configured URL.

You can also name the provider explicitly:

```sh
schway
```

```text
/login openai
/login xai
/logout openai
/logout xai
```

`/login <provider>` opens a separate masked entry. Type or paste only the API key,
then press Enter to save. Escape cancels before submission without changing the
store. Never put a key after the slash command. Normal conversation/editor history,
configuration, session JSONL and notices do not receive the entry text. A successful
save replaces only that identity. Empty or invalid entry saves nothing. Once Enter
submits an OS write, wait for its outcome: the native operation cannot be cancelled.

`/logout <provider>` deletes only that saved identity; a missing identity is reported
without error. Runtime and environment overrides remain unchanged, and the notice
identifies any override that still applies. Saving or removing the active provider's
key refreshes its adapter so future requests use the newly resolved source.

ChatGPT sign-in reports browser/device approval, OS secure-store saving, account
model discovery and activation as separate steps. A callback response alone does
not mean the connection is ready. If model discovery fails after saving, open
`/model` to retry without repeating OAuth. Cancelling after a successful store
write keeps the credential and reports that it remains saved. Device approval
codes appear only in the temporary approval panel. Logging out of an active
ChatGPT account blocks that account's adapter and reports any explicit API-key
overrides; it does not switch billing automatically.

For a compatible endpoint, configure its base URL before saving a key:

```sh
schway --provider openai-compatible --base-url https://example.com/v1 --auth required
```

```text
/login openai-compatible
/logout openai-compatible
```

Changing the endpoint selects a different stored credential. With `--auth optional`
(the compatible default), a missing key is allowed; when a key is available it is
used. If the OS store cannot be read, optional auth still runs without a key.
With `--auth none`, no automatic authentication header is sent and the OS store
is not read. An explicitly empty runtime override is still rejected.

A later headless invocation can reuse the saved key, but still needs an explicit
model and billing route. In a **POSIX shell**, after `/login openai`:

```sh
schway models list --provider openai --openai-auth api-key
# Paste an exact ID returned by that route.
IFS= read -r MODEL_ID
schway --provider openai --openai-auth api-key --model "$MODEL_ID" -p 'Explain this repository' --show-session
```

For a compatible service, start/configure the endpoint and its own credential,
then use the [complete profile flow](headless.md#compatible-endpoint-or-profile).
For existing subscriptions, use the separate [ChatGPT/Codex](headless.md#existing-chatgptcodex-subscription)
or [Grok](headless.md#existing-grok-subscription) flow, even when API keys also
exist. Listing, task and resume must retain the intended auth route; `--resume`
does not restore old credentials or billing. Copy the exact hint ID or find it
with `sessions list`; see [saved sessions](sessions.md) and
[output formats](headless.md#output-and-session-ids). [Doctor](doctor.md) reports
local credential/model readiness, not live access.

Headless mode never opens a login prompt. `/login` and `/logout` are interactive
commands. Keys cannot be stored in ordinary config files, and Schway does not
silently create plaintext credentials when secure storage is unavailable.

## Platform requirements and recovery

Schway uses the experimental `Bun.secrets` API (developed with Bun 1.4.2):

- macOS: Keychain access for the current user. Unlock the keychain and allow Bun
  access when macOS asks.
- Linux: `libsecret` and a running Secret Service, such as GNOME Keyring or KWallet,
  available in the user's desktop/D-Bus session. A minimal server/container may not
  have one.
- Windows: Windows Credential Manager for the current user.

See [Bun's Secrets documentation](https://bun.sh/docs/runtime/secrets).
Denied, locked or unavailable reads needed for native providers or required
compatible auth, plus saves and deletions, return recovery guidance without
printing the native error or key. Optional compatible auth runs without a key
when a read fails. Restore OS access and retry to use a saved key, or supply the
provider environment variable or `--api-key`. Saving and deleting still require
working secure storage. ChatGPT subscription OAuth uses a separate stored
identity; see [subscription login](configuration.md#chatgpt-subscription-codex-oauth).
Credentials are never migrated from another CLI.

## Credential-store lock

Saves, deletions and exact-value cleanups that Schway makes in the OS secure
store take one lock shared by every local Schway process, including separate
host runs that share a credential lifecycle. Two Schway-mediated mutations never
overlap. Reads stay outside the lock. Raw keychain tools and other applications
are outside this guarantee.

**Primitive.** The lock is a SQLite `BEGIN IMMEDIATE` transaction (`bun:sqlite`)
on a lock file. The transaction writes nothing and creates no journal. SQLite
holds it as a POSIX advisory record lock (`fcntl`) on macOS and Linux, including
Raspberry Pi ARM64, and as a `LockFileEx` lock on Windows. The operating system
drops the lock when the holding process exits for any reason, including SIGKILL,
an out-of-memory kill or a crash. There is no owner file, liveness check or stale
lock to remove, so concurrent contenders cannot remove each other's lock.
Record locks belong to the process, so a child process such as a running tool
never keeps the lock after Schway exits. The child-process tests check blocking
and SIGKILL release on whichever platform runs them; Windows is not covered.

**Crash semantics.** If the holder dies mid-mutation, the next contender gets the
lock as soon as the operating system reaps that process. Whatever the secure
store committed before the crash stays; Schway does not roll it back. Guarded
host writes keep their own exact-value cleanup rules (see
[device-code sign-in](host.md#device-code-sign-in)).

**Bounded wait.** A contender polls every 10 ms for up to 2 seconds while another
process holds the lock, without blocking the JavaScript event loop. If the
holder outlasts the wait, the operation fails closed before contacting the
secure store, with the usual sanitized error, for example `Cannot save credential
in the OS secure store. …`. Nothing changes, and retrying is safe. A second
acquisition inside one process waits out the same bound and fails closed rather
than deadlocking.

**Location.** The lock file is `~/.schway/credential-store.lock`, created once
with mode `0600` and never removed; missing parent directories are created with
mode `0700`. Without a home directory, Schway uses
`schway-credential-store-<uid>.lock` in the system temporary directory. The lock
file must be on a local filesystem with POSIX advisory locks; network homes (NFS
without a lock daemon, some SMB mounts) may not provide them. Do not delete or
replace the file while any Schway process runs: a new file lets a later process
lock a different inode than the current holder.

**Override.** Set `SCHWAY_CREDENTIAL_LOCK_FILE` to an absolute file path to move
the lock, for example for an isolated test root or a service identity whose
home is read-only (systemd `ProtectHome=`). Point it at a writable local path
such as one under the unit's `StateDirectory=`. Schway reads the variable on every
save or deletion and creates missing parent directories. A blank value uses the
default location. A relative value is refused: saves and deletions fail closed
with the sanitized store error immediately, without contacting the store.
Processes that should serialize must use the same path; processes with
different paths do not exclude each other.

**Upgrading from earlier releases.** Earlier releases used a directory at the
same path as their lock and removed a stopped owner's directory by path, which
could admit two writers. A directory at the lock path is that older lock.
Current Schway honors it for the bounded wait and never removes it. Once the
older holder releases it, current Schway creates the lock file in its place.
Earlier releases then cannot create their directory or read an owner from the
file, so their saves and deletions fail closed until they are upgraded. Only one
scheme can admit a writer. Stop or upgrade older Schway processes, including
embedded copies, before relying on the new lock.

If saves and deletions keep failing and `~/.schway/credential-store.lock` is a
directory, an older Schway crashed while holding it. Confirm that no older Schway
process is running, then remove that directory.

While older Schway processes still run, they keep their own stale-removal race
with each other. At the moment of upgrade, that race could also remove a
just-created lock file and admit an older writer alongside a newer one. It needs
a crashed older holder and two older contenders within microseconds. Stopping
older processes before upgrading avoids it.

**Reusing the primitive.** Embedders that build their own lock this way should
follow the same rules. Create the file once with an exclusive create (`wx`).
Never open an existing lock file outside SQLite in the locking process: under
POSIX rules, closing any descriptor for that file can release all of the
process's record locks on it. Never delete or replace the file. Use
`PRAGMA busy_timeout = 0` and poll asynchronously, because a SQLite busy timeout
blocks the thread, so an in-process holder could never release. A second
connection in the same process contends exactly like another process. Close the
connection to release the lock. Evidence is in `tests/credential-store-lock.test.ts`,
which holds the lock in child processes, kills them with SIGKILL and races
contenders after a crashed holder.

## ChatGPT catalog protocol compatibility

Schway pins the catalog request's `client_version` to the verified Codex protocol
version `0.160.0`, independently of Schway's package version. Same-account,
read-only verification on 2026-10-02 showed that `0.156.1` omitted `gpt-6.1-sol`,
while changing only this query version to `0.160.0` returned it with `medium`
reasoning support. Schway does not need Codex installed or read its credentials
or model cache at runtime.

When updating the pin, verify the candidate against an official Codex release and
repeat Schway's read-only catalog fetch with the same subscription account,
endpoint, headers and parser, changing only `client_version`. Confirm the selected
model and reasoning levels in both the raw response and parsed catalog without
sending an inference request; retain sanitized evidence without credentials.
Update the literal version regression in `tests/subscription-models.test.ts`
alongside the pin. Account visibility and authentication checks still apply.

## Grok subscription

`/login grok` opens browser approval; `/login grok --device` shows a temporary verification address and code. OAuth tokens live only at `grok-subscription:xai` in the OS secure store, separate from `api-key:xai`. Schway does not read another CLI's credentials. Device codes stay in the approval panel and never enter session history or saved drafts.

`--provider xai --xai-auth grok` uses only the saved Grok login. Access refresh is shared across simultaneous requests; a 401 gets one refresh and resend. Revocation and plan-level 403 errors never fall back to API-key billing. `/logout grok` removes only this login. See [route configuration](configuration.md#grok-subscription-xai-oauth).

Test coverage for this guide: [release verification](release-verification.md#credentials).

Grok API denials are classified by their error code. A `*:spending-limit`
401/403 reports `quota-exceeded` and points to <https://grok.com/?_s=usage>;
wait for subscription usage to reset before retrying. A plan rejection stays
`rejected`. A `cf-mitigated: challenge` response is temporarily unavailable.
Catalog reads, inference and host status share these categories without exposing
provider response prose, refreshing a quota denial, or switching billing.
