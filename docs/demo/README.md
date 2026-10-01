# README demo

The demo fixes an upper-bound bug in `clamp`, runs its real Bun test, and opens
change review. It uses an isolated Git workspace and a scripted model, with no
network requests or real credentials.

Recorded with [VHS](https://github.com/charmbracelet/vhs) v0.10.0. Install it,
[ttyd](https://github.com/tsl0922/ttyd), [ffmpeg](https://ffmpeg.org),
[Git](https://git-scm.com) and [Bun](https://bun.sh) 1.3.3+ on `PATH`.
The tape uses the DejaVu Sans Mono font; install it for matching dimensions.
From the repository root after `bun install`, run:

```sh
bun run demo:record
```

Keep `schway-demo.gif` at or below 2 MB (2,097,152 bytes). View the result before
committing: the ready screen, inline diff, outcome line and two-column review
must be visible, with no splash, private paths or real provider names. The
1120×640 terminal at 16 px records 106 columns and 29 rows.

The tape uses screen-text waits; sleeps are short viewing pauses. VHS spells
its environment command `Env`. Tune framerate or playback speed if needed,
then regenerate from the checked-in fixture and tape. `bun test` runs the
scenario and checks the GIF size without needing VHS.
