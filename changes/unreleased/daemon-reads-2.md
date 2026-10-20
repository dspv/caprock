---
kind: Fixed
---
- **daemon:** the dashboard reads far less of the database while agents work.
  The Work board keeps each live session's newest events and task list until
  the session writes something, the plan-limit pace is counted again only
  when a new sample arrives, the status screen's Memory line stops at the
  first passage it needs instead of parsing a fortnight of replies (it often
  ran out of time and showed nothing), and a week of spend per subscription
  is summed once a minute instead of on every request. On a copy of a 1.85 GB
  database with the Now screen open, the database reads the daemon asked for
  fell from 2,050 MB to 1,231 MB in three minutes.
