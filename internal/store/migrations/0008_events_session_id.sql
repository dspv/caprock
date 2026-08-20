-- The Now screen asks for each session's last 60 events to build one line of
-- narration, and does it for every session on the page. That query orders by
-- id, but the only session index was (session_id, ts) — so SQLite read every
-- event of the session and sorted it in a temp B-tree to find the newest 60.
-- On a session with 13k events that is 13k rows read to return 60.
--
-- Measured on a real 184k-event database: the per-session loop behind
-- /v1/sessions went from 296ms to 24ms.
CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id, id);
