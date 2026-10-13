-- A session's name as the user set it — verbatim from .ai/03-contracts.md
-- § Session name DDL.
--
-- Renamed from its tab or its sidebar row. It outranks the agent's own title
-- wherever a session is named, and the agent never writes it, so a later
-- ai-title line cannot undo a rename. Empty means not renamed.
ALTER TABLE sessions ADD COLUMN name TEXT NOT NULL DEFAULT '';
