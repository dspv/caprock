-- The permission prompt an owned session is waiting on (ADR-035), kept so a
-- daemon restart does not lose it. The session outlives the daemon in its
-- pty-host (ADR-033), and so does the dialog on its screen; before this table
-- the buttons that answer it lived only in the daemon's memory and did not come
-- back until the next prompt.
--
-- One row per session at most: a newer prompt replaces the row, and whatever
-- clears the prompt in memory (an answer, a key typed into the terminal, the
-- tool's PostToolUse, Stop, the session ending) deletes it. prompt_id is the
-- id the buttons were drawn for, so an answer after a restart is still checked
-- against the prompt it saw. input is the compacted tool input, which is how a
-- PostToolUse is recognised as answering this prompt.
CREATE TABLE IF NOT EXISTS pending_permissions (
  session_id TEXT    NOT NULL PRIMARY KEY,
  prompt_id  TEXT    NOT NULL,
  tool       TEXT    NOT NULL,
  detail     TEXT    NOT NULL DEFAULT '',
  always     TEXT    NOT NULL DEFAULT '',
  since      INTEGER NOT NULL,              -- unix ms the dialog was drawn
  input      TEXT    NOT NULL DEFAULT ''
);
