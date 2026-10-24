---
kind: Changed
---
- **store:** an event names its session by an integer key instead of
  repeating the session's 36-character id in its row and in most indexes. A
  1 GB database came out 128 MiB smaller after a VACUUM (measured
  2026-10-19). The upgrade no longer rewrites the events table before the
  dashboard answers: the first start takes seconds, and the older events
  move into the new table in the background, newest first, 1 min 52 s for
  603,141 of them on a 1.2 GB database (measured 2026-10-23). Until they
  are in, the Now screen and `caprock status` say so, older history is
  incomplete, the other agents' importers wait, and removing a session asks
  to try again later. A query on `caprock.db` joins `sessions` for a
  session's id (`docs/schema.md`). No earlier release opens the upgraded
  database, so the upgrade first keeps a copy of it as `caprock.pre-0073.db`
  in the data directory for 30 days: to go back, stop Caprock, put the copy
  in place of `caprock.db`, remove `caprock.db-wal` and `caprock.db-shm`,
  and install the older release. `caprock up` and the desktop app wait for
  the copy and say the database is upgrading.
