# Caprock desktop app

A thin [Tauri v2](https://v2.tauri.app/) shell around the dashboard the Caprock
daemon already serves ([ADR-038](../.ai/08-decisions.md#adr-038--the-desktop-app-is-a-thin-tauri-v2-shell-around-the-existing-react-ui-and-xtermjs-on-the-go-daemon)).
The window loads `http://127.0.0.1:<port>/?app=1#/app` from the daemon, so the
UI and the API always come from the same release. The Rust side owns only the
window, finding or starting the daemon, and what a browser tab cannot do. The
product spec is [.ai/21-app.md](../.ai/21-app.md); the work packages are in
[.ai/22-app-plan.md](../.ai/22-app-plan.md).

## Build and run

You need Go, Node 22 and Rust (stable, via [rustup](https://rustup.rs)). On
Linux you also need WebKitGTK 4.1:
`libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libxdo-dev libssl-dev`.

```bash
make app          # debug build, run it: finds or starts a daemon
make app-test     # cargo fmt --check, clippy -D warnings, cargo test
make app-bundle   # release bundle(s) in app/src-tauri/target/release/bundle
make app-bundle APP_BUNDLES=app   # macOS: the .app only (the .dmg step drives Finder)
make app-release TAG=vX.Y.Z       # macOS: the universal .dmg for a release (docs/RELEASING.md)
```

Each target first builds the daemon from this checkout into
`src-tauri/binaries/caprock-<rust host triple>`, which Tauri bundles as a
sidecar. Bundle id `dev.caprock.app`, minimum macOS 13. Builds are unsigned
(ad-hoc on macOS) until the owner's signing decisions say otherwise.

## Trying a change on your own Mac

`make app-local` builds this checkout's app and puts it in place of the one
in `/Applications`, without a release (`scripts/app-local.sh`):

```bash
make app-local          # build, install over /Applications/Caprock.app, relaunch
make app-local-revert   # back to the release: brew reinstall --cask dspv/tap/caprock-app
```

1. **Build.** The dashboard is rebuilt only when `ui/` changed since the last
   run; then the daemon, stamped `<last tag>-dev+<commit>` (with
   `.dirty.<time>` for uncommitted changes); then a release `.app` for this
   Mac's architecture only — no universal binary, no `.dmg`. Cargo keeps its
   own cache in `src-tauri/target/app-local` with fat LTO off and incremental
   compilation on, and runs 4 jobs (`CARGO_BUILD_JOBS`) so the build does not
   push a 16 GB machine into swap.
2. **Check.** Bundle id, version, the bundled daemon's `caprock version`, the
   ad-hoc signature, and no quarantine flag (a bundle built here has none).
3. **Install.** The new bundle is copied beside the old one, the running app
   is sent SIGTERM (it quits as with Cmd+Q, saving its window), and two
   renames swap the bundles. Only the app running from that folder is
   stopped.
4. **Relaunch** with `open -a`, then wait for the daemon: the app finds its
   own daemon at another version than the one it carries and puts its copy
   in place through `/v1/shutdown` and a start (ADR-040). Sessions keep
   running in their pty-hosts (ADR-033).

It prints how long each step took and the daemon's version before and after.
About Caprock and the status strip show the dev version; the update notice
offers only a release newer than the one the build was made after.
`make app-local-revert` quits the local build, reinstalls the released cask
and starts it, and the released app puts its daemon back the same way. A
daemon that applied a new migration leaves the database at that schema; the
older daemon runs on it, skipping the migrations it does not know.

Measured on an M1 Pro with 16 GB, 2026-10-06: the first run 6 min 50 s
(the cargo cache is empty); after that 33 s with nothing changed, 40 s for a
dashboard change, 32 s for a change to the shell's Rust. Each new daemon is
new ad-hoc-signed code, so macOS may ask for folder access again, as it does
after a release.

`APP_DIR` installs somewhere else; `APP_LAUNCH=exec` starts the executable
with `APP_LOCAL_ENV` (KEY=VALUE words) added to its environment instead of
going through LaunchServices, and `APP_LAUNCH=none` does not start it. Run
against a throw-away data directory the way the next section describes:

```bash
T=$PWD/.t; mkdir -p $T/home $T/data $T/bin
echo '{"port": 4517}' > $T/data/config.json
echo '{"background": false}' > $T/data/app.json
echo '{"accelerator": null}' > $T/data/app-hotkey.json
go build -o $T/bin/claude ./testdata/fakeclaude      # never the real claude
APP_DIR=$PWD/.apps APP_LAUNCH=exec CAPROCK_DATA_DIR=$T/data \
APP_LOCAL_ENV="HOME=$T/home CAPROCK_DATA_DIR=$T/data CAPROCK_SERVICE_LABEL=dev.caprock.apptest \
CAPROCK_APP_BACKGROUND=1 PATH=$T/bin:/usr/bin:/bin" make app-local
```

On Linux and Windows the target says it is macOS-only and does nothing.

## Finding the daemon

The supervisor (`src-tauri/src/supervisor.rs`) works on the data directory the
daemon uses (`$CAPROCK_DATA_DIR`, else `<user config dir>/caprock`):

1. It reads `runtime.json` and asks `/healthz` and `/v1/status`. A daemon that
   answers is used, whoever installed it — Homebrew, Scoop, `go install` or
   this app. One data directory never gets a second daemon: the configured
   port's bind is the lock.
2. A daemon whose `api_level` is below the app's `MIN_API_LEVEL` is refused
   with an upgrade screen: its package manager's command (copy button), or
   **Update** when the app installed it, which replaces the binary and restarts
   it through its own `/v1/shutdown`.
3. With no daemon on the first run, the app asks once, with the **Keep Caprock
   running in the background** switch on by default (decision 7). On macOS
   it always copies the bundled daemon to `<data_dir>/bin/caprock`
   (ADR-040). Elsewhere it uses
   the `caprock` formula's binary when Homebrew installed one (a
   `/opt/homebrew`, `/usr/local` or Linuxbrew `bin/caprock` that resolves into
   a Cellar), else copies the bundled daemon to `<data_dir>/bin/caprock`; then
   it runs `caprock service install` when the switch is on, and falls back to
   `caprock up`. The choice
   is stored in `<data_dir>/app.json`; later launches start the same way
   without asking. The macOS app menu keeps the switch afterwards.
4. It polls twice a second: `/healthz`, with `/v1/status` every 10 s while
   `runtime.json` names the same daemon; every 5 s while the window is hidden,
   and at once when it is shown again. A daemon gone for 1.2 s is shown as stopped (the
   bundled page, with **Start it now**); when one answers again, on any port,
   the window returns to the dashboard at the route it was on.

The app never stops a daemon it did not install, and quitting it leaves the
daemon and every session running. One exception, on macOS only (ADR-040):
when the running daemon is a Homebrew formula's and the bundled one is not
older, the app installs its copy, shuts the formula's daemon down through
`/v1/shutdown` and starts its own (as a login service when one was
registered), once per launch; `"own_daemon": false` in `app.json` turns this
off. A formula's binary lives at a new Cellar path every release, and macOS
lists each path as another "caprock" under Privacy & Security. The same
move replaces the app's own daemon when the bundle carries a different one
— another version, or the same version built differently — so a new
release, a local build and a step back to a release each leave the daemon
matching the app. Only a bundled app does it: `make app` (`cargo run`)
leaves the running daemon alone.

SIGTERM quits the app as Cmd+Q does (`src-tauri/src/sigterm.rs`): the window's
size and place are saved and the daemon keeps running.

## What a page may call

Commands are granted per origin (`src-tauri/capabilities/`):

| Command                  | Daemon page | Bundled page | Popover |
| ------------------------ | ----------- | ------------ | ------- |
| `daemon_status`          | yes         | yes          | no      |
| `open_external`          | yes         | yes          | no      |
| `notify`                 | yes         | no           | no      |
| `withdraw_notifications` | yes         | no           | no      |
| `start_daemon`           | no          | yes          | no      |
| `update_daemon`          | no          | yes          | no      |
| `set_background`         | no          | yes          | no      |
| `set_tray`               | yes         | no           | no      |
| `set_badge`              | yes         | no           | no      |
| `hotkey_status`          | yes         | no           | yes     |
| `register_hotkey`        | yes         | no           | no      |
| `tray_open`              | no          | no           | yes     |
| `tray_hide`              | no          | no           | yes     |
| `tray_fit`               | no          | no           | yes     |
| `app_update_status`      | yes         | no           | no      |
| `app_update_check`       | yes         | no           | no      |
| `app_update_install`     | yes         | no           | no      |
| `app_update_asked`       | yes         | no           | no      |

A page on any other origin gets nothing; `cargo test` checks each refusal.
The `app_update_*` commands are the app's updater (F20, `src-tauri/src/updater.rs`,
ADR-042): the state (`{version, supported, blocked?, asked, phase, …}`), a
check of `latest.json`, the signed install and restart, and the first-launch
question; every change also arrives as `caprock:app-update` in the page. The
updater plugin's own commands are granted to no page.
`open_external` opens `http`, `https` and `mailto` only; a Cmd/Ctrl+click on
a link in a terminal goes through it (`ui/src/lib/termlinks.ts`).
`notify` shows one OS notification (`{title, body, id?, sessionId?,
promptId?, actions?}`); the page decides when (`ui/src/lib/notify.ts`,
WP-09). On macOS, inside the `.app`, it goes through UNUserNotificationCenter
(`src-tauri/src/notify_macos.rs`): an approval with `actions`
`["allow","deny"]` carries **Approve** and **Deny**, one with `["deny"]`
**Open in Caprock** and **Deny**. The shell answers a button itself with
`POST /v1/agents/{sessionId}/permission` `{id: promptId, choice}` to the
loopback daemon it is connected to, so the window stays where it is; a 409
is followed by an "Already answered" notification. A click on the body opens
the session as the tray does. macOS asks for permission on the first
notification. `withdraw_notifications` (`{ids}`) removes delivered ones by
their notify id: the page calls it when a session's prompt goes away, so a
prompt answered in the terminal or on the card leaves no Approve button behind
(macOS; a no-op elsewhere). Everywhere else, and from `cargo run` (no bundle), the official
`tauri-plugin-notification` shows a title and body only. The window turns WKWebView's background throttling off (macOS 14+),
or a hidden or covered page would not hear the frame until brought forward.
Every show from the menu bar, tray or hotkey first dispatches `caprock:shown`
in the page, so it is not taken for a click on a notification.

## Contract with the UI (`ui/`)

- **Detection.** `window.__TAURI_INTERNALS__` exists, and the shell sets
  `window.__CAPROCK_SHELL__ = {app, platform, titlebarInset, trafficLightsInset}`
  before any page script runs.
- **Entry route.** `APP_ROUTE` in `src-tauri/src/shell.rs` is `/?app=1#/app`,
  matching `APP_ROUTE` and `APP_QUERY` in `ui/src/lib/appmode.ts`.
- **Title bar.** On macOS the title bar is transparent and the traffic lights
  sit over the page's top-left corner. Until the page sets
  `data-caprock-chrome` on `<html>`, the shell pads `body` by 28 px and adds a
  draggable strip. A page that sets it lays out around
  `--caprock-titlebar-inset` and `--caprock-traffic-lights-inset` itself and
  marks its own drag areas with `data-tauri-drag-region`.
- **Daemon gone.** A page that calls `daemon_status` at least every 2 s owns
  the "daemon stopped" state (its own banner, no reload); otherwise the shell
  switches to its bundled page and back.
- **Tray and badge.** The page computes what the menu bar or tray shows
  (`set_tray`: title, tooltip, read-only lines, waiting sessions) with the
  dashboard's own formatting, and the badge count (`set_badge`); the shell
  only draws them (`ui/src/lib/tray.ts`). A waiting session clicked in the
  tray brings the window up and dispatches
  `CustomEvent('caprock:open-session', {detail: <session id>})` on `window`.
- **Links and files.** `target="_blank"`, `window.open` and any navigation off
  the daemon's origin open in the system browser; a download asks where to
  save.

## Menu bar, badge and global hotkey

- **Menu bar / tray** (`src-tauri/src/tray.rs`): Claude's and Codex's 5-hour
  and 7-day windows with their reset clocks, today's spend, and the sessions
  waiting for your approval, each opening its session. macOS shows the 5-hour
  figure and the waiting count beside the icon. When the daemon stops, the
  menu says so and the badge clears. After a live `reset` (frames lost),
  the summary is asked again and every live owned session's prompt is
  re-read, so a missed `permission` frame cannot leave the badge stale. Linux needs
  `libayatana-appindicator3-1` (a `.deb` dependency); clicks on the icon
  itself are not delivered there, the menu is.
- **Badge** (`src-tauri/src/badge.rs`): the number of sessions waiting for
  approval on the Dock icon; a dot overlay on the Windows taskbar; the count
  on Linux docks that implement the Unity launcher API. Gone when none wait.
- **Global hotkey** (`src-tauri/src/hotkey.rs`): ⌃⌥⌘C on macOS, Win+Alt+C on
  Windows and Linux by default, changed or turned off in Settings → Global
  shortcut and kept in `<data_dir>/app-hotkey.json`. Pressed with the window
  in front it hides it; otherwise it brings it up. ⌥⌘C was not taken: it is
  Finder's Copy as Pathname and the browsers' inspector. Ctrl+Alt+C was not
  taken: Ctrl+Alt is AltGr on Windows, which types a letter with C on
  Polish, Czech and Hungarian layouts. A shortcut the system refuses is
  shown in Settings with its reason and the previous one stays.
- **Wayland.** Compositors do not give an app a global key: the shortcut is
  registered through X11 and works only under XWayland while an X11 window
  has focus, if at all. Settings says so in a Wayland session; the tray's
  **Show Caprock** still works.
- **Menu bar popover (macOS)** (`src-tauri/src/popover.rs`): a left click on
  the menu bar icon shows a 380 px borderless window under it (popover
  vibrancy, on top, on every Space) with the daemon's `/?app=1#/tray` page:
  sessions waiting for you first, with Approve only when the whole request is
  shown, then Deny and Open; then running sessions; today's spend and the
  Claude and Codex windows with their reset countdown. It is created hidden
  once a daemon answers, so it opens at once, and it hides on blur or Escape.
  Its page may call only `tray_open` (hide it and show the window, on a
  session when named), `tray_hide`, `tray_fit` (its height, clamped 140–640
  px) and `hotkey_status` (capability `tray`). A right click keeps the native
  menu. The shell dispatches `caprock:tray-shown` and `caprock:tray-hidden`
  in the page; the page asks the daemon only while shown. It is a
  non-activating `NSPanel` (the window Tauri builds changes class to a panel
  subclass laid out like Tao's window, through objc2 — no extra crate):
  opening it, typing in it and closing it leave the app you were in active
  and the main window where it was; only *Open* brings Caprock forward. The
  `snapshot` dev feature can toggle it and report whether the app activated
  (`src/snapshot.rs`), which is how this was checked without input on a
  shared desktop.
- **Closing the window.** On macOS it hides the window and the app stays in
  the menu bar (Cmd+Q or **Quit Caprock** quits; the Dock icon reopens it).
  On Windows and Linux closing still quits, because a tray may not be shown
  at all and a second launch would start a second app.

## Checking it on a machine someone is using

Point everything at a throw-away data directory, port and service label, and
launch without taking focus:

```bash
D=$(mktemp -d); mkdir -p $D/data
echo '{"port": 4517}' > $D/data/config.json
HOME=$D CAPROCK_DATA_DIR=$D/data CAPROCK_SERVICE_LABEL=dev.caprock.apptest \
CAPROCK_APP_BACKGROUND=1 src-tauri/target/release/bundle/macos/Caprock.app/Contents/MacOS/caprock-app
```

`CAPROCK_SERVICE_LABEL` keeps `caprock service install` away from the real
`dev.caprock.daemon` login agent. Write `{"accelerator": null}` to
`$D/data/app-hotkey.json` first, or the test app takes ⌃⌥⌘C.
`CAPROCK_APP_NOTIFY_LOG=<file>` appends each notification to that file as a
JSON line (with its session, prompt and buttons) instead of showing it. To
see real macOS notifications from a test build without touching
`dev.caprock.app`'s permission, copy the bundle, give the copy another
`CFBundleIdentifier` with `plutil`, re-sign it with `codesign --force --deep
-s -`, and start it with `open -g -n --env …`: macOS refuses notifications to
a bundle LaunchServices has not registered at that path (`lsregister -f`
registers one, `-u` forgets it). A build with `--features snapshot` (never
shipped) also reads `CAPROCK_APP_SNAPSHOT_DIR`: a name written to
`<dir>/request` captures the window to `<dir>/<name>.png`, a script written to
`<dir>/eval` runs in the page, and page loads are logged to `<dir>/loads.txt`.
For the benchmarks ([bench/README.md](../bench/README.md)): `<dir>/init.js`,
when present at launch, runs before every page's scripts and keeps the window
painting while covered or off screen (WebKit's occlusion detection and App
Nap off); an empty `<dir>/hide` hides the window and turns both back on.
Afterwards: `caprock service uninstall` and `caprock down` with the same
environment.
