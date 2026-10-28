---
kind: Changed
---
- **ci:** the Windows Go leg, the slowest job in a CI run, is split into
  three jobs that run side by side (lint and smoke, the slowest package's
  tests, the rest of the tests), and a pull request that touches only the
  changelog, its fragments or `.ai/` docs — a release pull request — skips the
  build and test jobs while the docs checks still run.
