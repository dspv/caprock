-- Which sessions were seen on which day, so the daily session count is a count.
--
-- `daily_stats.sessions` was incremented when a session recorded its *first
-- turn ever* — so a session that started yesterday and worked all of today
-- added nothing to today, and a day whose work was all continuations read
-- zero sessions beside real spend. On the owner's database four of the last
-- eight days read 0 against a true 1, 2, 2 and 2.
--
-- A marker row per (day, project, session) makes "is this the first turn of
-- this session on this day" answerable, and answers it the same way for a
-- session that moved to another project — `daily_stats` is keyed by project
-- too, so the same session working in two repositories is two rows and should
-- count in each.
-- Keyed by day and project, *not* by model. daily_stats is keyed by model too
-- and the dashboard sums a day's rows, so the count has to live in exactly one
-- of them: keyed by model, a session that switched from Opus to Haiku mid-day
-- would be counted twice — measured on the owner's database, 27 August read 3
-- against a true 2. The row that carries the count is the first one written
-- for that (day, project); the rest carry zero.
CREATE TABLE IF NOT EXISTS daily_sessions (
  day        TEXT NOT NULL,          -- local date, matching daily_stats.day
  project    TEXT NOT NULL,
  session_id TEXT NOT NULL,
  PRIMARY KEY (day, project, session_id)
) WITHOUT ROWID;

-- Backfill from the events themselves, which carry the truth this table is a
-- cache of. Local time, matching how `day` is computed on the write path.
INSERT OR IGNORE INTO daily_sessions(day, project, session_id)
SELECT date(e.ts/1000, 'unixepoch', 'localtime'),
       COALESCE(s.project, ''),
       e.session_id
FROM events e LEFT JOIN sessions s ON s.session_id = e.session_id
WHERE e.kind = 'turn.assistant';

-- And correct the counts that were recorded wrong, from the same source.
-- Put each day's count on one row and zero the others, so summing a day's rows
-- — which is what the dashboard does — gives the count once.
--
-- Matched on the day alone rather than on (day, project). A session's project
-- is resolved from its working directory and can be *renamed* later — a chat
-- started before its repository was known is stored as a timestamp and becomes
-- `chat` afterwards — so old daily_stats rows and the markers rebuilt from
-- events disagree about the name while agreeing about the day. Joining on the
-- name leaves those days reading zero, which is the bug this migration exists
-- to fix. The day is the thing the figure is about.
UPDATE daily_stats SET sessions = 0;
UPDATE daily_stats SET sessions = (
  SELECT COUNT(*) FROM daily_sessions ds WHERE ds.day = daily_stats.day
)
WHERE rowid = (
  SELECT MIN(x.rowid) FROM daily_stats x WHERE x.day = daily_stats.day
);
