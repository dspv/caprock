---
kind: Changed
---
- **ci:** a pull request no longer carries the built dashboard
  (`internal/api/dist`). Every two PRs that touched `ui/` used to conflict
  there, because the bundle's file names are content hashes; now a PR that
  changes it fails CI's *no dist in the PR* check (and `make check`) with
  the command that drops it (`make dist-reset`), and a new `dist` workflow
  rebuilds and commits it on `master` after each merge that touches `ui/`.
  `go install …@latest` still embeds the tag's dashboard: release `verify`
  and `make release-ready` check that the tagged commit's copy is its own
  `ui/` built, so a release is tagged after that rebuild lands (ADR-068).
