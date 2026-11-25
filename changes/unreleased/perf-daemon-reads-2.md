---
kind: Changed
---
- **perf:** the daemon reads less of its database for the Now screen's At a
  glance, the plan-limit pace and the background-work check. The all-time
  agent split keeps each session's sidechain mark between rebuilds and reads
  it again only for sessions whose events moved; the "at current pace"
  slope is extended by the status line's new samples instead of re-read over
  the whole seven-day cycle; and the newest restart of a working session is
  found from an index that carries each event's kind, so only its
  `SessionStart` rows are read. Every answer is the same as before.
- **perf:** the footprint's disk reads by source name more of what reads.
  Reads while nothing counted runs but the system pages the daemon's own
  program and memory back in are listed as `paging (no read running)`
  instead of `unattributed`, and the Disk reads verdict says the Mac is short
  of memory when that is the most. A prepared statement's runs, the copy of
  the database kept before an upgrade and the transcript tailer's folder walk
  and file checks are counted too.
