---
kind: Changed
---
- **perf(api):** the all-time history behind the Now screen and History is no
  longer counted again on every poll while agents work. It is refreshed at
  most once per 20 times what counting it took (never past 2 minutes), and
  its totals reuse the summary's scans instead of making them twice. Today's
  figures keep their 3-second refresh. Measured 2026-10-18 on an M1 Pro under
  a synthetic working load (four Claude and two Codex sessions writing, hooks,
  two dashboard pages): on an 890,000-event history the daemon went from 40%
  of one core to 11% and the history refresh's allocation from 2,839 MB to
  182 MB per 150 s; on a 181,000-event history the refresh's own CPU fell 40%
  and the daemon's total stayed within noise.
