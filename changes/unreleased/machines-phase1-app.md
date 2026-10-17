---
kind: Added
---
- **machines:** your other computers in the app (ADR-067). The sidebar lists
  each linked computer and the sessions running there, tagged by its name,
  and opens one with its Session view and terminal as on that computer's own
  screen, through this Caprock. Settings → Computers adds one by the link it
  shows, renames, forgets and checks them, says when one is offline, waiting
  for Allow, removed there or refused, lists the steps for the other computer
  (install, `caprock remote on`, `caprock pair --computer`), and shows a link
  for another computer to reach this one. With none linked, one quiet
  *+ Add a machine* row in the sidebar.
- **resources:** `GET /v1/resources` reports the machine as a whole —
  cores, one-minute load (not on Windows), total and available memory.
- **bench:** `bench/peer.mjs` measures keystroke-to-echo through a linked
  computer against the same session typed into locally.
