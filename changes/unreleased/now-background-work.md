---
kind: Fixed
---
- **now:** a session whose turn ended while work it started in the background
  still runs no longer says "Done": Now says *Waiting on background work · 1
  agent, 1 shell* and lists each background command, Monitor watch or agent
  with how long it has run, until Claude Code reports it finished, failed or
  stopped (or the session's process restarts). A background agent that stopped
  to wait on background work of its own now reads running, not "1 done". The
  work board shows such a session as background, and end-when-done and the
  idle end leave it running.
