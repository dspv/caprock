-- The main summary aggregate reads seven columns from every priced event in a
-- range, and the dashboard re-runs it every five seconds. With only (kind, ts)
-- indexed SQLite still had to fetch each full row to reach the token and cost
-- columns; on a 184k-event database that was ~1.1s for all time.
--
-- Listing those columns in the index makes it covering: the query is answered
-- from the index alone and never touches the table. Measured on a real
-- database: 1.117s to 0.019s, for about 13MB on a 306MB file. That trade is
-- worth it here because this is the hottest read in the product, and because
-- the alternative — caching — would mean showing stale money.
-- `model` is in the list because the model-mix breakdown groups by it. Left
-- out, that query alone took 1.26s through the Go driver against 57ms with it
-- — the driver pays per row to reach a column outside the index, and the
-- difference does not show up when the same SQL is timed in the sqlite3 shell.
CREATE INDEX IF NOT EXISTS idx_events_cost_cover
  ON events(kind, ts, model, session_id, tokens_in, tokens_out, cache_read, cache_write, cost_usd);
