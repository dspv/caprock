-- A subagent's own rows, found without walking its parent's. The cockpit
-- opens one subagent (GET /v1/sessions/{id}/subagents/{agent}): its calls,
-- turns and SubagentStop. idx_events_session_ts walked every row of the
-- parent to find them: on the owner's busiest session (62,000 events,
-- 2026-10-12) 220 ms warm, with this index 10 ms. Main-thread rows carry a
-- NULL agent_id and stay out of it: 16 MB over 229,000 subagent rows of a
-- 2 GB database, built in 4.5 s.
CREATE INDEX IF NOT EXISTS idx_events_agent
  ON events(session_id, agent_id, ts)
  WHERE agent_id IS NOT NULL;
