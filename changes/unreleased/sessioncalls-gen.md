---
kind: Fixed
---
- **perf:** opening a working session's tab no longer reads the whole
  session again for its spend chart. Compressing old tool payloads no longer
  counts as a change to a session, and the chart's calls are extended by
  what was added since the last read, so a linked tool call, a merged reply
  or a compressed payload no longer forces a full read. On a synthetic
  6,000-call session a tab open read 154 MB before and 0.1 MB after, with
  the file evicted from the OS cache; this was the largest reader of disk on
  the owner's daemon (3.1 GB an hour).
