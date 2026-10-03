-- A turn is paid for once, whichever session's transcript it appears in.
--
-- `claude --resume <id> --fork-session` (how Caprock picks up a session that is
-- still running elsewhere) writes the parent's history since its last
-- compaction into the new session's transcript: the same `uuid`, the same
-- `message.id`, the same usage, under the new `sessionId`. The store dedupes
-- turns on (session_id, key), so each copy was a new row and was priced again.
-- On the owner's database one fork carried 827 such turns: $212.93 counted
-- twice.
--
-- The write path now asks, per turn, whether another session already holds
-- this message id with usage on it (store.TurnPaidElsewhere), and the one-time
-- repair (rollup.RepairForkedTurns) finds the copies already stored. Both need
-- to find a message id across sessions; `idx_events_msg` leads on session_id
-- and cannot. Partial, so it costs only the assistant turns, and carrying
-- session_id so the repair's GROUP BY is answered from the index.
CREATE INDEX IF NOT EXISTS idx_events_turn_msg
  ON events(msg_id, session_id)
  WHERE kind = 'turn.assistant' AND msg_id IS NOT NULL;
