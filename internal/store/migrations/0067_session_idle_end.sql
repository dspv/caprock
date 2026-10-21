-- A session Caprock ended because it sat idle with no tab (03-contracts.md §
-- Ending idle sessions): when it was ended (unix ms) and the idle window
-- that ended it (ms), so its row can say "Ended after 12 h idle" rather
-- than vanish. Both 0 for every other session, and set back to 0 when the
-- session is continued.
ALTER TABLE sessions ADD COLUMN idle_ended_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN idle_ended_after INTEGER NOT NULL DEFAULT 0;
