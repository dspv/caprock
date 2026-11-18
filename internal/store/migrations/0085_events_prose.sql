-- The prose Claude wrote, searchable without opening the table — verbatim
-- from .ai/03-contracts.md § Prose search DDL.
--
-- GET /v1/notes (the Search screen) reads every main-thread assistant turn,
-- newest first, until a page of matches fills. A rare phrase fills none, so
-- the read walked every turn.assistant row of the table, each one's payload
-- opened for its text and its sidechain flag: 9.2 s a search on a copy of
-- the owner's 2 GB database (2026-11-18, 1.09M events, 307k assistant turns,
-- 77k of them main-thread prose). This index holds what the search tests —
-- the turn's session, time, sidechain flag and text — so the scan reads the
-- index alone, and the table only for the rows a page returns.
--
-- json_valid guards each extraction: json_extract raises an error on
-- malformed JSON, which in an index expression would fail the INSERT, and an
-- event must never be lost to an index (as idx_events_agent_task, 0054). The
-- queries name the same expressions, character for character
-- (store.proseText, store.proseSidechain).
CREATE INDEX IF NOT EXISTS idx_events_prose
  ON events(id, sid, ts,
            (CASE WHEN json_valid(payload) THEN json_extract(payload, '$.sidechain') END),
            (CASE WHEN json_valid(payload) THEN json_extract(payload, '$.text') END))
  WHERE kind = 'turn.assistant' AND internal = 0 AND COALESCE(agent_id, '') = '';
