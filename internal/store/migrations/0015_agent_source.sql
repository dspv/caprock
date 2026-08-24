-- Which coding agent produced a session.
--
-- Caprock was built around Claude Code, so every row until now came from one
-- place and the column was unnecessary. OpenCode stores its own sessions in a
-- SQLite database of its own, with cost and tokens already computed, and a
-- machine commonly runs both. Without this column the two merge into one
-- undifferentiated stream: a project shows a total nobody can attribute, and a
-- session cannot be routed back to the tool that can control it.
--
-- 'claude' is asserted for existing rows because that is what they are; the
-- default keeps every insert that predates the OpenCode ingester correct
-- without touching its call sites.
ALTER TABLE sessions ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude';

-- Sessions are listed and grouped per agent on every screen that offers the
-- filter, and the Cost screen groups by (agent, project).
CREATE INDEX idx_sessions_agent ON sessions(agent, last_event_at DESC);
