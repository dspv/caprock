-- The reasoning effort a session last ran at, as Claude Code's own hook
-- payloads state it (`effort.level`, common to every hook event). Only a
-- known level is written ("low", "medium", "high", "xhigh", "max"); '' is a
-- session no hook has told us about. A later hook that names a level
-- replaces it (/effort and /model change it mid-session); one that names
-- none leaves it. See 03-contracts.md § Session effort DDL.
ALTER TABLE sessions ADD COLUMN effort TEXT NOT NULL DEFAULT '';
