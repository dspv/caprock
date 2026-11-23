---
kind: Changed
---
- **release:** the right panel's Release section says why the next version is that number (*patch · fixes only*, *minor · a feature*) and, when open pull requests would change it, the version they would make: *0.190.0 once the 4 open PRs land*, with what waits under it. The pull requests not in the release are one line each — a small kind label, the title in the UI's font, and three squares for the checks on macOS, Windows and Linux, each naming its state and the failing or running job on hover. A check that names no system, such as lint, now counts toward every system on the board's per-OS checks.
