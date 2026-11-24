---
kind: Changed
---
- **app:** opening a session's inspector transfers less. The daemon leaves
  out the tool results the inspector never shows (`slim=1`): 38% smaller on
  a hook-driven session and 70% on a long one on the stand (612 KB → 184 KB).
