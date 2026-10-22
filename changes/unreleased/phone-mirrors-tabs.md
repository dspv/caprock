---
kind: Fixed
---
- **phone:** Continue on the phone home now lists the sessions open as tabs
  on your computer, in the tab strip's order and under the same names, and a
  row no longer jumps around as sessions start and stop working: its status
  changes in place. Sessions running in the background without a tab stay
  under *All sessions*. When the computer's app has not reported its tabs,
  the live sessions are listed oldest first, in an order activity never
  changes. The app now reports its tabs in strip order, and the daemon
  answers `GET /v1/tabs` (a paired phone may read it).
