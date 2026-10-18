---
kind: Changed
---
- **perf(api):** the sessions list no longer re-reads every listed session's
  recent events on every request. Each session's reads are kept until its
  events change: an insert raises its newest event id, and new database
  triggers count updates and deletes (migration 0062). Narration, stats, live
  subagents and the clock are still worked out on every request. Measured
  2026-10-18 on an M1 Pro under a synthetic working load (181,000-event
  history, four Claude and two Codex sessions writing, hooks, two dashboard
  pages): the list's allocation per request fell from 0.85–0.87 MB to
  0.35–0.36 MB and its CPU per request from 1.8–3.2 ms to 0.8–1.1 ms. The
  daemon went from 13–15% of one core to 11–12%. The cache holds about 9 MB
  for at most 256 sessions.
