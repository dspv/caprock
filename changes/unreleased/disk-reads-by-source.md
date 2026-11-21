---
kind: Fixed
---
- **resources:** the daemon reads less from disk while a session's page is
  open, and the doctor now says what reads. A session's permission mode and
  its cumulative cost line were read again every few seconds by walking every
  event the session had, most of them fetched whole from the table; each now
  reads only the rows it needs from an index of its own. Every figure stays
  the same. On a synthetic 1.6 GB, 680,000-event database with the dashboard
  and two session tabs open, two agents writing and the files evicted from
  memory every 30 seconds, the daemon's disk reads fell from 21,283 MB to
  11,745 MB an hour (2026-11-21); the stand evicts far harder than a real
  Mac, so the ratio is what carries over. `caprock doctor` and
  `GET /v1/footprint` (`disk_io.by_source`) split the last hour's reads by
  what was running when they were made — a database query by the code that
  asked for it, the transcript readers, another program's database — and
  the *Disk reads* warning names the largest.
