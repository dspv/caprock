-- What the tool statistics and the subagent rows read from a tool call,
-- stored once when the call is written instead of extracted from its payload
-- on every read (#672). Two readers opened payloads: ToolDrillStats called
-- json_extract eleven times per call and once more per result, and
-- describeSubagents sought idx_events_agent_task, whose expressions parse the
-- result JSON. Neither reads a payload any more, so the payload's storage can
-- change (compression, #672) without either noticing.
--
-- A side table keyed by the event's id rather than columns on events: a
-- column added to events sits after `payload`, and reading it walks the
-- payload's overflow pages (§ Subagent reads DDL); these rows are a few dozen
-- bytes each and stay on their own pages.
--
-- A tool.pre always has a row, with the group its call belongs to on the
-- Tools screen (store.drillKey, derived in Go: Open fills the calls stored
-- before this table). A tool.post has one only when it failed or is an
-- Agent/Task result naming its subagent; no row reads as "succeeded, no
-- agent". The posts are filled here, in SQL, from their payloads.
-- See 03-contracts.md § Tool fields DDL.
CREATE TABLE IF NOT EXISTS tool_fields (
  event_id   INTEGER PRIMARY KEY,  -- events.id
  drill_key  TEXT,                 -- tool.pre: the call's group, home not shortened
  drill_by   TEXT,                 -- tool.pre: what the group is (command, file, ...)
  is_error   INTEGER,              -- tool.post: 1 when the result says it failed
  agent_id   TEXT,                 -- Agent/Task tool.post: tool_response.agentId
  agent_desc TEXT                  -- Agent/Task tool.post: tool_response.description
);

-- describeSubagents: the listed agents' descriptions, each sought by its id.
CREATE INDEX IF NOT EXISTS idx_tool_fields_agent
  ON tool_fields(agent_id, agent_desc)
  WHERE agent_id IS NOT NULL;

-- A deleted event takes its fields with it, whichever code deleted it
-- (retention, removing a session, an ingest repair).
CREATE TRIGGER IF NOT EXISTS events_tool_fields_delete AFTER DELETE ON events BEGIN
  DELETE FROM tool_fields WHERE event_id = OLD.id;
END;

INSERT OR IGNORE INTO tool_fields(event_id, is_error, agent_id, agent_desc)
  SELECT id, is_error, agent_id, agent_desc FROM (
    SELECT id,
           CASE WHEN COALESCE(json_extract(payload, '$.is_error'), 0) <> 0 THEN 1 END AS is_error,
           CASE WHEN tool IN ('Agent', 'Task') THEN NULLIF(json_extract(payload, '$.tool_response.agentId'), '') END AS agent_id,
           CASE WHEN tool IN ('Agent', 'Task') THEN NULLIF(json_extract(payload, '$.tool_response.description'), '') END AS agent_desc
      FROM events
     WHERE kind = 'tool.post' AND json_valid(payload))
   WHERE is_error IS NOT NULL OR agent_id IS NOT NULL;

DROP INDEX IF EXISTS idx_events_agent_task;
