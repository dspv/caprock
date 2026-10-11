-- Spend by branch — verbatim from .ai/03-contracts.md § Branch spend DDL.
--
-- The session deck's Branches view sums what Caprock's sessions cost on each
-- branch of one repository: sessions WHERE repo_root = ? GROUP BY git_branch,
-- joined to session_stats by its primary key. Indexed on both columns so the
-- read is a range of this index, grouped in its order, never a scan of every
-- session on the machine.
CREATE INDEX IF NOT EXISTS idx_sessions_repo_branch ON sessions(repo_root, git_branch);
