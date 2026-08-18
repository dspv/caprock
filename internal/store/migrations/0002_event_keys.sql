-- DDL v2 — idempotency + accounting columns added in T2 (see .ai/03-contracts.md § DDL v2).
-- key: dedupe handle (hook tool_use_id / prompt_id, transcript uuid). Re-reading a
-- transcript after restart must not double-count a turn.
ALTER TABLE events ADD COLUMN key TEXT;
ALTER TABLE events ADD COLUMN model TEXT;
ALTER TABLE events ADD COLUMN cache_write_1h INTEGER;
ALTER TABLE events ADD COLUMN agent_id TEXT;
CREATE UNIQUE INDEX idx_events_session_key ON events(session_id, key) WHERE key IS NOT NULL;

-- Per-session tracking of which planes have been seen, so ingest can dedupe
-- against hooks by session_id (transcript emits only usage when hooks are live).
ALTER TABLE sessions ADD COLUMN has_hooks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN has_transcript INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN git_branch TEXT;
ALTER TABLE sessions ADD COLUMN version TEXT;

-- Files touched per session, so files_touched is a real count and the Now card can list them.
CREATE TABLE session_files (
  session_id TEXT NOT NULL,
  path TEXT NOT NULL,
  first_ts INTEGER NOT NULL,
  last_ts INTEGER NOT NULL,
  PRIMARY KEY (session_id, path)
);

-- Ingest offsets: resume tailing where we left off.
CREATE TABLE transcript_offsets (
  path TEXT PRIMARY KEY,
  session_id TEXT,
  offset INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
