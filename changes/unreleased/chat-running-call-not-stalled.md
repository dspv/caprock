---
kind: Fixed
---
- **chat:** a call that runs longer than 15 minutes (a build, `make e2e`)
  is no longer called stalled. The chat keeps *Running make e2e* with its
  clock instead of *No reply from Claude since …*; only a turn with no call
  running and no event for 15 minutes is stalled, in the chat and in the
  session lists alike.
