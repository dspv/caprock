-- Branches a session pushed — verbatim from .ai/03-contracts.md § Session
-- branches DDL.
--
-- Read from Claude Code's own record of a `git push` (the PostToolUse
-- payload's tool_response.gitOperation.push.branch), never from GitHub: rule 4.
-- One row per (session, branch); a later push of the same branch moves
-- pushed_at. The session deck finds a pull request by its head branch here
-- when the session never ran `gh pr` itself (session_prs has no row: a script
-- opened it), so the CI cell no longer sticks on an older one.
--
-- Filled at write time by the recorder; history is filled once, in Go, after
-- the daemon starts (meta.session_branches_backfilled).
CREATE TABLE IF NOT EXISTS session_branches (
  session_id TEXT    NOT NULL,
  branch     TEXT    NOT NULL,
  pushed_at  INTEGER NOT NULL,  -- unix ms of the latest push
  PRIMARY KEY (session_id, branch)
);
