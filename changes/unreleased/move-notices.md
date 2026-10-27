---
kind: Fixed
---
- **store:** an upgrade that found no disk for the safety copy of the
  database used to say so only in the log. It is now recorded, and
  `/v1/status` (`upgrade_copy_skipped`), `caprock status`, Now and Status say
  that no copy was made, how much disk was free and needed, and that older
  Caprock versions cannot open the upgraded database.
- **ui:** while older history moves in after the 0073 upgrade, History,
  Memory's search and session pages say so in one quiet line, "Older history
  is still loading — N% moved", gone once the move ends.
