---
kind: Fixed
---
- **brain:** Second Brain reads a long session whole. A read still sends at
  most 24,000 characters, but a session with more is now read in chunks,
  oldest first, each read going on where the last one stopped; before, a
  read kept only the newest part and the older part was never read. A wake
  still makes at most four calls, so a read costs what it did. The
  extraction is also told to keep a decision or standing rule you state
  ("from now on", "rule:") as a decision.
