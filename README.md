# Schway

A lean, fast coding agent for your terminal.

![Schway fixes a clamp function, runs its test, and reviews the changes.](https://raw.githubusercontent.com/chayapats/schway/main/docs/demo/schway-demo.gif)

## Quick start

1. `npm install -g schway` requires [Bun 1.2+](https://bun.sh) on `PATH`.
2. Run `schway`, press **Alt+L**, and pick a sign-in method.
3. Type a task in the editor and press **Enter**; headless: `schway -p "<task>"`.

Use `--approval <auto|read-only>` to choose the starting tool approval mode. In the TUI, **Shift+Tab** cycles modes; read-only allows investigation and refuses tools that can change state.

## Learn more

- [Use the terminal interface](https://github.com/chayapats/schway/blob/main/docs/tui.md)
- [Configure models and preferences](https://github.com/chayapats/schway/blob/main/docs/configuration.md)
- [Manage credentials](https://github.com/chayapats/schway/blob/main/docs/credentials.md)
- [Save, branch, and resume sessions](https://github.com/chayapats/schway/blob/main/docs/sessions.md)
- [Attach workspaces](https://github.com/chayapats/schway/blob/main/docs/workspaces.md)
- [Use Agent Skills](https://github.com/chayapats/schway/blob/main/docs/skills.md)
- [Add skills and extensions](https://github.com/chayapats/schway/blob/main/docs/extensions.md)
- [Diagnose local readiness](https://github.com/chayapats/schway/blob/main/docs/doctor.md)
- [Run headless tasks](https://github.com/chayapats/schway/blob/main/docs/headless.md)
- [Read tool output](https://github.com/chayapats/schway/blob/main/docs/tools.md)

## Development
```sh
bun install
bun test
bun run typecheck
bun run dev
```
[Run coding evals](https://github.com/chayapats/schway/blob/main/docs/evals.md)
