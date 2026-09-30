-- A session's own name, so ended sessions can be told apart (FB-035).
--
-- Claude Code writes `{"type":"ai-title","aiTitle":…}` lines into its
-- transcript — the name its own /resume picker shows — and OpenCode keeps a
-- title per session. Empty means the agent has not named it; the API then
-- falls back to the session's first substantive prompt, which is derived at
-- read time from events and never stored here.
--
-- Existing Claude Code rows are filled from the transcripts still on disk by
-- ingest.BackfillTitles, run once when the transcript schema moves to v3.
ALTER TABLE sessions ADD COLUMN title TEXT NOT NULL DEFAULT '';

-- The first thing the user typed, for agents whose prompts never become events
-- (Codex: its transcript's user messages open with injected instructions, and
-- its own thread index keeps the clean first message). For every other agent
-- the first prompt is read from events and this stays empty.
ALTER TABLE sessions ADD COLUMN prompt TEXT NOT NULL DEFAULT '';
