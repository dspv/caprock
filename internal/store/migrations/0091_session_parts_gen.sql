-- What a session's summary parts read moved, apart from a new row — verbatim
-- from .ai/03-contracts.md § Session parts generation DDL.
--
-- store.PartsCache keeps each live session's scan and, when the session only
-- added rows, adds those rows to it instead of reading the session's whole
-- range again. session_gen.gen (0063) cannot say "only added rows": it moves
-- on every update, and while Claude Code works nearly every response is one
-- (the prose and tool names of a response's later lines are merged into its
-- stored turn, store.MergeAssistantText, a payload the parts never read).
-- `parts` moves only when a column the parts sum changes, or a row goes.
--
-- A tool call the hook stored first gets its message id moments later
-- (store.LinkToolCall), once per call while hooks are on. That changes a
-- part (the call is linked, and its work kind goes to its turn), but it is
-- one known change to one known row, so it is logged instead (parts_links)
-- and the kept scan applies it; the newest 4,096 links are kept, and a
-- reader whose mark is older than the oldest kept reads everything again.
ALTER TABLE session_gen ADD COLUMN parts INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS parts_links (
  seq      INTEGER PRIMARY KEY,
  sid      INTEGER NOT NULL,
  event_id INTEGER NOT NULL,
  msg_id   TEXT    NOT NULL
);

-- gen 0 on a first insert: events_gen_update fires for the same statement
-- and moves gen, whichever of the two runs first.
CREATE TRIGGER IF NOT EXISTS events_parts_update AFTER UPDATE ON events
  WHEN OLD.sid IS NOT NEW.sid OR OLD.ts IS NOT NEW.ts OR OLD.kind IS NOT NEW.kind
    OR OLD.internal IS NOT NEW.internal OR OLD.model IS NOT NEW.model
    OR OLD.touch_dir IS NOT NEW.touch_dir OR OLD.tool IS NOT NEW.tool
    OR OLD.inner_tool IS NOT NEW.inner_tool OR OLD.tool_bytes IS NOT NEW.tool_bytes
    OR OLD.tokens_in IS NOT NEW.tokens_in OR OLD.tokens_out IS NOT NEW.tokens_out
    OR OLD.cache_read IS NOT NEW.cache_read OR OLD.cache_write IS NOT NEW.cache_write
    OR OLD.cost_usd IS NOT NEW.cost_usd
    OR (OLD.msg_id IS NOT NEW.msg_id AND NOT (OLD.msg_id IS NULL AND NEW.kind = 'tool.pre'))
BEGIN
  INSERT INTO session_gen(session_id, gen, parts)
    SELECT session_id, 0, 1 FROM sessions WHERE sid = NEW.sid
    ON CONFLICT(session_id) DO UPDATE SET parts = parts + 1;
  INSERT INTO session_gen(session_id, gen, parts)
    SELECT session_id, 0, 1 FROM sessions WHERE sid = OLD.sid AND OLD.sid IS NOT NEW.sid
    ON CONFLICT(session_id) DO UPDATE SET parts = parts + 1;
END;

CREATE TRIGGER IF NOT EXISTS events_parts_link AFTER UPDATE OF msg_id ON events
  WHEN OLD.msg_id IS NULL AND NEW.msg_id IS NOT NULL AND NEW.kind = 'tool.pre'
BEGIN
  INSERT INTO parts_links(sid, event_id, msg_id) VALUES (NEW.sid, NEW.id, NEW.msg_id);
  DELETE FROM parts_links WHERE seq <= (SELECT MAX(seq) FROM parts_links) - 4096;
END;

CREATE TRIGGER IF NOT EXISTS events_parts_delete AFTER DELETE ON events BEGIN
  INSERT INTO session_gen(session_id, gen, parts)
    SELECT session_id, 0, 1 FROM sessions WHERE sid = OLD.sid
    ON CONFLICT(session_id) DO UPDATE SET parts = parts + 1;
END;
