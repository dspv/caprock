-- Separate hidden product machinery from work a person started.
--
-- Codex's `codex-auto-review` is its hidden approval reviewer. The review turns
-- are written into the SAME session as the work they review — Codex reuses the
-- session id — so classification must be per-EVENT, not per-session: flagging a
-- session would hide the real turns sitting beside the review turns in one row.
--
-- The raw events stay intact (the review turns are the source for the
-- background-usage figure); the flag lets every user-facing aggregate omit them
-- without guessing from a model-name prefix. The exact id is backfilled; future
-- internal ids require their own evidence and migration.
ALTER TABLE events ADD COLUMN internal INTEGER NOT NULL DEFAULT 0 CHECK (internal IN (0,1));

UPDATE events
SET internal = 1
WHERE lower(trim(COALESCE(model,''))) = 'codex-auto-review';

-- daily_stats is keyed (day, project, model), so the review model's rows delete
-- cleanly; the review turns never owned a dollar value of their own.
DELETE FROM daily_stats
WHERE lower(trim(COALESCE(model,''))) = 'codex-auto-review';

-- daily_sessions markers for a session that is now review-only go away; a
-- session that still has a non-review event keeps its markers.
DELETE FROM daily_sessions
WHERE session_id NOT IN (SELECT session_id FROM events WHERE internal = 0);

-- session_stats mixes a session's review turns into its single row, so affected
-- rows are recomputed from the non-review events. files_touched is a
-- first-touch count events cannot re-derive, so it is carried over from the old
-- row. A review-only session ends up with no row at all — correct, it did no
-- user work.
CREATE TEMP TABLE ss_files AS
  SELECT session_id, COALESCE(files_touched, 0) AS files_touched
  FROM session_stats
  WHERE session_id IN (SELECT DISTINCT session_id FROM events WHERE internal = 1);

DELETE FROM session_stats
WHERE session_id IN (SELECT session_id FROM ss_files);

INSERT INTO session_stats(session_id, turns, tool_calls, files_touched, tokens_in, tokens_out, cache_read, cache_write, cost_usd)
SELECT e.session_id,
       SUM(CASE WHEN e.kind = 'turn.assistant' THEN 1 ELSE 0 END),
       SUM(CASE WHEN e.kind = 'tool.pre' THEN 1 ELSE 0 END),
       MAX(f.files_touched),
       COALESCE(SUM(e.tokens_in),0), COALESCE(SUM(e.tokens_out),0),
       COALESCE(SUM(e.cache_read),0), COALESCE(SUM(e.cache_write),0),
       COALESCE(SUM(e.cost_usd),0)
FROM events e
JOIN ss_files f ON f.session_id = e.session_id
WHERE e.internal = 0
GROUP BY e.session_id;

DROP TABLE ss_files;
