-- Phase 2 DDL additions (.ai/03-contracts.md § Phase 2 DDL additions).
-- Files are the source of truth for hive state; these tables mirror them for the
-- UI and are rebuildable by rescan.
CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  title         TEXT,
  status        TEXT NOT NULL,
  assignee      TEXT,
  budget_usd    REAL,
  verify_rounds INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,   -- attributed spend (T24)
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_tasks_status ON tasks(status);

CREATE TABLE verifications (
  task_id     TEXT NOT NULL,
  round       INTEGER NOT NULL,
  command     TEXT NOT NULL,
  exit_code   INTEGER NOT NULL,
  output_path TEXT,
  ts          INTEGER NOT NULL,
  PRIMARY KEY (task_id, round, command)
);

-- Per (session, task) forced-continue counter for the Stop-loop guard (T19).
CREATE TABLE forced_continues (
  session_id TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, task_id)
);

-- Task ⇄ session assignment windows, for cost attribution per task (T24).
CREATE TABLE task_assignments (
  task_id    TEXT NOT NULL,
  session_id TEXT NOT NULL,
  from_ts    INTEGER NOT NULL,
  to_ts      INTEGER,
  PRIMARY KEY (task_id, session_id, from_ts)
);
