-- A label the user put on a folder, so chats and the folders they run in can
-- be told apart at a glance: 'work' or 'personal' (ADR-091). dir is the
-- folder's absolute path as the sessions' cwd holds it; a label covers the
-- folders under it too (the UI matches by the longest labelled prefix).
-- Removing a label deletes the row. updated_at is unix ms. See
-- 03-contracts.md § Folder labels DDL.
CREATE TABLE IF NOT EXISTS folder_labels (
  dir        TEXT PRIMARY KEY,
  label      TEXT NOT NULL CHECK (label IN ('work', 'personal')),
  updated_at INTEGER NOT NULL
);
