---
kind: Fixed
---
- **app:** the window no longer flips to "the daemon stopped" and back to the
  dashboard on a brief hiccup. A running daemon is kept through 5 s of failed
  checks (20 s when it is only slow), and a slow `/v1/status` no longer counts
  at all; a real stop (its `runtime.json` gone, or its process exited) is
  still seen at once. When the app does count the daemon as gone, `app.log`
  says why.
