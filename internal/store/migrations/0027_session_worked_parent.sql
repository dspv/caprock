-- worked_at: the last time anyone worked in the session — a prompt, a reply,
-- a tool call. last_event_at moves on everything, including the end event a
-- computer shutting down sends every open session at once; after Vova's
-- restart every ended card read the restart time and the list was ordered by
-- it (FB-037). Moved only by work events from here on, and filled below from
-- the events already stored.
ALTER TABLE sessions ADD COLUMN worked_at INTEGER NOT NULL DEFAULT 0;

-- parent_session: the session this one continues in the same conversation,
-- when that is a fact rather than a guess (FB-039). Two are:
--   * /clear keeps Claude Code's process and starts a new session id, so the
--     session with the same pid that started just before is the one it
--     replaced;
--   * a fork Caprock started names the session it forked in its command line.
-- Same repository, same branch or close in time are deliberately not used:
-- they are how two unrelated sessions look too.
ALTER TABLE sessions ADD COLUMN parent_session TEXT NOT NULL DEFAULT '';

UPDATE sessions SET worked_at = COALESCE((
  SELECT MAX(e.ts) FROM events e
  WHERE e.session_id = sessions.session_id
    AND e.kind IN ('turn.user', 'turn.assistant', 'tool.pre', 'tool.post')
), 0);

UPDATE sessions SET parent_session = COALESCE((
  SELECT p.session_id FROM sessions p
  WHERE p.pid = sessions.pid AND p.session_id <> sessions.session_id
    AND p.started_at < sessions.started_at
  ORDER BY p.started_at DESC LIMIT 1
), '')
WHERE COALESCE(pid, 0) > 0 AND EXISTS (
  SELECT 1 FROM events e
  WHERE e.session_id = sessions.session_id AND e.kind = 'agent.spawn'
    AND json_extract(e.payload, '$.source') = 'clear'
);

UPDATE sessions
SET parent_session = substr(spawn_command, instr(spawn_command, '--resume ') + 9, 36)
WHERE parent_session = '' AND spawn_command LIKE '%--resume %--fork-session%';
