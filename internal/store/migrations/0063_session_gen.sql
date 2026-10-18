-- A per-session rewrite generation (F14, resource-usage audit 2026-10-18):
-- every update or delete of a session's events moves its `gen`, in the same
-- transaction as the change, whichever code wrote it. Inserts need no trigger:
-- each new row takes a rowid above every existing one, so the session's
-- MAX(id) (idx_events_session_id) moves instead. The sessions list keys its
-- cache of each session's recent events on the pair (store.EventsGen), so an
-- unchanged session is not read again.
--
-- No insert trigger on purpose: any trigger on events, even one that does
-- nothing, is compiled into every statement that fires it, and the driver
-- prepares each statement afresh; a no-op AFTER INSERT trigger measured
-- 58 -> 129 us per inserted event. Updates and deletes are rarer statements.
--
-- Rows are never deleted: a session id removed and seen again carries on
-- from its old generation instead of reusing one.
-- See 03-contracts.md § Session generation DDL.
CREATE TABLE IF NOT EXISTS session_gen (
  session_id TEXT    NOT NULL PRIMARY KEY,
  gen        INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS events_gen_update AFTER UPDATE ON events BEGIN
  INSERT INTO session_gen(session_id, gen) VALUES (NEW.session_id, 1)
    ON CONFLICT(session_id) DO UPDATE SET gen = gen + 1;
  INSERT INTO session_gen(session_id, gen)
    SELECT OLD.session_id, 1 WHERE OLD.session_id IS NOT NEW.session_id
    ON CONFLICT(session_id) DO UPDATE SET gen = gen + 1;
END;

CREATE TRIGGER IF NOT EXISTS events_gen_delete AFTER DELETE ON events BEGIN
  INSERT INTO session_gen(session_id, gen) VALUES (OLD.session_id, 1)
    ON CONFLICT(session_id) DO UPDATE SET gen = gen + 1;
END;
