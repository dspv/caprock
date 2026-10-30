-- What each main-thread compaction cost and what it has saved since, as an
-- estimate from the pricing table (ADR-085, amended 2026-10-30): one row per
-- context.compacted event of a session's main thread. Claude Code's
-- transcript carries no usage for the summary call, so est_cost_usd is the
-- context before (pre_tokens) priced as a cache read when the previous
-- main-thread call was within the cache TTL and as uncached input otherwise,
-- plus the summary (summary_chars / 4 tokens) as output, at the session's
-- model. est_saved_usd is (pre_tokens - post_tokens) priced as a cache read
-- for every main-thread call after the boundary and before the next one.
--
-- A table, not columns on events: a 2 GB events table would carry a dozen
-- columns for one kind in a thousand, and the figures are written again as
-- later calls land. The rows are derived and rebuilt by
-- rollup.RefreshCompactionStats; nothing is filled here. The first start
-- fills them for every stored boundary (meta compaction_stats_backfilled).
-- See 03-contracts.md § Compaction stats DDL.
CREATE TABLE IF NOT EXISTS compaction_stats (
  event_id           INTEGER PRIMARY KEY,         -- the context.compacted events.id
  sid                INTEGER NOT NULL,            -- sessions.sid
  at                 INTEGER NOT NULL,            -- the boundary's time, unix ms
  trigger            TEXT    NOT NULL DEFAULT '', -- 'auto' | 'manual'
  model              TEXT    NOT NULL DEFAULT '', -- the session's model at the boundary; '' when no call says
  pre_tokens         INTEGER NOT NULL DEFAULT 0,
  post_tokens        INTEGER NOT NULL DEFAULT 0,  -- 0 until known
  summary_chars      INTEGER,                     -- the isCompactSummary message's length; NULL when not read
  summary_tokens_est INTEGER,                     -- summary_chars / 4; NULL when not read
  warm               INTEGER NOT NULL DEFAULT 0 CHECK (warm IN (0,1)), -- the prefix was in the cache
  est_cost_usd       REAL,                        -- NULL when the model is not in the pricing table
  turns_after        INTEGER NOT NULL DEFAULT 0,  -- main-thread calls counted after the boundary
  est_saved_usd      REAL    NOT NULL DEFAULT 0,
  counted_ts         INTEGER NOT NULL DEFAULT 0,  -- the last counted call (ts, events.id): the cursor
  counted_id         INTEGER NOT NULL DEFAULT 0,
  next_at            INTEGER,                     -- the session's next main-thread boundary; NULL while none
  cost_stale         INTEGER NOT NULL DEFAULT 1 CHECK (cost_stale IN (0,1)), -- est_cost_usd to be computed again
  pricing_version    TEXT    NOT NULL DEFAULT '',
  updated_at         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_compaction_stats_at ON compaction_stats(at);
CREATE INDEX IF NOT EXISTS idx_compaction_stats_sid ON compaction_stats(sid, at);
CREATE INDEX IF NOT EXISTS idx_compaction_stats_open ON compaction_stats(next_at) WHERE next_at IS NULL;
