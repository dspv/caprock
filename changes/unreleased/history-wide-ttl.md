---
kind: Changed
---
- **perf(api):** with the dashboard open and agents working, the daemon no
  longer counts the whole history again on every 10-second poll. A history
  that reaches before today (7 days, 30 days, all time) is kept for a minute
  however fast it was to count; today's keeps its 3-second refresh. A quick
  count was quick only because the page cache answered it, and on a machine
  short of memory every count went to disk: one user's daemon read 8.8 GB in
  an hour. On a preview stand with a 103 MB database and the Now screen open,
  database reads fell from 193 MB to 71 MB per 3 minutes (2026-10-20). The
  lifetime and weekly figures can now be up to about two minutes behind.
