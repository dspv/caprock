---
kind: Fixed
---
- **ui:** a freshly opened window no longer logs a 404 for
  `/v1/projects/dir:…/cleanup`: the finished-copies line waits for the
  daemon's own project list instead of asking about a project the window
  derived while that list was loading. Found by `make e2e`.
