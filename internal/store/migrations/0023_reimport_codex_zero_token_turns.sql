-- Clear the Codex events again, so turns stored with no tokens are re-read.
--
-- Until v0.54.4 the importer read only the per-kind breakdown of a token
-- report. About half of Codex's samples fill in `total_tokens` and leave every
-- component at zero — 114 of 233 on the machine this was measured on, one of
-- them 4.4M tokens — so those turns were stored as having used nothing. On that
-- machine it hid 18.6M tokens and showed $23.71 of usage as $0.53.
--
-- The rows cannot be repaired in place: `events.payload` records the model and
-- the cwd, not the token report, so the numbers are simply not in the database.
-- The transcripts under ~/.codex are, they are append-only, and the importer
-- re-reads every one of them on the next daemon start — which is why deleting
-- is the cheap and correct move here, exactly as in migration 0022.
--
-- Deliberately unscoped to the affected rows. Picking out "turns with zero
-- tokens" would leave the correct rows in place and let the re-import add the
-- same turns beside them; 0022 made precisely that mistake by scoping to the
-- visibly-broken keys, and one session then counted every turn twice. The keys
-- are unchanged by this release, so a partial delete would collide rather than
-- duplicate — but the cost of being wrong again is higher than the cost of
-- re-reading a hundred files.
DELETE FROM events WHERE source = 'codex';

-- The rollups were accumulated from those events. Zeroed so the re-import
-- counts each turn once rather than adding to a stale total.
UPDATE session_stats
SET turns = 0, tool_calls = 0, files_touched = 0,
    tokens_in = 0, tokens_out = 0, cache_read = 0, cache_write = 0, cost_usd = 0
WHERE session_id IN (SELECT session_id FROM sessions WHERE agent = 'codex');
