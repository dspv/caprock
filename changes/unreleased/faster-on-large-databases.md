---
kind: Fixed
---
- **store:** faster on a large history. Searching Claude's prose for a phrase
  it rarely wrote read every assistant turn on the machine; a new index
  (migration 0085) holds what the search tests, and a reply's prompt is
  looked up only where it can match. The Cursor overhead report and a
  session's overhead estimate no longer read every event of every session,
  the cockpit's call list reads only its candidate rows, and the session
  search no longer reads every prompt a second time for a capitalised
  spelling SQLite already folds. On a copy of a 2 GB, 1.09M-event database
  (2026-11-18, warm medians): a rare-phrase prose search 3.1 s to 0.31 s, the
  overhead report 454 ms to 202 ms, a session's overhead estimate 70 ms to
  under 1 ms, a session search 360 ms to 197 ms. Building the index takes a
  few seconds once, on the first start after the update.
