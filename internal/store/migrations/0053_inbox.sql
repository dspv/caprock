-- The Inbox: a note, a link or a photo saved for later, from the phone (its
-- Save button, or another app's Share) or on the machine, kept for the user
-- to start a chat from on the Mac. Unlike a saved prompt (0045) it has no
-- name and is written by a paired controller too: saving is what a phone is
-- for here.
--
-- project_id NULL means the Inbox itself, no project. files is a JSON array
-- of paths under <data_dir>/inbox, written by the daemon only; a row's files
-- are deleted with it. from_device is the paired device's name, '' when it
-- was saved on the machine.
CREATE TABLE IF NOT EXISTS inbox (
  id          INTEGER PRIMARY KEY,
  text        TEXT    NOT NULL DEFAULT '',
  files       TEXT    NOT NULL DEFAULT '[]',
  project_id  INTEGER,                -- NULL = the Inbox, no project
  from_device TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL        -- unix ms
);
CREATE INDEX IF NOT EXISTS idx_inbox_created ON inbox(created_at);
