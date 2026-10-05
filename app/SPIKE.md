# Caprock desktop app — Tauri v2 spike

These are measurements for the ADR on the desktop app. The design under test is a **Tauri v2 thin shell** around the
existing React UI (`ui/`) and xterm.js, with the Go daemon as the engine.
**This is a spike, not the product.** Nothing in `cmd/`, `internal/` or `ui/`
changed, and CI does not build `app/`.

Measured on 2026-10-05 on one machine: an Apple M1 Pro with 16 GB, macOS 27.0.1. The run used an isolated daemon
built from master `d80276c` on port 4291 with its own HOME and data dir. The
owner's daemon on :4173 was never touched. Raw data is in `spike-data/`, and the
tables are produced by `bench/tables.py spike-data`.

## Results

**Keystroke to echo on screen, p50 / p95 in ms** (200 keystrokes per cell, two runs of 100;
"load" is the fake claude's stream in lines/s on top of its 12 fps spinner):

| client | load 0 | load 200 | load 1000 | source |
|---|---|---|---|---|
| **Tauri, minimal xterm.js (WKWebView, WebGL)** | **9.2 / 17.7** | **10.6 / 18.2** | **10.2 / 18.0** | this spike |
| **Tauri, unchanged dashboard's terminal** | **13.3 / 25.2** | **16.7 / 27.3** | **16.4 / 26.2** | this spike |
| Chrome, dashboard, headed | 11.9 / 21.7 | 12.5 / 20.4 | 14.3 / 21.1 | `macos/README.md`, 2026-10-04 |
| Chrome, dashboard, headless (today) | 27.9 / 35.8 | 29.2 / 36.3 | 28.6 / 36.1 | this spike; not comparable, see caveats |
| native SwiftTerm, CoreGraphics | 5.7 / 10.0 | 5.6 / 8.7 | 5.5 / 9.1 | `macos/README.md`, 2026-10-04 |
| native SwiftTerm, Metal | 3.7 / 13.0 | 1.2 / 9.4 | 1.1 / 13.6 | `macos/README.md`, 2026-10-04 |
| Orca 1.4.220 | not measured | | | would mean typing into the owner's sessions |

There were no timeouts in any Tauri cell, and the worst single keystroke was 21 ms for the minimal terminal and 41 ms for the dashboard.

**Opening a session to the first echoed keystroke, in ms** (median per load level; the app types a 4-letter word every
100 ms until it comes back):

| client | load 0 | load 200 | load 1000 |
|---|---|---|---|
| Tauri, dashboard route change to the Terminal tab (warm) | 143 | 212 | 175 |
| Tauri, new terminal window in the warm app (6 samples each) | 264 (234–310) | 301 (281–401) | 282 (263–315) |
| Chrome headless, dashboard route change (today's master) | 130 | 145 | 141 |
| Chrome headed, dashboard route change (2026-10-04 master) | 434 | 466 | 1119 |
| native SwiftTerm, pane created (2026-10-04) | 97 | 113 | 101 |

**Cold start** (app not running, `open` it, measured by the wall clock):

| client | result |
|---|---|
| Tauri, launch → terminal window → first echo | 647–927 ms (6 runs, median 754 ms) |
| Tauri, launch → dashboard `load` event | 536–850 ms (6 runs) |
| Tauri, first launch after a rebuild | 1.1–2.6 s (Gatekeeper first-run scan of the new binary) |
| native SwiftTerm, launch → first echo (CoreGraphics) | 0.7–1.2 s (2026-10-04) |
| Orca | not measured: it was already running for the owner and was not quit |

**CPU and memory, counting every process of the app.** For Tauri this means the app plus WebKit's WebContent, GPU and
Networking helpers. CPU is averaged over 20 s with no typing (30 s for idle), 100 % equals one core, and RSS is the sum
at the end of the run (range of 2 runs):

| client | CPU idle / load 0 | CPU load 200 | CPU load 1000 | RSS |
|---|---|---|---|---|
| Tauri, dashboard open, no terminal (idle) | 1.4–1.6 % | – | – | 139–160 MB |
| Tauri, minimal terminal | 6.0 % | 15.1 % | 20.0 % | 177–199 / 219–234 / 234–252 MB |
| Tauri, dashboard + terminal | 8.2 % | 18.4 % | 24.1 % | 206–331 / 416–447 / 504–529 MB |
| Chrome headed, tab only (renderer + GPU), 2026-10-04 | 5.5 % | – | 20 % | 278–442 MB |
| Chrome headed, whole instance, 2026-10-04 | 24 % | – | 36 % | 435–732 MB |
| Chrome headless, whole instance (today) | 4.4 % | 10.4 % | 15.4 % | 948–1037 MB (tab only 571–653) |
| native SwiftTerm, CoreGraphics, 2026-10-04 | 7 % | – | 14 % | 34–53 MB |
| **Orca**, 8 app processes, observed live | 5.0–5.2 % | – | – | 420–541 MB |

The Orca row was observed, not set up. Orca had been running for 26 h with the owner's sessions open, including the
one running this spike. An earlier 60 s snapshot taken while that session streamed showed 15.6 % CPU and 609 MB. The
figures exclude the shells and agents launched inside its terminals.

Where the Tauri memory goes, at load 1000 in run 1:

| setup | WebContent | app process | GPU | Networking |
|---|---|---|---|---|
| minimal terminal | 117 MB | 95 MB | 25 MB | 16 MB |
| dashboard | 387 MB | 88 MB | 38 MB | 16 MB |

The app process holds about 90 MB however small the page is: WebKit's UI-process side plus the Tauri runtime.

**Bundle size** (arm64 only, release profile with `opt-level = "s"`, LTO, strip, ad-hoc signed):

| artifact | size |
|---|---|
| `Caprock Spike.app` | 4.5 MB (binary 4.3 MiB, of which the xterm.js bundle is 448 KB) |
| `.dmg` (UDZO) | 2.0 MB |
| the Go daemon, not bundled in the spike | 22.7 MB |
| `ui/` dist, if the UI were bundled rather than served by the daemon | 1.3 MB |
| Orca.app, for scale | 624 MB on disk |

A universal (arm64 + x86_64) build would roughly double the binary. Shipping
the daemon as a sidecar adds its 22.7 MB.

## What it says

- **Typing latency: a Tauri shell matches Chrome, it does not match native.**
  The minimal terminal's p50 of 9–11 ms sits between native, which is 4–6 ms
  faster, and the dashboard in headed Chrome (12–14 ms on 2026-10-04). The p95
  is flat at 18 ms under load. In the same webview the dashboard's own
  terminal is 4–6 ms slower than the minimal one, so React and the rest of the
  page cost more than WKWebView does.
- **Opening a session is fast in both shapes.** A route change inside the
  already-loaded dashboard took 143–212 ms, the same as today's master in
  Chrome (130–145 ms). Master has improved since the 2026-10-04 run, so the
  older 434–1119 ms figure is stale. A new terminal window took about 0.3 s.
  Native is still 3x faster at about 0.1 s.
- **Memory is where Tauri wins against a browser and loses against native.**
  Tauri with the full dashboard and a busy terminal used 0.2–0.5 GB. Orca, the
  Electron reference the owner uses, used 0.4–0.6 GB. Chrome used 0.4–0.7 GB
  headed and about 1 GB headless. Native used 34–53 MB. The idle shell
  (dashboard only) is about 150 MB.
- **CPU is the same order everywhere,** 6–24 % of one core while streaming.
  The dashboard costs about 2–4 points more than the minimal terminal.
- **Cold start is under 1 s** to a usable terminal or to a loaded dashboard.
- **The unchanged dashboard works in WKWebView.** All 10 routes rendered
  with 0 JS errors, 0 console errors or warnings, and 0 error boundaries.
  Hanken Grotesk and JetBrains Mono loaded, and the Terminal tab ended up on
  the WebGL renderer (2 canvases). `:has()`, container queries, `color-mix()`,
  `oklch()`, WebGL2, `navigator.clipboard`, `navigator.share` and
  `Notification` are all present. Data: `spike-data/tauri-dashboard-tour.json`.

## Findings for the ADR

1. **Origin. This needs a decision, and it touches the architecture.** The
   spike's windows load the daemon's own URL (`http://127.0.0.1:<port>/`). The
   page origin is then the daemon's, so `checkOrigin` (`internal/api/csrf.go`)
   passes with no daemon change. Bundling the UI into the app instead means
   the page runs on `tauri://localhost` (macOS, Linux) or
   `http://tauri.localhost` (Windows, Android). The daemon refuses both today.
   `isLoopbackOrigin` accepts only http(s) loopback hosts, so
   `tauri://localhost` fails. `http://tauri.localhost` passes the host test,
   but the request carries `Sec-Fetch-Site: cross-site`, which is refused
   outright.

   The two options:

   | option | daemon change | trade-off |
   |---|---|---|
   | (a) load from the daemon | none | UI version is tied to the daemon, as for the browser today; IPC must be granted to `http://127.0.0.1:*` |
   | (b) bundle the UI | must admit exactly the three Tauri origins, not any loopback origin | UI can update with the app; the research below recommends this option |

   `docs/architecture.md`, which CLAUDE.md names as the source of truth, does
   not exist in this tree. Whichever option is chosen should be written down
   there.
2. **IPC from the daemon's origin** takes two things: a capability with
   `remote.urls`, and the app command declared in `build.rs`
   (`AppManifest::commands`) and granted (`allow-<command>`). Without the
   second, Tauri answers "not allowed by ACL". Use Tauri ≥ 2.11.1, because
   GHSA-7gmj-67g7-phm9 let remote origins call local-only commands on
   Windows and Android.
3. **Webview gaps the dashboard will hit:**
   - **Links and new windows:** 25 `target="_blank"` links across 11
     components, plus one `window.open`. They need a new-window handler that
     opens the system browser (Tauri's opener plugin).
   - **File downloads:** 2 `a.download` saves, in `Week` and `Share`. They need
     Tauri's download handler.
   - **Clipboard:** reading it is unreliable on WebKitGTK and gated on WebView2
     (see research). The dashboard only writes to it today.
   - **Notifications:** desktop notifications have no action buttons with the
     official plugin.

   None of these was exercised, because each has side effects outside the app.
4. **Packaging:** Tauri's DMG step (`bundle_dmg.sh`) lays out the window by
   driving Finder through AppleScript. It failed in this headless session. The
   `.app` bundle target is unaffected, and `hdiutil` makes the image without
   Finder.
5. **xterm.js v6 has no canvas renderer.** The fallback is the DOM renderer,
   so the dashboard's `onContextLoss → dispose` path matters on Linux (see
   research).

## Method

The harness is the one from `origin/spike/macos-app:macos/bench`, copied to
`bench/`:

- `fake-claude` writes 4000 lines at start, then streams N lines/s, runs a
  12 fps spinner, and redraws `> <typed>` on every input byte.
- `stand.sh` starts the isolated daemon with one `POST /v1/agents` session.
- `summarize.py` is copied as well.

Added for this spike:

- **`src-tauri/src/bench.rs` + `src-tauri/src/keys.rs`** are the Tauri app's
  built-in benchmark, on with `--bench-out`. Each keystroke is an `NSEvent`
  handed in-process to the app's own `NSWindow` (`sendEvent:` → WKWebView
  `keyDown`). The clock starts from Rust's wall clock just before the event is
  handed over.

  The page hook in `term/main.ts` is the same as `web.mjs`'s. It wraps
  `WebSocket` and waits for `> <typed>\x1b` on the `/term` socket. Then it runs
  `term.write('', cb)`, the next animation frame and a task after it, and
  reports `Date.now()` back over Tauri IPC.
- **`bench/tauri.sh`, `bench/run-tauri.sh`** launch the `.app` through
  LaunchServices (`open -g -n -W`) with `BENCH_T0` set just before, which
  gives cold start.
- **`bench/procs.py`** measures CPU (CPU-time delta over wall time) and RSS
  of the app's processes. The set is: the app; every process macOS charges
  to it through `responsibility_get_pid_responsible_for_pid`, which covers
  WebKit's XPC helpers since they are launchd's children rather than the
  app's; and for Orca, only executables inside the bundle.
- **`bench/run-web.sh` + `bench/web.mjs`** run the same dashboard in Chrome
  over CDP. The daemon's dashboard build carries the same single bench-only
  line as on 2026-10-04 (`window.__caprockTerm = term` in `Terminal.tsx`),
  built in a scratch copy and not committed.
- **Modes:**
  - `term`: minimal terminal, cold start, steady typing, 20 s watch, then 3 new
    windows in the warm app.
  - `dash`: the dashboard, 4 s after load a route change to
    `#/session/<id>?tab=terminal`, then steady typing and the watch.
  - `idle`: dashboard only, 30 s watch.
  - `tour`: every route, collecting errors.

**Nothing system-wide was injected.** No CGEvent, no AppleScript, no
activation. The Tauri app stayed in the background (`lsappinfo front`
showed the owner's front app throughout). Because of that, the bench
disables WebKit's window-occlusion detection
(`_setWindowOcclusionDetectionEnabled:`, SPI) and App Nap
(`NSProcessInfo.beginActivity`), so that a background window still paints on
time. That mirrors the Chrome flags in `web.mjs`.

## Caveats

- **Clock resolution.** WebKit coarsens `performance.now()` and `Date.now()`
  to 1 ms. Page timestamps use `Date.now() + 0.5`, which reads the same wall
  clock as the Rust side. `performance.timeOrigin + now()` ran about 1 ms
  behind it.
- **Start points differ slightly:**

  | client | timer starts at |
  |---|---|
  | Tauri | just before the NSEvent is sent (the page's `keydown` follows about 0.3–0.8 ms later) |
  | Chrome | the `keydown` event's `timeStamp` |
  | native | the NSEvent's timestamp |

  All three stop when the frame is handed to the compositor, not when it
  reaches the screen. As in `macos/README.md`, the web-based figures can
  include up to one 60 Hz frame of vsync wait that native's does not.
- **Headless Chrome is not comparable on latency.** Today's re-run had to be
  headless, because a headed Chrome takes the foreground on launch even with
  `open -g`, and the owner was at the machine. Its socket arrival alone was
  about 10 ms, against about 2 ms in Tauri. Its memory is also higher than
  headed. It stays in the tables only for the same-day click figure. The
  headed 2026-10-04 run is the Chrome baseline.
- **Cross-day comparisons are approximate.** The 2026-10-04 README says
  macOS 14.6.1; this machine reports 27.0.1 today. Master also moved, and
  its terminal now loads WebGL late.
- **Window placement:** all windows were 1400×900 on the 1920×1080 external
  display at devicePixelRatio 1, not on the Retina panel.
- **Grids differ,** which changes how much each renderer draws per frame:

  | client | grid |
  |---|---|
  | minimal terminal | 196×61 |
  | dashboard in Tauri | 186×37 |
  | Chrome | 186×35 |
  | native, 2026-10-04 | 195×40 |
- **Fonts differ:** the minimal terminal uses Menlo, the dashboard uses the
  JetBrains Mono webfont.
- **Renderer during typing:** the dashboard defers WebGL until 1.5 s without
  input. Which renderer it used during the typing phase was not recorded, in
  Tauri or in Chrome.
- **Not measured:**
  - Orca's echo latency and cold start (see above).
  - Typing comfort: focus, shortcuts, IME.
  - Windows and Linux; everything above is macOS only.
- **Empty data dir:** the stand's data dir held a single fake session. The
  dashboard's screens were close to empty, and real history would raise its
  memory.

## Research: Tauri v2 beyond macOS (as of 2026-10)

Tauri 2.12 (2026-09-26) is current stable. It drops Windows 7, requires Rust
≥ 1.90, and fixes GHSA-7gmj-67g7-phm9 (fixed from 2.11.1).
[blog](https://v2.tauri.app/blog/tauri-2.12/),
[advisory](https://github.com/tauri-apps/tauri/security/advisories/GHSA-7gmj-67g7-phm9)

| OS / webview | status for this app |
|---|---|
| macOS / WKWebView | Mature. Measured above. |
| Windows / WebView2 (Chromium) | Mature, and the lowest-risk webview for xterm.js. See below. |
| Linux / WebKitGTK 4.1 | Works. Most rendering and performance risk is here. See below. |

**Windows / WebView2**

- **Runtime:** it ships with Windows 10 1803+ and Windows 11. The installer can
  download it (0 MB), embed the bootstrapper (about 1.8 MB), or bundle an
  offline (about 127 MB) or fixed (about 180 MB) runtime.
  [installer](https://v2.tauri.app/distribute/windows-installer/)
- **Known xterm issues:** a 1 px seam in WebGL block glyphs
  ([xterm#6207](https://github.com/xtermjs/xterm.js/issues/6207)), and a Chinese
  IME field report ([Ageminal#38](https://github.com/pangbw/Ageminal/issues/38)).

**Linux / WebKitGTK**

- **Requirement:** webkit2gtk-4.1 (Ubuntu 22.04+). Users ask for a Chromium
  runtime, but that is still an open request.
  [prereqs](https://v2.tauri.app/start/prerequisites/),
  [#14963](https://github.com/tauri-apps/tauri/issues/14963)
- **Rendering and performance problems:**
  - NVIDIA with Wayland and the DMABUF renderer gives blank windows. The
    workarounds, in order, are `__NV_DISABLE_EXPLICIT_SYNC=1`,
    `WEBKIT_DISABLE_DMABUF_RENDERER=1`, then `WEBKIT_DISABLE_COMPOSITING_MODE=1`.
    [Tauri: Linux graphics](https://v2.tauri.app/develop/debug/linux-graphics/)
  - There are reports of laggy scrolling and WebKitGTK regressions.
    [#7021](https://github.com/tauri-apps/tauri/issues/7021),
    [wry#1315](https://github.com/tauri-apps/wry/issues/1315),
    [#14427](https://github.com/tauri-apps/tauri/issues/14427)

| xterm.js on WebKitGTK | detail |
|---|---|
| Typing lag | With DMABUF disabled, the WebGL canvas paints one frame behind, and typed text shows only on the next cursor blink (about 600 ms). `new WebglAddon({ preserveDrawingBuffer: true })` on Linux brought this down to 14–37 ms. [voltius#313](https://github.com/VoltiusApp/voltius/pull/313) |
| Software rendering | It can't be detected, because the renderer string is hidden. [same PR](https://github.com/VoltiusApp/voltius/pull/313) |
| Lost WebGL context | Reported in Tauri on Linux. [#6559](https://github.com/tauri-apps/tauri/issues/6559) |
| Canvas fallback | xterm.js v6 removed the canvas renderer, so the only fallback is DOM. [xterm.js releases](https://github.com/xtermjs/xterm.js/releases), [cockpit#22509](https://github.com/cockpit-project/cockpit/issues/22509) |

**Per feature**

| feature | macOS | Windows | Linux | notes / source |
|---|---|---|---|---|
| IME in xterm.js | dead-key duplication and dropped keys open ([xterm#5894](https://github.com/xtermjs/xterm.js/issues/5894), [#5887](https://github.com/xtermjs/xterm.js/issues/5887)) | Chromium path | wry disables inline preedit, so composition shows in a detached popup; the fix is unmerged ([wry#1724](https://github.com/tauri-apps/wry/pull/1724)) | QA matrix with CJK and dead-key layouts |
| Clipboard | ok | reading needs `enable_clipboard_access()` | `navigator.clipboard.readText` unreliable, especially on Wayland | use `tauri-plugin-clipboard-manager` for reads. [docs](https://v2.tauri.app/plugin/clipboard/) |
| Global shortcuts | ok | ok | **X11 only, none on Wayland** | [global-hotkey#28](https://github.com/tauri-apps/global-hotkey/issues/28) |
| Tray / menu bar | ok | ok | no click events, only the menu (AppIndicator; GNOME needs an extension) | [docs](https://v2.tauri.app/learn/system-tray/), [tray-icon#104](https://github.com/tauri-apps/tray-icon/issues/104) |
| Notifications with actions | **no** (actions are mobile-only in the official plugin) | no | no | a community fork adds desktop actions. [docs](https://v2.tauri.app/plugin/notification/), [fork](https://github.com/Choochmeque/tauri-plugin-notifications) |
| Autostart | LaunchAgent | ok | ok | [docs](https://v2.tauri.app/plugin/autostart/) |
| Updater | `.app.tar.gz` | MSI / NSIS | AppImage only (no deb or rpm) | minisign signature required. [docs](https://v2.tauri.app/plugin/updater/) |
| Code signing | Developer ID + notarization (paid account; API key or Apple ID env vars) | Authenticode. EV no longer gives instant SmartScreen reputation; OV, or Azure Artifact Signing via `signCommand` | AppImage GPG (not verified at run time); deb/rpm through repo GPG | [macOS](https://v2.tauri.app/distribute/sign/macos/), [Windows](https://v2.tauri.app/distribute/sign/windows/), [Linux](https://v2.tauri.app/distribute/sign/linux/) |

**Mobile (iOS and Android)**

- **Maturity:** stable since 2.0, but by the team's own account the developer
  experience is behind desktop and plugin coverage is partial.
  [2.0](https://v2.tauri.app/blog/tauri-20/)
- **Desktop-only plugins:** clipboard-manager, global-shortcut, tray,
  window-state, single-instance. [plugins](https://v2.tauri.app/plugin/)
- **xterm.js on iOS:** IME composition is not shown in xterm
  ([Codeman#499](https://github.com/Ark0N/Codeman/pull/499)), and WebGL context
  loss is common in WKWebView.
- **No local daemon:** a phone has no daemon on 127.0.0.1, so mobile needs a
  remote transport. That is a separate design, and today's paired-device path
  (ADR-034) is the starting point.

**Origins.** The Tauri page origin is `tauri://localhost` on macOS and Linux, and `http://tauri.localhost` on Windows and Android
(`https://` with `useHttpsScheme`). WebKit does not treat `127.0.0.1` as
potentially trustworthy
([WebKit 171934](https://bugs.webkit.org/show_bug.cgi?id=171934)), so any
https page in WKWebView or WebKitGTK cannot open `ws://127.0.0.1`. Keep
`useHttpsScheme` off.
[migration](https://v2.tauri.app/start/migrate/from-tauri-1/),
[capabilities](https://v2.tauri.app/security/capabilities/)

### Risks and mitigations

| risk | mitigation |
|---|---|
| Linux blank windows (NVIDIA / Wayland / DMABUF) | Apply the env workarounds above in `main()` before the webview exists, offer a safe-mode flag, and document it. |
| Linux typing lag or software WebGL | Use `preserveDrawingBuffer: true` on Linux. Keep the `onContextLoss → dispose` fallback to DOM, add a user renderer toggle, or default to DOM on Linux after a first-frames probe. |
| macOS WebGL glitches on new OS releases ([xterm#5816](https://github.com/xtermjs/xterm.js/issues/5816)) | Same renderer toggle. The canvas addon is gone in v6. |
| IME / dead keys in WebKit webviews | Track the xterm and wry issues above. Run a CJK and international-layout QA pass before launch. |
| No global shortcuts on Wayland | Use a shortcut set in the desktop environment's own settings, and show an in-app hint. |
| Tray click on Linux | Make the tray menu-only, with every action in the menu. |
| No notification action buttons | A click focuses the app and shows the action in-app, or adopt the community fork. |
| Origin check too loose or broken | Exact per-OS allowlist (Finding 1). Never admit "any loopback origin". |
| SmartScreen and Gatekeeper friction | Developer ID plus notarization from day one. OV or Azure Artifact Signing with a stable identity. |
| Linux distro spread | AppImage (has an updater) plus deb/rpm, with Flatpak on the GNOME runtime as an option. Build on the oldest supported glibc. |
| `bundle_dmg.sh` needs Finder | Run it on a GUI CI runner, or build `--bundles app` and make the DMG with `hdiutil`. |

## Build and run

You need Rust (via rustup), Node and yarn, plus the Xcode Command Line Tools on macOS.

```sh
cd app && yarn install
yarn build:term                        # → dist-term/term.js (included by the Rust build)
yarn tauri build --bundles app         # → src-tauri/target/release/bundle/macos/Caprock Spike.app
open "src-tauri/target/release/bundle/macos/Caprock Spike.app" --args --port 4173 --sid <session-id>

# benchmark, against an isolated stand (never the live daemon)
bench/stand.sh /tmp/stand 4291 /path/to/caprock-with-bench-line
bench/run-tauri.sh /tmp/stand spike-data
bench/run-web.sh   /tmp/stand spike-data
python3 bench/tables.py spike-data
```
