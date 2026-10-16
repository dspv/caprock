---
kind: Added
---
- **ci:** `make e2e` drives the app's golden paths in Playwright's own
  headless shell against a sandboxed daemon (temp home and data directory, a
  free port, the fake `claude`): the workspace loads with no console errors,
  sessions open as tabs with a sidebar row in Tree and Flat, typing, paste and
  a native file drop reach the terminal, and the palette, Settings, Second
  Brain, Pipeline and the share dialog open. `make pr-check` runs it when
  `ui/` or `internal/api/` changed, and CI runs it on Ubuntu. The app's own
  tests now check that a drop on its window is heard on the dashboard's
  webview, the 0.123.0 bug.
