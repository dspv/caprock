---
kind: Changed
---
- **codex:** a live Codex session's transcript is read from where the last
  poll stopped, and only what the new lines added is offered to the database,
  instead of parsing the whole file and offering every record again on each
  append. Measured 2026-10-18 on a synthetic 16,384-record transcript (Apple
  M1 Pro under load): one poll after a one-record append went from about
  201 MB allocated and 1.2 million allocations to about 150 KB and 300.
  A restart, a rewritten file and a compressed rollout are still read in full
  once.
