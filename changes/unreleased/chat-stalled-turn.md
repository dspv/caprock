---
kind: Fixed
---
- **chat:** a turn that never got a reply no longer reads *Claude is
  thinking…* forever. After 15 minutes with no event from the agent the chat
  says *No reply from Claude since 22:20*, how long it has been quiet, and
  offers **Send again** (types the prompt in at once, even though the daemon
  still counts the turn as running) and **Open terminal**. A session left
  this way showed a 48-hour thinking clock.
