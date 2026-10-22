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
-- Tools screen (store.drillKey). A tool.post has one only when it failed or
-- is an Agent/Task result naming its subagent; no row reads as "succeeded,
-- no agent".
--
-- Nothing is filled here: reading every tool payload took 15 s on a 2 GB
-- database, and a migration runs before the daemon answers. The calls stored
-- before this table are filled in the background, newest first
-- (Store.ToolFieldsStep); until then meta.tool_fields_pending names the
-- highest id not yet filled, and the readers take those rows from their
-- payloads as before.
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

-- idx_events_agent_task (0054) stays until the fill is done: describeSubagents
-- seeks it for the results not yet filled, 0.1 ms where reading their
-- payloads was 345 ms on a busy session. Store.ToolFieldsStep drops it with
-- the last step.
