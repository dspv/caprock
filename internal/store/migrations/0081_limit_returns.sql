-- A return after the reset (ADR-090): a session Caprock moved by itself at a
-- usage limit goes back to the sign-in or provider it left once that
-- window has reset. session_id is the session now carrying the work,
-- to_target the move's From in continue-on's terms ('default', a
-- subscription id, 'deepseek', 'kimi', 'codex'), return_at when to go back
-- (unix ms). The row is deleted when the session goes back, is moved by
-- hand or is no longer held. Read back when the daemon starts, so a restart
-- keeps the plan; one due more than an hour before that, or whose session
-- has ended, is dropped. See 03-contracts.md § Limit returns DDL.
CREATE TABLE IF NOT EXISTS limit_returns (
  session_id TEXT PRIMARY KEY,
  to_target  TEXT NOT NULL,
  return_at  INTEGER NOT NULL
);
