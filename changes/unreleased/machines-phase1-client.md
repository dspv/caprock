---
kind: Added
---
- **remote:** the groundwork for reaching your other computers through the
  relay (ADR-067). A Caprock daemon can now be a client of another
  machine's daemon over the same end-to-end encrypted channel a phone uses,
  pair with it by its link and keep the token in `machines.json` (0600),
  opening the channel only while something needs it. Nothing to see yet:
  the routes, the target's computer pairing and the app follow.
