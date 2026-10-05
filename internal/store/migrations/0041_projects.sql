-- Projects a person works in, listed before any session runs there (the
-- desktop app's sidebar, .ai/21-app.md § Projects).
--
-- Until now a "project" was derived from sessions' working directories
-- (migration 0011), so a folder appeared only after an agent had run in it and
-- could never be added, created, cloned or taken off the list. This table is
-- the list. Cost attribution keeps using sessions.repo_root and
-- sessions.project, so no total changes because a row is added or unlisted.
--
-- root is the repository root (or the folder, for kind 'folder') in the same
-- normalised, forward-slash form sessions.repo_root holds, so the two join on
-- equality. archived_at set means unlisted: hidden from the list, never
-- deleted from disk, and not added back by the seeding that adds a repository
-- a session ran in.
CREATE TABLE IF NOT EXISTS projects (
  id             INTEGER PRIMARY KEY,
  root           TEXT    NOT NULL UNIQUE,
  name           TEXT    NOT NULL,
  kind           TEXT    NOT NULL DEFAULT 'repo' CHECK (kind IN ('repo','folder')),
  source         TEXT    NOT NULL DEFAULT 'seed' CHECK (source IN ('seed','session','folder','new','clone')),
  remote_url     TEXT    NOT NULL DEFAULT '',
  default_branch TEXT    NOT NULL DEFAULT '',
  added_at       INTEGER NOT NULL,             -- unix ms
  pinned         INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  sort           INTEGER NOT NULL DEFAULT 0,
  defaults       TEXT    NOT NULL DEFAULT '{}', -- JSON: {agent?, model?, permission_mode?}
  archived_at    INTEGER                       -- unix ms; NULL = listed
);
