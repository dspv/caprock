---
kind: Fixed
---
- **cursor:** edits Cursor named by a path starting with the project's own
  folder name are filed under the right folder, not one level too deep, and
  Cursor's MCP calls and newer edit tools carry the names Claude Code's do.
  Chats stored before are corrected once on the next start, with their cost
  unchanged.
- **cursor:** a Cursor session's Turns tile counts its replies and names the
  requests Cursor counted, instead of counting Cursor's running totals as
  turns.
- **cursor:** the estimate of what Cursor adds to each request is recorded
  again for chats billed to several models, as an unnamed model.
