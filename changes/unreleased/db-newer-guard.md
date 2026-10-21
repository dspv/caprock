---
kind: Fixed
---
- **store:** Caprock no longer opens a database that a newer Caprock has
  migrated. Going back to an older version used to open it anyway and could
  lose data without a word; now the daemon stops before writing anything and
  says, in one line, the database's schema number, the highest this version
  knows, and to install the newer Caprock. `caprock up`, the desktop app's
  "Caprock could not start" screen and `caprock doctor` show that line, and
  the database file is left exactly as it was.
