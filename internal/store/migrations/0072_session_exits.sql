-- How a session Caprock started ended (the user who pressed Continue here
-- five times, 2026-10-24): its program's exit code, how long it ran, and the
-- last lines its terminal printed, ANSI stripped and capped at 4 KB. A
-- program that exits at once — `claude` printing "No conversation found" and
-- ending with status 1 a moment after it started — used to leave nothing but
-- "exit status 1" in service.log; its tab kept trying to connect, and no
-- screen said why. One row per owned session that ended; written when its
-- process exits (agents.Manager), read by GET /v1/agents/{id}/exit.
--
-- Nothing is filled here: rows appear as owned sessions end.
-- See 03-contracts.md § Session exits DDL.
CREATE TABLE IF NOT EXISTS session_exits (
  session_id TEXT    PRIMARY KEY,
  code       INTEGER NOT NULL,
  ran_ms     INTEGER NOT NULL DEFAULT 0,  -- spawn to exit
  early      INTEGER NOT NULL DEFAULT 0,  -- 1: ended within agents.EarlyExit, nothing typed
  tail       TEXT    NOT NULL DEFAULT '', -- last lines on its screen, plain text
  at         INTEGER NOT NULL             -- unix ms it ended
) WITHOUT ROWID;
