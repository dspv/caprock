---
kind: Changed
---
- **store:** the Tools screen's drill-down no longer reads tool payloads: each
  call's group, each result's failure and each Agent result's subagent are
  stored beside the event when it is written (migration 0070). On a 2 GB
  database the Bash drill-down over 30 days went from 4.1 s to 0.8 s. Calls
  stored before the upgrade are filled in the background, newest first, and
  read as before until they are, so the upgrade starts as fast as ever and
  no screen changes meanwhile. The first step towards compressing tool
  payloads (#672).
