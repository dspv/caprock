---
kind: Fixed
---
- **now:** a subagent whose SubagentStop never came no longer reads "working"
  forever: when its session's process started again (a resume) after its last
  event, when the session ended, or when it went silent for 15 minutes with
  no call in progress while the session sat at its prompt, it is listed as
  stopped, with why on hover (*stopped when the session restarted*).
