---
kind: Changed
---
- **store:** four indexes that later ones had replaced are dropped, giving
  back 125 MiB of a 1041 MiB database of 519,000 events, with every query
  as fast as before. The space returns as the database's idle vacuum runs.
