---
kind: Fixed
---
- **terminal:** The wheel scrolls Codex again. A terminal opened, reloaded or
  reconnected after Codex's startup had scrolled out of the daemon's 256 KB
  output buffer came back on the normal screen with the mouse off, so the
  wheel never reached Codex. The replay now restores the alternate screen and
  mouse reporting along with the other modes the session set.
