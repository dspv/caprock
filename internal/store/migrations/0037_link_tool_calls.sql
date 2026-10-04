-- Attach the tool calls stored without a message id to the turn that paid for
-- them, so the work-kind breakdown ("What it went on") stops filing their cost
-- under "no tool call".
--
-- On a copy of the owner's database (2026-10-04) 31,091 of the last 30 days'
-- tool calls had no msg_id and "no tool call" read 93% of spend. Three causes:
--
--   * Claude Code with hooks installed: the PreToolUse hook stores the call
--     first, without a message id; the transcript's copy, which has one, was
--     dropped as a duplicate of the same `pre:<tool_use_id>` key. The live
--     path now fills it in (store.LinkToolCall). Old rows can only be linked
--     from the transcripts, so the existing background backfill
--     (ingest.BackfillToolMessageIDs) is re-armed; it marked itself done on
--     2026-08-23 and never looked again.
--   * Codex records no response id, and no msg_id was ever written. A
--     response's items come before the token_count that bills it, so a call
--     belongs to the first turn after it in the file (codex.ToolCall.TurnKey).
--   * DSH (DeepSeek) likewise: a tool/call record follows the assistant
--     message that holds its tool-call block, so it belongs to the nearest
--     turn before it — 503 of 503 on the owner's machine, checked by call id.
--
-- For Codex and DSH the turn's key stands in for a message id, prefixed with
-- the session (msg_id is matched across sessions by store.TurnPaidElsewhere).
-- The ingesters write the same value from now on. Keys carry the transcript
-- line (Codex) or seq (DSH), which is what orders the rows here; a subagent's
-- Codex rows are matched only within its own `codex:sub:<thread>:` family.
--
-- Window functions rather than a correlated subquery: the subquery form took
-- 2m12s on the owner's database, this takes ~6s.

UPDATE meta SET v = '0' WHERE k = 'tool_link_cursor';

UPDATE events SET msg_id = session_id || '/' || key
WHERE source IN ('codex', 'deepseek') AND kind = 'turn.assistant'
  AND msg_id IS NULL AND key IS NOT NULL;

CREATE TEMP TABLE tool_turn AS
WITH r AS (
  SELECT id, kind, session_id, msg_id,
         substr(key, 1, instr(key, ':' || substr(kind, 1, 4)) - 1) AS fam,
         CAST(substr(key, instr(key, ':' || substr(kind, 1, 4)) + 6) AS INTEGER) AS line
  FROM events
  WHERE source = 'codex' AND kind IN ('tool.pre', 'turn.assistant') AND key IS NOT NULL
), n AS (
  SELECT id, kind, msg_id, session_id, fam,
         MIN(CASE WHEN kind = 'turn.assistant' THEN line END) OVER (
           PARTITION BY session_id, fam ORDER BY line
           ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS turn_line
  FROM r WHERE fam != ''
)
SELECT id, session_id || '/' || fam || ':turn:' || turn_line AS msg_id
FROM n WHERE kind = 'tool.pre' AND msg_id IS NULL AND turn_line IS NOT NULL;

UPDATE events SET msg_id = (SELECT tt.msg_id FROM tool_turn tt WHERE tt.id = events.id)
WHERE id IN (SELECT id FROM tool_turn);
DROP TABLE tool_turn;

CREATE TEMP TABLE tool_turn AS
WITH r AS (
  SELECT id, kind, session_id, msg_id, CAST(substr(key, 10) AS INTEGER) AS seq
  FROM events
  WHERE source = 'deepseek' AND kind IN ('tool.pre', 'turn.assistant')
    AND (key LIKE 'dsh:tool:%' OR key LIKE 'dsh:turn:%')
), n AS (
  SELECT id, kind, msg_id, session_id,
         MAX(CASE WHEN kind = 'turn.assistant' THEN seq END) OVER (
           PARTITION BY session_id ORDER BY seq
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS turn_seq
  FROM r
)
SELECT id, session_id || '/dsh:turn:' || turn_seq AS msg_id
FROM n WHERE kind = 'tool.pre' AND msg_id IS NULL AND turn_seq IS NOT NULL;

UPDATE events SET msg_id = (SELECT tt.msg_id FROM tool_turn tt WHERE tt.id = events.id)
WHERE id IN (SELECT id FROM tool_turn);
DROP TABLE tool_turn;
