---
kind: Changed
---
- **changelog:** a pull request no longer edits `CHANGELOG.md`. It adds one
  file, `changes/unreleased/<slug>.md`, holding its entry under a `kind:`
  line, and the release writes them all into the new version's section with
  `scripts/changelog.py assemble`; `scripts/changelog.py preview` shows that
  section before then, and `make docs-check` rejects a malformed file. With
  many pull requests in flight, editing one shared section made git conflict
  and, three times on 2026-10-15, put entries silently into releases that
  had already shipped. The Work page's next-release list reads these files
  too, from any repository that keeps them.
