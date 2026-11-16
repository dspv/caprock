-- The Jarvis thread (ADR-097): the person's messages to Jarvis and Jarvis's
-- replies, oldest first. role is 'user' or 'jarvis'; kind says what made a
-- row ('say', 'reply', 'done', 'auto_answer'); project and session_id what
-- it was about ('' for none); via 'text' or 'voice' on a user row; pending 1
-- while the brain is still answering (a restart turns those into a note);
-- brain 1 when a model ran for the row; cost_usd what that run cost, as the
-- agent reported it (0 when unknown or no model ran). Pruned to the newest 2000 rows. See
-- 03-contracts.md § Jarvis thread DDL.
CREATE TABLE IF NOT EXISTS jarvis_thread (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  role       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT '',
  text       TEXT NOT NULL,
  project    TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  via        TEXT NOT NULL DEFAULT '',
  pending    INTEGER NOT NULL DEFAULT 0,
  brain      INTEGER NOT NULL DEFAULT 0,
  cost_usd   REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_jarvis_thread_at ON jarvis_thread(at);
