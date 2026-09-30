-- Whether a new session was handed what the last one left in its folder:
-- 0 no handoff was available, 1 it was given one, 2 one was available and held
-- back to measure what it is worth. See 03-contracts.md.
ALTER TABLE sessions ADD COLUMN handoff INTEGER NOT NULL DEFAULT 0;
