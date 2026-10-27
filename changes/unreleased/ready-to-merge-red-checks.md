---
kind: Fixed
---
- **ui:** a pull request with failed checks no longer says "ready to merge".
  GitHub calls it clean when no check is required, and Caprock repeated that
  beside the red checks; it now says "mergeable, checks failed", or "checks
  running" while they run.
