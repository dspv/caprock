-- When a Claude Code session last hit its plan's usage limit, as its own
-- transcript records it: the synthetic assistant line Claude Code writes
-- for a refused call (`"error":"rate_limit"`, `"isApiErrorMessage":true`,
-- with `quotaLimits.resetsAt` / `rateLimitType`). limit_hit_at is the line's
-- time (unix ms, 0 = not at a limit), limit_resets_at when the plan says
-- the window reopens (unix ms, 0 = not stated), limit_window which window
-- refused it ('five_hour', 'seven_day', ... as Claude Code names it; '' when
-- not stated). All three go back to their defaults when a real reply
-- arrives after it. See 03-contracts.md § Session limit DDL.
ALTER TABLE sessions ADD COLUMN limit_hit_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN limit_resets_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN limit_window TEXT NOT NULL DEFAULT '';
-- The watcher (daemon/limitwatch.go) asks every few seconds which sessions
-- are at a limit; almost none ever are.
CREATE INDEX IF NOT EXISTS idx_sessions_limit_hit ON sessions(limit_hit_at) WHERE limit_hit_at > 0;
