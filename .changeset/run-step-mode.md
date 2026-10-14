---
"e2e": minor
---

`e2e run --step` runs the first step, which opens the browser, then holds each later step until `c` is pressed in the terminal; `t` runs the rest of the current test and holds at the next one, `r` runs the rest of the run without stopping, and `q`, Esc, or Ctrl-C stops it. A setup test and a retry run without stopping. Each prompt names the step and the test line it came from, and keys pressed just before a prompt appears are ignored. A step run this way uses one worker, has no test timeout while a step is held, and ignores `maxDuration`. It is refused in CI, without a terminal, with `--watch`, with `--reporter json`, and with `--workers` above 1.
