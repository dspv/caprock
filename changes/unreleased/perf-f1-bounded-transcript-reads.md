---
kind: Fixed
---
- **ingest:** a Claude Code transcript record longer than the 16 MiB line limit
  is now skipped while it is read, in fragments, instead of being read whole
  first: one read of a 32 MiB record allocated 67 MB before and 17 MB after,
  and the same 17 MB for a 64 MiB one. A complete record over the limit is
  skipped too (before, only an unfinished one was), counted once as a
  malformed line, and the line after it is read. Skipping an unfinished one no
  longer leaves the offset inside it, which made the next read start the whole
  transcript over.
