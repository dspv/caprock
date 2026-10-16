-- Chats as a kind of session (ADR-071): a session Caprock started in its own
-- chats workspace, <data_dir>/chats/<stamp>/, to ask something rather than to
-- work on a repository. `chat` marks it, so the Chats list can find them
-- without reading paths and the project and terminal lists can leave them
-- out; `archived_at` (unix ms, 0 = not archived) hides one from the Chats
-- list without deleting anything. See 03-contracts.md § Chats DDL.
ALTER TABLE sessions ADD COLUMN chat INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN archived_at INTEGER NOT NULL DEFAULT 0;
-- The chats recorded before this column: their folder is a dated name under a
-- folder called `chats` (internal/agents newChatDir), with a counter for a
-- second chat started in the same second. GLOB, because LIKE's `_` would also
-- take a letter; `[/\]` takes either separator.
UPDATE sessions SET chat = 1
WHERE cwd GLOB '*[/\]chats[/\][0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]'
   OR cwd GLOB '*[/\]chats[/\][0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]-[0-9]*';
CREATE INDEX IF NOT EXISTS idx_sessions_chat ON sessions(last_event_at) WHERE chat = 1;
