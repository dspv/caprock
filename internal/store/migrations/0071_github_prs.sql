-- The pull request headers GitHub already sent (owner, 2026-10-23): every
-- list the Pipeline reads (github.RepoPulls, the newest 50 by update) is
-- upserted here, so a repository's history accumulates past those 50 and a
-- pull request opened outside an agent — by hand, by a contributor — still
-- has a head branch for its sessions to be charged by (store.SpendByPR).
-- Nothing is asked of GitHub for it: these are only the rows of lists the
-- daemon read anyway.
--
-- Nothing is filled here: the table starts empty and grows as lists are
-- read (a migration runs before the daemon answers).
-- See 03-contracts.md § GitHub pull requests DDL.
CREATE TABLE IF NOT EXISTS github_prs (
  repo       TEXT    NOT NULL COLLATE NOCASE,  -- owner/name
  number     INTEGER NOT NULL,
  url        TEXT    NOT NULL,
  title      TEXT    NOT NULL DEFAULT '',
  head       TEXT    NOT NULL DEFAULT '',      -- head branch
  state      TEXT    NOT NULL DEFAULT '',      -- open | closed | merged
  created_at INTEGER NOT NULL DEFAULT 0,       -- unix ms, GitHub's stamps
  merged_at  INTEGER NOT NULL DEFAULT 0,       -- 0 until merged
  closed_at  INTEGER NOT NULL DEFAULT 0,       -- 0 while open
  updated_at INTEGER NOT NULL DEFAULT 0,
  seen_at    INTEGER NOT NULL,                 -- unix ms the daemon last read it
  PRIMARY KEY (repo, number)
) WITHOUT ROWID;
