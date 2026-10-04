-- A session started to carry on another's work, in the same or another agent,
-- with a brief rather than the conversation (ADR-032). Empty for every other
-- session. Indexed for the "continued in" list on the source session's page.
ALTER TABLE sessions ADD COLUMN relay_from TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_sessions_relay_from ON sessions(relay_from) WHERE relay_from <> '';
