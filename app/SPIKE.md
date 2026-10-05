# Caprock desktop app — Tauri v2 spike

Numbers for the ADR on the desktop app: a **Tauri v2 thin shell** around the
existing React UI (`ui/`) and xterm.js, with the Go daemon as the engine.
**This is a spike, not the product.** Nothing in `cmd/`, `internal/` or `ui/`
changed; CI does not build `app/`.

%%RESULTS%%

## What was built

`app/` is a Tauri 2.12 app (Rust 1.99, `@tauri-apps/cli` 2.12.1):

- **Terminal window.** A minimal xterm.js 6.0.0 terminal with the dashboard's
  addon set and versions (`@xterm/addon-fit` 0.11.0, `@xterm/addon-webgl`
  0.19.0, WebGL loaded at once) on the daemon's `WS /v1/agents/{id}/term`, for
  a session spawned with `POST /v1/agents`. Same frames as
  `ui/src/components/Terminal.tsx`: binary keystrokes, a text
  `{"resize":{"cols":N,"rows":N}}`. Source: `term/main.ts`, bundled by Vite
  into one IIFE (448 KB, 116 KB gzip).
- **Dashboard window.** The full existing dashboard, unchanged, at the
  daemon's URL in the same WKWebView.
- **Both windows load the daemon's loopback origin** (`WebviewUrl::External`).
  The terminal bundle is injected as an initialization script into a
  same-origin document (`/manifest.json`). Reason: a page on the app's own
  scheme (`tauri://localhost` on macOS/Linux, `http://tauri.localhost` on
  Windows) is refused by the daemon today — `isLoopbackOrigin` accepts only
  http(s) loopback origins, and `Sec-Fetch-Site: cross-site` is refused
  outright (`internal/api/csrf.go`). See "Findings for the ADR".
- **IPC from a remote origin** needs both a capability with
  `remote.urls: ["http://127.0.0.1:*"]` and the app command declared in
  `build.rs` (`AppManifest::commands`) and granted (`allow-bench-report`);
  without the latter Tauri answers "Command bench_report not allowed by ACL".

Build and run (needs Rust via rustup, Node, yarn; Xcode CLT on macOS):

```sh
cd app && yarn install
yarn build:term                       # → dist-term/term.js (included by the Rust build)
yarn tauri build --bundles app        # → src-tauri/target/release/bundle/macos/Caprock Spike.app
open "src-tauri/target/release/bundle/macos/Caprock Spike.app" --args --port 4173 --sid <session-id>
```

The DMG target is configured, but Tauri's `bundle_dmg.sh` lays out the
window through Finder AppleScript, which failed headless here; the DMG
measured below was made with `hdiutil create -format UDZO` (the same image
format) from the same `.app`.

%%METHOD%%

%%RESEARCH%%
