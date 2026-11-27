-- Telegram messages waiting for the computer that holds the bot — verbatim
-- from .ai/03-contracts.md § Telegram outbox DDL (migration 0096).
--
-- A computer that sends its Telegram messages through another computer's
-- bot (ADR-047, amended 2026-11-27) keeps each one here until the holder
-- takes it over the machine-to-machine link, so a holder that is asleep or
-- offline delays them instead of losing them. id is the message's own id
-- (what a button press coming back names), created_at unix ms on this
-- machine's clock, body the message as the holder's
-- POST /v1/telegram/hub/messages takes it (JSON), tries how many posts
-- failed and last_error the last failure's words. Bounded by the daemon:
-- at most 200 rows and none older than 24 hours.
CREATE TABLE IF NOT EXISTS telegram_outbox (
  id         TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  body       TEXT NOT NULL,
  tries      INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_telegram_outbox_created ON telegram_outbox(created_at, id);
