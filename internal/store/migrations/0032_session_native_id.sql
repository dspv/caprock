-- native_id: the agent's own id for a session Caprock started under an id of
-- its own. Claude Code and Gemini CLI take Caprock's id on the command line
-- (--session-id), so theirs is always empty. Codex and OpenCode cannot be told
-- an id: Codex names its thread itself and OpenCode creates its session when
-- the first message is sent. The importers write a linked thread's events under
-- the Caprock session that started it, so its cost and history land on the
-- page with its terminal, and `codex resume` / `opencode --session` are given
-- this id. Empty for every session that was never linked.
ALTER TABLE sessions ADD COLUMN native_id TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_sessions_native
  ON sessions(agent, native_id)
  WHERE native_id <> '';
