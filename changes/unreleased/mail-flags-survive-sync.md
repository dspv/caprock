---
kind: Fixed
---
- **mail:** a reply's original stays marked answered, and a message you mark
  read, unread, flagged or unflagged keeps that mark, when a sync was already
  under way. That sync read the server's old flags and wrote them back over
  yours until the next sync, up to five minutes later.
