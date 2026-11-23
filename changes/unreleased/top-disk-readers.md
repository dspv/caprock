---
kind: Fixed
---
- **perf:** the machine's typical compaction figure, read once a minute
  while an Agent panel is open, no longer walks every Cursor chat with a
  compaction that has no after measured, from the boundary to its end, to
  find a turn it never counts: on the owner's database that walk was about
  20 MB of disk reads each time (0.5 to 0.9 GB an hour). The figures are
  the same.
- **doctor:** `GET /v1/footprint`'s `disk_io.by_source` lists the top thirty
  readers instead of ten. The rest, summed into *other sources*, had been
  reading more than any reader listed.
