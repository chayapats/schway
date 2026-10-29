# Schway

[![GitHub stars](https://img.shields.io/github/stars/chayapats/schway?style=social)](https://github.com/chayapats/schway/stargazers)
[![Greptile: The War on Bugs](https://www.greptile.com/badge.svg)](https://www.greptile.com/?utm_source=oss_badge&utm_medium=readme&utm_campaign=greptile_for_open_source)

A lean, fast coding agent for your terminal.

![Schway fixes a clamp function, runs its test, and reviews the changes.](https://raw.githubusercontent.com/chayapats/schway/main/docs/demo/schway-demo.gif)

## Quick start

1. `npm install -g schway` requires [Bun 1.2+](https://bun.sh) on `PATH`.
2. Run `schway`, press **Alt+L**, and pick a sign-in method.
3. Type a task in the editor and press **Enter**.

Use `--approval <auto|ask|read-only>` or `approval.mode` to choose the starting tool approval mode. In the TUI, **Shift+Tab** cycles modes; ask previews tools that can change state before you approve them, and read-only refuses them. Headless ask denies mutations without waiting for input.

## Run a headless task

Choose the auth route and model explicitly; interactive sign-in does not save a
headless model choice. This **POSIX shell** example assumes you saved an OpenAI
API key using interactive `/login openai`. It selects API-key billing even if a
ChatGPT login also exists. For ChatGPT/Codex, xAI, Grok or a compatible endpoint,
use the [complete route guides](docs/headless.md#choose-your-route-run-and-resume).

<!-- headless-flow:readme -->
```sh
schway models list --provider openai --openai-auth api-key
# Paste one exact model ID returned above, then press Enter.
IFS= read -r MODEL_ID
schway -p "Explain this project" --provider openai --openai-auth api-key --model "$MODEL_ID" --approval read-only --show-session
schway sessions list
# Paste the exact Session hint ID or its matching saved-work row.
IFS= read -r SESSION_ID
schway -p "Continue this explanation" --provider openai --openai-auth api-key --model "$MODEL_ID" --resume "$SESSION_ID" --approval read-only --show-session
```

The hint goes to stderr; model text stays on stdout. Task `--json` already emits
`session.ready` as JSONL and cannot be combined with `--show-session`. Resume
restores saved work, while current flags/config still choose credentials and
billing. See [headless output and recovery](docs/headless.md#output-and-session-ids),
[credentials](docs/credentials.md), [configuration](docs/configuration.md),
[doctor](docs/doctor.md) and [sessions](docs/sessions.md).

## Learn more

- [Use the terminal interface](https://github.com/chayapats/schway/blob/main/docs/tui.md)
- [Configure models and preferences](https://github.com/chayapats/schway/blob/main/docs/configuration.md)
- [Manage credentials](https://github.com/chayapats/schway/blob/main/docs/credentials.md)
- [Save, branch, and resume sessions](https://github.com/chayapats/schway/blob/main/docs/sessions.md)
- [Attach workspaces](https://github.com/chayapats/schway/blob/main/docs/workspaces.md)
- [Use Agent Skills](https://github.com/chayapats/schway/blob/main/docs/skills.md)
- [Add skills and extensions](https://github.com/chayapats/schway/blob/main/docs/extensions.md) · [Public extension API](docs/extensions.md#public-api)
- [Diagnose local readiness](https://github.com/chayapats/schway/blob/main/docs/doctor.md)
- [Run headless tasks](https://github.com/chayapats/schway/blob/main/docs/headless.md)
- [Embed a native scripted turn](docs/host.md) · [Public host API](docs/host.md#public-api)
- [Read tool output](https://github.com/chayapats/schway/blob/main/docs/tools.md)

## Development
```sh
bun install
bun test
bun run typecheck
bun run dev
```
[Run coding evals](https://github.com/chayapats/schway/blob/main/docs/evals.md)

See the [stability policy](docs/stability.md) for compatibility promises.
