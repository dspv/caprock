---
kind: Added
---
- **brain:** Second Brain says what it spends. A strip on top of the screen
  reads *Today 84k of 300k tokens* over a thin bar against the daily limit,
  with a chip for its share of every Claude token Caprock recorded in the
  same 24 hours; while a backfill catches up, a second line says *X / Y
  reads, about N days left*. A click opens the last 14 days: tokens per day
  against the limit, and reads, tokens and memories per project. Read from
  the new `GET /v1/brain/spend?days=` (open to paired devices); the status
  gains a generic `catch_up` field.
