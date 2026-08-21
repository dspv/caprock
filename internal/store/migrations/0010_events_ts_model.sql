-- The model mix on the Cost screen groups by model over a ts range, and
-- /v1/stats/summary computes it on every call. idx_events_cost_cover carries
-- model but leads on kind, so a query filtering only on ts cannot use it:
-- SQLite searched idx_events_ts and grouped in a temp B-tree, reading the
-- table for model and cost_usd on every matching row.
--
-- Measured on a real 190k-event database, best of three, through the Go
-- driver: 146ms to 56ms over a 30-day range. The index carries cost_usd so
-- the aggregate is answered without touching the table.
CREATE INDEX IF NOT EXISTS idx_events_ts_model ON events(ts, model, cost_usd);
