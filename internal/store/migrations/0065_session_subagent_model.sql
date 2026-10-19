-- The model a Claude Code session's subagents were started to run on
-- (CLAUDE_CODE_SUBAGENT_MODEL): "haiku", "sonnet" or "opus", empty when the
-- session did not choose one (subagents follow the session). Set once, when
-- Caprock starts the session. See 03-contracts.md § Subagent model.
ALTER TABLE sessions ADD COLUMN subagent_model TEXT NOT NULL DEFAULT '';
