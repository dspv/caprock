-- An API error that ended a Claude Code session's turn after Claude Code's
-- own retries ran out, and what Caprock did about it (ADR-105) — verbatim
-- from .ai/03-contracts.md § Session API error DDL (migration 0095).
--
-- api_error_at is the synthetic error line's time (unix ms, 0 = none since
-- the last real reply), api_error the short reason shown ("529 Overloaded"),
-- api_error_retry 1 when the error is one worth sending "continue" after
-- (overloaded, 5xx, network, timeout). The tailer sets the three from the
-- transcript and clears them on the first real reply after it.
--
-- api_resume_tries is how many times Caprock typed "continue" in the
-- current incident, api_resume_at when it last did (unix ms),
-- api_resume_for the api_error_at that state answers, and
-- api_resume_state what happened: '' nothing, 'resumed' a try went in,
-- 'recovered' a reply came after one, 'gave_up' the tries ran out,
-- 'stopped' the user took over. The daemon writes them
-- (daemon/apiresume.go); a reply turns 'resumed' into 'recovered'.
ALTER TABLE sessions ADD COLUMN api_error_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN api_error TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN api_error_retry INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN api_resume_tries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN api_resume_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN api_resume_for INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN api_resume_state TEXT NOT NULL DEFAULT '';
-- The watcher asks every few seconds which owned sessions stand on an API
-- error; almost none ever do.
CREATE INDEX IF NOT EXISTS idx_sessions_api_error ON sessions(api_error_at) WHERE api_error_at > 0;
