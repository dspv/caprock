-- Second Brain: finding memories, and which decisions are current
-- (03-contracts.md § Second Brain, § Second Brain find and decisions DDL;
-- § SessionStart handoff).
--
-- 1. brain_nodes.keywords: 5-8 English keywords the extraction gives each
--    memory whatever language its title is in, joined with ", ". Search
--    weighs them like the title. '' for a memory made before this, by hand,
--    or imported.
ALTER TABLE brain_nodes ADD COLUMN keywords TEXT NOT NULL DEFAULT '';

-- 2. brain_edges gains the kind 'supersedes': from a newer decision to the
--    older one it replaces. SQLite cannot change a CHECK in place, so the
--    table is rebuilt as 0062 did. Nothing references brain_edges, so it is
--    copied aside, dropped, made again and filled back.
CREATE TABLE brain_edges_keep AS SELECT src, dst, kind, weight, created_at FROM brain_edges;
DROP TABLE brain_edges;
CREATE TABLE brain_edges (
  src         INTEGER NOT NULL REFERENCES brain_nodes(id) ON DELETE CASCADE,
  dst         INTEGER NOT NULL REFERENCES brain_nodes(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL CHECK (kind IN ('relates','follows','contradicts','part_of','supersedes')),
  weight      REAL    NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (src, dst, kind),
  CHECK (src != dst)
) WITHOUT ROWID;
INSERT INTO brain_edges (src, dst, kind, weight, created_at)
  SELECT src, dst, kind, weight, created_at FROM brain_edges_keep;
DROP TABLE brain_edges_keep;
CREATE INDEX IF NOT EXISTS idx_brain_edges_dst ON brain_edges(dst);
-- "Is this decision superseded" is asked per decision by the current-
-- decisions read, the handoff and every search.
CREATE INDEX IF NOT EXISTS idx_brain_edges_supersedes ON brain_edges(dst) WHERE kind = 'supersedes';

-- 3. How long a new session's SessionStart handoff was, in runes of its
--    additionalContext: 0 when nothing was handed (none to hand, held back,
--    or switched off). Recorded so delivery can be measured.
ALTER TABLE sessions ADD COLUMN handoff_runes INTEGER NOT NULL DEFAULT 0;
