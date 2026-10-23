---
kind: Fixed
---
- **ui:** the cockpit's CI block, folded, no longer shows an old copy of a
  pull request's checks as running. Its one line was drawn from what was
  kept when the block was last unfolded and never read again, so it could
  say "#801 · 4 running · 11h" of a pull request merged hours before, next
  to the time of a different answer. The session's pull requests are now
  read folded too, the line waits for that read and the time beside it is
  that read's; a kept copy not read again yet no longer has a growing
  elapsed time.
