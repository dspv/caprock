---
kind: Fixed
---
- **cost:** Cursor's spend is read per request, not per usage record. Cursor
  keeps its cost per chat and model, and Caprock stored it on records that
  are not turns, so a model of 2,153 requests and $623 read as "7 turns" and
  "$89 per turn". Those records no longer count as turns anywhere — the model
  mix, All time, the agents and the Week card — and a Cursor model shows its
  requests instead: *2,153 requests · $0.29/request*. Hermes's usage records
  stop counting as turns too.
- **session:** a figure an agent does not record reads the same for every
  agent: "—" with *Cursor doesn't record cache reads or writes*, *Gemini
  doesn't record cache writes*, *Hermes doesn't record each request's tokens*
  under the tile it belongs to. Cursor's Context tile no longer measures a sum
  of requests against a window (or names its model as missing from the
  pricing table), and a Cursor chat with no cost says Cursor recorded none
  rather than "price unknown".
