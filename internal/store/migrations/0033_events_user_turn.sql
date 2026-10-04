-- A session's first prompts, found without reading the rest of the session.
--
-- The sessions list describes every untitled row by its first substantive
-- prompt (store.FirstPrompts). With no index that leads on session_id AND
-- knows the kind, SQLite chose idx_events_kind_ts and walked every turn.user
-- in the database, reading each row to test its session — 6ms per session on
-- the owner's 1 GB database, 330ms of a 50-row /v1/sessions. Pinned to
-- idx_events_session_ts instead it walks the session's own events in time
-- order, which is quick when the first prompt is near the start and reads the
-- whole session when there is none (a subagent-only or Codex session): 600ms
-- cold for the same page.
--
-- Partial, so it holds only the user turns (5k of 333k rows there), and in
-- (session_id, ts) order with the rowid as the implicit tie-break, which is
-- exactly the query's ORDER BY ts, id.
CREATE INDEX IF NOT EXISTS idx_events_user_turn
  ON events(session_id, ts)
  WHERE kind = 'turn.user';
