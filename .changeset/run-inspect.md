---
"e2e": minor
"@e2e-dev/web": minor
---

`e2e run --inspect` steps through a run from an inspector page: the test file with a ✓ on the lines that ran and an arrow on the line about to run, the steps grouped by test with a `Test N of M` count, and Next, Finish test, Run the rest, and Stop buttons, with toggles to hold setup tests and retries. It implies `--step` and `--headed` and needs no terminal. The page is served on `127.0.0.1` under a random address the run prints. The web engine opens it in a window on the left half of the screen and its browser on the right half, starting Chromium through XWayland on a Wayland desktop. `EngineInitInfo` gains an optional `inspector`, the page's address, which an engine may show beside its window; `RunOptions` gains `inspect`. The web engine's peer range on `e2e` now starts at the release that carries it.
