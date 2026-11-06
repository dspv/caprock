---
kind: Fixed
---
- **daemon:** "Return after the reset" survives a restart. A session that
  Caprock moved to another provider or sign-in at a usage limit still goes
  back once the limit resets, even when Caprock restarted in between; a
  return more than an hour overdue at the restart is dropped.
