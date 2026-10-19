---
kind: Fixed
---
- **codex:** a reply no longer shows its text twice when the import was interrupted between saving the turn and saving its words; the import is retried on the next tick, and turns already doubled are corrected the next time their session file is read in full.
