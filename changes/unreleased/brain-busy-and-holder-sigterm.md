---
kind: Fixed
---
- **brain:** keeping a memory while a backfill imports many transcripts no
  longer fails with `SQLITE_BUSY`. Each import batch left the database free
  for a while after it committed, but a batch already waiting was handed the
  lock at once, so the gap never opened; it now waits the gap out. A write
  that still finds the database busy is answered `503` with words, and the
  dashboard tries a drop again rather than showing a bare error.
- **terminal:** a shell terminal's holder stops on `SIGTERM` within about a
  second. It passed `SIGTERM` to the shell, which ignores it, and then waited
  for good; it now hangs the shell up first (as closing a terminal window
  does, which also ends the shell's jobs), and kills what is still running
  750 ms later.
