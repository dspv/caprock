-- Migration 0024 added `internal`, and every aggregate since filters on
-- `internal = 0` — a column none of the covering indexes carried. Each one
-- stopped covering its query, so SQLite fetched every full row (heavy with
-- payload) to test one flag. On the owner's 300k-event database
-- /v1/history?range=all went to 9s and /v1/stats/summary?range=all to 3-4s;
-- Now polls both.
--
-- The three covering indexes are rebuilt with `internal` as their last column,
-- and idx_events_ts_cover is new: the range aggregates that group by kind or
-- count distinct sessions filter on ts alone, which no covering index led on.
-- Measured on a copy of that database (all time / 30 days):
--   model mix and per-session spend   2.5s   -> 0.05s / 0.01s
--   by-kind totals                    0.57s  -> 0.15s / 0.21s
--   distinct sessions                 0.35s  -> 0.07s / 0.05s
--   tool distribution                 0.7s   -> 0.07s / 0.04s
-- The rebuild took 10s on a 770MB file, once, and added 23MB.
DROP INDEX IF EXISTS idx_events_cost_cover;
CREATE INDEX idx_events_cost_cover
  ON events(kind, ts, model, session_id, tokens_in, tokens_out, cache_read, cache_write, cost_usd, internal);

DROP INDEX IF EXISTS idx_events_tool_dist;
CREATE INDEX idx_events_tool_dist ON events(kind, ts, tool, tool_bytes, internal);

DROP INDEX IF EXISTS idx_events_attr_work;
CREATE INDEX idx_events_attr_work ON events(
  session_id, ts, id, kind, msg_id, touch_dir, tool,
  cost_usd, tokens_in, tokens_out, cache_read, cache_write, internal
);

CREATE INDEX IF NOT EXISTS idx_events_ts_cover
  ON events(ts, internal, kind, session_id, tokens_in, tokens_out, cache_read, cache_write, cost_usd);
