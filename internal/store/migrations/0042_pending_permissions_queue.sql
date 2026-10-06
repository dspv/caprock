-- The permission prompts an owned session is waiting on, as a queue (ADR-035,
-- amended): one row per prompt instead of one per session.
--
-- Claude Code queues permission dialogs — parallel tool calls, a subagent's
-- calls next to the main agent's — and shows the oldest. Migration 0039 kept
-- one row per session, so every PermissionRequest overwrote the last, and the
-- buttons could name a different request than the dialog on the screen. Now
-- each prompt keeps its own row until something answers it; the buttons show
-- the oldest.
--
-- tool_use_id is the hook's own id for the call when Claude Code sends one
-- (it is how a PostToolUse names the prompt it answers); agent_id is set when
-- a subagent asked, so its SubagentStop clears what it left. The rows 0039
-- kept are carried over unchanged.
CREATE TABLE pending_permissions_queue (
  session_id  TEXT    NOT NULL,
  prompt_id   TEXT    NOT NULL,
  tool        TEXT    NOT NULL,
  detail      TEXT    NOT NULL DEFAULT '',
  always      TEXT    NOT NULL DEFAULT '',
  since       INTEGER NOT NULL,              -- unix ms the dialog was drawn
  input       TEXT    NOT NULL DEFAULT '',
  tool_use_id TEXT    NOT NULL DEFAULT '',
  agent_id    TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (session_id, prompt_id)
);

INSERT INTO pending_permissions_queue(session_id, prompt_id, tool, detail, always, since, input)
SELECT session_id, prompt_id, tool, detail, always, since, input FROM pending_permissions;

DROP TABLE pending_permissions;

ALTER TABLE pending_permissions_queue RENAME TO pending_permissions;
