---
kind: Fixed
---
- **queue:** a message waiting in a session's queue is no longer lost when
  the session ends. When the process ends, the waiting messages are kept for
  7 days, shown under the conversation as *Not sent: the session ended*,
  each with **Send to a new session** (the same agent in the same folder,
  continuing the conversation when it can; the message then goes in through
  that session's queue), **Copy** and **Delete**, and **Send all** for
  several, in order, one per turn. A `/clear` no longer empties the queue:
  it moves to the new session and carries on delivering there. Migration
  0075 (ADR-053, amendment of 2026-10-27).
