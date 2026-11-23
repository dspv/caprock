-- Which agent made a 2nd Brain read, and whether it reported the read's
-- tokens — verbatim from .ai/03-contracts.md § 2nd Brain reader DDL
-- (migration 0092, ADR-103).
--
-- A read used to go through claude only, which always reports its usage.
-- It can now go through Codex, Cursor or Gemini CLI too, and Cursor reports
-- none: such a read keeps 0 tokens with no_usage = 1 and is counted against
-- the daily reads limit, never estimated. Every row before this migration
-- was claude's: reader '' reads as claude.
ALTER TABLE brain_runs ADD COLUMN reader TEXT NOT NULL DEFAULT '';
ALTER TABLE brain_runs ADD COLUMN no_usage INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_brain_runs_reader ON brain_runs(reader, id);
