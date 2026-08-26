-- Rename quick-chat sessions that were stored before chats had a label.
--
-- A chat lives in `<data_dir>/chats/<YYYY-MM-DD-HHMMSS>/` and took its project
-- name from that directory, so the dashboard listed `2026-08-26-212735`
-- alongside repositories with names. The owner's reaction on seeing one was
-- that it was not clear what he was looking at, which is the correct reaction
-- to a timestamp presented as an identity.
--
-- New sessions are labelled at write time (store.chatLabel). This is for the
-- ones already on disk: a label is stored, not derived, so fixing the
-- derivation leaves history untouched.
--
-- SQLite has no date formatter that produces `Jan 2, 15:04`, and inventing one
-- out of substr() would put a second, subtly different implementation of the
-- name in the schema. So this writes the plain marker; the row reads as a chat
-- immediately, and its exact wording follows whenever the session is next
-- upserted. Being briefly less precise beats being permanently inconsistent.
UPDATE sessions
   SET project = 'chat'
 WHERE (repo_root IS NULL OR repo_root = '')
   AND cwd LIKE '%/chats/%'
   AND project GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-*';
