# Benchmarks (WP-16)

One command per OS measures every row of
[.ai/21-app.md § Budgets](../.ai/21-app.md#budgets) against a throwaway
daemon, never the live one. Results are committed as
`bench/results-<date>/` with the machine, OS and date.

```bash
bench/run-macos.sh --work "$TMPDIR/caprock-bench"   # macOS (run on 2026-10-06)
bench/run-linux.sh                                   # Linux (written, not yet run)
pwsh bench/run-windows.ps1                           # Windows (written, not yet run)
```

`--no-build` reuses the last build, `--runs N` (default 2), `--port P`
(default 4393, refused if in use or a live daemon's port), `--out DIR`
(default `bench/results-<today>`). A run takes about 15 minutes and writes
`app-rN.json`, `phone-rN.json`, `size.json`, `machine.json` and
`summary.md` (the budget table, `report.py`). Every phase records the machine's
load average and busiest processes before it starts: re-run when it is high.

## What runs

| File                                              | What it does                                                                                                                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stand.sh`                                        | The throwaway daemon: own HOME, data dir, port and service label, the fake `claude`, 10 sessions, one chat transcript, notifications and hotkey off                                |
| `fake-claude`                                     | A busy Claude Code TUI without a model: 4000 lines at start, N lines/s from `<cwd>/.fake_lps`, a 12 fps spinner, `> <typed>` echoed per key; a negative rate is silent             |
| `chat-transcript.py`                              | 150 synthetic turns for the phone's chat view                                                                                                                                      |
| `page-hook.js`                                    | Runs before the page's scripts: watches each terminal socket for the echo, types through the page, times paints and main-thread stalls                                             |
| `app.mjs`                                         | The desktop harness: cold start, open, switch, memory at 1/5/10 tabs, echo at 0/200/1000 lines/s, CPU, flood isolation, daemon restart, disk, hidden CPU, restored-tab cold starts |
| `phone.mjs`                                       | The phone harness: headless Chrome at 390 px through a TCP proxy that drops, stalls and slows the network; chat open, back to live, half-open detection                            |
| `procs.py`, `procs-linux.py`, `procs-windows.ps1` | CPU, memory (RSS and footprint) and disk writes of the app's processes                                                                                                             |
| `report.py`                                       | The budget table from the JSON, one column per run, pass/fail/mixed                                                                                                                |
| `reference-orca.mjs`                              | The reference app on the same Mac. Not run: refuses unless `ORCA_BENCH_OK=1` and Orca is quit                                                                                      |
| `run-macos.sh`, `run-linux.sh`, `run-windows.ps1` | The one command per OS                                                                                                                                                             |

## Method

- **The app under test** is a `--features snapshot` build of this checkout
  (app/README.md), never shipped: its init script runs `page-hook.js` from
  `$CAPROCK_APP_SNAPSHOT_DIR/init.js` before the page's own scripts, it keeps
  painting while covered or off screen (WebKit SPI
  `_setWindowOcclusionDetectionEnabled:`, App Nap off, as the spike did), and
  hides its window on request. On macOS the bundle is copied under the bundle
  id `dev.caprock.bench`, re-signed ad hoc, launched with `open -g` and
  `CAPROCK_APP_BACKGROUND`, and placed all but 2 px off screen: it never takes
  focus or covers another window. WKWebView has no CDP, so the page long-polls
  `app.mjs` for what to run and posts results back.
- **Input** goes in through the page: a `keydown` (and `keypress`) on xterm's
  own textarea, the events the keyboard would deliver; `term.input()` if xterm
  did not take them (`key_path` in the JSON says which). Never the OS keyboard.
- **Echo** is timed from just before the key event to the frame that shows
  the echo: the fake's `> <typed>` arrives on the session's socket, xterm's
  write callback says it is parsed, then the next animation frame and a task
  after it. 200 keys per load, 120–200 ms apart; p50/p95 over all of them. The
  terminals register in `window.__caprockBench` only when the hook is present
  (`ui/src/lib/benchhook.ts`); everywhere else that is a no-op.
- **Open** is a click on the session's row in the sidebar to the first echo
  of a nonce typed every 100 ms; **switch** is a click on an open session's row
  to the first frame of its terminal.
- **Memory and CPU** are all the app's processes: the app and every process
  macOS charges to it (WebKit's WebContent, GPU and Networking helpers), the
  daemon and the sessions excluded. The budget rows use the physical
  footprint (Activity Monitor's "Memory"); summed RSS, the spike's figure, is
  listed beside it. "No output" is every session silent (no spinner);
  "spinner only" is the fake's 12 fps spinner, which a real Claude Code also
  draws. During each CPU window the harness's page loop stays quiet
  (`B.quiet`), so its own polling is not counted.
- **Flood isolation:** tab B is brought forward, set to 1000 lines/s, then tab
  A is brought back and 120 keys are typed in A within the 30 s a hidden tab
  keeps its socket.
- **Long tasks:** WebKit has no Long Tasks API, so a 16 ms interval timer
  records the longest gap between two ticks during each phase; a gap is at
  least as long as the longest task in it, so the row errs high.
- **Cold start** is launch to the workspace's sidebar drawn; **restored tab**
  is launch to the first echo in the tab the last run left in front. The first
  launch of a new copy includes the system's scan of a new binary and is kept
  apart.
- **Daemon restart:** the stand's daemon is stopped and started again; from
  `/healthz` answering to an echo in the open tab.
- **Disk** is the kernel's count of bytes written by the app's processes
  (`proc_pid_rusage`): the first two minutes after launch, and the rate while
  idle for 60 s, times 24 h, for the per-day row.
- **Phone:** headless Chrome at 390×844 (DPR 3, touch) loads the dashboard
  through a TCP proxy in `phone.mjs`. Wi-Fi is 10 ms round trip, cellular
  120 ms. Events: Wi-Fi off for 5 s (×5; connections reset and Chrome told it
  is offline), airplane mode for 60 s, Wi-Fi to cellular (×5; every
  connection reset, the latency raised), a 10 s stall with no event (×5;
  packets held), and a 40 s half-open connection (×2). "Back to live" is from
  the network returning to a keystroke echoed and drawn; "half-open detected"
  is from the stall to the page dialling a new terminal socket. Chat open is
  the route change to the newest message drawn, 8 times per profile.

## Caveats

- One machine per OS; the numbers are this machine's on this date.
- The timer starts before the key event, not at the hardware key: the OS's
  key handling before the event reaches the page is not counted (the spike
  measured 0.3–0.8 ms for it). It stops at the frame handed to the
  compositor, which can be up to one 60 Hz frame before the screen.
- Off-screen placement and the occlusion opt-out keep a background window
  painting like a visible, uncovered one; a window really in front may
  behave differently (for example ProMotion rates).
- Linux and Windows open the app on screen, do not script the hidden-window
  row, and on Windows the window-state file is the real user's.

## From the spike

Ported from `spike/tauri-app` (`app/bench/`, PR #209): `fake-claude` (its two
Cyrillic test words replaced with Greek, the repository being English only;
silent mode and a Windows input path added), `procs.py` (footprint and disk
added), `stand.sh` (ten sessions, notifications and hotkey off, port checks).
Replaced: `tauri.sh`/`run-tauri.sh` and the spike's in-process `bench.rs`
key injection by `app.mjs` + `page-hook.js` on the shipped shell's snapshot
build; `web.mjs`/`run-web.sh` (desktop Chrome) by `phone.mjs`; `summarize.py`
and `tables.py` by `report.py`. The spike's 2026-10-04/05 figures stay in
[.ai/21-app.md](../.ai/21-app.md#what-is-measured-already).
