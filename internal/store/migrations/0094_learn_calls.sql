-- The Bash calls GitHub's stamps are matched against, and the results that
-- end them — verbatim from .ai/03-contracts.md § Learned calls DDL
-- (migration 0094).
--
-- store.learnMatch asks, for every pull request stamp no session recorded,
-- which session of the repository had a Bash call running over it: a call
-- started in the fifteen minutes before the stamp whose result came at or
-- after it. On the call side it walked idx_events_tool_dist, which holds no
-- sid and no key, so it fetched every tool call in each stamp's window from
-- the table, and key comes after payload in the row; on the result side it
-- found each result by idx_events_sid_key and fetched its row for ts. On a
-- cold copy of the owner's database that was 3.1 s for one repository's
-- thousand stamps, most of a cold /v1/week. These two partial indexes hold
-- only the rows the statement can match, with the columns it reads, so
-- neither side reads the table: 0.26 s.
CREATE INDEX IF NOT EXISTS idx_events_bash_pre ON events(ts, sid, key)
  WHERE kind = 'tool.pre' AND tool = 'Bash' AND internal = 0;

CREATE INDEX IF NOT EXISTS idx_events_tool_post ON events(sid, key, ts)
  WHERE kind = 'tool.post';
