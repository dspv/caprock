---
kind: Changed
---
- **daemon:** the summaries' per-session figures are kept in the database
  across restarts (migration 0093), so a start reads only what moved since
  the last run instead of all of history. On a copy of a 2.4 GB database,
  about 255 MB less read at each start.
