# The app window's footprint, 2026-10-19

The owner asked whether Caprock would be much faster or lighter as a pure
terminal UI rather than the desktop app (a Tauri v2 shell whose WKWebView
renders the React dashboard). This is the measurement behind the answer: what
the window costs, idle and under load, next to what the daemon costs.

## Method

- **Build.** `--features snapshot` release `.app` built from master at
  0.136.0 (`76d5b809`), copied under the bundle id `dev.caprock.appwin`,
  re-signed ad hoc, launched with `open -g` and `CAPROCK_APP_BACKGROUND`, its
  window placed all but 2 px off screen (the WP-16 method in
  [bench/README.md](../bench/README.md)). The installed Caprock.app and the
  live daemon were never touched.
- **Stand.** A throwaway daemon on a spare port: `env -i`, its own HOME and
  data directory, `CAPROCK_SECRET_STORE=file`, the fake `claude`
  (`bench/fake-claude`). Seeded with 400 Claude and 120 Codex transcripts
  (backfilled before measuring), 3 projects with 2 sessions and a shell each,
  and 300 Second Brain memories (63 nodes and 144 edges drawn).
- **Sampling.** `bench/procs.py` every second for 120 s per scenario: CPU% (100%
  = one core), summed RSS and physical footprint (Activity Monitor's
  "Memory"). The app row is the shell and every process macOS charges to it
  (WebKit's WebContent, GPU and Networking helpers). The daemon row is the
  `caprock` process; its terminal holders and sessions are listed apart.
- **In the page.** Running animations (`document.getAnimations()`), DOM size,
  and the longest gap of a 16 ms timer (WebKit has no Long Tasks API or JS
  heap figure, and no CDP).
- **Proxy for a profile.** The same dashboard in Playwright's headless shell
  (Chromium, not WKWebView): a 30 s CPU profile, `Performance.getMetrics`
  deltas, Long Tasks, JS heap, and the requests the page made. The headless
  shell has no GPU, so its terminals fell back to xterm's DOM renderer; its
  terminal numbers overstate what the app's WebGL terminals cost.
- **Scenarios.** No window, silent; no window, one session printing 20
  lines/s; the app on its project Home, all sessions silent; the Second Brain
  graph open; 3 terminal tabs, the front one printing 20 lines/s (the fake
  also draws its 12 fps spinner there); the same with the window hidden; the
  window hidden with everything silent.
- **Machine.** MacBook Pro M1 Pro (MacBookPro18,3), 10 cores, 16 GB, macOS
  27.0.1. Other agents were building on the same Mac: the 1-minute load
  average was between 5 and 20 during the windows (recorded per scenario in
  the raw JSON). One run; read differences under about 0.3 points as noise.

## CPU, % of one core, 120 s each

| Scenario              | Window total | WebContent | GPU  | Shell | Networking | Daemon | Terminal holders |
| --------------------- | ------------ | ---------- | ---- | ----- | ---------- | ------ | ---------------- |
| No window, silent     | —            | —          | —    | —     | —          | 0.23   | 0.00             |
| No window, 20 l/s     | —            | —          | —    | —     | —          | 0.37   | 0.55             |
| Home, silent          | 1.16         | 0.71       | 0.02 | 0.27  | 0.16       | 0.54   | 0.01             |
| Brain graph, silent   | 1.53         | 0.98       | 0.07 | 0.28  | 0.20       | 0.68   | 0.00             |
| 3 tabs, 20 l/s        | 10.4         | 5.42       | 2.55 | 1.71  | 0.72       | 1.01   | 0.47             |
| Hidden, 3 tabs 20 l/s | 1.60         | 0.72       | 0.13 | 0.11  | 0.64       | 0.76   | 0.57             |
| Hidden, silent        | 0.47         | 0.25       | 0.05 | 0.07  | 0.10       | 0.44   | 0.00             |

The fake `claude` processes themselves (Python) used 1.2–1.6% across all
rows; they stand in for the real agents and belong to neither side.

## Memory, MB (physical footprint, end of window)

| Scenario              | Window total | WebContent | Shell | Daemon | Terminal holders (9) |
| --------------------- | ------------ | ---------- | ----- | ------ | -------------------- |
| No window, silent     | —            | —          | —     | 154    | 51                   |
| Home, silent          | 210          | 104        | 34    | 164    | 52                   |
| Brain graph, silent   | 206          | 120        | 32    | 162    | 52                   |
| 3 tabs, 20 l/s        | 277          | 174        | 33    | 160    | 52                   |
| Hidden, 3 tabs 20 l/s | 300          | 191        | 33    | 159    | 53                   |
| Hidden, silent        | 287          | 184        | 33    | 162    | 53                   |

Summed RSS of the window was 145–190 MB in the same rows; the footprint is
higher because it counts WebKit's compressed and GPU-shared pages.

## What the page does

| Scenario       | Running animations | Longest timer gap | DOM nodes |
| -------------- | ------------------ | ----------------- | --------- |
| Home           | 0                  | 26 ms             | 462       |
| Brain graph    | 0                  | 55 ms             | 992       |
| 3 tabs, 20 l/s | 0                  | 58 ms             | 853       |
| Hidden         | 1 (a transition)   | timers at 1 Hz    | 853       |

From the Chromium proxy:

- **Idle Home, 60 s:** 26 API requests (`/v1/footprint` and `/v1/shells` 6
  each, `/v1/keepawake` 4, the rest 1–2), 24 live-socket frames, 28 ms of
  script and 0.22 s of main-thread work in total, no long task, 6.5 MB of JS
  heap. An earlier 30 s window under heavier machine load showed one 151 ms
  task (a React commit); it did not recur.
- **Brain graph, idle:** 37 ms of script in 30 s, no long task, 8 MB heap.
  The canvas loop stops once the layout settles; nothing animates at rest.
- **3 tabs, 20 l/s:** 0.64 s of script and 4.6 s of main-thread work in
  30 s, six long tasks of 51–125 ms, 14 MB heap; the top self time was
  xterm's DOM renderer (`createRow`, `replaceChildren`), which the app does
  not use once WebGL is loaded.

## What the numbers say

- **Idle, the window is cheap.** About 1.2% of one core and 210 MB visible,
  0.5% hidden. Nothing animates when nothing happens, the graph does not
  redraw at rest, and a hidden window drops its timers to 1 Hz.
- **The real cost is drawing a busy terminal.** One terminal printing 20
  lines/s plus a spinner costs the window about 10% of a core, against about
  1.5% for the daemon and terminal holders that carry the same bytes. Almost
  all of it is WebKit: layout and paint in WebContent, compositing in the GPU
  process and in the shell's own process (WebKit's UI side), not Caprock's
  Rust code. It falls to 1.6% as soon as the window is hidden.
