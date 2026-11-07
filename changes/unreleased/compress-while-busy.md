---
kind: Fixed
---
- **storage:** Compress tool output now works on a computer whose agents never
  stop. It waited for 30 minutes with nothing recorded, which agents running
  around the clock never leave, so with the setting on all night it compressed
  nothing. Its steps — and the base64 compaction's, and incremental vacuum's,
  which give free space back to the disk — now run whenever writes pause for
  5 seconds, give way to any write that arrives, and rest nine times as long
  as each step took, so they use at most a tenth of one core.
