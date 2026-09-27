# API keys and OS secure storage

Schway resolves API keys in this order: an explicit `--api-key`, the selected
provider's environment variable, its saved OS credential, then missing credentials.
An explicitly empty `--api-key` is an error and never falls back. Blank environment
values fall through. Usable runtime/environment keys bypass the OS store, so a
locked store does not stop these runs.

| Provider | Environment override | Stored identity |
| --- | --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` | Native Anthropic |
| `openai` | `OPENAI_API_KEY` | Native OpenAI |
| `openai-compatible` | `OPENAI_COMPATIBLE_API_KEY` | Canonical configured endpoint |

`OPENAI_COMPATIBLE_API_KEY` explicitly applies to the currently selected compatible
endpoint. Native `OPENAI_API_KEY` is never used for a compatible endpoint. Saved
compatible keys are isolated by canonical HTTP(S) URL: host case, default ports and
trailing slashes normalize; paths, query values and user information remain part
of identity. The store uses an opaque SHA-256 account identifier, and display labels
show only the host and a short identity digest. A compatible endpoint pointing at
OpenAI still has a separate identity from native OpenAI.

## Explicit interactive management

Start an interactive session and type `/login` to choose ChatGPT browser approval,
device approval, a pasted browser callback, or a provider API key. Use Up/Down,
Enter and Esc; no credential syntax is needed in the chooser. The callback entry
is masked and stays outside prompt recall and session history. A draft and its
cursor return after the chooser or masked entry closes.

You can also name the provider explicitly:

```sh
schway
```

```text
/login anthropic
/login openai
/logout openai
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

A later headless invocation may use the saved key:

```sh
schway --provider openai -p 'Explain this repository'
schway --provider openai-compatible --base-url https://example.com/v1 --auth required -p 'Hello'
```

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

## Deterministic checks and opt-in native smoke

```sh
bun test tests/credentials.test.ts tests/credential-store.test.ts tests/credential-management.test.ts tests/cli.test.ts tests/cli-process.test.ts tests/config-cli.test.ts
bun run typecheck
```

These checks inject an in-memory store. CLI subprocess tests preload a fake
`Bun.secrets`; a temporary `HOME` alone does **not** isolate the OS keychain.

The following optional smoke uses a unique test account, a non-production value,
and removes it in `finally`. Run it only when you explicitly want to exercise your
real OS credential store. It does not contact a model provider or alter Schway's
saved provider accounts:

```sh
bun --no-env-file -e '
const address = { service: "schway-smoke", name: crypto.randomUUID() };
try {
  await Bun.secrets.set({ ...address, value: "non-production-smoke-value" });
  if (await Bun.secrets.get(address) !== "non-production-smoke-value") throw new Error("read mismatch");
  if (!await Bun.secrets.delete(address)) throw new Error("delete mismatch");
  if (await Bun.secrets.get(address) !== null) throw new Error("credential still present");
  console.log(`OS store smoke passed: ${process.platform}, Bun ${Bun.version}`);
} finally {
  await Bun.secrets.delete(address);
}
'
```

Record the actual OS, Bun version and result. A fake-store test is not evidence
that any native store, all supported platforms, live providers or human terminal
interaction passed. Native smoke and human terminal dogfood remain pending until
performed explicitly.
