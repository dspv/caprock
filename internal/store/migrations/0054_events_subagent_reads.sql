-- What the cockpit's subagent rows read, without the parent session's rows.
--
-- GET /v1/sessions/{id}/subagents is asked again every two seconds while a
-- session's subagents work, by every open cockpit. Three of its reads walked
-- every row of the parent session through idx_events_session_id and read
-- each from the table — and the columns they test (agent_id, internal,
-- cost_usd) sit after `payload`, so every row also walked its payload's
-- overflow pages. With nine live sessions the daemon's own slow-query log
-- named them hundreds of times an hour (2026-10-14). Measured on a copy of
-- the owner's 2.4 GB database: .ai/03-contracts.md § Subagent reads DDL.

-- The parent's Agent/Task results, by the agent id each names: the
-- description a subagent row shows (store.describeSubagents). The id and the
-- description are inside the result's JSON, so the index holds the two
-- expressions and the query never opens a payload. json_valid guards the
-- extraction: json_extract raises an error on malformed JSON, which in an
-- index expression would fail the INSERT, and an event must never be lost to
-- an index. The query names the same expressions, character for character
-- (store.agentTaskID, store.agentTaskDesc).
CREATE INDEX IF NOT EXISTS idx_events_agent_task
  ON events(session_id,
            (CASE WHEN json_valid(payload) THEN json_extract(payload, '$.tool_response.agentId') END),
            (CASE WHEN json_valid(payload) THEN json_extract(payload, '$.tool_response.description') END))
  WHERE kind = 'tool.post' AND tool IN ('Agent', 'Task');

-- A subagent's own priced turns, covering store.SubagentsSpend: per agent,
-- its newest turn's model and what its turns cost. kind and internal are
-- columns as well as conditions: SQLite counts an index as covering only
-- when it holds every column the query names, its WHERE terms included.
CREATE INDEX IF NOT EXISTS idx_events_subagent_turn
  ON events(session_id, agent_id, ts, model, cost_usd, tokens_in, kind, internal)
  WHERE kind = 'turn.assistant' AND agent_id IS NOT NULL AND internal = 0;

-- A session's subagent rows in time order, with their agent and kind,
-- covering the live-subagent counts (store.LiveSubagents, SubagentsNow,
-- SubagentsDone): the subagents heard from in the last 30 minutes, grouped by
-- agent, each row's kind tested. idx_events_agent (0049) leads on the agent,
-- so it cannot seek on the window; the session's own index can, but then
-- reads every row from the table.
CREATE INDEX IF NOT EXISTS idx_events_agent_ts
  ON events(session_id, ts, agent_id, kind)
  WHERE agent_id IS NOT NULL;
