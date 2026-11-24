---
kind: Changed
---
- **app:** the window does less while agents work. The live session list is
  asked when a frame names a session the window does not hold, and every
  15 s, not on every live tick; session frames are applied once a second.
  On the stand with four tabs and four agents: 984 → 593 redraws and
  996 → 383 KB of requests a minute. Agents' text still arrives as it did.
