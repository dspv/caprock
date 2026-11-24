---
kind: Changed
---
- **daemon:** the Work board's per-session cache keeps only the fields its
  readers look at, and drops a session the board no longer lists. On the
  stand's database, 256 sessions' cached events went from 30.5 MB of
  payloads to 2.4 MB, with every state read the same.
