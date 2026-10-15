---
kind: Added
---
- **machines:** one of your computers can work on another's sessions
  (ADR-067). On the computer to be reached, `caprock pair --computer`
  prints a link (turning access from anywhere on if it is off); on the
  other, `caprock machines add '<link>'` pairs with it through that
  computer's own relay, end to end encrypted. Nothing is let in until the
  first computer's owner allows it by name: a card on its screen, the
  prompt in the terminal that printed the link, or `caprock machines allow
  <name>` over SSH. An allowed computer can start agents in any folder, open
  shells and run tasks there, but never change that computer's settings,
  pairing, updates or the doctor's stop. `caprock machines revoke <name>`
  or Remove ends it at once, open terminals included, and `caprock machines
  forget <name>` on the other side drops it from both. On Linux both
  `caprock service install` and `caprock pair --computer` say when
  `loginctl enable-linger` is needed to stay reachable with nobody logged
  in.
