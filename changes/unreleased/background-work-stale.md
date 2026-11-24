---
kind: Fixed
---
- **now:** *Waiting on background work* no longer lists work that ended hours
  ago. A background command stopped from outside (a `pkill` of its script) and
  a background agent whose last word was that it was waiting on its own work
  never got a notification of their end, so they stayed listed until the
  12-hour window ran out. Caprock now also reads Claude Code's own list of
  what still runs, which every Stop carries: what is off it has ended, and an
  agent once nothing it started itself is on it either.
