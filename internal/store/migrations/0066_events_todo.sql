-- A session's task tool calls, for its task list (store.SessionTodos): the
-- Work board reads it for every live session that wrote anything, and through
-- idx_events_attr_work it walked the session's whole index range to find a few
-- rows (F18, docs/resource-usage-audit-2026-10-18.md). The partial index holds
-- only those calls; the rowid tail gives the query's ORDER BY ts, id.
-- See 03-contracts.md § Task-list DDL.
CREATE INDEX IF NOT EXISTS idx_events_todo
  ON events(session_id, ts)
  WHERE kind = 'tool.pre' AND tool IN ('TodoWrite', 'TaskCreate', 'TaskUpdate', 'update_plan');
