-- Second Brain's catch-up (03-contracts.md § Second Brain, *Catch-up*).
-- Until 2026-10-22 a read of a session with more unread prose than one read
-- sends kept only the newest part and moved the cursor past the rest, so the
-- older part was never read. A gap is that skipped span of one past read:
-- the session's events after the read's from_event_id up to to_event_id,
-- read later in chunks, oldest first, when nothing else waits.
--
-- Every successful read made before this migration is a gap until measured:
-- the daemon re-runs the old cut against the stored events, fills
-- to_event_id and reads_total, and deletes the row when nothing was skipped.
-- to_event_id is NULL until then. cursor is how far the gap has been read;
-- attempts counts failed reads in a row, reset by one that succeeds.
CREATE TABLE IF NOT EXISTS brain_gaps (
  id            INTEGER PRIMARY KEY,
  run_id        INTEGER NOT NULL UNIQUE,     -- the brain_runs read that skipped it
  session_id    TEXT    NOT NULL,
  from_event_id INTEGER NOT NULL,
  to_event_id   INTEGER,                     -- last event of the span; NULL until measured
  cursor        INTEGER NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  reads_total   INTEGER NOT NULL DEFAULT 0,  -- reads the span takes, counted when measured
  reads_done    INTEGER NOT NULL DEFAULT 0,
  attempts      INTEGER NOT NULL DEFAULT 0,
  error         TEXT    NOT NULL DEFAULT '',
  updated_at    INTEGER NOT NULL DEFAULT 0   -- unix ms
);
CREATE INDEX IF NOT EXISTS idx_brain_gaps_status ON brain_gaps(status, id);

-- A catch-up read names its gap; a regular read has NULL. held = 1 marks a
-- read that found too little new prose in a session still open and left the
-- cursor where it was, so that prose is read with what comes next;
-- through_event_id is then the session's newest event when it was held.
ALTER TABLE brain_runs ADD COLUMN gap_id INTEGER;
ALTER TABLE brain_runs ADD COLUMN held INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO brain_gaps (run_id, session_id, from_event_id, cursor)
  SELECT id, session_id, from_event_id, from_event_id FROM brain_runs WHERE status = 'ok';
