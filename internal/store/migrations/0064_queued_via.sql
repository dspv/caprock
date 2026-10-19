-- Where a queued message came from (ADR-081): "telegram" for messages
-- forwarded to the paired bot, "" for everything typed in Caprock. The Queue
-- list and the chat mark a forwarded one "from Telegram", and the daemon
-- tells the bot when it was typed in.
-- See 03-contracts.md § Queued messages DDL.
ALTER TABLE queued_messages ADD COLUMN via TEXT NOT NULL DEFAULT '';
