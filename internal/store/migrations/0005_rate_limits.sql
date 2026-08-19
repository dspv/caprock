-- Rate-limit snapshots from Claude Code's statusline JSON (`rate_limits`) — see
-- .ai/03-contracts.md § Rate-limit snapshots. Present only for Pro/Max subscribers.
-- Two tables: a small "latest per window" state row (the fact the Cost screen
-- shows), and a throttled history used to compute an honest "at current pace"
-- forecast. Both are additive; no existing table changes.
CREATE TABLE rate_limit_latest (
  window          TEXT    NOT NULL PRIMARY KEY,  -- 'five_hour' | 'seven_day'
  ts              INTEGER NOT NULL,              -- unix ms, when we received it
  session_id      TEXT    NOT NULL,
  used_percentage REAL    NOT NULL,              -- 0..100
  resets_at       INTEGER NOT NULL               -- unix seconds, from Claude Code
);

CREATE TABLE rate_limit_history (
  ts              INTEGER NOT NULL,              -- unix ms
  window          TEXT    NOT NULL,
  used_percentage REAL    NOT NULL,
  resets_at       INTEGER NOT NULL
);
CREATE INDEX idx_rate_limit_history_window_ts ON rate_limit_history(window, ts);
