-- Phase 1 DDL additions — verbatim from .ai/03-contracts.md § Phase 1 DDL additions.
ALTER TABLE sessions ADD COLUMN owned INTEGER NOT NULL DEFAULT 0;  -- spawned by Caprock
ALTER TABLE sessions ADD COLUMN worktree TEXT;
CREATE TABLE throttle_observations (ts INTEGER, session_id TEXT, kind TEXT, payload TEXT);
-- Additive: what Caprock launched (for restart bookkeeping and the spawn dialog history).
ALTER TABLE sessions ADD COLUMN spawn_command TEXT;
ALTER TABLE sessions ADD COLUMN pid INTEGER;
ALTER TABLE sessions ADD COLUMN exit_code INTEGER;
