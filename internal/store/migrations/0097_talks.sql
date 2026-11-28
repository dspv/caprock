-- Talks: agents speak for two people (ADR-110) — verbatim from
-- .ai/03-contracts.md § Talks DDL (migration 0097).
--
-- One row in talks per Talk, on each side: the goal, the other party
-- (person: their relay id, as people.json lists them), this side's state,
-- caps, spend and the one message held for its owner, if any. Every
-- envelope either side sent is in talk_envelopes, byte for byte as it
-- travelled (raw), with its hash, so both transcripts can be checked equal.
-- talk_outbox is what this side sent and the other side has not taken yet:
-- retried while that Caprock is offline; the relay keeps nothing.
CREATE TABLE IF NOT EXISTS talks (
  id             TEXT PRIMARY KEY,
  person         TEXT NOT NULL,
  person_name    TEXT NOT NULL DEFAULT '',
  goal           TEXT NOT NULL,
  started_by     TEXT NOT NULL,
  state          TEXT NOT NULL,
  hold           TEXT NOT NULL DEFAULT '',
  ended_by       TEXT NOT NULL DEFAULT '',
  brief          TEXT NOT NULL DEFAULT '',
  agent          TEXT NOT NULL DEFAULT '',
  model          TEXT NOT NULL DEFAULT '',
  max_messages   INTEGER NOT NULL,
  max_usd        REAL NOT NULL,
  sent           INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL NOT NULL DEFAULT 0,
  their_cost_usd REAL,
  draft          TEXT NOT NULL DEFAULT '',
  draft_redacted TEXT NOT NULL DEFAULT '',
  draft_caught   TEXT NOT NULL DEFAULT '',
  draft_done     INTEGER NOT NULL DEFAULT 0,
  note           TEXT NOT NULL DEFAULT '',
  steer          TEXT NOT NULL DEFAULT '',
  last_error     TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_talks_updated ON talks(updated_at);
CREATE INDEX IF NOT EXISTS idx_talks_person ON talks(person, state);

CREATE TABLE IF NOT EXISTS talk_envelopes (
  talk         TEXT NOT NULL,
  side         TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  hash         TEXT NOT NULL,
  raw          TEXT NOT NULL,
  how          TEXT NOT NULL DEFAULT '',
  caught       TEXT NOT NULL DEFAULT '',
  cost_usd     REAL NOT NULL DEFAULT 0,
  at           INTEGER NOT NULL,
  delivered_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (talk, side, seq)
);

CREATE TABLE IF NOT EXISTS talk_outbox (
  talk       TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  person     TEXT NOT NULL,
  tries      INTEGER NOT NULL DEFAULT 0,
  next_at    INTEGER NOT NULL,
  last_error TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (talk, seq)
);
CREATE INDEX IF NOT EXISTS idx_talk_outbox_next ON talk_outbox(next_at);
