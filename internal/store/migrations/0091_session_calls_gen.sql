-- A session's calls generation, and no generation move for a compressed
-- payload — verbatim from .ai/03-contracts.md § Session calls generation DDL.
--
-- GET /v1/sessions/{id}/calls is kept by the session's generation and read
-- whole when it moves, and on a working session it moved on nearly every
-- row: the owner's main session had gen 92,720 over 83,240 events
-- (2026-11-23), from the idle compression of tool payloads (~50,000 rows),
-- the transcript's message id written onto a hook's tool call (~27,000) and
-- the assistant text merged into a turn. None of the first changes what any
-- reader sees; the other two change nothing the calls read but the link,
-- which store.ReadSessionCalls picks up itself.
--
-- 1. An update that only stores a text payload compressed moves nothing.
--    The compression pass (store.CompressPayloadsStep) is the only writer
--    that turns a text payload into a BLOB, and it writes the same JSON;
--    every reader of a tool row decompresses (ZPayload). The test is the
--    storage class going from text to BLOB with every other column the
--    same. Restoring (BLOB to text) still moves the generation: another
--    writer rewrites a compressed payload as changed text.
-- 2. calls_gen moves only on an update that changes a column the calls read
--    (the row's id, time, session or kind; a turn's model, cost, tokens,
--    message id, agent, internal flag or sidechain mark; a tool call's tool,
--    agent, payload or a message id it already had), and on every delete.
--    A tool call's message id going from none to one does not move it: the
--    reader keeps the ids of the tool calls it saw without one and reads
--    those again (store.CallsSeries).
ALTER TABLE session_gen ADD COLUMN calls_gen INTEGER NOT NULL DEFAULT 0;

DROP TRIGGER IF EXISTS events_gen_update;
CREATE TRIGGER events_gen_update AFTER UPDATE ON events
WHEN NOT (typeof(OLD.payload) = 'text' AND typeof(NEW.payload) = 'blob'
  AND NEW.id IS OLD.id AND NEW.ts IS OLD.ts AND NEW.sid IS OLD.sid AND NEW.source IS OLD.source
  AND NEW.kind IS OLD.kind AND NEW.tool IS OLD.tool AND NEW.tokens_in IS OLD.tokens_in
  AND NEW.tokens_out IS OLD.tokens_out AND NEW.cache_read IS OLD.cache_read
  AND NEW.cache_write IS OLD.cache_write AND NEW.cost_usd IS OLD.cost_usd AND NEW.key IS OLD.key
  AND NEW.model IS OLD.model AND NEW.cache_write_1h IS OLD.cache_write_1h
  AND NEW.agent_id IS OLD.agent_id AND NEW.msg_id IS OLD.msg_id AND NEW.touch_dir IS OLD.touch_dir
  AND NEW.tool_bytes IS OLD.tool_bytes AND NEW.internal IS OLD.internal
  AND NEW.inner_tool IS OLD.inner_tool)
BEGIN
  INSERT INTO session_gen(session_id, gen)
    SELECT session_id, 1 FROM sessions WHERE sid = NEW.sid
    ON CONFLICT(session_id) DO UPDATE SET gen = gen + 1;
  INSERT INTO session_gen(session_id, gen)
    SELECT session_id, 1 FROM sessions WHERE sid = OLD.sid AND OLD.sid IS NOT NEW.sid
    ON CONFLICT(session_id) DO UPDATE SET gen = gen + 1;
  INSERT INTO session_gen(session_id, gen, calls_gen)
    SELECT session_id, 1, 1 FROM sessions WHERE sid = NEW.sid AND (
      NEW.id IS NOT OLD.id OR NEW.ts IS NOT OLD.ts OR NEW.sid IS NOT OLD.sid OR NEW.kind IS NOT OLD.kind
      OR (NEW.kind = 'turn.assistant' AND (
        NEW.model IS NOT OLD.model OR NEW.cost_usd IS NOT OLD.cost_usd
        OR NEW.tokens_in IS NOT OLD.tokens_in OR NEW.tokens_out IS NOT OLD.tokens_out
        OR NEW.cache_read IS NOT OLD.cache_read OR NEW.cache_write IS NOT OLD.cache_write
        OR NEW.cache_write_1h IS NOT OLD.cache_write_1h OR NEW.msg_id IS NOT OLD.msg_id
        OR NEW.agent_id IS NOT OLD.agent_id OR NEW.internal IS NOT OLD.internal
        OR (CASE WHEN typeof(OLD.payload) = 'text' AND json_valid(OLD.payload)
                 THEN json_extract(OLD.payload, '$.sidechain') ELSE OLD.payload END)
           IS NOT (CASE WHEN typeof(NEW.payload) = 'text' AND json_valid(NEW.payload)
                        THEN json_extract(NEW.payload, '$.sidechain') ELSE NEW.payload END)))
      OR (NEW.kind = 'tool.pre' AND (
        NEW.tool IS NOT OLD.tool OR NEW.agent_id IS NOT OLD.agent_id OR NEW.payload IS NOT OLD.payload
        OR (NEW.msg_id IS NOT OLD.msg_id AND OLD.msg_id IS NOT NULL))))
    ON CONFLICT(session_id) DO UPDATE SET calls_gen = calls_gen + 1;
  INSERT INTO session_gen(session_id, gen, calls_gen)
    SELECT session_id, 1, 1 FROM sessions WHERE sid = OLD.sid AND OLD.sid IS NOT NEW.sid
    ON CONFLICT(session_id) DO UPDATE SET calls_gen = calls_gen + 1;
END;

DROP TRIGGER IF EXISTS events_gen_delete;
CREATE TRIGGER events_gen_delete AFTER DELETE ON events BEGIN
  INSERT INTO session_gen(session_id, gen, calls_gen)
    SELECT session_id, 1, 1 FROM sessions WHERE sid = OLD.sid
    ON CONFLICT(session_id) DO UPDATE SET gen = gen + 1, calls_gen = calls_gen + 1;
END;
