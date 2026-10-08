-- The subagent type of a stored permission prompt (ADR-035, amended
-- 2026-10-09).
--
-- Claude Code draws a subagent's permission dialog in the parent's terminal,
-- and the card named no requester: the owner approved a subagent's command
-- believing it was the main thread's. The card now says "Subagent
-- (general-purpose) wants to run Bash", and the type comes from the hook's
-- agent_type, which is kept here so the card says the same after a daemon
-- restart. Empty for the main thread's prompts and for rows stored before.
ALTER TABLE pending_permissions ADD COLUMN agent_type TEXT NOT NULL DEFAULT '';
