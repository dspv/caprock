-- The summaries' per-session scan covers every column they sum — verbatim
-- from .ai/03-contracts.md § Session parts DDL.
--
-- The wide summaries (7d, 30d, all time; /v1/stats/summary, /v1/history) are
-- now kept per session and only the sessions whose events moved are read
-- again (store.PartsCache). That read seeks each such session on this index,
-- so it has to cover everything a summary sums: the model mix needs `model`
-- and the tool distribution `tool_bytes`, which idx_events_attr_work did not
-- carry, and without them every row of a live session would be fetched from
-- the table, payload and all. The columns go on the end, so every query that
-- pins the index by name keeps its plan; SQLite cannot add a column to an
-- index in place, so it is dropped and created again under the same name.
DROP INDEX IF EXISTS idx_events_attr_work;
CREATE INDEX idx_events_attr_work ON events(
  sid, ts, id, kind, msg_id, touch_dir, tool,
  cost_usd, tokens_in, tokens_out, cache_read, cache_write, internal, inner_tool,
  model, tool_bytes
);
