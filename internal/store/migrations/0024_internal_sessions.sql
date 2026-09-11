-- Separate hidden product machinery from sessions and turns a person started.
--
-- Codex writes a normal rollout transcript for `codex-auto-review`, its hidden
-- approval reviewer. Treating that transcript as a user session made its token
-- samples appear as ordinary turns and, because OpenAI publishes no price for
-- the id, raised an unpriced-cost warning the user could not resolve.
--
-- The raw events stay intact. A session flag lets every user-facing aggregate
-- omit the background work without guessing from model-name prefixes, while a
-- separate aggregate can still report its measured token volume. The exact id
-- is backfilled; future internal ids require their own evidence and migration.
ALTER TABLE sessions ADD COLUMN internal INTEGER NOT NULL DEFAULT 0 CHECK (internal IN (0,1));

UPDATE sessions
SET internal = 1
WHERE lower(trim(COALESCE(model,''))) = 'codex-auto-review';

-- These rollups described the internal session as user work. Raw events remain
-- the source for the new background-usage figure.
DELETE FROM session_stats
WHERE session_id IN (SELECT session_id FROM sessions WHERE internal = 1);

DELETE FROM daily_sessions
WHERE session_id IN (SELECT session_id FROM sessions WHERE internal = 1);

DELETE FROM daily_stats
WHERE lower(trim(COALESCE(model,''))) = 'codex-auto-review';
