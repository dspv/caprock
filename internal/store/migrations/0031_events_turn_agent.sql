-- Assistant turns by session, agent id and model, covered.
--
-- The Now screen's At a glance block splits all-time turns and cost by agent
-- (Claude Code's by main thread and subagent) and the bill by token type.
-- agent_id and cache_write_1h are in no covering index, so both read every
-- assistant turn's full row: 3.5 s and 2 s on the owner's 1 GB database
-- (2026-10-04). Partial to assistant turns, the index stays a fraction of the
-- table and serves both.
CREATE INDEX IF NOT EXISTS idx_events_turn_agent
  ON events(kind, ts, session_id, agent_id, model, cost_usd,
            tokens_in, tokens_out, cache_read, cache_write, cache_write_1h, internal)
  WHERE kind = 'turn.assistant';
