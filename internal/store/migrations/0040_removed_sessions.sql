-- Sessions the owner removed from Caprock (ADR-037), so nothing brings them
-- back.
--
-- Removing a session deletes its events and everything built from them — its
-- stats, its files, its pull requests, its share of each day's totals — and
-- the session row itself, in one transaction. What stays is this row. The
-- transcript is still on disk, and a re-read of it (a truncation check, a
-- repair, a rebuilt offset) would otherwise record the whole session again;
-- the recorder refuses any event for a session listed here.
--
-- A tombstone table rather than a deleted_at column on sessions: every screen
-- reads sessions and events, and a column would have to be filtered in every
-- one of those queries — dozens, several on covering indexes a new column
-- would uncover — where a missed filter is a total that silently still counts
-- the session. With the rows gone there is nothing to filter.
CREATE TABLE IF NOT EXISTS removed_sessions (
  session_id TEXT    NOT NULL PRIMARY KEY,
  removed_at INTEGER NOT NULL,            -- unix ms
  cwd        TEXT    NOT NULL DEFAULT '', -- where it ran, for the record
  cost_usd   REAL    NOT NULL DEFAULT 0   -- what it had cost, for the record
) WITHOUT ROWID;
