-- A session's priced and unpriced turns are counted off its assistant turns
-- alone — verbatim from .ai/03-contracts.md § Session turns DDL.
--
-- store.SessionCostSeries (the session page's cumulative cost line) and
-- store.SessionUnpricedTurns read a session's assistant turns again every
-- time its events move, which for a working session is every few seconds.
-- They walked idx_events_attr_work, which holds every event of the session
-- in sixteen columns, and the cost line fetched each priced turn's row from
-- the table, payload and all, to test whether its key is a Cursor or Hermes
-- usage record. This index holds only the turns they count, with every
-- column they read, key included, so both are one covering read of the
-- turns alone. (An indexed expression for the key test, which would be
-- smaller, does not make the read covering: SQLite still fetches the row
-- for the column the expression names.)
CREATE INDEX IF NOT EXISTS idx_events_session_turns ON events(
  sid, ts, id, cost_usd, tokens_in, tokens_out, cache_read, cache_write, key
) WHERE kind = 'turn.assistant' AND internal = 0;
