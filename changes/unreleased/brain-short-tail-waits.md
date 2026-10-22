---
kind: Fixed
---
- **brain:** A short exchange at the end of a session that is still open is
  no longer marked read and lost. Second Brain waits and reads it together
  with what the session says next. When the session has ended, the short
  tail is marked read, so nothing waits forever.
