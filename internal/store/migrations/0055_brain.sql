-- Second Brain (ADR-063): a graph of what the user's sessions did, decided and
-- found, kept on this machine. A node is one memory — an idea, a decision, a
-- finding, a question — or an entity it hangs off: a topic, a person, a
-- project. An edge says how two nodes stand to each other.
--
-- A node dropped in by hand has manual = 1; one read out of a session by the
-- automatic extraction carries the run that made it (brain_runs), so every
-- memory says where it came from. session_id, event_id, source_ts and project
-- point at the moment in the record it was taken from; '' / NULL / 0 for a
-- line typed into the quick capture.
--
-- norm is the title folded for comparison (lower case, spaces collapsed). An
-- entity — topic, person, project — exists once per norm, which the partial
-- unique index enforces; memories may share a title.
CREATE TABLE IF NOT EXISTS brain_nodes (
  id          INTEGER PRIMARY KEY,
  kind        TEXT    NOT NULL CHECK (kind IN ('idea','decision','finding','question','topic','person','project')),
  title       TEXT    NOT NULL,
  norm        TEXT    NOT NULL DEFAULT '',
  summary     TEXT    NOT NULL DEFAULT '',
  session_id  TEXT    NOT NULL DEFAULT '',
  event_id    INTEGER,
  source_ts   INTEGER NOT NULL DEFAULT 0,  -- unix ms of the source moment
  project     TEXT    NOT NULL DEFAULT '',
  manual      INTEGER NOT NULL DEFAULT 0 CHECK (manual IN (0,1)),
  pinned      INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  run_id      INTEGER,                     -- brain_runs.id; NULL when manual
  created_at  INTEGER NOT NULL,            -- unix ms
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_brain_nodes_entity ON brain_nodes(kind, norm)
  WHERE kind IN ('topic','person','project');
CREATE INDEX IF NOT EXISTS idx_brain_nodes_created ON brain_nodes(created_at);
CREATE INDEX IF NOT EXISTS idx_brain_nodes_session ON brain_nodes(session_id);
CREATE INDEX IF NOT EXISTS idx_brain_nodes_event ON brain_nodes(event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_brain_nodes_project ON brain_nodes(project, created_at);

-- One edge per (src, dst, kind). Deleting a node deletes its edges.
CREATE TABLE IF NOT EXISTS brain_edges (
  src         INTEGER NOT NULL REFERENCES brain_nodes(id) ON DELETE CASCADE,
  dst         INTEGER NOT NULL REFERENCES brain_nodes(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL CHECK (kind IN ('relates','follows','contradicts','part_of')),
  weight      REAL    NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (src, dst, kind),
  CHECK (src != dst)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_brain_edges_dst ON brain_edges(dst);

-- One automatic extraction: which session, how far into it it read, what it
-- cost and what came of it. A session's newest row is how far the extraction
-- has read it (through_event_id), so a session is never read twice and a
-- failed run is retried from the same place.
CREATE TABLE IF NOT EXISTS brain_runs (
  id               INTEGER PRIMARY KEY,
  session_id       TEXT    NOT NULL,
  from_event_id    INTEGER NOT NULL DEFAULT 0,
  through_event_id INTEGER NOT NULL DEFAULT 0,
  status           TEXT    NOT NULL CHECK (status IN ('ok','failed','skipped')),
  model            TEXT    NOT NULL DEFAULT '',
  tokens_in        INTEGER NOT NULL DEFAULT 0,  -- input + cache read + cache write, as claude reported it
  tokens_out       INTEGER NOT NULL DEFAULT 0,
  cost_usd         REAL    NOT NULL DEFAULT 0,  -- claude's own total_cost_usd
  nodes            INTEGER NOT NULL DEFAULT 0,
  error            TEXT    NOT NULL DEFAULT '',
  started_at       INTEGER NOT NULL,
  finished_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brain_runs_session ON brain_runs(session_id, id);
CREATE INDEX IF NOT EXISTS idx_brain_runs_finished ON brain_runs(finished_at);
