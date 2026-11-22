-- The passages long enough to hand a new session, found without opening a
-- payload — verbatim from .ai/03-contracts.md § Handoff passages DDL.
--
-- store.HandoffCoverage (the status screen's memory line, read once a minute
-- while the dashboard polls status) asks which repositories hold a
-- main-thread assistant passage of 400+ characters in the last fortnight,
-- and when the oldest was written. Even stopping at the first passage per
-- project it opened the payload of every assistant turn it walked to test
-- its sidechain flag and measure its text: 48 MB a call cold on a copy of the
-- owner's database. This index holds only the passages that qualify, by
-- session and time, so both figures are seeks into it and the table is never
-- read. The query names the same five conditions character for character
-- (store.handoffWhere); SQLite then drops them as implied by the index.
--
-- json_valid guards each extraction, as in idx_events_prose (0085):
-- json_extract raises an error on malformed JSON, which in an index's WHERE
-- would fail the INSERT, and an event must never be lost to an index.
CREATE INDEX IF NOT EXISTS idx_events_handoff ON events(sid, ts)
  WHERE kind = 'turn.assistant' AND internal = 0 AND COALESCE(agent_id, '') = ''
    AND (CASE WHEN json_valid(payload) THEN json_extract(payload, '$.sidechain') END) IS NOT 1
    AND LENGTH(CASE WHEN json_valid(payload) THEN json_extract(payload, '$.text') END) >= 400;
