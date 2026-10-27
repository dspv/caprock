-- Queued messages a session never got (ADR-053, amendment of 2026-10-27).
-- When the process of a session Caprock started ends with messages still
-- waiting, they are no longer deleted: undelivered_at is set to when the
-- process was found gone (unix ms), and the chat shows them as not sent,
-- with Send to a new session, Copy and Delete. 0 is a message that still
-- waits for its session's turn to end. The daemon deletes an undelivered
-- row 7 days after undelivered_at.
-- See 03-contracts.md § Queued messages DDL.
ALTER TABLE queued_messages ADD COLUMN undelivered_at INTEGER NOT NULL DEFAULT 0;
