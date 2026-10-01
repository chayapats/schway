Output docs/demo/schway-demo.gif
Require bun
Require git
Set Shell bash
Set FontFamily "DejaVu Sans Mono"
Set FontSize 16
Set Width 1120
Set Height 640
Set Padding 16
Set LineHeight 1.1
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms
Set Framerate 10
Set PlaybackSpeed 1
Set CursorBlink false
Set WaitTimeout 30s
# VHS calls its environment command Env (rather than Set Env).
Env SCHWAY_THEME dark
Env SCHWAY_MOTION reduced
Env PS1 "demo> "

Hide
Type@0ms "bun --no-env-file tests/fixtures/readme-demo.ts"
Enter
Wait+Screen /demo.offline-model/
Wait+Screen /Type a task/
Show
Sleep 1s
Type "Fix clamp so it respects the upper bound"
Enter
Wait+Screen /Alt\+R review/
Sleep 3s
Alt+r
Wait+Screen /Review · turn 1/
Sleep 4s
Escape
Wait+Screen /Fixed clamp so it respects the upper bound/
Sleep 1s
Hide
Ctrl+c
Wait+Screen /demo>/
