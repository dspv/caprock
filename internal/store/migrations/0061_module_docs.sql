-- Private modules' document store (ADR-075): small JSON documents a module
-- installed under an admin key keeps, by module id, collection and document
-- id. `data` is a JSON object as text; `created_at`/`updated_at` are unix ms.
-- Removing a module's files leaves its rows, so reinstalling finds them.
-- See 03-contracts.md § Module documents DDL.
CREATE TABLE IF NOT EXISTS module_docs (
  module     TEXT NOT NULL,
  collection TEXT NOT NULL,
  doc_id     TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (module, collection, doc_id)
) WITHOUT ROWID;
