-- Delete the Codex turns that collided onto one key, so they can be re-imported.
--
-- The first Codex importer keyed every event on the transcript record's
-- `ordinal` field. That field is present in **1 of 100** real transcripts; in
-- the other 99 it decoded to 0 for every record, so every turn in a session
-- shared the key `codex:turn:0` (and every tool call `codex:tool:0`). The store
-- rejects a duplicate `(session_id, key)` — which is exactly the behaviour that
-- makes re-reading an append-only transcript safe — so all but the first event
-- of each session were dropped on the way in. Silently: a rejected duplicate is
-- the normal case, not an error.
--
-- The damage on the owner's database: 98 turn rows where the transcripts hold
-- 218, one session keeping 1 turn of its 55, and 18.5M tokens absent along with
-- them. Cost was wrong in the direction that matters least — too low — but the
-- session and token counts were simply untrue.
--
-- Keys now come from the record's line number, which is unique by construction
-- in an append-only file. That means a re-import writes the *correct* rows
-- under *different* keys, and would sit them beside the broken ones rather than
-- replacing them. So the broken ones have to go first.
--
-- This deletes rather than repairs because the rows cannot be repaired: each
-- one holds a single turn's tokens where 55 turns happened, and the other 54
-- were never written. The transcripts on disk are intact and are re-read on the
-- next daemon start, so what is deleted here comes back correct within seconds.
--
-- Every Codex event goes, not only the collided ones.
--
-- Scoping this to `codex:turn:0` was the first attempt and it was wrong: the
-- one transcript that *does* carry ordinals imported fine under the old scheme,
-- and its rows survived — then the re-import wrote the same turns again under
-- line-number keys, one greater than the ordinal, and that session counted
-- every turn twice. Deleting only the visibly-broken rows left the invisibly
-- stale ones to be duplicated.
--
-- Deleting all of them is safe precisely because these rows are derived data:
-- the transcripts under ~/.codex are the source, they are append-only, and the
-- importer re-reads every one of them on the next daemon start. Nothing here is
-- the only copy of anything.
DELETE FROM events WHERE source = 'codex';

-- The per-session rollups were accumulated from those events and are now too
-- low. They are rebuilt from the events table as the re-import records each
-- turn, so zeroing the Codex sessions here leaves them to be counted once
-- rather than twice.
UPDATE session_stats
SET turns = 0, tool_calls = 0, files_touched = 0,
    tokens_in = 0, tokens_out = 0, cache_read = 0, cache_write = 0, cost_usd = 0
WHERE session_id IN (SELECT session_id FROM sessions WHERE agent = 'codex');
