-- Jarvis's Handled for you log (ADR-096): what Caprock did on its own — a
-- session moved to another sign-in at its usage limit and moved back after
-- the reset, a session continued after a usage limit reset, a session ended
-- when done or after idling with no tab, the morning summary sent, and an
-- answer the Jarvis brain gave a routine question. One row per action; kind
-- names it (limit_switch, limit_return, limit_resume, end_done, idle_end,
-- morning, auto_answer), text says it in one line, reason why. undo_kind and
-- undo_session (and undo_target) name the action that undoes it, '' when
-- none does. Rows older than 30 days are deleted as new ones are written.
-- See 03-contracts.md § Jarvis handled DDL.
CREATE TABLE IF NOT EXISTS jarvis_handled (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  session_id   TEXT NOT NULL DEFAULT '',
  project      TEXT NOT NULL DEFAULT '',
  text         TEXT NOT NULL,
  reason       TEXT NOT NULL DEFAULT '',
  undo_kind    TEXT NOT NULL DEFAULT '',
  undo_session TEXT NOT NULL DEFAULT '',
  undo_target  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_jarvis_handled_at ON jarvis_handled(at);
