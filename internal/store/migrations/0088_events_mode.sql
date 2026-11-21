-- A session's permission mode is read off its hook events alone — verbatim
-- from .ai/03-contracts.md § Permission mode DDL.
--
-- store.LastPermissionMode looks for the newest hook event that states the
-- mode. It walked idx_events_session_ts, which holds every event of the
-- session, and fetched each row from the table, payload and all, to test its
-- source: a session with no hook events (a Codex one, one observed from its
-- transcript alone) was read whole on every ask, and an open session tab asks
-- every few seconds. This index holds only the rows the query can use, in
-- the order it wants them, so such a session costs one empty seek and any
-- other at most the query's window of rows.
CREATE INDEX IF NOT EXISTS idx_events_mode ON events(sid, ts, id)
  WHERE source IN ('hook','cursor') AND kind <> 'tool.post';
