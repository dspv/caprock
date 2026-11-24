-- A range's per-session summary parts, kept across restarts — verbatim from
-- .ai/03-contracts.md § Kept parts DDL (migration 0093).
--
-- The parts (store.PartsCache) were rebuilt from every event in range at
-- each start. They are now written here with the events mark they were read
-- at, and a start reads only what moved since. A cache, nothing else: any
-- row may be deleted at any time and the next ask reads the range whole.
CREATE TABLE IF NOT EXISTS parts_kept (
  range_from INTEGER PRIMARY KEY,
  built_at   INTEGER NOT NULL,
  version    TEXT NOT NULL,
  format     INTEGER NOT NULL,
  parts      BLOB NOT NULL
);
