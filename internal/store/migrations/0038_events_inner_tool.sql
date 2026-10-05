-- The tool a Codex `exec` call actually ran, so "What it went on" can tell its
-- patches from its commands.
--
-- Codex's `exec` is a wrapper: its input is a JavaScript script that calls the
-- real tools as tools.exec_command(…), tools.apply_patch(…) and so on. Of
-- 13,086 calls on the owner's machine (2026-10-05) 63% ran a command and 14%
-- applied a patch, yet all of them counted as "command", so Codex's editing
-- read as 0.4% of 30-day spend instead of 4.8%.
--
-- Stored rather than read from the payload at query time. Reading the script
-- inside the work-kind scan breaks its covering index: the scan went from
-- ~90 ms to ~190 ms and the 30-day summary from ~270 ms to ~760 ms on a copy of
-- that database. The value is derived in Go (store.innerTool) when the event is
-- written, and rows already stored are filled by Store.backfillInnerTool on
-- the next open — the same split as touch_dir (0012), because the regex that
-- reads the script must have one definition, not a second one in SQL.
--
-- NULL for every other tool call: only `exec` hides its tool.
ALTER TABLE events ADD COLUMN inner_tool TEXT;

-- The work-kind scan reads every column from idx_events_attr_work, so the new
-- one joins it; SQLite cannot widen an index in place.
DROP INDEX IF EXISTS idx_events_attr_work;
CREATE INDEX idx_events_attr_work ON events(
  session_id, ts, id, kind, msg_id, touch_dir, tool,
  cost_usd, tokens_in, tokens_out, cache_read, cache_write, internal, inner_tool
);
