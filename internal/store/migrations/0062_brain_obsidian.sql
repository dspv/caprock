-- Obsidian vaults in Second Brain (ADR-079; 03-contracts.md § Obsidian
-- vaults DDL). A vault the user picked is read on this machine and never
-- written: each Markdown note becomes a node of the new kind 'note', or a
-- second source on a node with the same title or alias; its [[links]] are
-- edges and its #tags topics.
--
-- 1. brain_nodes gains the kind 'note' and vault_id, the vault whose import
--    made the node (NULL for everything else). SQLite cannot change a CHECK
--    in place and foreign keys are on inside this transaction, so dropping
--    brain_nodes would cascade into brain_edges: the edges are copied aside
--    first, both tables are rebuilt, and the edges are put back.
CREATE TABLE brain_edges_keep AS SELECT src, dst, kind, weight, created_at FROM brain_edges;
DROP TABLE brain_edges;

CREATE TABLE brain_nodes_new (
  id          INTEGER PRIMARY KEY,
  kind        TEXT    NOT NULL CHECK (kind IN ('idea','decision','finding','question','note','topic','person','project')),
  title       TEXT    NOT NULL,
  norm        TEXT    NOT NULL DEFAULT '',
  summary     TEXT    NOT NULL DEFAULT '',
  session_id  TEXT    NOT NULL DEFAULT '',
  event_id    INTEGER,
  source_ts   INTEGER NOT NULL DEFAULT 0,
  project     TEXT    NOT NULL DEFAULT '',
  manual      INTEGER NOT NULL DEFAULT 0 CHECK (manual IN (0,1)),
  pinned      INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  run_id      INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  search      TEXT    NOT NULL DEFAULT '',
  vault_id    INTEGER
);
INSERT INTO brain_nodes_new (id, kind, title, norm, summary, session_id, event_id, source_ts, project, manual, pinned, run_id, created_at, updated_at, search)
  SELECT id, kind, title, norm, summary, session_id, event_id, source_ts, project, manual, pinned, run_id, created_at, updated_at, search FROM brain_nodes;
DROP TABLE brain_nodes;
ALTER TABLE brain_nodes_new RENAME TO brain_nodes;

CREATE UNIQUE INDEX IF NOT EXISTS idx_brain_nodes_entity ON brain_nodes(kind, norm)
  WHERE kind IN ('topic','person','project');
CREATE INDEX IF NOT EXISTS idx_brain_nodes_created ON brain_nodes(created_at);
CREATE INDEX IF NOT EXISTS idx_brain_nodes_session ON brain_nodes(session_id);
CREATE INDEX IF NOT EXISTS idx_brain_nodes_event ON brain_nodes(event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_brain_nodes_project ON brain_nodes(project, created_at);
CREATE INDEX IF NOT EXISTS idx_brain_nodes_vault ON brain_nodes(vault_id) WHERE vault_id IS NOT NULL;

CREATE TABLE brain_edges (
  src         INTEGER NOT NULL REFERENCES brain_nodes(id) ON DELETE CASCADE,
  dst         INTEGER NOT NULL REFERENCES brain_nodes(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL CHECK (kind IN ('relates','follows','contradicts','part_of')),
  weight      REAL    NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (src, dst, kind),
  CHECK (src != dst)
) WITHOUT ROWID;
INSERT INTO brain_edges (src, dst, kind, weight, created_at)
  SELECT src, dst, kind, weight, created_at FROM brain_edges_keep;
DROP TABLE brain_edges_keep;
CREATE INDEX IF NOT EXISTS idx_brain_edges_dst ON brain_edges(dst);

-- 2. The vaults. agents is whether a vault's notes may reach an agent (a
--    new session's handoff, the extraction's topic list): off unless the
--    user turns it on, because a vault is the user's private notes.
CREATE TABLE IF NOT EXISTS brain_vaults (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  path        TEXT    NOT NULL UNIQUE,
  agents      INTEGER NOT NULL DEFAULT 0 CHECK (agents IN (0,1)),
  notes       INTEGER NOT NULL DEFAULT 0,      -- Markdown notes read at the last scan
  scanned_at  INTEGER NOT NULL DEFAULT 0,      -- unix ms; 0 before the first
  scan_ms     INTEGER NOT NULL DEFAULT 0,      -- how long the last scan took
  error       TEXT    NOT NULL DEFAULT '',     -- why the last scan failed; '' when it did not
  created_at  INTEGER NOT NULL
);

-- 3. One row per note file: the source mark on its node. Two files with the
--    same title or alias share a node and keep a row each, with their own
--    excerpt; nothing is glued together. keys is the note's title and
--    aliases normalised (store.NormTitle), one per line; links and tags are
--    what the file says, one per line, so a refresh can resolve them again
--    without reading unchanged files.
CREATE TABLE IF NOT EXISTS brain_vault_notes (
  id          INTEGER PRIMARY KEY,
  vault_id    INTEGER NOT NULL REFERENCES brain_vaults(id) ON DELETE CASCADE,
  path        TEXT    NOT NULL,                -- in the vault, slash-separated
  node_id     INTEGER NOT NULL REFERENCES brain_nodes(id) ON DELETE CASCADE,
  title       TEXT    NOT NULL,
  aliases     TEXT    NOT NULL DEFAULT '',
  keys        TEXT    NOT NULL DEFAULT '',
  links       TEXT    NOT NULL DEFAULT '',
  tags        TEXT    NOT NULL DEFAULT '',
  project     TEXT    NOT NULL DEFAULT '',
  excerpt     TEXT    NOT NULL DEFAULT '',
  mtime       INTEGER NOT NULL DEFAULT 0,      -- the file's, unix ms
  size        INTEGER NOT NULL DEFAULT 0,
  UNIQUE (vault_id, path)
);
CREATE INDEX IF NOT EXISTS idx_brain_vault_notes_node ON brain_vault_notes(node_id);

-- 4. The edges a vault's import made or also wants. An edge is removed only
--    when no vault wants it any more and it did not exist before an import
--    first claimed it (pre = 1).
CREATE TABLE IF NOT EXISTS brain_vault_edges (
  vault_id    INTEGER NOT NULL REFERENCES brain_vaults(id) ON DELETE CASCADE,
  src         INTEGER NOT NULL REFERENCES brain_nodes(id) ON DELETE CASCADE,
  dst         INTEGER NOT NULL REFERENCES brain_nodes(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL,
  pre         INTEGER NOT NULL DEFAULT 0 CHECK (pre IN (0,1)),
  PRIMARY KEY (vault_id, src, dst, kind)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_brain_vault_edges_edge ON brain_vault_edges(src, dst, kind);
CREATE INDEX IF NOT EXISTS idx_brain_vault_edges_dst ON brain_vault_edges(dst);
