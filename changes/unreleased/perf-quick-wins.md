---
kind: Changed
---
- **daemon:** the daemon holds about half the memory it did. SQLite's page
  cache per connection is 4 MiB instead of 16 MiB: on a stand at the owner's
  scale (1.18M events, 2.8 GB) its steady footprint went from 518 MB to
  276 MB, SQLite's share from 366 MB to 100 MB, with every timed endpoint as
  fast and its CPU about the same (10.2% → 10.7% of a core).
