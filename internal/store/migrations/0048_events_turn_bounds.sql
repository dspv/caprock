-- Where Claude Code's turns begin and end, without reading the table.
--
-- The Queue view (.ai/03-contracts.md § Queue) estimates how long a turn
-- takes in a project from the turns already finished there: the hooks'
-- UserPromptSubmit (turn.user) to the main thread's Stop (agent.stop) or
-- StopFailure (throttle). No index held source and agent_id, so the scan read
-- every matching row from the table: on a copy of the owner's database
-- (2026-10-12, 2 GB, 16k such rows) one project's turns took 1.6 s cold and
-- 47 ms warm through idx_events_kind_id. Partial to the hook plane's turn
-- bounds, so it holds those 16k rows and nothing else, and covering, so the
-- same read is 1 ms. Building it took 4 s there, once.
CREATE INDEX IF NOT EXISTS idx_events_turn_bounds
  ON events(session_id, ts, kind, agent_id)
  WHERE source = 'hook' AND kind IN ('turn.user', 'agent.stop', 'throttle');
