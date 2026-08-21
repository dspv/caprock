-- Per-directory attribution — verbatim from .ai/03-contracts.md § Touch attribution DDL.
--
-- THE PROBLEM. The Projects breakdown keyed its per-directory rows on the
-- SESSION's cwd (sessions.repo_path), so a monorepo whose services live in
-- /services/api and /services/web showed exactly one directory row: the one
-- Claude happened to be launched from. That answers "where was the terminal",
-- not "which service cost what" — and on the owner's database only one
-- repository expanded at all, because only one had sessions started from two
-- different directories.
--
-- The signal people actually mean is which FILES Claude touched. That lives in
-- the tool call: a tool.pre payload carries `tool_input.file_path` for the
-- tools that name one.
--
-- THE CONSTRAINT. Cost lives on turn.assistant and NOWHERE else — SUM(cost_usd)
-- over tool.pre is exactly 0 on the owner's 191k-event database. So a directory
-- can only be charged by first linking each tool call to the turn that paid for
-- it.
--
-- THE LINKAGE: msg_id. A tool_use block and the usage billed for it are content
-- blocks of the SAME assistant message, so they share its id by construction.
-- This is exact rather than statistical, and it is written at ingest because
-- nothing downstream can recover it: one API response is written as several
-- assistant lines (thinking / text / tool_use) that each repeat the same usage,
-- the store keeps only the first (key `msg:<id>`), and the tool_use blocks
-- arrive on a later line whose turn row was deduped away. Ordering by id
-- therefore lands a tool AFTER the next distinct turn — measured against
-- transcript ground truth, nearest-preceding-turn recovers the true message id
-- for 1981 of 5115 tool calls (38.7%), a systematic one-turn shift.
--
-- WHY COLUMNS AND NOT json_extract ON READ. /v1/stats/summary is polled. On the
-- owner's database (measured through the Go driver, 2026-08-22, 30d range):
-- the summary answers in ~152ms warm, and json_extract over the 48212 tool.pre
-- rows in that range costs ~215ms on its own — it would more than double a
-- polled endpoint before any grouping happened. Resolved once at ingest, the
-- read is an indexed column scan.
--
--   msg_id    — assistant message id; links tool.pre to the turn that paid
--   touch_dir — the directory the tool touched, absolute and slash-normalized
ALTER TABLE events ADD COLUMN msg_id TEXT;
ALTER TABLE events ADD COLUMN touch_dir TEXT;

-- Backfill from the payloads already stored. Both facts are present in
-- historical rows, so this needs no filesystem and no transcript re-read:
-- turn.assistant has always written `message_id`, and tool.pre has always
-- written `tool_input.file_path`. Only the ingest-time EXTRACTION is new.
--
-- tool.pre rows captured by the hook plane carry no message id (the PreToolUse
-- payload does not contain one), so theirs stays NULL and their spend reports
-- as unattributed rather than being guessed at.
UPDATE events SET msg_id = json_extract(payload, '$.message_id')
 WHERE kind = 'turn.assistant' AND json_extract(payload, '$.message_id') IS NOT NULL;

UPDATE events SET msg_id = json_extract(payload, '$.message_id')
 WHERE kind = 'tool.pre' AND json_extract(payload, '$.message_id') IS NOT NULL;

-- touch_dir is the DIRECTORY, not the file, and it is backfilled in GO rather
-- than here (Store.backfillTouch, which runs right after this migration).
--
-- Deriving a dirname in SQL would mean re-implementing path normalization in a
-- second language: folding backslashes so a Windows-captured session groups
-- with the same repository read on any other host, collapsing duplicate
-- separators, and refusing to strip a root. SQLite has no `reverse`, so the
-- basename cut is string surgery that would silently disagree with the Go
-- resolver at exactly the edges that matter. One definition, in store.TouchDir,
-- used by both the ingest path and the backfill.
--
-- The backfill is idempotent: it only reads tool.pre rows whose touch_dir is
-- still NULL, and rows whose tool named no path are left NULL for good.

-- The attribution query walks tool.pre rows in a time range and joins them to
-- turns by (session_id, msg_id). Covering both keeps it off the table.
CREATE INDEX IF NOT EXISTS idx_events_touch ON events(kind, ts, session_id, msg_id, touch_dir);
CREATE INDEX IF NOT EXISTS idx_events_msg ON events(session_id, msg_id) WHERE msg_id IS NOT NULL;
