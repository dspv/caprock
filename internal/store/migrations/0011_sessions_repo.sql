-- Repository grouping — verbatim from .ai/03-contracts.md § Repository grouping DDL.
--
-- sessions.project used to hold the BASENAME of the cwd, so one repository
-- became several rows (caprock, ui), a subdirectory posed as a project (app
-- under a monorepo), agent worktrees became projects (worker-1), and two
-- unrelated paths ending in the same segment silently summed into one row
-- (two testrepo, two repo on the owner's real database).
--
-- project now holds the REPOSITORY label, and these columns carry the rest of
-- the resolved identity so neither the summary query nor the per-subdirectory
-- breakdown has to touch the filesystem on a read.
--
--   repo_root — absolute repository root, '' when the cwd is not in a repo
--   repo_path — location within the repository, '' at the root itself
--
-- The values are resolved once at ingest (a cached upward walk for .git, with a
-- linked worktree followed to the repository that owns it) and backfilled for
-- existing rows by Store.backfillRepo, which runs right after this migration.
-- Backfill is in Go because resolution needs the filesystem, and it is
-- idempotent: it only writes rows whose repo_root is still NULL.
ALTER TABLE sessions ADD COLUMN repo_root TEXT;
ALTER TABLE sessions ADD COLUMN repo_path TEXT;

-- The projects roll-up joins events to sessions and groups by project; the
-- breakdown groups by (project, repo_path). Both read only these three columns
-- for a session, so covering them keeps the join off the sessions table.
CREATE INDEX IF NOT EXISTS idx_sessions_repo ON sessions(session_id, project, repo_path);
