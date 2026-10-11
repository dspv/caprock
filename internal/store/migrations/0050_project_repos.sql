-- The repositories of a multi-repo project (ADR-055): a folder holding
-- several git repositories that the user chose to treat as one project.
--
-- The project row keeps its root (the folder an agent starts in); this table
-- names the member repositories, each in the same normalised, forward-slash
-- form as sessions.repo_root, so a session joins its member on equality or
-- containment. A repository is a member of at most one listed project; the
-- daemon moves it rather than duplicating it. Removing a member, splitting
-- or unlisting the project deletes rows here and nothing on disk.
CREATE TABLE IF NOT EXISTS project_repos (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path       TEXT    NOT NULL,
  added_at   INTEGER NOT NULL,             -- unix ms
  PRIMARY KEY (project_id, path)
);
CREATE INDEX IF NOT EXISTS idx_project_repos_path ON project_repos(path);
