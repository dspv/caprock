---
kind: Fixed
---
- **tabs:** an agent session Caprock started that ends without you asking —
  killed by a signal, or exiting with an error code — no longer turns into a
  nameless shell. The shell keeps the session's name and says so on one line
  at its top, *ops ended unexpectedly at 19:58 (killed by a signal)*, with
  **Resume**, which continues the same conversation in that tab, and a ×.
  The session is also listed in Recently closed, *ended unexpectedly*, and
  reopening it resumes it. A typed `/exit` still just leaves a shell.
