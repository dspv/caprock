---
kind: Added
---
- **ui:** the Agent panel header shows the session's reasoning effort beside
  its model, *Opus 5.5 · high*, as Claude Code's own hooks report it. The
  daemon now keeps the newest known level per session (low, medium, high,
  xhigh, max; migration 0076) and returns it as `effort`; a session whose
  hooks never named one shows the model alone.
