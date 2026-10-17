-- AI;DR (ADR-072): an agent answer squeezed into at most two short sentences
-- by the user's own claude, on a tap, kept so a second tap makes no call.
-- `event_id` is the assistant note's event (events.id); `model` and
-- `cost_usd` are what claude reported for the call; `created_at` is unix ms.
-- Rows go when their event does (store.RemoveSession, PruneEventsBefore).
-- See 03-contracts.md § AI;DR DDL.
CREATE TABLE IF NOT EXISTS event_tldr (
  event_id   INTEGER PRIMARY KEY,
  text       TEXT NOT NULL,
  model      TEXT NOT NULL DEFAULT '',
  cost_usd   REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
