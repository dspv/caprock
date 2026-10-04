-- Pull requests a session opened or merged — verbatim from .ai/03-contracts.md
-- § Session pull requests DDL.
--
-- Read from Claude Code's own record of a `gh pr` command (the PostToolUse
-- payload's tool_response.gitOperation.pr), never from GitHub: rule 4. One row
-- per (session, pull request); each later command on the same PR moves its
-- timestamps. merged_at is set ONLY by a recorded "merged" action, so nothing
-- here claims a merge it did not see.
--
-- Filled at write time by the recorder; history is filled once, in Go, after
-- the daemon starts (meta.session_prs_backfilled), because the title is parsed
-- out of the command line.
CREATE TABLE session_prs (
  session_id TEXT    NOT NULL,
  url        TEXT    NOT NULL,
  number     INTEGER NOT NULL,
  title      TEXT    NOT NULL DEFAULT '',
  opened_at  INTEGER NOT NULL DEFAULT 0,  -- unix ms of a recorded "created", 0 if none
  merged_at  INTEGER NOT NULL DEFAULT 0,  -- unix ms of a recorded "merged", 0 if none
  closed_at  INTEGER NOT NULL DEFAULT 0,  -- unix ms of a recorded "closed", 0 if none
  last_at    INTEGER NOT NULL,            -- unix ms of the latest command on it
  PRIMARY KEY (session_id, url)
);
CREATE INDEX idx_session_prs_last ON session_prs(last_at);
