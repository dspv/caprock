-- How many Second Brain memories a new session was handed with its handoff:
-- 0 none (no handoff, held back, or the repository keeps none). Counted so
-- the Second Brain screen can say how often agents start with its memories
-- instead of guessing. See 03-contracts.md § SessionStart handoff.
ALTER TABLE sessions ADD COLUMN handoff_brain INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_sessions_handoff_brain ON sessions(started_at) WHERE handoff_brain > 0;
