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
```

Each target first builds the daemon from this checkout into
`src-tauri/binaries/caprock-<rust host triple>`, which Tauri bundles as a
sidecar. Bundle id `dev.caprock.app`, minimum macOS 13. Builds are unsigned
(ad-hoc on macOS) until the owner's signing decisions say otherwise.

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
   running in the background** switch on by default (decision 7). It copies
   the bundled daemon to `<data_dir>/bin/caprock`, runs `caprock service
   install` when the switch is on, and falls back to `caprock up`. The choice
   is stored in `<data_dir>/app.json`; later launches start the same way
   without asking. The macOS app menu keeps the switch afterwards.
4. It polls twice a second. A daemon gone for 1.2 s is shown as stopped (the
   bundled page, with **Start it now**); when one answers again, on any port,
   the window returns to the dashboard at the route it was on.

The app never stops a daemon it did not install, and quitting it leaves the
daemon and every session running.

## What a page may call

Commands are granted per origin (`src-tauri/capabilities/`):

| Command          | Daemon page | Bundled page |
| ---------------- | ----------- | ------------ |
| `daemon_status`  | yes         | yes          |
| `open_external`  | yes         | yes          |
| `start_daemon`   | no          | yes          |
| `update_daemon`  | no          | yes          |
| `set_background` | no          | yes          |

A page on any other origin gets nothing; `cargo test` checks each refusal.
`open_external` opens `http` and `https` only.

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
- **Links and files.** `target="_blank"`, `window.open` and any navigation off
  the daemon's origin open in the system browser; a download asks where to
  save.

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
`dev.caprock.daemon` login agent. A build with `--features snapshot` (never
shipped) also reads `CAPROCK_APP_SNAPSHOT_DIR`: a name written to
`<dir>/request` captures the window to `<dir>/<name>.png`, a script written to
`<dir>/eval` runs in the page, and page loads are logged to `<dir>/loads.txt`.
Afterwards: `caprock service uninstall` and `caprock down` with the same
environment.