- **Memory:** the window adds 210–300 MB of footprint to the daemon's 160 MB
  and the terminal holders' 52 MB.
- **"Terminal-only would be faster" — partly.** A TUI would drop the
  window's 200–300 MB and its idle 1.2%. It would not drop the busy-terminal
  cost: the agents' output still has to be drawn, by the terminal emulator
  the TUI runs in, and that emulator's cost for the same stream was not
  measured here. The daemon side is the part a TUI keeps, and it is already
  the small part (0.2–1% CPU). The measured case for going TUI is memory and
  idle CPU. Keystroke echo was not measured in this run; the main thread's
  longest stall in any visible row was 58 ms.

## Cheap wins, ranked

None was obvious and safe enough to ship in this change; each needs its own
before/after.

1. **Hidden-window terminal traffic.** Hidden, the Networking process still
   uses 0.64% for one 20 l/s stream (bytes arrive and are parsed while
   nothing is drawn). Pausing terminal sockets while the window is hidden
   would save most of it, but resuming relies on replaying the terminal
   ring, which can start mid-frame after a reconnect; not cheap.
2. **Cap the paint rate of a flooding terminal.** The busy row's cost scales
   with frames drawn (20 lines/s plus a 12 fps spinner; the frame rate itself
   was not measured). Coalescing continuous output to a lower frame rate
   would cut the WebContent and GPU share at the cost of smoothness; how much
   is unmeasured. Needs a typing-latency check (bench/busy.mjs) before and
   after.
3. **Idle polling on Home.** 26 requests a minute; `/v1/footprint` and
   `/v1/shells` every 10 s could ride the live socket instead. The page's
   script cost is already 28 ms a minute, so the saving is in the daemon
   (0.23% → 0.54% with the window open) more than in the window.
4. **Memory after closing tabs.** WebContent grew from 104 MB to 184–191 MB
   once three terminals had been open and stayed there hidden; WebGL
   contexts and scrollback of tabs in the background are the candidates.

## Side findings

- `POST /v1/brain/nodes` returned 500 `database is locked (SQLITE_BUSY)` while
  the transcript backfill was running (48 of 300 memories created, the rest
  after it finished).
- Shell terminal holders of the stand ignored SIGTERM after their daemon was
  stopped and needed SIGKILL.

## Raw data

Kept in the session's scratchpad, not committed: `appwin-run1.json` (every
process, every scenario, machine load), `appwin-proxy.json` and
`appwin-proxy-home60.json` (profiles), the driver `appwin.mjs` and
`proxy.mjs`.
