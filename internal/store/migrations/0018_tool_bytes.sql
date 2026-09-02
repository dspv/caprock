-- How much each tool call handed back.
--
-- The tool tables could say how OFTEN a tool was used and nothing about how
-- much it cost, and the honest version of "cost" turns out not to exist: tool
-- events carry no tokens, because a tool does not spend them — the turn that
-- reads its output does. Splitting a turn's tokens between its calls would put
-- a number on screen that looks measured and is not.
--
-- What IS measured is the size of what came back, which the PostToolUse hook
-- already delivers in `tool_response`. It answers the question the call count
-- cannot: on one real machine Bash was called 22× more often than Read and
-- returned a quarter as much text. Read is what fills a context; Bash is what
-- fills a list.
--
-- Stored rather than derived. `SUM(LENGTH(json_extract(payload, ...)))` over
-- 89k tool events takes 1.3s on a 641MB database — fine once, far too slow for
-- a screen that refreshes every five seconds.
ALTER TABLE events ADD COLUMN tool_bytes INTEGER NOT NULL DEFAULT 0;

-- Backfilled here rather than lazily: the figure is a lifetime total, so a
-- column that only fills going forward would read as "Read returned nothing"
-- until enough new history accumulated to hide the gap.
UPDATE events
SET tool_bytes = COALESCE(LENGTH(json_extract(payload, '$.tool_response')), 0)
WHERE kind = 'tool.post';

-- Covering index for the tool tables.
--
-- Without it the query finds its rows by (kind, ts) and then fetches each one
-- from the table to read `tool` and `tool_bytes` — and those rows also hold the
-- whole payload, which on a 641MB database was most of the 2.1s it took. With
-- every column in the index the table is never touched: 0.05s, measured on the
-- owner's 254k-event database.
CREATE INDEX IF NOT EXISTS idx_events_tool_dist
  ON events(kind, ts, tool, tool_bytes)
  WHERE tool IS NOT NULL AND tool != '';
